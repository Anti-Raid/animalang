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
} from "../common";
import { AnalysisScope, VariableMetadata } from "./scope";
import { subExprs as subExprsOf } from "./passes/lang";
import { Lconv, SET_BOX } from "./passes/assignments";

const OP_APPLY = Symbol.for("%apply");
import { CORE_FORMS } from "./core";
import { bodyOf, clausesOf, isLetrecLambda, paramsOf, restOf, unwrapBoxed } from "./lambda";
import type { Intrinsics } from "./intrinsics";

// Analyzes the core forms (arrays, see compiler.ts) to handle scoping prior to actual compilation. This lets us avoid
// boxing of primitives

const subExprs = (e: any[]): any[] => subExprsOf(Lconv, e);

const mentions = (e: any, names: ReadonlySet<symbol>): boolean =>
    typeof e === "symbol" ? names.has(e) : Array.isArray(e) && subExprs(e).some(x => mentions(x, names));

// whether e makes a closure that mentions one of names
const lambdaMentions = (e: any, names: ReadonlySet<symbol>): boolean =>
    Array.isArray(e) && (e[0] === CORE_LAMBDA ? mentions(e, names) : subExprs(e).some(x => lambdaMentions(x, names)));

// The %letrec names that are not lambdas but may be copied into a closure before their init has run, so they must be
// treated as assigned (a box when captured) rather than filled into closures once known: a closure made by an earlier
// (or its own) init mentions it, or earlier inits may have run the %letrec's lambdas, whose nested closures could then
// have copied it. Inits that mention a lambda's name, or a value whose init did, may run them
const lateValues = (bindings: [symbol, any][]): symbol[] => {
    const isLambda = isLetrecLambda;
    const runsGroup = new Set<symbol>(bindings.filter(([, init]) => isLambda(init)).map(([name]) => name));
    const values = bindings.filter(([, init]) => !isLambda(init));
    const late: symbol[] = [];
    let groupMayHaveRun = false;
    values.forEach(([name, init], i) => {
        if (mentions(init, runsGroup)) {
            groupMayHaveRun = true;
            runsGroup.add(name);
        }
        const self = new Set([name]);
        if (groupMayHaveRun || values.slice(0, i + 1).some(([, v]) => lambdaMentions(v, self))) late.push(name);
    });
    return late;
};

// (spread x) of the table's spread intrinsic, x a variable
export const isSpreadOf = (e: any, intrinsics: Intrinsics): e is [symbol, symbol] =>
    intrinsics.spread !== undefined && Array.isArray(e) && e.length === 2 && e[0] === Symbol.for(intrinsics.spread.name) && typeof e[1] === "symbol";

export class AstAnalysis {
    scopeMap = new WeakMap<object, AnalysisScope>();

    constructor(private readonly intrinsics: Intrinsics) {}

    // the scopes of `ast`: each variable's metadata, but for liveAcrossCall (see markLiveAcrossCalls)
    analyze(ast: any) {
        const baseScope = new AnalysisScope(null);
        if (Array.isArray(ast)) this.scopeMap.set(ast, baseScope);
        this.visit(ast, baseScope);
        return baseScope;
    }

