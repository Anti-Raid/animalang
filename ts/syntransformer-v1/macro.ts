import { AbstractCompiler, AbstractVM, AnimaMeta, DottedPair, OP_QUOTE } from "../common"

export enum TransformState {
    Recurse,
    DoChildren, // done, go to children
    ReturnImm, // done, return new thing *immediately*
}

export interface TransformResult {
    expanded: any,
    state: TransformState
}

export type Transform = (evaluator: MacroEvaluator, expr: any[], orig: any[]) => TransformResult;

const MAX_TRANSFORM_DEPTH = 1000
export class MacroEvaluator {
    readonly meta: AnimaMeta
    readonly #transformers: Map<symbol, Transform>

    readonly expandcmp: AbstractCompiler
    readonly expandvm: AbstractVM;

    constructor(meta: AnimaMeta, maxSteps: number) {
        this.meta = meta
        this.expandcmp = meta.compiler()
        this.expandvm = meta.vm(maxSteps)
        this.#transformers = new Map<symbol, Transform>()
    }

    registerTransform(onsym: symbol, transform: Transform) {
        this.#transformers.set(onsym, transform)
    }

    transform(ast: any): any {
        return this.#transform(ast, 0)
    }

    #transform(ast: any, depth: number): any {
        if (ast instanceof DottedPair) {
            if (depth > MAX_TRANSFORM_DEPTH) {
                throw new Error(`Macro expansion limit exceeded`);
            }

            ast.items = ast.items.map(i => this.#transform(i, depth+1));
            ast.rest = this.#transform(ast.rest, depth+1);
            return ast;
        }

        if (Array.isArray(ast) && ast.length > 0) {
            const op = ast[0];
            if (op === OP_QUOTE) return ast; // cannot desugar a quote

            if (depth > MAX_TRANSFORM_DEPTH) {
                throw new Error(`Macro expansion limit exceeded while expanding macro ${op}`);
            }

            // recursively expand the macro
            if (typeof op === "symbol" && this.#transformers.has(op)) {
                const transformer = this.#transformers.get(op)!

                const transformed = transformer(this, ast.slice(1), ast);

                switch (transformed.state) {
                    case TransformState.Recurse:
                        return this.#transform(transformed.expanded, depth+1);
                    case TransformState.DoChildren:
                        return transformed.expanded.map((i: any) => this.#transform(i, depth+1));
                    case TransformState.ReturnImm:
                        return transformed.expanded
                }
            }

            // go through children
            return ast.map((i: any) => this.#transform(i, depth+1));
        }

        // if no transformations apply, just return the original ast
        return ast
    }
}