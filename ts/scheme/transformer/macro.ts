import { AbstractCompiler, AbstractVM, AnimaMeta, Cons, Env, OP_QUOTE, CORE_QUOTE, OP_AT, SOURCE_POS } from "../../common"
import type { Intrinsics } from "../../bytecode-rvm/intrinsics";

export enum TransformState {
    Recurse, // check the new expr as if it was a new expr
    DoChildren, // done, go to children (ignoring outer)
    ReturnImm, // done, return new thing *immediately*
}

export interface TransformResult {
    expanded: any,
    state: TransformState
}

export type Transform = (evaluator: MacroEvaluator, expr: any, orig: any) => TransformResult;

const MAX_TRANSFORM_DEPTH = 1000
// how deeply transformation may recurse on the js stack: below where the stack runs out (about 1200 for the deepest
// frames per level), so running out is always reported the same way, whatever the JIT has made of the frames
const MAX_NESTING = 1100
const TOO_DEEP = "program is nested too deeply to expand (or a macro keeps expanding into itself)"
export class MacroEvaluator {
    readonly meta: AnimaMeta
    readonly #transformers: Map<symbol, Transform>

    scope: Env
    readonly expandcmp: AbstractCompiler
    readonly expandvm: AbstractVM;

    // macros run with the same intrinsics as the code they expand
    constructor(meta: AnimaMeta, maxSteps: number, readonly intrinsics: Intrinsics) {
        this.meta = meta
        this.expandcmp = meta.compiler(intrinsics)
        this.expandvm = meta.vm(maxSteps, intrinsics)
        this.#transformers = new Map<symbol, Transform>()
        this.scope = new Env()
    }

    // macros run in a scope chained to `publicScope` (the prelude's exports, set up with this evaluator's compiler and VM)
    init(publicScope: Env) {
        this.scope = publicScope.chained()
    }

    registerTransform(onsym: symbol, transform: Transform) {
        this.#transformers.set(onsym, transform)
    }

    // a rewrite for calls whose operator is not a transformer keyword; returns null to leave the call alone
    #applicationTransform: ((evaluator: MacroEvaluator, expr: Cons) => TransformResult | null) | null = null

    setApplicationTransform(transform: (evaluator: MacroEvaluator, expr: Cons) => TransformResult | null) {
        this.#applicationTransform = transform
    }

    // expansions on the path to the transformer currently running, or -1 outside one
    #depth = -1
    #nesting = 0

    transform(ast: any): any {
        // called from inside a transformer (e.g. for a lambda body): keep counting toward the expansion limit
        if (this.#depth >= 0) return this.#transform(ast, this.#depth)
        try {
            return this.#transform(this.#stripAt(ast), 0)
        } catch (e) {
            if (e instanceof RangeError && /call stack/i.test(e.message)) throw new Error(TOO_DEEP)
            throw e
        }
    }


    // (%at file line col expr) becomes expr with a source position attached, before any macro sees it
    #stripAt(ast: any): any {
        if (!(ast instanceof Cons) || ast.car === OP_QUOTE || ast.car === CORE_QUOTE) return ast
        if (ast.car === OP_AT) {
            const [file, line, col, expr] = ast.length === 5 ? ast.toArray().slice(1) : []
            if (typeof file !== "string" || typeof line !== "number" || typeof col !== "number") {
                throw new Error("%at must be in format (%at file line col expr)")
            }
            const inner = this.#stripAt(expr)
            if (inner instanceof Cons) SOURCE_POS.set(inner, { file, line, col })
            return inner
        }
        let changed = false
        const items: any[] = []
        let curr: any = ast
        while (curr instanceof Cons) {
            const item = this.#stripAt(curr.car)
            if (item !== curr.car) changed = true
            items.push(item)
            curr = curr.cdr
        }
        if (!changed) return ast
        let out: any = curr
        for (let i = items.length - 1; i >= 0; i--) out = new Cons(items[i], out)
        const pos = SOURCE_POS.get(ast)
        if (pos !== undefined) SOURCE_POS.set(out, pos)
        return out
    }

    #transform(ast: any, depth: number): any {
        try {
            if (++this.#nesting > MAX_NESTING) throw new Error(TOO_DEEP)
            return this.#transformNode(ast, depth)
        } finally {
            this.#nesting--
        }
    }

    #transformNode(ast: any, depth: number): any {
        if (ast instanceof Cons) {
            const op = ast.car;

            if (depth > MAX_TRANSFORM_DEPTH) {
                throw new Error(`Macro expansion limit exceeded while expanding macro ${String(op)}`);
            }

            // recursively expand the macro (transformers that transform subforms themselves continue from this depth)
            const transformer = typeof op === "symbol" ? this.#transformers.get(op) : undefined;
            if (transformer !== undefined || (typeof op !== "symbol" && this.#applicationTransform !== null)) {
                const outer = this.#depth;
                this.#depth = depth;
                let transformed: TransformResult | null;
                try {
                    transformed = transformer !== undefined ? transformer(this, ast.cdr, ast) : this.#applicationTransform!(this, ast);
                } finally {
                    this.#depth = outer;
                }
                if (transformed !== null) return this.#continue(ast, transformed, depth);
            }

            // go through children
            return this.#mapTransform(ast, depth);
        }

        // if no transformations apply, just return the original ast
        return ast;
    }

    #continue(ast: Cons, transformed: TransformResult, depth: number): any {
        const pos = SOURCE_POS.get(ast);
        if (pos !== undefined && transformed.expanded instanceof Cons && !SOURCE_POS.has(transformed.expanded)) {
            SOURCE_POS.set(transformed.expanded, pos);
        }
        // only expanding an expansion again counts toward the limit, so deep but finite nesting is fine
        switch (transformed.state) {
            case TransformState.Recurse:
                return this.#transform(transformed.expanded, depth + 1);
            case TransformState.DoChildren:
                return this.#mapTransform(transformed.expanded, depth);
            case TransformState.ReturnImm:
                return transformed.expanded;
        }
    }

    #mapTransform(list: any, depth: number): any {
        if (list instanceof Cons) {
            const out = new Cons(this.#transform(list.car, depth), this.#mapTransform(list.cdr, depth));
            const pos = SOURCE_POS.get(list);
            if (pos !== undefined) SOURCE_POS.set(out, pos);
            return out;
        }
        return list;
    }
}