    private visit(ast: any, scope: AnalysisScope) {       
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
                    const lambdaScope = new AnalysisScope(scope);
                    for (const p of paramsOf(c)) lambdaScope.define(p);
                    const rest = restOf(c);
                    if (rest !== null) {
                        lambdaScope.define(rest);
                        lambdaScope.getVarinfo(rest)!.isRestParam = true;
                    }
                    this.scopeMap.set(c, lambdaScope);
                    for (const e of bodyOf(c)) this.visit(e, lambdaScope);
                }
                return;
            }
            case CORE_SET:
            case SET_BOX: {
                scope.markMutable(ast[1]);
                this.visit(ast[2], scope);
                return;
            }
            // (%let ((x init) ...) body ...): inits are evaluated outside, body inside a block scope
            case CORE_LET: {
                const letScope = new AnalysisScope(scope, false);
                for (const [name, init] of ast[1]) {
                    this.visit(init, scope);
                    letScope.define(name);
                }
                this.scopeMap.set(ast, letScope);
                for (const e of ast.slice(2)) this.visit(e, letScope);
                return;
            }
            // (%let* ((name init) ...) body ...): each init sees the names before it. The bindings share a scope
            // (recorded under each clause), and a new one starts only for a name already visible, so a name bound twice is
            // two variables while a long %let* of distinct names does not make lookups walk a scope per binding
            case CORE_LET_STAR: {
                let inner = new AnalysisScope(scope, false);
                for (const clause of ast[1]) {
                    this.visit(clause[1], inner);
                    if (inner.getVarinfo(clause[0]) !== null) inner = new AnalysisScope(inner, false);
                    inner.define(clause[0]);
                    this.scopeMap.set(clause, inner);
                }
                this.scopeMap.set(ast, inner);
                for (const e of ast.slice(2)) this.visit(e, inner);
                return;
            }
            // (%letrec ((name init) ...) body ...): like %let, but the names are visible in the inits
            case CORE_LETREC: {
                const letScope = new AnalysisScope(scope, false);
                const bindings: [symbol, any][] = ast[1];
                for (const [name] of bindings) letScope.define(name);
                for (const [, init] of bindings) this.visit(init, letScope);
                this.scopeMap.set(ast, letScope);
                for (const e of ast.slice(2)) this.visit(e, letScope);
                for (const name of lateValues(bindings)) letScope.getVarinfo(name)!.mutable = true;
                return;
            }
            // (%let-values ((formals expr) ...) body ...): like %let, binding every variable in each formals
            case CORE_LET_VALUES:
            case CORE_LET_VALUES_STRICT: {
                const letScope = new AnalysisScope(scope, false);
                for (const [params, rest, init] of ast[1]) {
                    this.visit(init, scope);
                    for (const p of params) letScope.define(p);
                    if (rest !== null) letScope.define(rest);
                }
                this.scopeMap.set(ast, letScope);
                for (const e of ast.slice(2)) this.visit(e, letScope);
                return;
            }
            // block names are labels, not variables
            case CORE_BLOCK:
            case CORE_ESCAPE:
                for (const e of ast.slice(2)) this.visit(e, scope);
                return;
            case OP_DEFINE_GLOBAL:
                this.visit(ast[2], scope);
                return;
            // (%apply proc arg ... (spread x)): x is only spread, so it may be a forwarded rest parameter
            case OP_APPLY: {
                const last = ast[ast.length - 1];
                for (const e of ast.slice(1, -1)) this.visit(e, scope);
                if (ast.length > 2 && isSpreadOf(last, this.intrinsics)) scope.readApplyList(last[1]);
                else if (ast.length > 2) this.visit(last, scope);
                return;
            }
        }
        for (const e of ast) this.visit(e, scope);
    }
}

