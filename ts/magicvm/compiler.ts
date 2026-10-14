import { Msg, VMError, ensureCanBind, normalizeExpr, CORE_CALL, CORE_INTCALL, CORE_INTAPPLY, CORE_BEGIN, CORE_IF, CORE_LAMBDA, CORE_QUOTE, CORE_SET, CORE_BLOCK, CORE_ESCAPE, CORE_LOOP, CORE_LET, CORE_LET_VALUES, CORE_LET_VALUES_STRICT, CORE_LETREC, CORE_LET_STAR, CORE_WITH_MARK, OP_CURRENT_MARKS, CORE_CATCH, OP_DEFINE_GLOBAL, type SourcePos } from "../common";
import { AstAnalysis, isSpreadOf } from "./analysis";
import { AnalysisScope, CompilerScope } from "./scope";
import { IR, type Node, JumpLabel, ClosureTemplateIR } from "./ir";
import { UNPACK_REST, UNPACK_STRICT } from "./ops";
import { blockEscapes, liftLambdas, splitCaseLambdas } from "./passes/lift";
import { mergeLoops } from "./passes/merge"
import { flattenLets } from "./passes/flatten"
import { PAD, UNNAMED, bodyOf, clausesOf, isBoxedInit, isLetrecLambda, isPadded, optionsOf, paramsOf, restOf, unwrapBoxed } from "./lambda";
import { corePos, type Code } from "./exec";
import { runPass, type Pass, type PassContext } from "./passes/pass";
import { interruptsPass, type FunctionIR } from "./passes/interrupts";
import { renamePass } from "./passes/rename";
import { bindOncePass } from "./passes/once";
import { closureCaptures, type Captures } from "./passes/closures";
import { BOX, BOX_IN_PLACE, SET_BOX, UNBOX, convertAssignments, type Converted } from "./passes/assignments";
import { removeBoxes, type Unboxed } from "./passes/unbox";
import { INLINED, TAIL_INLINED } from "./passes/cp0";
import { optimize } from "./passes/cp0";
import { hasCore, isCoreForm, newIntrinsics } from "./core";
import { Intrinsics, type Intrinsic } from "./intrinsics";
import { VALUES_MAX } from "./values";
import { ascend, descend, run, start, type Task } from "./visitor";

// a body as one expression
const bodyExpr = (body: any[]): any => body.length === 0 ? null : body.length === 1 ? body[0] : [CORE_BEGIN, null, ...body]

const OP_APPLY = Symbol.for("%apply");
const IMPORT_GLOBALS = corePos("%import-globals"), IMPORT_SET = corePos("%import-set!"), IMPORT_REF = corePos("%import-ref"), IMPORT_OR = corePos("%import-or");
const IMPORT_REF_OP = Symbol.for("%import-ref"), IS_VOID = Symbol.for("%nothing?");

type Analyzed = { ast: any, analyzer: AstAnalysis, ascope: AnalysisScope }
type Closed = Unboxed & { captures: Captures }

// every assigned local a box (see passes/assignments.ts)
const assignmentsPass: Pass<Analyzed, Converted> = { name: "assignments", run: ({ ast, ascope }, ctx) => convertAssignments(ast, ascope.variables) }

// only the boxes that are needed (see passes/unbox.ts)
// the operations that make a continuation or leave through one
const NO_CONTINUATIONS: ReadonlySet<symbol> = new Set(["%call/cc", "%call/ec", "%call/comp", "%call-with-prompt", "%abort"].map(n => Symbol.for(n)))

const unboxPass: Pass<Converted, Unboxed> = { name: "unbox", run: ({ ast, boxes }, ctx) => removeBoxes(ast, boxes, ctx.intrinsics, ctx.reentrant) }

// what each lambda captures (see passes/closures.ts)
const closuresPass: Pass<Unboxed, Closed> = { name: "closures", run: (unboxed, ctx) => ({ ...unboxed, captures: closureCaptures(unboxed.ast, ctx.intrinsics) }) }

// the core forms to core forms (see passes/lift.ts)
const escapesPass: Pass<any, any> = { name: "block-escapes", run: ast => blockEscapes(ast) }
const caseLambdasPass: Pass<any, any> = { name: "split-case-lambdas", run: ast => splitCaseLambdas(ast) }
const liftPass: Pass<any, any> = { name: "lift-lambdas", run: ast => liftLambdas(ast) }
// long chains of nested %lets made one %let*, so that no pass goes as deep as a function has locals (see passes/flatten.ts)
const flattenPass: Pass<any, any> = { name: "flatten-lets", run: ast => flattenLets(ast) }
// procedures that call one another in tail position made one, whose calls of itself are loops (see passes/merge.ts)
const mergePass: Pass<any, any> = { name: "merge-loops", run: ast => mergeLoops(ast) }

// the variables of each scope: which are assigned, captured, rest parameters (see AstAnalysis)
const resolvePass: Pass<any, Analyzed> = {
    name: "resolve",
    run: (ast, ctx) => {
        const analyzer = new AstAnalysis(ctx.intrinsics)
        return { ast, analyzer, ascope: analyzer.analyze(ast) }
    },
}

const lowerPass: Pass<FunctionIR, Code> = { name: "lower", run: ({ nodes, numRegs, imports }, ctx) => new IR(ctx.intrinsics, ctx.debug, ctx.assumed, ctx.reentrant, imports).lower(nodes, numRegs) }

// the optimizer (see passes/cp0.ts)
const cp0Pass: Pass<Converted, Converted> = {
    name: "cp0",
    run: (converted, ctx) => {
        const { ast, assumed, boxes } = optimize(converted.ast, ctx.intrinsics)
        for (const pos of assumed) ctx.assumed.add(pos)
        return { ast, boxes: new Set([...converted.boxes, ...boxes]) }
    },
}

// a %block that %escape can jump to: where its value goes and how its code ends
interface BlockTarget {
    name: symbol
    end: JumpLabel
    destReg?: number
    isTail: boolean
    fnDepth: number
    // how many non-tail %with-mark regions enclose the block (escaping out of any more restores the marks first)
    markDepth: number
    parent: BlockTarget | undefined
}

interface CmpOpts {
    destReg?: number // where to store dest reg
    isTail: boolean // whether this is a tail-call or not (for tco)
    // the %call being compiled wants one value (see #compileNormalCall)
    one?: boolean
    // the %call being compiled has its values bound at once to this many names (see #compileLetValues)
    many?: number
    nodes: Node[]
    scope: CompilerScope,
    pos?: SourcePos // position of the enclosing form
    blocks?: BlockTarget // enclosing %blocks, innermost first
    fnDepth?: number // how many %lambdas deep we are; escapes cannot cross one
    markRegions?: number[] // for each enclosing non-tail %with-mark, where it saved the marks (outermost first)
    name?: string // name for a lambda compiled directly as this value

    // from the assignment conversion and closures passes
    forwards: ReadonlySet<symbol>,
    captures: Captures
}

