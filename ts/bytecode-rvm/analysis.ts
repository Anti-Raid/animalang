import {
  CORE_QUOTE,
  CORE_LAMBDA,
  CORE_SET,
  CORE_BLOCK,
  CORE_ESCAPE,
  CORE_LET,
  CORE_LET_VALUES,
  CORE_LET_VALUES_STRICT,
  CORE_IF,
  CORE_BEGIN,
  CORE_LOOP,
  CORE_WITH_MARK,
  CORE_CATCH,
  OP_CURRENT_MARKS,
  OP_CURRENT_STACK,
  OP_DEFINE_GLOBAL,
  unpackLambdaExprArgs,
  Cons,
} from "../common";
import { AnalysisScope, VariableMetadata } from "./scope";
import { CORE_FORMS, CORE_OPS } from "./core";
import type { Intrinsics } from "./intrinsics";

// Analyzes a fully transformed AST to handle scoping prior to actual compilation. This lets us avoid boxing of primitives
export class AstAnalysis {
    scopeMap = new WeakMap<object, AnalysisScope>();

    constructor(private readonly intrinsics: Intrinsics) {}

    analyze(ast: any) {
        const baseScope = new AnalysisScope(null);
        if (ast instanceof Cons) this.scopeMap.set(ast, baseScope);
        this.visit(ast, baseScope);
        new CallLiveness(this.scopeMap, this.intrinsics).expr(ast, baseScope, new Set(), new Map());
        return baseScope;
    }

    private visit(ast: any, scope: AnalysisScope) {       
        // Symbols simulate a read into the value
        if (typeof ast === 'symbol') {
            scope.readVar(ast); 
            return;
        }
        
        // Base cases: primitives, strings, symbols, or null
        if (ast === null || typeof ast !== "object") {
            return;
        }

        if (!(ast instanceof Cons)) return;

        const op = ast.car;
        switch (op) {
            case CORE_QUOTE:
                return; // don't touch quoted
            case CORE_LAMBDA: {
                const body = ast.cdr.cdr;
                
                const lambdaScope = new AnalysisScope(scope);
                
                const extractedParams = unpackLambdaExprArgs(ast);
                for (const p of extractedParams.params) {
                    lambdaScope.define(p); 
                }
                if (extractedParams.remParams) {
                    lambdaScope.define(extractedParams.remParams); 
                }

                this.scopeMap.set(ast, lambdaScope);

                // Visit children (yes scope change)
                let curr: any = body;
                while (curr instanceof Cons) {
                    this.visit(curr.car, lambdaScope);
                    curr = curr.cdr;
                }
                if (curr !== null) {
                    this.visit(curr, lambdaScope);
                }
                return;
            }
            case CORE_SET: {
                const sym = ast.cdr.car;
                const value = ast.cdr.cdr.car;
                
                scope.markMutable(sym);
                this.visit(value, scope);
                return;
            }
            // (%let ((x init) ...) body ...): inits are evaluated outside, body inside a block scope
            case CORE_LET: {
                const letScope = new AnalysisScope(scope, false);
                let binding: any = ast.cdr.car;
                while (binding instanceof Cons) {
                    this.visit(binding.car.cdr.car, scope);
                    letScope.define(binding.car.car);
                    binding = binding.cdr;
                }
                this.scopeMap.set(ast, letScope);
                let curr: any = ast.cdr.cdr;
                while (curr instanceof Cons) {
                    this.visit(curr.car, letScope);
                    curr = curr.cdr;
                }
                return;
            }
            // (%let-values ((formals expr) ...) body ...): like %let, binding every variable in each formals
            case CORE_LET_VALUES:
            case CORE_LET_VALUES_STRICT: {
                const letScope = new AnalysisScope(scope, false);
                let clause: any = ast.cdr.car;
                while (clause instanceof Cons) {
                    this.visit(clause.car.cdr.car, scope);
                    let formals: any = clause.car.car;
                    while (formals instanceof Cons) {
                        letScope.define(formals.car);
                        formals = formals.cdr;
                    }
                    if (typeof formals === "symbol") letScope.define(formals);
                    clause = clause.cdr;
                }
                this.scopeMap.set(ast, letScope);
                let curr: any = ast.cdr.cdr;
                while (curr instanceof Cons) {
                    this.visit(curr.car, letScope);
                    curr = curr.cdr;
                }
                return;
            }
            // block names are labels, not variables
            case CORE_BLOCK:
            case CORE_ESCAPE: {
                let curr: any = ast.cdr.cdr;
                while (curr instanceof Cons) {
                    this.visit(curr.car, scope);
                    curr = curr.cdr;
                }
                return;
            }
            case OP_DEFINE_GLOBAL: {
                const value = ast.cdr.cdr.car;
                this.visit(value, scope);
                return;
            }
        }
        // Visit children (no scope change)
        let curr: any = ast;
        while (curr instanceof Cons) {
            this.visit(curr.car, scope);
            curr = curr.cdr;
        }
        if (curr !== null) {
            this.visit(curr, scope);
        }
    }
}

type Live = Set<VariableMetadata>;

const union = (a: Live, b: Live): Live => {
    const out = new Set(a);
    for (const m of b) out.add(m);
    return out;
};

// Second pass: backward liveness of the variables that are assigned but not captured, marking those that are live
// after a call (see VariableMetadata.isBoxed). `expr` returns the variables live before `ast` given those live after
// it (`out`); `blocks` gives what is live after each %block an %escape can reach.
class CallLiveness {
    // each %loop's last live set at its start. An inner loop is re-analysed on every pass of the loops around it, whose
    // live sets only grow, so starting from the previous result reaches the same fixed point in about one pass
    readonly #loopHeads = new Map<object, Live>();

