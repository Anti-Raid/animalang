import { AbstractCompiler, AbstractVM, AnimaMeta, Cons, Table, OP_QUOTE, OP_AT, SOURCE_POS } from "../common"
import { Bootstrapper } from "../std";

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
export class MacroEvaluator {
    readonly meta: AnimaMeta
    readonly #transformers: Map<symbol, Transform>
    readonly #bootstrapper: Bootstrapper

    scope: Table
    readonly expandcmp: AbstractCompiler
    readonly expandvm: AbstractVM;

    constructor(meta: AnimaMeta, maxSteps: number) {
        this.meta = meta
        this.expandcmp = meta.compiler()
        this.expandvm = meta.vm(maxSteps)
        this.#transformers = new Map<symbol, Transform>()
        this.#bootstrapper = new Bootstrapper()
        this.scope = new Table()
    }

    init() {
        const publicScope = this.#bootstrapper.setupPublicScope(this.meta, this.expandcmp, this.expandvm, this)
        this.scope = publicScope.chained()
    }

    registerTransform(onsym: symbol, transform: Transform) {
        this.#transformers.set(onsym, transform)
    }

    transform(ast: any): any {
        return this.#transform(this.#stripAt(ast), 0)
    }

    // (%at file line col expr) becomes expr with a source position attached, before any macro sees it
    #stripAt(ast: any): any {
        if (!(ast instanceof Cons) || ast.car === OP_QUOTE) return ast
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
        if (ast instanceof Cons) {
            const op = ast.car;
            if (op === OP_QUOTE) return ast; // cannot desugar a quote

            if (depth > MAX_TRANSFORM_DEPTH) {
                throw new Error(`Macro expansion limit exceeded while expanding macro ${String(op)}`);
            }

            // recursively expand the macro
            if (typeof op === "symbol" && this.#transformers.has(op)) {
                const transformer = this.#transformers.get(op)!;
                const transformed = transformer(this, ast.cdr, ast);
                const pos = SOURCE_POS.get(ast);
                if (pos !== undefined && transformed.expanded instanceof Cons && !SOURCE_POS.has(transformed.expanded)) {
                    SOURCE_POS.set(transformed.expanded, pos);
                }

                switch (transformed.state) {
                    case TransformState.Recurse:
                        return this.#transform(transformed.expanded, depth + 1);
                    case TransformState.DoChildren:
                        return this.#mapTransform(transformed.expanded, depth + 1);
                    case TransformState.ReturnImm:
                        return transformed.expanded;
                }
            }

            // go through children
            return this.#mapTransform(ast, depth + 1);
        }

        // if no transformations apply, just return the original ast
        return ast;
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