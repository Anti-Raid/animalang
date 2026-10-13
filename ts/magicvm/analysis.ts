import {
  CORE_QUOTE,
  CORE_LAMBDA,
  CORE_SET,
  CORE_BLOCK,
  CORE_ESCAPE,
  CORE_LET,
  CORE_LET_VALUES,
  CORE_LET_VALUES_STRICT,
  CORE_LETREC,
  CORE_LET_STAR,
  CORE_IF,
  CORE_BEGIN,
  CORE_LOOP,
  CORE_WITH_MARK,
  CORE_CATCH,
  OP_CURRENT_MARKS,
  OP_DEFINE_GLOBAL,
  CORE_CALL,
  CORE_INTCALL,
  CORE_INTAPPLY,
} from "../common";
import { AnalysisScope, VariableMetadata } from "./scope";
import { subExprs as subExprsOf } from "./passes/lang";
import { Worklist, run, start, type Task } from "./visitor";
import { Lconv, SET_BOX } from "./passes/assignments";

const OP_APPLY = Symbol.for("%apply");
import { CORE_FORMS } from "./core";
import { bodyOf, clausesOf, isLetrecLambda, paramsOf, restOf, unwrapBoxed } from "./lambda";
import type { Intrinsics } from "./intrinsics";

// Analyzes the core forms (arrays, see compiler.ts) to handle scoping prior to actual compilation. This lets us avoid
// boxing of primitives

const subExprs = (e: any[]): any[] => subExprsOf(Lconv, e);

// whether `e` mentions one of `names`
const mentions = (e: any, names: ReadonlySet<symbol>): boolean => {
    if (!Array.isArray(e)) return typeof e === "symbol" && names.has(e);
    let found = false;
    const todo = new Worklist();
    todo.add(e);
    todo.run(x => {
        if (typeof x === "symbol") {
            if (names.has(x)) {
                found = true;
                todo.stop();
            }
        } else if (Array.isArray(x)) todo.addAll(subExprs(x));
    });
    return found;
};

// The %letrec names that are not lambdas but may be copied into a closure before their init has run, so they must be
// treated as assigned (a box when captured) rather than filled into closures once known: a closure made by an earlier
// (or its own) init mentions it, or earlier inits may have run the %letrec's lambdas, whose nested closures could then
// have copied it. Inits that mention a lambda's name, or a value whose init did, may run them
const lateValues = (bindings: [symbol, any][]): symbol[] => {
    const isLambda = isLetrecLambda;
    const runsGroup = new Set<symbol>(bindings.filter(([, init]) => isLambda(init)).map(([name]) => name));
    const values = bindings.filter(([, init]) => !isLambda(init));
    // the first init with a closure that mentions each value
    const names = new Set(values.map(([name]) => name));
    const first = new Map<symbol, number>();
    const todo = new Worklist<boolean>();
    values.forEach(([, init], i) => {
        if (!Array.isArray(init)) return;
        todo.add(init, false);
        todo.run((x, inLambda) => {
            if (typeof x === "symbol") {
                if (inLambda && names.has(x) && !first.has(x)) first.set(x, i);
            } else if (Array.isArray(x)) todo.addAll(subExprs(x), inLambda || x[0] === CORE_LAMBDA);
        });
    });
    const late: symbol[] = [];
    let groupMayHaveRun = false;
    values.forEach(([name, init], i) => {
        if (mentions(init, runsGroup)) {
            groupMayHaveRun = true;
            runsGroup.add(name);
        }
        if (groupMayHaveRun || (first.get(name) ?? Infinity) <= i) late.push(name);
    });
    return late;
};

// (%intcall spread x) of the table's spread intrinsic, x a variable
export const isSpreadOf = (e: any, intrinsics: Intrinsics): e is [symbol, any, symbol, symbol] =>
    intrinsics.spread !== undefined && Array.isArray(e) && e.length === 4 && e[0] === CORE_INTCALL && e[2] === Symbol.for(intrinsics.spread.name) && typeof e[3] === "symbol";

export class AstAnalysis {
    scopeMap = new WeakMap<object, AnalysisScope>();

    constructor(private readonly intrinsics: Intrinsics) {}

    // the scopes of `ast`: each variable's metadata, but for liveAcrossCall (see markLiveAcrossCalls)
    analyze(ast: any) {
        const baseScope = new AnalysisScope(null);
        if (Array.isArray(ast)) this.scopeMap.set(ast, baseScope);
        const todo = new Worklist<AnalysisScope>();
        todo.add(ast, baseScope);
        todo.run((e, scope) => this.visit(e, scope, todo));
        return baseScope;
    }