    constructor(private readonly scopeMap: WeakMap<object, AnalysisScope>, private readonly intrinsics: Intrinsics) {}

    #candidate(scope: AnalysisScope, sym: symbol): VariableMetadata | null {
        const meta = scope.getVarinfo(sym);
        return meta !== null && meta.mutable && !meta.isCaptured ? meta : null;
    }

    #seq(exprs: any, scope: AnalysisScope, out: Live, blocks: Map<symbol, Live>): Live {
        const items = exprs instanceof Cons ? exprs.toArray() : [];
        let live = out;
        for (let i = items.length - 1; i >= 0; i--) live = this.expr(items[i], scope, live, blocks);
        return live;
    }

    // whether calling this operator never calls back into the VM, where a continuation of the current frame could be captured
    #isLeaf(op: any, scope: AnalysisScope): boolean {
        if (typeof op !== "symbol") return false;
        return (CORE_FORMS.get(op) ?? CORE_OPS.get(op) ?? this.intrinsics.get(op))?.leaf ?? false;
    }

    // intrinsics' operands are expressions, but the operator is not evaluated
    #isIntrinsic(op: any): boolean {
        return typeof op === "symbol" && (CORE_FORMS.has(op) || CORE_OPS.has(op) || this.intrinsics.get(op) !== undefined);
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
        if (!(ast instanceof Cons)) return out;

        const op = ast.car;
        switch (op) {
            case CORE_QUOTE:
                return out;
            case CORE_LAMBDA: {
                // a separate function: its own locals, and no escapes into ours
                const lambdaScope = this.scopeMap.get(ast);
                if (lambdaScope !== undefined) this.#seq(ast.cdr.cdr, lambdaScope, new Set(), new Map());
                return out;
            }
            case CORE_IF: {
                const [cond, then, otherwise] = ast.cdr.toArray();
                return this.expr(cond, scope, union(this.expr(then, scope, out, blocks), this.expr(otherwise, scope, out, blocks)), blocks);
            }
            case CORE_BEGIN:
                return this.#seq(ast.cdr, scope, out, blocks);
            case CORE_SET: {
                const meta = this.#candidate(scope, ast.cdr.car);
                let after = out;
                if (meta !== null && out.has(meta)) {
                    after = new Set(out);
                    after.delete(meta);
                }
                return this.expr(ast.cdr.cdr.car, scope, after, blocks);
            }
            case OP_DEFINE_GLOBAL:
                return this.expr(ast.cdr.cdr.car, scope, out, blocks);
            case CORE_LET:
            case CORE_LET_VALUES:
            case CORE_LET_VALUES_STRICT: {
                const letScope = this.scopeMap.get(ast)!;
                const clauses: Cons[] = ast.cdr.car === null ? [] : ast.cdr.car.toArray();
                const syms: symbol[] = [];
                for (const clause of clauses) {
                    let formals: any = clause.car;
                    if (op === CORE_LET) formals = new Cons(formals, null);
                    while (formals instanceof Cons) {
                        syms.push(formals.car);
                        formals = formals.cdr;
                    }
                    if (typeof formals === "symbol") syms.push(formals);
                }
                let live = new Set(this.#seq(ast.cdr.cdr, letScope, out, blocks));
                for (const meta of this.#bound(letScope, syms)) live.delete(meta);
                for (let i = clauses.length - 1; i >= 0; i--) live = this.expr(clauses[i].cdr.car, scope, live, blocks);
                return live;
            }
            case CORE_BLOCK:
                return this.#seq(ast.cdr.cdr, scope, out, new Map(blocks).set(ast.cdr.car, out));
            case CORE_ESCAPE: {
                const target = blocks.get(ast.cdr.car) ?? new Set<VariableMetadata>();
                return ast.cdr.cdr === null ? target : this.expr(ast.cdr.cdr.car, scope, target, blocks);
            }
            // key and value, then the body (in the mark's tail position); none of it is a call
            case CORE_WITH_MARK: {
                const [key, value, body] = ast.cdr.toArray();
                return this.expr(key, scope, this.expr(value, scope, this.expr(body, scope, out, blocks), blocks), blocks);
            }
            case OP_CURRENT_MARKS:
            case OP_CURRENT_STACK:
                return out;
            // (thunk) is called; only if it raised is the handler evaluated and called
            case CORE_CATCH: {
                const [thunk, handler, pre] = ast.cdr.toArray();
                const after = union(out, this.expr(handler, scope, out, blocks));
                for (const meta of after) meta.liveAcrossCall = true;
                return this.expr(thunk, scope, pre === undefined ? after : this.expr(pre, scope, after, blocks), blocks);
            }
            case CORE_LOOP: {
                // the end of the body flows back to its start: iterate until the live set at the start is stable
                let head: Live = this.#loopHeads.get(ast) ?? new Set();
                for (;;) {
                    const next = this.#seq(ast.cdr, scope, head, blocks);
                    if ([...next].every(m => head.has(m))) break;
                    head = union(head, next);
                }
                this.#loopHeads.set(ast, head);
                return head;
            }
        }

        // a call (or intrinsic): operands are evaluated first, then the call runs; anything live after a call that is not a
        // leaf could be read after re-entering a continuation captured during it
        if (!this.#isLeaf(op, scope)) {
            for (const meta of out) meta.liveAcrossCall = true;
        }
        const operands = this.#isIntrinsic(op) ? (ast.cdr instanceof Cons ? ast.cdr.toArray() : []) : ast.toArray();
        let live = out;
        for (let i = operands.length - 1; i >= 0; i--) live = this.expr(operands[i], scope, live, blocks);
        return live;
    }
}
