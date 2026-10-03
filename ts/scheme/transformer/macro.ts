import { Env, CORE_QUOTE, OP_DEFINE_GLOBAL, SOURCE_POS } from "../../common"
import { Cons } from "../list"
import { Compiler } from "../../bytecode-rvm/compiler"
import { AnimaVM } from "../../bytecode-rvm/vm"
import type { AnimaOptions } from "../../bytecode-rvm/meta"
import { OP_QUOTE, OP_AT, OP_BEGIN, OP_DEFINE } from "../symbols"
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

const DEFINE_VALUES = Symbol.for("define-values")
const UNBOUND = Symbol.for("%unbound")

const MAX_TRANSFORM_DEPTH = 1000
// how deeply transformation may recurse on the js stack: below where the stack runs out (about 1200 for the deepest
// frames per level), so running out is always reported the same way, whatever the JIT has made of the frames
const MAX_NESTING = 1100
const TOO_DEEP = "program is nested too deeply to expand (or a macro keeps expanding into itself)"
export class MacroEvaluator {
    readonly #transformers: Map<symbol, Transform>

    scope: Env
    readonly expandcmp: Compiler
    readonly expandvm: AnimaVM;

    // macros run with the same intrinsics as the code they expand
    constructor(options: AnimaOptions, readonly intrinsics: Intrinsics) {
        this.expandcmp = new Compiler(intrinsics, options.debug, options.optimize)
        this.expandvm = new AnimaVM(intrinsics)
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

    // Builtins can be shadowed: a local binding of one is renamed where it is in scope (see syntax.ts), and a top-level
    // definition of one makes its name an ordinary global for this instance from then on (`redefined`). What the
    // transformer itself emits refers to builtins by their `@name` twins, which code cannot bind, so neither can capture it
    readonly #redefined = new Set<symbol>()

    #internal(sym: symbol): boolean {
        const c = sym.description?.charCodeAt(0)
        return (c === 37 || c === 64) && Symbol.keyFor(sym) !== undefined
    }

    // whether a local binding of `sym` must be renamed: it names a builtin, or has a transformer, and is not syntax
    shadows(sym: any): boolean {
        if (typeof sym !== "symbol" || this.#internal(sym)) return false
        const reserved = this.intrinsics.reserved.get(sym)
        return reserved === "builtin" || (reserved === undefined && this.#transformers.has(sym))
    }

    isRedefined(sym: symbol): boolean {
        return this.#redefined.has(sym)
    }

    // a top-level definition of `sym`: a builtin's name becomes an ordinary global. Whether it was one
    redefine(sym: any): boolean {
        if (typeof sym !== "symbol" || this.#internal(sym) || this.intrinsics.reserved.get(sym) !== "builtin") return false
        this.#redefined.add(sym)
        this.intrinsics.reserved.delete(sym)
        return true
    }

    // a whole program: its top-level definitions (in top-level begins too) apply to all of it, so builtins they redefine
    // are ordinary globals everywhere in it. As in a Racket module, such a name cannot be read before its definition has
    // run: the program first binds it to Env.UNDEFINED (only where it is redefined for the first time, so a later program
    // does not undo an earlier one's definition)
    transformProgram(ast: any): any {
        const fresh: symbol[] = []
        const scan = (e: any) => {
            if (!(e instanceof Cons)) return
            const redefine = (sym: any) => { if (this.redefine(sym)) fresh.push(sym) }
            if (e.car === OP_BEGIN) for (let p = e.cdr; p instanceof Cons; p = p.cdr) scan(p.car)
            else if (e.car === OP_DEFINE && e.cdr instanceof Cons) redefine(e.cdr.car instanceof Cons ? e.cdr.car.car : e.cdr.car)
            else if (e.car === DEFINE_VALUES && e.cdr instanceof Cons) {
                let f = e.cdr.car
                for (; f instanceof Cons; f = f.cdr) redefine(f.car)
                redefine(f)
            }
        }
        const stripped = this.#stripAt(ast)
        scan(stripped)
        if (fresh.length === 0) return this.transform(stripped)
        const declare = fresh.map(sym => Cons.list(OP_DEFINE_GLOBAL, sym, Cons.list(UNBOUND)))
        return this.transform(new Cons(OP_BEGIN, Cons.fromArray([...declare, stripped])))
    }

    // the transformer for an operator: none for a redefined builtin's name; a builtin's `@name` twin uses its builtin's
    #transformerOf(op: symbol): Transform | undefined {
        const own = this.#transformers.get(op)
        if (own !== undefined) return this.#redefined.has(op) ? undefined : own
        if (op.description?.charCodeAt(0) !== 64 || this.intrinsics.reserved.get(op) !== "builtin") return undefined
        const key = Symbol.keyFor(op)
        return key !== undefined ? this.#transformers.get(Symbol.for(key.slice(1))) : undefined
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
            const transformer = typeof op === "symbol" ? this.#transformerOf(op) : undefined;
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

    // transforms every element of a list (and an improper tail), one element at a time rather than one js frame each
    #mapTransform(list: any, depth: number): any {
        const cells: Cons[] = [];
        const items: any[] = [];
        let curr: any = list;
        while (curr instanceof Cons) {
            cells.push(curr);
            items.push(this.#transform(curr.car, depth));
            curr = curr.cdr;
        }
        let out: any = curr;
        for (let i = cells.length - 1; i >= 0; i--) {
            out = new Cons(items[i], out);
            const pos = SOURCE_POS.get(cells[i]);
            if (pos !== undefined) SOURCE_POS.set(out, pos);
        }
        return out;
    }
}