    // (what is inside `ast` is added to `todo`, and what is to be done between its parts with `then`, in order)
    private visit(ast: any, scope: AnalysisScope, todo: Worklist<AnalysisScope>) {
        // Symbols simulate a read into the value
        if (typeof ast === 'symbol') {
            scope.readVar(ast);
            return;
        }
        if (!Array.isArray(ast)) return;

        const op = ast[0];
        switch (op) {
            case CORE_QUOTE:
                return; // don't touch quoted
            // each clause is a function of its own
            case CORE_LAMBDA: {
                for (const c of clausesOf(ast)) {
                    todo.then(() => {
                        const lambdaScope = new AnalysisScope(scope);
                        for (const p of paramsOf(c)) lambdaScope.define(p);
                        const rest = restOf(c);
                        if (rest !== null) {
                            lambdaScope.define(rest);
                            lambdaScope.getVarinfo(rest)!.isRestParam = true;
                        }
                        this.scopeMap.set(c, lambdaScope);
                        todo.addAll(bodyOf(c), lambdaScope);
                    });
                }
                return;
            }
            case CORE_SET:
            case SET_BOX: {
                scope.markMutable(ast[2]);
                todo.add(ast[3], scope);
                return;
            }
            // (%let ((x init) ...) body ...): inits are evaluated outside, body inside a block scope
            case CORE_LET: {
                const letScope = new AnalysisScope(scope, false);
                for (const [name, init] of ast[2]) {
                    todo.add(init, scope);
                    todo.then(() => letScope.define(name));
                }
                this.scopeMap.set(ast, letScope);
                todo.addAll(ast.slice(3), letScope);
                return;
            }
            // (%let* ((name init) ...) body ...): each init sees the names before it. The bindings share a scope
            // (recorded under each clause), and a new one starts only for a name already visible, so a name bound twice is
            // two variables while a long %let* of distinct names does not make lookups walk a scope per binding
            case CORE_LET_STAR: {
                let inner = new AnalysisScope(scope, false);
                for (const clause of ast[2]) {
                    todo.then(() => todo.add(clause[1], inner));
                    todo.then(() => {
                        if (inner.getVarinfo(clause[0]) !== null) inner = new AnalysisScope(inner, false);
                        inner.define(clause[0]);
                        this.scopeMap.set(clause, inner);
                    });
                }
                todo.then(() => {
                    this.scopeMap.set(ast, inner);
                    todo.addAll(ast.slice(3), inner);
                });
                return;
            }
            // (%letrec ((name init) ...) body ...): like %let, but the names are visible in the inits
            case CORE_LETREC: {
                const letScope = new AnalysisScope(scope, false);
                const bindings: [symbol, any][] = ast[2];
                for (const [name] of bindings) letScope.define(name);
                for (const [, init] of bindings) todo.add(init, letScope);
                this.scopeMap.set(ast, letScope);
                todo.addAll(ast.slice(3), letScope);
                todo.then(() => { for (const name of lateValues(bindings)) letScope.getVarinfo(name)!.mutable = true; });
                return;
            }
            // (%let-values ((formals expr) ...) body ...): like %let, binding every variable in each formals
            case CORE_LET_VALUES:
            case CORE_LET_VALUES_STRICT: {
                const letScope = new AnalysisScope(scope, false);
                for (const [params, rest, init] of ast[2]) {
                    todo.add(init, scope);
                    todo.then(() => {
                        for (const p of params) letScope.define(p);
                        if (rest !== null) letScope.define(rest);
                    });
                }
                this.scopeMap.set(ast, letScope);
                todo.addAll(ast.slice(3), letScope);
                return;
            }
            // block names are labels, not variables
            case CORE_BLOCK:
            case CORE_ESCAPE:
                todo.addAll(ast.slice(3), scope);
                return;
            case OP_DEFINE_GLOBAL:
                todo.add(ast[3], scope);
                return;
            // (%apply proc arg ... (spread x)): x is only spread, so it may be a forwarded rest parameter
            case OP_APPLY:
            case CORE_INTAPPLY: {
                const from = op === OP_APPLY ? 2 : 3;
                const last = ast[ast.length - 1];
                todo.addAll(ast.slice(from, -1), scope);
                if (ast.length > 3 && isSpreadOf(last, this.intrinsics)) todo.then(() => scope.readApplyList(last[3]));
                else if (ast.length > 3) todo.add(last, scope);
                return;
            }
        }
        todo.addAll(ast.slice(op === CORE_INTCALL ? 3 : 2), scope);
    }
}

// sets liveAcrossCall on the variables of `ast` that are read after a call before being assigned again (see CallLiveness)
export const markLiveAcrossCalls = (ast: any, analysis: AstAnalysis, scope: AnalysisScope, intrinsics: Intrinsics): void => {
    run(new CallLiveness(analysis.scopeMap, intrinsics).expr(ast, scope, new Set(), new Map()));
};