// sets liveAcrossCall on the variables of `ast` that are read after a call before being assigned again (see CallLiveness)
export const markLiveAcrossCalls = (ast: any, analysis: AstAnalysis, scope: AnalysisScope, intrinsics: Intrinsics): void => {
    new CallLiveness(analysis.scopeMap, intrinsics).expr(ast, scope, new Set(), new Map());
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

    #seq(items: any[], scope: AnalysisScope, out: Live, blocks: Map<symbol, Live>): Live {
        let live = out;
        for (let i = items.length - 1; i >= 0; i--) live = this.expr(items[i], scope, live, blocks);
        return live;
    }

    // whether calling this operator never calls back into the VM, where a continuation of the current frame could be captured
    #isLeaf(op: any): boolean {
        if (typeof op !== "symbol") return false;
        return (CORE_FORMS.get(op) ?? this.intrinsics.get(op))?.leaf ?? false;
    }

    // intrinsics' operands are expressions, but the operator is not evaluated
    #isIntrinsic(op: any): boolean {
        return typeof op === "symbol" && (CORE_FORMS.has(op) || this.intrinsics.get(op) !== undefined);
    }

    // the variables bound by a %let / %let-values, as they are known in its own scope
    #bound(letScope: AnalysisScope, syms: symbol[]): VariableMetadata[] {
        return syms.map(sym => letScope.getVarinfo(sym)).filter((m): m is VariableMetadata => m !== null);
    }

    expr(ast: any, scope: AnalysisScope, out: Live, blocks: Map<symbol, Live>): Live {
        if (typeof ast === "symbol") {
            const meta = this.#candidate(scope, ast);
            return meta === null || out.has(meta) ? out : union(out, new Set([meta]));
        }
        if (!Array.isArray(ast)) return out;

        const op = ast[0];
        switch (op) {
            case CORE_QUOTE:
                return out;
            case CORE_LAMBDA: {
                // separate functions: their own locals, and no escapes into ours
                for (const c of clausesOf(ast)) {
                    const lambdaScope = this.scopeMap.get(c);
                    if (lambdaScope !== undefined) this.#seq(bodyOf(c), lambdaScope, new Set(), new Map());
                }
                return out;
            }
            // (%if c1 e1 c2 e2 ... [else]): each ci runs after the ones before it, then its branch or the rest of the chain
            case CORE_IF: {
                const args = ast.slice(1);
                let live = args.length % 2 === 1 ? this.expr(args[args.length - 1], scope, out, blocks) : out;
                for (let i = args.length - (args.length % 2 === 1 ? 3 : 2); i >= 0; i -= 2) {
                    live = this.expr(args[i], scope, union(this.expr(args[i + 1], scope, out, blocks), live), blocks);
                }
                return live;
            }
            case CORE_BEGIN:
                return this.#seq(ast.slice(1), scope, out, blocks);
            case CORE_SET:
            case SET_BOX: {
                const meta = this.#candidate(scope, ast[1]);
                let after = out;
                if (meta !== null && out.has(meta)) {
                    after = new Set(out);
                    after.delete(meta);
                }
                return this.expr(ast[2], scope, after, blocks);
            }
            case OP_DEFINE_GLOBAL:
                return this.expr(ast[2], scope, out, blocks);
            case CORE_LET_STAR: {
                const clauses: [symbol, any][] = ast[1];
                let live = new Set(this.#seq(ast.slice(2), this.scopeMap.get(ast)!, out, blocks));
                for (let i = clauses.length - 1; i >= 0; i--) {
                    for (const meta of this.#bound(this.scopeMap.get(clauses[i])!, [clauses[i][0]])) live.delete(meta);
                    live = this.expr(clauses[i][1], i === 0 ? scope : this.scopeMap.get(clauses[i - 1])!, live, blocks);
                }
                return live;
            }
            // the lambdas are made first, which runs nothing, and their names are set; then each other init runs, in order,
            // and its name is set after it
            case CORE_LETREC: {
                const letScope = this.scopeMap.get(ast)!;
                const clauses: [symbol, any][] = ast[1];
                let live = new Set(this.#seq(ast.slice(2), letScope, out, blocks));
                for (let i = clauses.length - 1; i >= 0; i--) {
                    if (isLetrecLambda(clauses[i][1])) continue;
                    for (const meta of this.#bound(letScope, [clauses[i][0]])) live.delete(meta);
                    live = this.expr(unwrapBoxed(clauses[i][1]), letScope, live, blocks);
                }
                for (const meta of this.#bound(letScope, clauses.map(c => c[0]))) live.delete(meta);
                return live;
            }
            case CORE_LET:
            case CORE_LET_VALUES:
            case CORE_LET_VALUES_STRICT: {
                const letScope = this.scopeMap.get(ast)!;
                const clauses: any[][] = ast[1];
                // %let clauses are [name, init]; %let-values ones [params, rest, init]
                const syms: symbol[] = op === CORE_LET ? clauses.map(c => c[0]) : clauses.flatMap(c => c[1] === null ? c[0] : [...c[0], c[1]]);
                const init = (c: any[]) => op === CORE_LET ? c[1] : c[2];
                let live = new Set(this.#seq(ast.slice(2), letScope, out, blocks));
                for (const meta of this.#bound(letScope, syms)) live.delete(meta);
                for (let i = clauses.length - 1; i >= 0; i--) live = this.expr(init(clauses[i]), scope, live, blocks);
                return live;
            }
            case CORE_BLOCK:
                return this.#seq(ast.slice(2), scope, out, new Map(blocks).set(ast[1], out));
            case CORE_ESCAPE: {
                const target = blocks.get(ast[1]) ?? new Set<VariableMetadata>();
                return ast.length < 3 ? target : this.expr(ast[2], scope, target, blocks);
            }
            // key and value, then the body (in the mark's tail position); none of it is a call
            case CORE_WITH_MARK: {
                const [, key, value, body] = ast;
                return this.expr(key, scope, this.expr(value, scope, this.expr(body, scope, out, blocks), blocks), blocks);
            }
            case OP_CURRENT_MARKS:
                return out;
            // (thunk) is called; only if it raised is the handler evaluated and called
            case CORE_CATCH: {
                const [, thunk, handler, pre] = ast;
                const after = union(out, this.expr(handler, scope, out, blocks));
                for (const meta of after) meta.liveAcrossCall = true;
                return this.expr(thunk, scope, pre === undefined ? after : this.expr(pre, scope, after, blocks), blocks);
            }
            case CORE_LOOP: {
                // the end of the body flows back to its start: iterate until the live set at the start is stable
                let head: Live = this.#loopHeads.get(ast) ?? new Set();
                for (;;) {
                    const next = this.#seq(ast.slice(1), scope, head, blocks);
                    if ([...next].every(m => head.has(m))) break;
                    head = union(head, next);
                }
                this.#loopHeads.set(ast, head);
                return head;
            }
        }

        // a call (or intrinsic): operands are evaluated first, then the call runs; anything live after a call that is not a
        // leaf could be read after re-entering a continuation captured during it
        if (!this.#isLeaf(op)) {
            for (const meta of out) meta.liveAcrossCall = true;
        }
        const operands = this.#isIntrinsic(op) ? ast.slice(1) : ast;
        let live = out;
        for (let i = operands.length - 1; i >= 0; i--) live = this.expr(operands[i], scope, live, blocks);
        return live;
    }
}