// Compiles core forms, as arrays (see README.md): `[op, operand ...]`, symbols as variable references, anything else
// that is not an array as a literal
export class Compiler {
    // called with each pass's output (see PassContext)
    trace?: (pass: string, output: unknown) => void

    constructor(readonly intrinsics: Intrinsics = newIntrinsics(), private readonly debug: boolean = false, private readonly optimize: boolean = true, private readonly reentrant: boolean = true) {
        if (!hasCore(intrinsics)) throw new Error("the compiler's intrinsics must start with the core operations (see newIntrinsics)")
    }

    // `trExpr`: core forms, each [op, pos, operand ...] with where it comes from (see forms.ts)
    compile(trExpr: any, debug: boolean = this.debug, optimize: boolean = this.optimize): Code {
        const ctx: PassContext = { intrinsics: this.intrinsics, debug, optimize, reentrant: this.reentrant, assumed: new Set(), trace: this.trace }
        try {
            const renamed = runPass(renamePass, runPass(flattenPass, trExpr, ctx), ctx)
            const escaped = runPass(escapesPass, runPass(bindOncePass, renamed, ctx), ctx)
            const split = runPass(caseLambdasPass, escaped, ctx)
            const lifted = runPass(liftPass, ctx.optimize ? runPass(mergePass, split, ctx) : split, ctx)
            const converted = runPass(assignmentsPass, runPass(resolvePass, lifted, ctx), ctx)
            const unboxed = runPass(unboxPass, ctx.optimize ? runPass(cp0Pass, converted, ctx) : converted, ctx)
            const closed = runPass(closuresPass, unboxed, ctx)
            const ir = runPass(interruptsPass, runPass(this.#generatePass, closed, ctx), ctx)
            return runPass(lowerPass, ir, ctx)
        } catch (err) {
            if (err instanceof VMError) err.format(this.intrinsics.format)
            throw err
        }
    }

    // what the unit being compiled imports, by slot (%import-globals), once that is met
    #imports: (symbol | undefined)[] | null = null

    // the IR of a top-level expression, its variables analysed
    readonly #generatePass: Pass<Closed, FunctionIR> = {
        name: "generate",
        run: ({ ast, forwards, captures }) => {
            this.#imports = null
            const scope = new CompilerScope(null)
            const nodes: Node[] = []
            const retReg = scope.allocTemp()
            run(this.#compile(ast, { destReg: retReg, isTail: true, nodes, scope, forwards, captures }))
            if (!this.#nodesEndsInRet(nodes)) {
                nodes.push({ k: "Return", src: retReg })
            }
            return { nodes, numRegs: scope.numRegs, imports: this.#imports }
        },
    }

    // (a walk, as every method here that compiles what is inside a form: see visitor.ts)
    #compile(expr: any, opts: CmpOpts): void | Task<void> {
        // Raw values
        if (typeof expr === 'symbol') {
            const res = this.#getVar(expr, opts, opts.destReg)
            if (res) opts.nodes.push(...res)
            return
        } else if (expr === null) {
            if (opts.destReg === undefined) return 
            opts.nodes.push({ k: "LoadValue", constant: null, dst: opts.destReg })
            return
        } else if (!Array.isArray(expr)) { // a literal (string, number, boolean, undefined, etc.)
            if (opts.destReg === undefined) return  
            opts.nodes.push({ k: "LoadValue", constant: expr, dst: opts.destReg })
            return
        }
        if (expr.length === 0) throw new VMError(Msg.EmptyForm, [])

        // the form's own position, and its operands for the compile methods (which index them from 1)
        const pos = expr[1]
        const form = [expr[0], ...expr.slice(2)]
        // (as deep on the js stack as compiling may go: what is inside is left for a walk of its own)
        if (!descend()) return this.#compileLater(expr, opts)
        try {
            if (pos === null || pos === opts.pos) {
                const walk = this.#compileForm(form, opts)
                return walk === undefined ? undefined : start(walk)
            }
            opts.nodes.push({ k: "Pos", pos })
            let walk: void | Task<void>
            try {
                walk = this.#compileForm(form, { ...opts, pos })
                if (walk !== undefined) walk = start(walk)
            } catch (err) {
                if (err instanceof VMError) err.at ??= pos
                throw err
            }
            if (walk !== undefined) return this.#compileAt(walk, opts, pos)
            if (opts.pos !== undefined) opts.nodes.push({ k: "Pos", pos: opts.pos })
        } finally {
            ascend()
        }
    }

    *#compileLater(expr: any, opts: CmpOpts): Task<void> {
        const walk = this.#compile(expr, opts)
        if (walk !== undefined) yield walk
    }

    // the rest of a form with a position of its own, when compiling it is a walk
    *#compileAt(walk: Task<void>, opts: CmpOpts, pos: SourcePos): Task<void> {
        try {
            yield walk
        } catch (err) {
            if (err instanceof VMError) err.at ??= pos
            throw err
        }
        if (opts.pos !== undefined) opts.nodes.push({ k: "Pos", pos: opts.pos })
    }

    #compileForm(expr: any[], opts: CmpOpts): void | Task<void> {
        const name = opts.name
        if (name !== undefined) opts = { ...opts, name: undefined }
        const operator = expr[0];