type Live = Set<VariableMetadata>;

const union = (a: Live, b: Live): Live => {
    const out = new Set(a);
    for (const m of b) out.add(m);
    return out;
};

// Backward liveness of the variables that are assigned but not captured, marking those that are live
// after a call (see VariableMetadata.isBoxed). `expr` returns the variables live before `ast` given those live after
// it (`out`); `blocks` gives what is live after each %block an %escape can reach.
// Its correctness is argued in PROOFS.md (4.2), generated by Claude Opus 5.5 and not independently verified
class CallLiveness {
    // each %loop's last live set at its start. An inner loop is re-analysed on every pass of the loops around it, whose
    // live sets only grow, so starting from the previous result reaches the same fixed point in about one pass
    readonly #loopHeads = new Map<object, Live>();

    constructor(private readonly scopeMap: WeakMap<object, AnalysisScope>, private readonly intrinsics: Intrinsics) {}

    #candidate(scope: AnalysisScope, sym: symbol): VariableMetadata | null {
        const meta = scope.getVarinfo(sym);
        return meta !== null && meta.mutable && !meta.isCaptured ? meta : null;
    }

    *#seq(items: any[], scope: AnalysisScope, out: Live, blocks: Map<symbol, Live>): Task<Live> {
        let live = out;
        for (let i = items.length - 1; i >= 0; i--) live = yield this.expr(items[i], scope, live, blocks);
        return live;
    }

    // whether the form never calls back into the VM, where a continuation of the current frame could be captured
    #isLeaf(ast: any[]): boolean {
        const op = ast[0];
        if (op === CORE_INTCALL || op === CORE_INTAPPLY) return this.intrinsics.get(ast[2])?.leaf ?? false;
        return CORE_FORMS.get(op)?.leaf ?? false;
    }

    // the variables bound by a %let / %let-values, as they are known in its own scope
    #bound(letScope: AnalysisScope, syms: symbol[]): VariableMetadata[] {
        return syms.map(sym => letScope.getVarinfo(sym)).filter((m): m is VariableMetadata => m !== null);
    }

    // (a walk: see visitor.ts)
    expr(ast: any, scope: AnalysisScope, out: Live, blocks: Map<symbol, Live>): Live | Task<Live> {
        if (typeof ast === "symbol") {
            const meta = this.#candidate(scope, ast);
            return meta === null || out.has(meta) ? out : union(out, new Set([meta]));
        }
        if (!Array.isArray(ast)) return out;
        const op = ast[0];
        if (op === CORE_QUOTE) return out;
        // a call whose operands are variables and constants: nothing inside it to walk
        if (op === CORE_CALL || op === CORE_INTCALL) {
            const from = op === CORE_INTCALL ? 3 : 2;
            let atoms = true;
            for (let i = from; i < ast.length && atoms; i++) atoms = !Array.isArray(ast[i]);
            if (atoms) {
                if (!this.#isLeaf(ast)) for (const meta of out) meta.liveAcrossCall = true;
                let live = out;
                for (let i = ast.length - 1; i >= from; i--) live = this.expr(ast[i], scope, live, blocks) as Live;
                return live;
            }
        }
        return start(this.#form(ast, scope, out, blocks));
    }

    *#form(ast: any[], scope: AnalysisScope, out: Live, blocks: Map<symbol, Live>): Task<Live> {
        const op = ast[0];
        switch (op) {
            case CORE_QUOTE:
                return out;
            case CORE_LAMBDA: {
                // separate functions: their own locals, and no escapes into ours
                for (const c of clausesOf(ast)) {
                    const lambdaScope = this.scopeMap.get(c);
                    if (lambdaScope !== undefined) (yield this.#seq(bodyOf(c), lambdaScope, new Set(), new Map()));
                }
                return out;
            }
            // (%if c1 e1 c2 e2 ... [else]): each ci runs after the ones before it, then its branch or the rest of the chain
            case CORE_IF: {
                const args = ast.slice(2);
                let live = args.length % 2 === 1 ? (yield this.expr(args[args.length - 1], scope, out, blocks)) : out;
                for (let i = args.length - (args.length % 2 === 1 ? 3 : 2); i >= 0; i -= 2) {
                    live = (yield this.expr(args[i], scope, union((yield this.expr(args[i + 1], scope, out, blocks)), live), blocks));
                }
                return live;
            }
            case CORE_BEGIN:
                return (yield this.#seq(ast.slice(2), scope, out, blocks));
            case CORE_SET:
            case SET_BOX: {
                const meta = this.#candidate(scope, ast[2]);
                let after = out;
                if (meta !== null && out.has(meta)) {
                    after = new Set(out);
                    after.delete(meta);
                }
                return (yield this.expr(ast[3], scope, after, blocks));
            }
            case OP_DEFINE_GLOBAL:
                return (yield this.expr(ast[3], scope, out, blocks));
            case CORE_LET_STAR: {
                const clauses: [symbol, any][] = ast[2];
                let live: Live = new Set<VariableMetadata>((yield this.#seq(ast.slice(3), this.scopeMap.get(ast)!, out, blocks)));
                for (let i = clauses.length - 1; i >= 0; i--) {
                    for (const meta of this.#bound(this.scopeMap.get(clauses[i])!, [clauses[i][0]])) live.delete(meta);
                    live = (yield this.expr(clauses[i][1], i === 0 ? scope : this.scopeMap.get(clauses[i - 1])!, live, blocks));
                }
                return live;
            }
            // the lambdas are made first, which runs nothing, and their names are set; then each other init runs, in order,
            // and its name is set after it
            case CORE_LETREC: {
                const letScope = this.scopeMap.get(ast)!;
                const clauses: [symbol, any][] = ast[2];
                let live: Live = new Set<VariableMetadata>((yield this.#seq(ast.slice(3), letScope, out, blocks)));
                for (let i = clauses.length - 1; i >= 0; i--) {
                    if (isLetrecLambda(clauses[i][1])) continue;
                    for (const meta of this.#bound(letScope, [clauses[i][0]])) live.delete(meta);
                    live = (yield this.expr(unwrapBoxed(clauses[i][1]), letScope, live, blocks));
                }
                for (const meta of this.#bound(letScope, clauses.map(c => c[0]))) live.delete(meta);
                return live;
            }
            case CORE_LET:
            case CORE_LET_VALUES:
            case CORE_LET_VALUES_STRICT: {
                const letScope = this.scopeMap.get(ast)!;
                const clauses: any[][] = ast[2];
                // %let clauses are [name, init]; %let-values ones [params, rest, init]
                const syms: symbol[] = op === CORE_LET ? clauses.map(c => c[0]) : clauses.flatMap(c => c[1] === null ? c[0] : [...c[0], c[1]]);
                const init = (c: any[]) => op === CORE_LET ? c[1] : c[2];
                let live: Live = new Set<VariableMetadata>((yield this.#seq(ast.slice(3), letScope, out, blocks)));
                for (const meta of this.#bound(letScope, syms)) live.delete(meta);
                for (let i = clauses.length - 1; i >= 0; i--) live = (yield this.expr(init(clauses[i]), scope, live, blocks));
                return live;
            }
            case CORE_BLOCK:
                return (yield this.#seq(ast.slice(3), scope, out, new Map(blocks).set(ast[2], out)));
            case CORE_ESCAPE: {
                const target = blocks.get(ast[2]) ?? new Set<VariableMetadata>();
                return ast.length < 4 ? target : (yield this.expr(ast[3], scope, target, blocks));
            }
            // key and value, then the body (in the mark's tail position); none of it is a call
            case CORE_WITH_MARK: {
                const [, , key, value, body] = ast;
                return (yield this.expr(key, scope, (yield this.expr(value, scope, (yield this.expr(body, scope, out, blocks)), blocks)), blocks));
            }
            case OP_CURRENT_MARKS:
                return out;
            // (thunk) is called; only if it raised is the handler evaluated and called
            case CORE_CATCH: {
                const [, , thunk, handler, pre] = ast;
                const after = union(out, (yield this.expr(handler, scope, out, blocks)));
                for (const meta of after) meta.liveAcrossCall = true;
                return (yield this.expr(thunk, scope, pre === undefined ? after : (yield this.expr(pre, scope, after, blocks)), blocks));
            }
            case CORE_LOOP: {
                // the end of the body flows back to its start: iterate until the live set at the start is stable
                let head: Live = this.#loopHeads.get(ast) ?? new Set();
                for (;;) {
                    const next = (yield this.#seq(ast.slice(2), scope, head, blocks));
                    if ([...next].every(m => head.has(m))) break;
                    head = union(head, next);
                }
                this.#loopHeads.set(ast, head);
                return head;
            }
        }

        // a call (or intrinsic): operands are evaluated first, then the call runs; anything live after a call that is not a
        // leaf could be read after re-entering a continuation captured during it
        if (!this.#isLeaf(ast)) {
            for (const meta of out) meta.liveAcrossCall = true;
        }
        const operands = ast.slice(op === CORE_INTCALL || op === CORE_INTAPPLY ? 3 : 2);
        let live = out;
        for (let i = operands.length - 1; i >= 0; i--) live = (yield this.expr(operands[i], scope, live, blocks));
        return live;
    }
}
