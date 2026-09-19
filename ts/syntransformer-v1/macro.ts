import { AbstractCompiler, AbstractVM, AnimaMeta, Cons, Globals, OP_QUOTE } from "../common"
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

    scope: Globals
    readonly expandcmp: AbstractCompiler
    readonly expandvm: AbstractVM;

    constructor(meta: AnimaMeta, maxSteps: number) {
        this.meta = meta
        this.expandcmp = meta.compiler()
        this.expandvm = meta.vm(maxSteps)
        this.#transformers = new Map<symbol, Transform>()
        this.#bootstrapper = new Bootstrapper()
        this.scope = Globals.newWith({})
    }

    init() {
        const publicScope = this.#bootstrapper.setupPublicScope(this.meta, this.expandcmp, this.expandvm, this)
        this.scope = publicScope.nestWith({})
    }

    registerTransform(onsym: symbol, transform: Transform) {
        this.#transformers.set(onsym, transform)
    }

    transform(ast: any): any {
        return this.#transform(ast, 0)
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
            return new Cons(this.#transform(list.car, depth), this.#mapTransform(list.cdr, depth));
        }
        return list;
    }
}