        if (typeof operator === "symbol") {
            switch (operator) {
                case CORE_BEGIN:
                    return this.#compileBegin(expr, opts)
                case CORE_IF:
                    return this.#compileIfCall(expr, opts)
                case CORE_QUOTE:
                    return this.#compileQuote(expr, opts)
                case CORE_SET:
                    return this.#compileSet(expr, opts)
                case CORE_LAMBDA:
                    return this.#compileLambda(expr, opts, name)
                case CORE_LETREC:
                    return this.#compileLetrec(expr, opts)
                case CORE_LET_STAR:
                    return this.#compileLetStar(expr, opts)
                case CORE_LET:
                    return this.#compileLet(expr, opts)
                case CORE_LET_VALUES:
                case CORE_LET_VALUES_STRICT:
                    return this.#compileLetValues(expr, opts, operator === CORE_LET_VALUES_STRICT)
                case CORE_BLOCK:
                    return this.#compileBlock(expr, opts)
                case CORE_ESCAPE:
                    return this.#compileEscape(expr, opts)
                case CORE_LOOP:
                    return this.#compileLoop(expr, opts)
                case CORE_WITH_MARK:
                    return this.#compileWithMark(expr, opts)
                case OP_CURRENT_MARKS:
                    if (opts.destReg !== undefined) opts.nodes.push({ k: "CurMarks", dst: opts.destReg })
                    return
                case CORE_CATCH:
                    return this.#compileCatch(expr, opts)
                case OP_DEFINE_GLOBAL:
                    return this.#compileDefine(expr, opts)
                case BOX:
                    return this.#compileBox(expr, opts)
                case UNBOX:
                    return this.#compileUnbox(expr, opts)
                case BOX_IN_PLACE:
                    return this.#compileBoxInPlace(expr, opts)
                case SET_BOX:
                    return this.#compileSetBox(expr, opts)
                case INLINED:
                case TAIL_INLINED:
                    return this.#compileInlined(expr, opts, operator === TAIL_INLINED)
                case OP_APPLY:
                    return this.#compileApply(expr, opts)
                case CORE_INTAPPLY:
                    return this.#compileIntApply(expr, opts)
                case CORE_CALL:
                    if (expr.length < 2) throw new VMError(Msg.FormArgs, ["%call", "a procedure", 0])
                    return this.#compileNormalCall(expr.slice(1), opts)
                case CORE_INTCALL: {
                    // code that is not re-entrant has no continuations: asking for one raises
                    if (!this.reentrant && typeof expr[1] === "symbol" && NO_CONTINUATIONS.has(expr[1])) {
                        return this.#compileForm([CORE_INTCALL, Symbol.for("%no-continuations"), expr[1].description], opts)
                    }
                    const intrinsic = this.#intrinsicNamed("%intcall", expr)
                    const call = expr.slice(1)
                    // (%first-value (%call f arg ...) <#void>): a call that wants one value, which the callee gives
                    // itself when it is entered for one (see Code.wanted), with nothing to check after it
                    if (intrinsic.pos === corePos("%first-value") && call.length === 3 && call[2] === undefined && Array.isArray(call[1]) && call[1][0] === CORE_CALL && call[1].length >= 3) {
                        return this.#compile(call[1], { ...opts, isTail: false, one: true })
                    }
                    // a unit's imports (see coreops.ts)
                    if (intrinsic.pos === IMPORT_GLOBALS || intrinsic.pos === IMPORT_SET || intrinsic.pos === IMPORT_REF || intrinsic.pos === IMPORT_OR) {
                        return this.#compileImport(intrinsic.pos, call, opts)
                    }
                    if (intrinsic.leaf) {
                        return this.#compileRuntimeOp(call, opts, intrinsic.min, intrinsic.max, (start, nargs, dest) => {
                            this.#withDest(opts, dest, destReg => opts.nodes.push({ k: "IntCall", pos: intrinsic.pos, dst: destReg, start, nargs }))
                        })
                    }
                    return this.#compileRuntimeOp(call, opts, intrinsic.min, intrinsic.max, (start, nargs, dest) => {
                        // an intrinsic whose value is that of the call itself (see `tail`) is a call and then a return
                        opts.nodes.push({ k: "HostCall", pos: intrinsic.pos, start, nargs, tail: opts.isTail && intrinsic.tail, dst: dest })
                    })
                }
            }
        }
        throw new VMError(Msg.BareCall, [operator])
    }

    *#compileInlined(expr: any[], opts: CmpOpts, tail: boolean): Task<void> {
        opts.nodes.push({ k: "InlineEnter", name: expr[1].description, at: opts.pos ?? null, tail })
        { const t = this.#compileBody(expr.slice(2), opts); if (t !== undefined) yield t }
        opts.nodes.push({ k: "InlineExit" })
    }

    #bindingsOf(form: string, expr: any[]): [symbol, any][] {
        const bindings = expr[1]
        if (!Array.isArray(bindings) || !bindings.every(b => Array.isArray(b) && b.length === 2)) {
            throw new VMError(Msg.FormArgs, [form, "bindings of a name and an init each", expr.length - 1])
        }
        return bindings
    }

    #intrinsicNamed(form: string, expr: any[]): Intrinsic {
        const intrinsic = typeof expr[1] === "symbol" ? this.intrinsics.get(expr[1]) : undefined
        if (intrinsic === undefined) throw new VMError(Msg.UnknownIntrinsic, [form, expr[1]])
        return intrinsic
    }

    #compileBegin(expr: any[], opts: CmpOpts): void | Task<void> {
        return this.#compileBody(expr.slice(1), opts)
    }

    // expressions in order, the last one giving the value (<#void> if there are none)
    // (compiled here as far as it goes without a walk: from the first expression that is one, the rest is a walk too)
    #compileBody(body: any[], opts: CmpOpts): void | Task<void> {
        if (body.length === 0) {
            if (opts.destReg === undefined) return
            opts.nodes.push({ k: "LoadValue", constant: undefined, dst: opts.destReg })
            return
        }
        for (let i = 0; i < body.length; i++) {
            const walk = this.#compileBodyItem(body, i, opts)
            if (walk !== undefined) return this.#compileBodyFrom(body, opts, i + 1, walk)
        }
    }

    #compileBodyItem(body: any[], i: number, opts: CmpOpts): void | Task<void> {
        const isLastChild = i === body.length - 1;
        return this.#compile(body[i], { ...opts, destReg: isLastChild ? opts.destReg : undefined, isTail: isLastChild && opts.isTail });
    }

    *#compileBodyFrom(body: any[], opts: CmpOpts, next: number, walk: Task<void>): Task<void> {
        yield walk
        for (let i = next; i < body.length; i++) {
            const t = this.#compileBodyItem(body, i, opts)
            if (t !== undefined) yield t
        }
    }

    // compiles both if calls as well as code that is converted into if calls
    // (%if c1 e1 c2 e2 ... [else]): the first ei whose ci is true, else `else` (or <#void>). One chain whatever the number
    // of clauses: If c1 L1; e1; Else end; L1: <c2>; If (elseif) c2 L2; e2; Else end; L2: ...; else; EndIf; end:
    *#compileIfCall(expr: any[], opts: CmpOpts): Task<void> {
        const args = expr.slice(1)
        if (args.length < 2) {
            throw new VMError(Msg.IfArgs, [args.length])
        }
        const endLabel = new JumpLabel()
        for (let i = 0; i + 1 < args.length; i += 2) {
            const condReg = opts.scope.allocTemp()
            { const t = this.#compile(args[i], { ...opts, destReg: condReg, isTail: false }); if (t !== undefined) yield t }
            const nextLabel = new JumpLabel()
            opts.nodes.push({ k: "If", cond: condReg, else: nextLabel, elseif: i !== 0 })
            opts.scope.freeTemp(condReg)
            { const t = this.#compile(args[i + 1], opts); if (t !== undefined) yield t }
            opts.nodes.push({ k: "Else", end: endLabel })
            opts.nodes.push({ k: "Label", label: nextLabel })
        }
        { const t = this.#compile(args.length % 2 === 1 ? args[args.length - 1] : undefined, opts); if (t !== undefined) yield t }
        opts.nodes.push({ k: "EndIf" })
        opts.nodes.push({ k: "Label", label: endLabel })
    }

    #compileQuote(expr: any[], opts: CmpOpts) {
        if (expr.length !== 2) {
            throw new VMError(Msg.QuoteArgs, [expr.length - 1])
        }
        if (opts.destReg === undefined) return
        opts.nodes.push({ k: "LoadValue", constant: normalizeExpr(expr[1]), dst: opts.destReg })
    }

    // note that the syntax transformer alr handles defines inside a lambda so
    *#compileDefine(expr: any[], opts: CmpOpts): Task<void> {
        const [, sym, val] = expr;
        if (typeof sym !== "symbol") throw new Error("internal error: complex defines should be transformed by AnimaTransform prior to reaching here")
        this.#ensureNotIntrinsic(sym, "define")

        // We need to compile the second arg first and leave it on a temp reg
        const valReg = opts.scope.allocTemp();
        { const t = this.#compile(val, { ...opts, destReg: valReg, isTail: false, name: sym.description }); if (t !== undefined) yield t }
        opts.nodes.push({ k: "SetGlobal", src: valReg, sym })
        opts.scope.freeTemp(valReg)
        if (opts.destReg !== undefined) {
            opts.nodes.push({ k: "LoadValue", dst: opts.destReg, constant: undefined })
        }
    }

    *#compileSet(expr: any[], opts: CmpOpts): Task<void> {
        const [, sym, val] = expr;
        if (typeof sym !== "symbol") throw new VMError(Msg.SetTarget, [sym])
        this.#ensureNotIntrinsic(sym, "set!")

        // We need to compile the second arg first and leave it on a temp reg
        const valReg = opts.scope.allocTemp();
        { const t = this.#compile(val, { ...opts, destReg: valReg, isTail: false, name: sym.description }); if (t !== undefined) yield t }
        const res = this.#setVar(sym, opts, valReg)
        if(res) opts.nodes.push(...res)
        opts.scope.freeTemp(valReg)
        if (opts.destReg !== undefined) {
            opts.nodes.push({ k: "LoadValue", dst: opts.destReg, constant: undefined })
        }
    }

    // [%lambda, clause ...]: one clause is a closure; several are their closures, made in a block, then one procedure
    // that runs the first taking the call's count (%make-case-lambda)
    *#compileLambda(expr: any[], opts: CmpOpts, name?: string): Task<void> {
        const clauses = expr.slice(1)
        const wellFormed = (c: any) => Array.isArray(c) && Array.isArray(c[0]) && c[0].every((o: any) => typeof o === "symbol")
            && Array.isArray(c[1]) && (c[2] === null || typeof c[2] === "symbol")
        if (clauses.length === 0 || !clauses.every(wellFormed)) throw new VMError(Msg.LambdaForm, [])
        for (const c of clauses) for (const o of optionsOf(c)) if (o !== PAD && o !== UNNAMED) throw new VMError(Msg.LambdaOption, [o])
        if (clauses.some(c => optionsOf(c).includes(UNNAMED))) name = undefined
        // a padded clause takes any count, so none after it would ever run
        const padded = clauses.findIndex(isPadded)
        if (padded !== -1 && padded < clauses.length - 1) throw new VMError(Msg.UnreachableClause, [])
        if (clauses.length === 1) {
            yield this.#compileClause(clauses[0], opts, name)
            return
        }
        const startReg = opts.scope.regAlloc.allocBlock(clauses.length)
        for (let i = 0; i < clauses.length; i++) yield this.#compileClause(clauses[i], { ...opts, destReg: opts.destReg === undefined ? undefined : startReg + i, isTail: false }, name)
        this.#withDest(opts, opts.destReg, destReg => opts.nodes.push({ k: "IntCall", pos: corePos("%make-case-lambda"), dst: destReg, start: startReg, nargs: clauses.length }))
        opts.scope.regAlloc.freeBlock(startReg, clauses.length)
    }

    // [options, params, rest, body ...]: params an array of symbols, rest a symbol or null
    *#compileClause(clause: any[], opts: CmpOpts, name?: string): Task<void> {
        const lambdaScope = new CompilerScope(opts.scope, opts.captures.get(clause) ?? [])

        const params: symbol[] = paramsOf(clause)
        const remParams: symbol | null = restOf(clause)
        const seen = new Set<symbol>()
        for (const p of params) ensureCanBind(p, seen, "lambda")
        if (remParams !== null) ensureCanBind(remParams, seen, "lambda")
        for (const p of params) this.#ensureNotIntrinsic(p, "lambda")
        this.#ensureNotIntrinsic(remParams, "lambda")
        const lambdaNodes: Node[] = []
        if (opts.pos !== undefined) lambdaNodes.push({ k: "Pos", pos: opts.pos })

        for (const p of params) lambdaScope.addLocal(p)
        if (remParams !== null) lambdaScope.addLocal(remParams)

        // Once we've verified the syntax, we can then drop the entire lambda if its not actually needed
        if (opts.destReg === undefined) return

        // Compile lambda body
        const retReg = lambdaScope.allocTemp() // no need to free the temp reg as we return?
        lambdaNodes.push({ k: "FunctionEntry" })
        { const t = this.#compile(bodyExpr(bodyOf(clause)), {...opts, destReg: retReg, isTail: true, nodes: lambdaNodes, scope: lambdaScope, fnDepth: (opts.fnDepth ?? 0) + 1 }); if (t !== undefined) yield t }
        if (!this.#nodesEndsInRet(lambdaNodes)) {
            lambdaNodes.push({ k: "Return", src: retReg })
        }
        const displayName = name ?? (opts.pos !== undefined ? `lambda@${opts.pos.file}:${opts.pos.line}` : "lambda")
        const rest = remParams === null || opts.forwards.has(remParams) || this.intrinsics.pack === undefined ? "array" : "packed"
        const template = new ClosureTemplateIR(params, remParams, lambdaNodes, lambdaScope.numRegs, lambdaScope.upvars, displayName, rest, isPadded(clause));
        opts.nodes.push({ k: "NewClosure", template, dst: opts.destReg })
    }

    // (%let-values ((formals expr) ...) body ...): every expr is evaluated and spread into registers (Unpack), then
    // all the variables are bound in a block, as in %let
    // clauses are [params, rest, init]
    *#compileLetValues(expr: any[], opts: CmpOpts, strict: boolean): Task<void> {
        const clauses: [symbol[], symbol | null, any][] = expr[1]

        const bound: { sym: symbol, reg: number }[] = []
        const blocks: { start: number, size: number }[] = []
        for (const [names, rest, init] of clauses) {
            const valReg = opts.scope.allocTemp()
            // names bound to the values of a call, any missing <#void>: the call asks for that many (see Code.entry)
            const many = !strict && rest === null && names.length >= 2 && names.length <= VALUES_MAX && Array.isArray(init) && init[0] === CORE_CALL && init.length >= 3
            { const t = this.#compile(init, { ...opts, destReg: valReg, isTail: false, ...(many ? { many: names.length } : {}) }); if (t !== undefined) yield t }
            const size = names.length + (rest !== null ? 1 : 0)
            const start = opts.scope.regAlloc.allocBlock(size)
            opts.nodes.push({ k: "Unpack", src: valReg, start, count: names.length, flags: (rest !== null ? UNPACK_REST : 0) | (strict ? UNPACK_STRICT : 0), many })
            const pack = this.intrinsics.pack
            if (rest !== null && pack !== undefined) {
                const reg = start + names.length
                opts.nodes.push({ k: "IntApply", pos: pack.pos, dst: reg, start: reg, nargs: 1 })
            }
            opts.scope.freeTemp(valReg)
            names.forEach((sym, i) => bound.push({ sym, reg: start + i }))
            if (rest !== null) bound.push({ sym: rest, reg: start + names.length })
            blocks.push({ start, size })
        }

        opts.scope.enterBlock()
        const seen = new Set<symbol>()
        for (const { sym, reg } of bound) {
            ensureCanBind(sym, seen, "let-values")
            this.#ensureNotIntrinsic(sym, "let-values")
            const destReg = opts.scope.addLocal(sym)
            opts.nodes.push({ k: "Move", src: reg, dst: destReg })
        }
        { const t = this.#compileBody(expr.slice(2), opts); if (t !== undefined) yield t }
        opts.scope.exitBlock()
        for (const { start, size } of blocks) opts.scope.regAlloc.freeBlock(start, size)
    }

    // (%block name body ...): the value of the body, or of an (%escape name value) jumping to its end
    *#compileBlock(expr: any[], opts: CmpOpts): Task<void> {
        if (typeof expr[1] !== "symbol") throw new VMError(Msg.FormArgs, ["%block", "a block name symbol", expr.length - 1])
        const end = new JumpLabel()
        const target: BlockTarget = {
            name: expr[1], end, destReg: opts.destReg, isTail: opts.isTail, fnDepth: opts.fnDepth ?? 0,
            markDepth: opts.markRegions?.length ?? 0, parent: opts.blocks,
        }
        opts.nodes.push({ k: "Block", end })
        { const t = this.#compileBody(expr.slice(2), { ...opts, blocks: target }); if (t !== undefined) yield t }
        opts.nodes.push({ k: "Label", label: end })
    }

    *#compileEscape(expr: any[], opts: CmpOpts): Task<void> {
        if (typeof expr[1] !== "symbol" || expr.length > 3) throw new VMError(Msg.FormArgs, ["%escape", "a block name symbol and at most a value", expr.length - 1])
        const name: symbol = expr[1]
        let target = opts.blocks
        while (target !== undefined && target.name !== name) target = target.parent
        if (target === undefined) throw new VMError(Msg.EscapeNoBlock, [name])
        if (target.fnDepth !== (opts.fnDepth ?? 0)) {
            throw new VMError(Msg.EscapeFromLambda, [name])
        }
        // the value is computed as if it were the block's own value: into its register, in its tail position
        const valueOpts = { ...opts, destReg: target.destReg, isTail: target.isTail }
        if (expr.length > 2) { const t = this.#compile(expr[2], valueOpts); if (t !== undefined) yield t }
        else { const t = this.#compile(undefined, valueOpts); if (t !== undefined) yield t }
        const regions = opts.markRegions ?? []
        if (regions.length > target.markDepth) opts.nodes.push({ k: "MarkRestore", reg: regions[target.markDepth] })
        opts.nodes.push({ k: "Jump", target: target.end })
    }

    // (%with-mark key value body): in tail position the mark goes on the current frame (replacing its value for the key)
    // and stays until the frame returns; otherwise the body runs as a new frame, so the marks are saved and put back after
    *#compileWithMark(expr: any[], opts: CmpOpts): Task<void> {
        const [, key, value, body] = expr
        const saved = opts.isTail ? -1 : opts.scope.regAlloc.allocBlock(2)
        if (!opts.isTail) opts.nodes.push({ k: "MarkSave", reg: saved })
        const kv = opts.scope.regAlloc.allocBlock(2)
        { const t = this.#compile(key, { ...opts, destReg: kv, isTail: false }); if (t !== undefined) yield t }
        { const t = this.#compile(value, { ...opts, destReg: kv + 1, isTail: false }); if (t !== undefined) yield t }
        opts.nodes.push({ k: "SetMark", key: kv, val: kv + 1 })
        opts.scope.regAlloc.freeBlock(kv, 2)
        if (opts.isTail) {
            { const t = this.#compile(body, opts); if (t !== undefined) yield t }
            return
        }
        { const t = this.#compile(body, { ...opts, markRegions: [...(opts.markRegions ?? []), saved] }); if (t !== undefined) yield t }
        opts.nodes.push({ k: "MarkRestore", reg: saved })
        opts.scope.regAlloc.freeBlock(saved, 2)
    }

    // (%loop body ...): repeats forever; only an %escape leaves it
    *#compileLoop(expr: any[], opts: CmpOpts): Task<void> {
        const head = new JumpLabel()
        const end = new JumpLabel()
        opts.nodes.push({ k: "Loop", end })
        opts.nodes.push({ k: "Label", label: head })
        for (const e of expr.slice(1)) { const t = this.#compile(e, { ...opts, destReg: undefined, isTail: false }); if (t !== undefined) yield t }
        opts.nodes.push({ k: "EndLoop", head })
        opts.nodes.push({ k: "Label", label: end })
    }

    #nodesEndsInRet(nodes: Node[]) {
        let last = nodes.length - 1
        while (last >= 0 && nodes[last].k === "Pos") last--
        if (last < 0) return false // we need a return if there is no code
        const lastNode = nodes[last]
        if (
            (lastNode.k === "Call" && lastNode.tail) ||
            lastNode.k === "Return" ||
            (lastNode.k === "HostCall" && lastNode.tail)
        ) {
            return true // all of these ops alr return
        }
        return false
    }

    // (%catch thunk handler [pre]): %call-catching gives the value of (thunk), or a Caught when it raised, after which the
    // handler expression is evaluated and called with the error (in tail position if the %catch is); pre is evaluated
    // first, and runs on the error before unwinding
    *#compileCatch(expr: any[], opts: CmpOpts): Task<void> {
        if (expr.length < 3 || expr.length > 5) {
            throw new VMError(Msg.FormArgs, ["%catch", "2 to 4 arguments (thunk, handler, pre, guarded)", expr.length - 1]);
        }
        if (expr.length === 5 && typeof expr[4] !== "boolean") throw new VMError(Msg.CatchGuard, []);
        const args = expr[4] === true ? [expr[1], expr[3], true] : expr.length >= 4 ? [expr[1], expr[3]] : [expr[1]];
        const resReg = opts.scope.allocTemp();
        const startReg = opts.scope.regAlloc.allocBlock(args.length);
        for (let i = 0; i < args.length; i++) { const t = this.#compile(args[i], { ...opts, destReg: startReg + i, isTail: false }); if (t !== undefined) yield t }
        opts.nodes.push({ k: "HostCall", pos: corePos("%call-catching"), start: startReg, nargs: args.length, tail: false, dst: resReg });
        opts.scope.regAlloc.freeBlock(startReg, args.length);

        const condReg = opts.scope.allocTemp();
        opts.nodes.push({ k: "IntCall", pos: corePos("%caught?"), dst: condReg, start: resReg, nargs: 1 });
        const elseLabel = new JumpLabel();
        const endLabel = new JumpLabel();
        opts.nodes.push({ k: "If", cond: condReg, else: elseLabel, elseif: false });
        opts.scope.freeTemp(condReg);

        const call = opts.scope.regAlloc.allocBlock(2);
        { const t = this.#compile(expr[2], { ...opts, destReg: call, isTail: false }); if (t !== undefined) yield t }
        opts.nodes.push({ k: "IntCall", pos: corePos("%caught-value"), dst: call + 1, start: resReg, nargs: 1 });
        if (opts.isTail) opts.nodes.push({ k: "Call", proc: call, start: call + 1, nargs: 1, tail: true });
        else opts.nodes.push({ k: "Call", proc: call, dst: opts.destReg, start: call + 1, nargs: 1, tail: false });
        opts.scope.regAlloc.freeBlock(call, 2);

        opts.nodes.push({ k: "Else", end: endLabel });
        opts.nodes.push({ k: "Label", label: elseLabel });
        if (opts.destReg !== undefined) opts.nodes.push({ k: "Move", dst: opts.destReg, src: resReg });
        opts.nodes.push({ k: "EndIf" });
        opts.nodes.push({ k: "Label", label: endLabel });
        opts.scope.freeTemp(resReg);
    }

    #compileRuntimeOp(expr: any[], opts: CmpOpts, minArgs: number, maxArgs: number, emit: (startReg: number, nargs: number, destReg: number | undefined) => void): void | Task<void> {
        const nargs = expr.length - 1
        if (nargs < minArgs || nargs > maxArgs) throw new VMError(Msg.Arity, [String(expr[0].description), minArgs, maxArgs, nargs])
        const startReg = opts.scope.regAlloc.allocBlock(nargs)
        for (let i = 0; i < nargs; i++) {
            const walk = this.#compile(expr[i + 1], { ...opts, destReg: startReg + i, isTail: false })
            if (walk !== undefined) return this.#compileRuntimeOpFrom(expr, opts, emit, startReg, i + 1, walk)
        }
        emit(startReg, nargs, opts.destReg)
        opts.scope.regAlloc.freeBlock(startReg, nargs)
    }

    *#compileRuntimeOpFrom(expr: any[], opts: CmpOpts, emit: (startReg: number, nargs: number, destReg: number | undefined) => void, startReg: number, next: number, walk: Task<void>): Task<void> {
        const nargs = expr.length - 1
        yield walk
        for (let i = next; i < nargs; i++) { const t = this.#compile(expr[i + 1], { ...opts, destReg: startReg + i, isTail: false }); if (t !== undefined) yield t }
        emit(startReg, nargs, opts.destReg)
        opts.scope.regAlloc.freeBlock(startReg, nargs)
    }

    #compileImport(op: number, call: any[], opts: CmpOpts): void | Task<void> {
        const malformed = () => new VMError(Msg.FormArgs, [String(call[0].description)])
        if (op === IMPORT_GLOBALS) {
            const quoted = call[1]
            if (call.length !== 2 || !Array.isArray(quoted) || quoted[0] !== CORE_QUOTE || !Array.isArray(quoted[2]) || this.#imports !== null) throw malformed()
            const syms: (symbol | undefined)[] = this.#imports = quoted[2]
            return this.#withDest(opts, opts.destReg, dst => opts.nodes.push({ k: "ImportGlobals", dst, syms }))
        }
        const slot = call[1]
        if (typeof slot !== "number") throw malformed()
        if (op === IMPORT_REF) return this.#withDest(opts, opts.destReg, dst => opts.nodes.push({ k: "ImportRef", dst, slot }))
        if (op === IMPORT_OR) {
            const read = [CORE_INTCALL, null, IMPORT_REF_OP, slot]
            return this.#compileIfCall([CORE_IF, [CORE_INTCALL, null, IS_VOID, read], call[2], read], opts)
        }
        return this.#compileRuntimeOp([call[0], call[2]], opts, 1, 1, (start, _nargs, dest) => {
            opts.nodes.push({ k: "ImportSet", src: start, slot })
            if (dest !== undefined) opts.nodes.push({ k: "LoadValue", constant: undefined, dst: dest })
        })
    }

    #withRtResult(opts: CmpOpts, op: string, startReg: number, nargs: number, use: (reg: number) => void) {
        const reg = opts.scope.allocTemp()
        opts.nodes.push({ k: "IntCall", pos: corePos(op), dst: reg, start: startReg, nargs })
        use(reg)
        opts.scope.freeTemp(reg)
    }

    #withDest(opts: CmpOpts, dest: number | undefined, push: (destReg: number) => void) {
        const destReg = dest ?? opts.scope.allocTemp()
        push(destReg)
        if (dest === undefined) opts.scope.freeTemp(destReg)
    }

    #isIntrinsic(sym: symbol): boolean {
        return isCoreForm(sym) || this.intrinsics.get(sym) !== undefined
    }

    // a call of an intrinsic's name always calls the intrinsic, so the name cannot be a variable too; nor can the names
    // the front end reserved
    #ensureNotIntrinsic(sym: any, syntaxCtx: string) {
        if (typeof sym !== "symbol") return
        const reserved = this.intrinsics.reserved.get(sym)
        if (reserved === "special form") throw new VMError(Msg.BadSyntax, [sym])
        if (reserved === "builtin") throw new VMError(Msg.CannotBindBuiltin, [syntaxCtx, sym])
        if (this.#isIntrinsic(sym)) throw new VMError(Msg.CannotBindIntrinsic, [syntaxCtx, sym])
    }


    *#compileApply(expr: any[], opts: CmpOpts): Task<void> {
        if (expr.length < 3) {
            throw new VMError(Msg.FormArgs, ["%apply", "at least 2 arguments (proc, ...args, array)", expr.length - 1]);
        }
        const procExpr = expr[1];
        const argExprs = expr.slice(2);
        argExprs[argExprs.length - 1] = this.#forwarded(argExprs[argExprs.length - 1], opts);
        yield this.#compileApplyCall(procExpr, argExprs, opts, argExprs.length === 1 && this.#isFresh(argExprs[0]) ? "%apply-fresh" : "%apply-array");
    }

    *#compileIntApply(expr: any[], opts: CmpOpts): Task<void> {
        if (expr.length < 3) {
            throw new VMError(Msg.FormArgs, ["%intapply", "at least 2 arguments (intrinsic, ...args, array)", expr.length - 1]);
        }
        const intrinsic = this.#intrinsicNamed("%intapply", expr);
        const argExprs = expr.slice(2);
        argExprs[argExprs.length - 1] = this.#forwarded(argExprs[argExprs.length - 1], opts);
        yield this.#compileApplyIntrinsic(intrinsic, argExprs, opts);
    }

    // a call of an intrinsic that returns a new array, or an %intapply of one
    #isFresh(expr: any): boolean {
        if (!Array.isArray(expr) || (expr[0] !== CORE_INTCALL && expr[0] !== CORE_INTAPPLY) || typeof expr[2] !== "symbol") return false
        return this.intrinsics.get(expr[2])?.fresh === true
    }

    // applying a procedure is a call of the core operation %apply-array (or %apply-fresh) over [proc, arg ..., array]
    *#compileApplyCall(procExpr: any, argExprs: any[], opts: CmpOpts, op: string): Task<void> {
        if (typeof procExpr === "symbol" && this.#isIntrinsic(procExpr)) {
            throw new VMError(Msg.IntrinsicAsValue, [procExpr]);
        }
        const nargs = 1 + argExprs.length;
        const startReg = opts.scope.regAlloc.allocBlock(nargs);
        { const t = this.#compile(procExpr, { ...opts, destReg: startReg, isTail: false }); if (t !== undefined) yield t }
        for (let i = 0; i < argExprs.length; i++) { const t = this.#compile(argExprs[i], { ...opts, destReg: startReg + 1 + i, isTail: false }); if (t !== undefined) yield t }
        opts.nodes.push({ k: "HostCall", pos: corePos(op), start: startReg, nargs, tail: opts.isTail, dst: opts.destReg });
        opts.scope.regAlloc.freeBlock(startReg, nargs);
    }

    // (%intapply %intrinsic arg ... lst): the argument count is only known at run time, so IntApply checks it there
    *#compileApplyIntrinsic(intrinsic: Intrinsic, argExprs: any[], opts: CmpOpts): Task<void> {
        if (!intrinsic.leaf) throw new VMError(Msg.ApplyNonLeaf, [intrinsic.name]);
        const nargs = argExprs.length;
        const startReg = opts.scope.regAlloc.allocBlock(nargs);
        for (let i = 0; i < argExprs.length; i++) { const t = this.#compile(argExprs[i], { ...opts, destReg: startReg + i, isTail: false }); if (t !== undefined) yield t }
        this.#withDest(opts, opts.destReg, destReg => opts.nodes.push({ k: "IntApply", pos: intrinsic.pos, dst: destReg, start: startReg, nargs }));
        opts.scope.regAlloc.freeBlock(startReg, nargs);
    }

    // (spread x) of a forwarded rest parameter is x itself (see VariableMetadata.forwardsRest)
    #forwarded(expr: any, opts: CmpOpts): any {
        if (!isSpreadOf(expr, this.intrinsics)) return expr
        const sym = expr[3]
        return opts.scope.resolve(sym).type === "Local" && opts.forwards.has(sym) ? sym : expr
    }

    // a normal call
    #compileNormalCall(expr: any[], opts: CmpOpts): void | Task<void> {
        const one = opts.one === true, many = opts.many
        if (one || many !== undefined) opts = { ...opts, one: false, many: undefined }
        // We need to compile the proc and place it on its own tempval
        const procExpr = expr[0]
        if (typeof procExpr === "symbol" && this.#isIntrinsic(procExpr)) {
            throw new VMError(Msg.IntrinsicAsValue, [procExpr]);
        }
        const procReg = opts.scope.allocTemp();
        const walk = this.#compile(procExpr, { ...opts, destReg: procReg, isTail: false })
        if (walk !== undefined) return this.#compileNormalCallFrom(expr, opts, one, many, procReg, -1, 0, walk)

        // Push all arguments to a contiguous reg block
        const nargs = expr.length - 1;
        const startReg = opts.scope.regAlloc.allocBlock(nargs);
        for (let i = 0; i < nargs; i++) {
            const walk = this.#compile(expr[i + 1], { ...opts, destReg: startReg + i, isTail: false })
            if (walk !== undefined) return this.#compileNormalCallFrom(expr, opts, one, many, procReg, startReg, i + 1, walk)
        }
        this.#emitCall(opts, one, many, procReg, startReg, nargs)
    }

    // (`startReg` -1: the walk is the procedure's, and the arguments' block is yet to be taken)
    *#compileNormalCallFrom(expr: any[], opts: CmpOpts, one: boolean, many: number | undefined, procReg: number, startReg: number, next: number, walk: Task<void>): Task<void> {
        const nargs = expr.length - 1;
        yield walk
        if (startReg === -1) startReg = opts.scope.regAlloc.allocBlock(nargs);
        for (let i = next; i < nargs; i++) { const t = this.#compile(expr[i + 1], { ...opts, destReg: startReg + i, isTail: false }); if (t !== undefined) yield t }
        this.#emitCall(opts, one, many, procReg, startReg, nargs)
    }

    #emitCall(opts: CmpOpts, one: boolean, many: number | undefined, procReg: number, startReg: number, nargs: number) {
        if (opts.isTail) {
            opts.nodes.push({ k: "Call", nargs, proc: procReg, start: startReg, tail: true })
        } else {
            opts.nodes.push({ k: "Call", dst: opts.destReg, nargs, proc: procReg, start: startReg, one, many, tail: false })
        }

        opts.scope.regAlloc.freeBlock(startReg, nargs)
        opts.scope.freeTemp(procReg)
    }

    // (%let ((x init) ...) body ...): inits are evaluated in the outer scope, then bound in a block of this function
    // (%let* ((name init) ...) body ...): each init runs with the names before it bound, then its name is bound; all in
    // one block of the current function, as nested %lets would be, without the nesting
    *#compileLetStar(expr: any[], opts: CmpOpts): Task<void> {
        const bindings: [symbol, any][] = this.#bindingsOf("%let*", expr)
        opts.scope.enterBlock()
        for (const binding of bindings) {
            const [sym, init] = binding
            ensureCanBind(sym, undefined, "let*")
            this.#ensureNotIntrinsic(sym, "let*")
            const reg = opts.scope.allocTemp()
            const boxed = (yield this.#compileInit(init, { ...opts, destReg: reg, isTail: false, name: sym.description }))
            const destReg = opts.scope.addLocal(sym)
            opts.nodes.push({ k: boxed ? "Box" : "Move", src: reg, dst: destReg })
            opts.scope.freeTemp(reg)
        }
        { const t = this.#compileBody(expr.slice(2), opts); if (t !== undefined) yield t }
        opts.scope.exitBlock()
    }

    *#compileLet(expr: any[], opts: CmpOpts): Task<void> {
        const bindings: [symbol, any][] = this.#bindingsOf("%let", expr)

        const initRegs: number[] = []
        const boxed: boolean[] = []
        for (const [sym, init] of bindings) {
            const reg = opts.scope.allocTemp()
            boxed.push((yield this.#compileInit(init, { ...opts, destReg: reg, isTail: false, name: sym.description })))
            initRegs.push(reg)
        }

        opts.scope.enterBlock()
        const seen = new Set<symbol>()
        for (let i = 0; i < bindings.length; i++) {
            const sym = bindings[i][0]
            ensureCanBind(sym, seen, "let")
            this.#ensureNotIntrinsic(sym, "let")
            const destReg = opts.scope.addLocal(sym)
            opts.nodes.push({ k: boxed[i] ? "Box" : "Move", src: initRegs[i], dst: destReg })
        }
        { const t = this.#compileBody(expr.slice(2), opts); if (t !== undefined) yield t }
        opts.scope.exitBlock()
        for (const reg of initRegs) opts.scope.freeTemp(reg)
    }

    // (%letrec ((name init) ...) body ...): the names are bound first, so the inits can refer to any of them. The lambdas
    // are made first, all at once; the other inits then run in order. A name that is never assigned holds its value
    // directly, and the upvars captured before it existed are filled in once it does (FixUpvar); an assigned name (or
    // one a closure may copy before its init has run, see lateValues) is a box
    *#compileLetrec(expr: any[], opts: CmpOpts): Task<void> {
        const bindings: [symbol, any][] = this.#bindingsOf("%letrec", expr)
        const isLambda = bindings.map(([, init]) => isLetrecLambda(init))
        // a name the assignments pass boxed holds its box from the start, which its init sets
        const boxed = bindings.map(([, init]) => isBoxedInit(init))

        opts.scope.enterBlock()
        const seen = new Set<symbol>()
        const regs: number[] = []
        for (let i = 0; i < bindings.length; i++) {
            const sym = bindings[i][0]
            ensureCanBind(sym, seen, "letrec")
            this.#ensureNotIntrinsic(sym, "letrec")
            const reg = opts.scope.addLocal(sym)
            regs.push(reg)
            if (boxed[i] || !isLambda[i]) opts.nodes.push({ k: "LoadValue", constant: undefined, dst: reg })
            if (boxed[i]) opts.nodes.push({ k: "Box", src: reg, dst: reg })
        }

        // every closure made here, with what it captured, so a name can be filled into them once its value exists
        const made: { reg: number, captures: readonly { index: number, local: boolean }[] }[] = []
        const temps: number[] = []
        const fillIn = (reg: number) => {
            for (const closure of made) {
                closure.captures.forEach((c, j) => {
                    if (c.local && c.index === reg) opts.nodes.push({ k: "FixUpvar", clo: closure.reg, idx: j, src: reg })
                })
            }
        }
        const self = this
        const compileInit = function* (i: number): Task<{ dest: number, closure: Node | undefined }> {
            const dest = boxed[i] ? opts.scope.allocTemp() : regs[i]
            if (boxed[i]) temps.push(dest)
            const before = opts.nodes.length
            { const t = self.#compile(unwrapBoxed(bindings[i][1]), { ...opts, destReg: dest, isTail: false, name: bindings[i][0].description }); if (t !== undefined) yield t }
            if (boxed[i]) opts.nodes.push({ k: "SetBox", dst: regs[i], src: dest })
            return { dest, closure: opts.nodes.slice(before).reverse().find(n => n.k === "NewClosure") }
        }

        for (let i = 0; i < bindings.length; i++) {
            if (!isLambda[i]) continue
            const { dest, closure } = yield compileInit(i)
            made.push({ reg: dest, captures: closure?.k === "NewClosure" ? closure.template.upvarLocs : [] })
        }
        for (let i = 0; i < bindings.length; i++) if (isLambda[i] && !boxed[i]) fillIn(regs[i])
        for (let i = 0; i < bindings.length; i++) {
            if (isLambda[i]) continue
            yield compileInit(i)
            if (!boxed[i]) fillIn(regs[i])
        }
        for (const reg of temps) opts.scope.freeTemp(reg)

        { const t = this.#compileBody(expr.slice(2), opts); if (t !== undefined) yield t }
        opts.scope.exitBlock()
    }

    #getVar(varname: symbol, opts: CmpOpts, destReg?: number): Node[] {
        const resolved = opts.scope.resolve(varname)
        if (resolved.type === "Local") return destReg !== undefined && resolved.index !== destReg ? [{ k: "Move", src: resolved.index, dst: destReg }] : []
        if (resolved.type === "Upvar") return destReg !== undefined ? [{ k: "LoadUpvar", idx: resolved.index, dst: destReg, unbox: false }] : []
        if (destReg !== undefined) return [{ k: "LoadGlobal", sym: varname, dst: destReg }]
        const tmpReg = opts.scope.allocTemp()
        opts.scope.freeTemp(tmpReg)
        return [{ k: "LoadGlobal", sym: varname, dst: tmpReg }]
    }

    #setVar(varname: symbol, opts: CmpOpts, srcReg: number): Node[] {
        const resolved = opts.scope.resolve(varname)
        if (resolved.type === "Local") return srcReg !== resolved.index ? [{ k: "Move", src: srcReg, dst: resolved.index }] : []
        if (resolved.type === "Upvar") return [{ k: "SetUpvar", src: srcReg, idx: resolved.index, box: false }]
        return [{ k: "SetGlobal", sym: varname, src: srcReg }]
    }

    // a %let or %let* init: (%box e) is e, which the binding boxes (whether it did is the result)
    *#compileInit(init: any, opts: CmpOpts): Task<boolean> {
        const boxed = Array.isArray(init) && init[0] === BOX && init.length === 3
        { const t = this.#compile(boxed ? init[2] : init, opts); if (t !== undefined) yield t }
        return boxed
    }

    // (%box e): a new box holding e's value
    *#compileBox(expr: any[], opts: CmpOpts): Task<void> {
        { const t = this.#compile(expr[1], { ...opts, isTail: false }); if (t !== undefined) yield t }
        if (opts.destReg !== undefined) opts.nodes.push({ k: "Box", src: opts.destReg, dst: opts.destReg })
    }

    // (%unbox x): the value in the box x holds
    #compileUnbox(expr: any[], opts: CmpOpts) {
        const resolved = opts.scope.resolve(expr[1])
        if (opts.destReg === undefined) return
        if (resolved.type === "Local") opts.nodes.push({ k: "Unbox", src: resolved.index, dst: opts.destReg })
        else if (resolved.type === "Upvar") opts.nodes.push({ k: "LoadUpvar", idx: resolved.index, dst: opts.destReg, unbox: true })
        else throw new Error(`internal error: unboxing ${String(expr[1]?.description)}, which is not a local variable`)
    }

    // (%box! x): x, a local, now holds a box of its value
    #compileBoxInPlace(expr: any[], opts: CmpOpts) {
        const resolved = opts.scope.resolve(expr[1])
        if (resolved.type !== "Local") throw new Error(`internal error: boxing ${String(expr[1]?.description)} in place, which is not a local of this function`)
        opts.nodes.push({ k: "Box", src: resolved.index, dst: resolved.index })
    }

    // (%set-box! x v): the box x holds now holds v; the value is <#void>
    *#compileSetBox(expr: any[], opts: CmpOpts): Task<void> {
        const [, sym, val] = expr
        const valReg = opts.scope.allocTemp()
        { const t = this.#compile(val, { ...opts, destReg: valReg, isTail: false, name: sym.description }); if (t !== undefined) yield t }
        const resolved = opts.scope.resolve(sym)
        if (resolved.type === "Local") {
            opts.nodes.push({ k: "SetBox", src: valReg, dst: resolved.index })
        } else if (resolved.type === "Upvar") {
            const tmpReg = opts.scope.allocTemp()
            opts.nodes.push({ k: "LoadUpvar", unbox: false, dst: tmpReg, idx: resolved.index }, { k: "SetBox", dst: tmpReg, src: valReg })
            opts.scope.freeTemp(tmpReg)
        } else {
            throw new Error(`internal error: setting the box of ${String(sym?.description)}, which is not a local variable`)
        }
        opts.scope.freeTemp(valReg)
        if (opts.destReg !== undefined) opts.nodes.push({ k: "LoadValue", dst: opts.destReg, constant: undefined })
    }
}
