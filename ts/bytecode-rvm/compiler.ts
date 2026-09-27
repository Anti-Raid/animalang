import { Msg, VMError, ensureCanBind, normalizeExpr, CORE_BEGIN, CORE_IF, CORE_LAMBDA, CORE_QUOTE, CORE_SET, CORE_BLOCK, CORE_ESCAPE, CORE_LOOP, CORE_LET, CORE_LET_VALUES, CORE_LET_VALUES_STRICT, CORE_LETREC, CORE_LET_STAR, CORE_CASE_LAMBDA, CORE_WITH_MARK, OP_CURRENT_MARKS, CORE_CATCH, OP_DEFINE_GLOBAL, SOURCE_POS, type SourcePos } from "../common";
import { AstAnalysis, isSpreadOf } from "./analysis";
import { AnalysisScope, CompilerScope } from "./scope";
import { IR, type Node, JumpLabel, ClosureTemplateIR } from "./ir";
import { liftLambdas } from "./lift";
import { corePos } from "./exec";
import { hasCore, isCoreForm, newIntrinsics } from "./core";
import { Intrinsics, type Intrinsic } from "./intrinsics";

// a body as one expression
const bodyExpr = (body: any[]): any => body.length === 0 ? null : body.length === 1 ? body[0] : [CORE_BEGIN, ...body]

const OP_DYNAMIC_WIND = Symbol.for("%dynamic-wind");
const OP_CALLEC = Symbol.for("%call/ec");
const OP_APPLY = Symbol.for("%apply");

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
    nodes: Node[]
    scope: CompilerScope,
    pos?: SourcePos // position of the enclosing form
    blocks?: BlockTarget // enclosing %blocks, innermost first
    fnDepth?: number // how many %lambdas deep we are; escapes cannot cross one
    markRegions?: number[] // for each enclosing non-tail %with-mark, where it saved the marks (outermost first)
    name?: string // name for a lambda compiled directly as this value

    // From pass 1
    ascope: AnalysisScope,
    analyzer: AstAnalysis
}

// Compiles core forms, as arrays (see README.md): `[op, operand ...]`, symbols as variable references, anything else
// that is not an array as a literal
export class Compiler {
    constructor(readonly intrinsics: Intrinsics = newIntrinsics(), private readonly debug: boolean = false) {
        if (!hasCore(intrinsics)) throw new Error("the compiler's intrinsics must start with the core operations (see newIntrinsics)")
    }

    compile(trExpr: any, debug: boolean = this.debug) {
        try {
            return this.#compileTop(trExpr, debug)
        } catch (err) {
            if (err instanceof VMError) err.format(this.intrinsics.format)
            throw err
        }
    }

    #compileTop(trExpr: any, debug: boolean) {
        trExpr = liftLambdas(trExpr)
        // Step 1 is to analyze our variables so we know what to box and what not to box
        let analyzer = new AstAnalysis(this.intrinsics)
        const ascope = analyzer.analyze(trExpr)

        const scope = new CompilerScope(null)
        const nodes: Node[] = []
        const retReg = scope.allocTemp(); // no need to free the temp reg as we return?
        this.#compile(trExpr, {destReg: retReg, isTail: true, nodes, scope, ascope, analyzer})
        if (!this.#nodesEndsInRet(nodes)) {
            nodes.push({t: "Return", reg: retReg})
        }
        const ir = new IR(this.intrinsics, debug)
        return ir.lower(nodes, scope.numRegs)
    }

    #compile(expr: any, opts: CmpOpts) {
        // Raw values
        if (typeof expr === 'symbol') {
            const res = this.#getVar(expr, opts, opts.destReg)
            if (res) opts.nodes.push(...res)
            return
        } else if (expr === null) {
            if (opts.destReg === undefined) return 
            opts.nodes.push({t: "LoadValue", constant: null, destReg: opts.destReg})
            return
        } else if (!Array.isArray(expr)) { // a literal (string, number, boolean, undefined, etc.)
            if (opts.destReg === undefined) return  
            opts.nodes.push({t: "LoadValue", constant: expr, destReg: opts.destReg})
            return
        }
        if (expr.length === 0) throw new VMError(Msg.EmptyForm, [])

        const pos = SOURCE_POS.get(expr)
        if (pos !== undefined && pos !== opts.pos) {
            opts.nodes.push({ t: "Pos", pos })
            try {
                this.#compileForm(expr, { ...opts, pos })
            } catch (err) {
                if (err instanceof VMError) err.at ??= pos
                throw err
            }
            if (opts.pos !== undefined) opts.nodes.push({ t: "Pos", pos: opts.pos })
            return
        }
        this.#compileForm(expr, opts)
    }

    #compileForm(expr: any[], opts: CmpOpts) {
        const name = opts.name
        if (name !== undefined) opts = { ...opts, name: undefined }
        const operator = expr[0];

        if (typeof operator === "symbol") {
            switch (operator) {
                case CORE_BEGIN:
                    this.#compileBegin(expr, opts)
                    return
                case CORE_IF:
                    this.#compileIfCall(expr, opts)
                    return
                case CORE_QUOTE:
                    this.#compileQuote(expr, opts)
                    return
                case CORE_SET:
                    this.#compileSet(expr, opts)
                    return
                case CORE_CASE_LAMBDA:
                    this.#compileCaseLambda(expr, opts, name)
                    return
                case CORE_LAMBDA:
                    this.#compileLambda(expr, opts, name)
                    return
                case CORE_LETREC:
                    this.#compileLetrec(expr, opts)
                    return
                case CORE_LET_STAR:
                    this.#compileLetStar(expr, opts)
                    return
                case CORE_LET:
                    this.#compileLet(expr, opts)
                    return
                case CORE_LET_VALUES:
                case CORE_LET_VALUES_STRICT:
                    this.#compileLetValues(expr, opts, operator === CORE_LET_VALUES_STRICT)
                    return
                case CORE_BLOCK:
                    this.#compileBlock(expr, opts)
                    return
                case CORE_ESCAPE:
                    this.#compileEscape(expr, opts)
                    return
                case CORE_LOOP:
                    this.#compileLoop(expr, opts)
                    return
                case CORE_WITH_MARK:
                    this.#compileWithMark(expr, opts)
                    return
                case OP_CURRENT_MARKS:
                    if (opts.destReg !== undefined) opts.nodes.push({ t: "CurrentMarks", destReg: opts.destReg })
                    return
                case OP_DYNAMIC_WIND:
                    this.#compileDynamicWind(expr, opts)
                    return
                case OP_CALLEC:
                    this.#compileCallEC(expr, opts)
                    return
                case CORE_CATCH:
                    this.#compileCatch(expr, opts)
                    return
                case OP_DEFINE_GLOBAL:
                    this.#compileDefine(expr, opts)
                    return
                case OP_APPLY:
                    this.#compileApply(expr, opts)
                    return
            }

            const intrinsic = this.intrinsics.get(operator)
            if (intrinsic !== undefined && intrinsic.leaf) {
                this.#compileRuntimeOp(expr, opts, intrinsic.min, intrinsic.max, (start, nargs, dest) => {
                    this.#withDest(opts, dest, destReg => opts.nodes.push({ t: "IntCall", pos: intrinsic.pos, destReg, startReg: start, nargs }))
                })
                return
            }
            if (intrinsic !== undefined) {
                this.#compileRuntimeOp(expr, opts, intrinsic.min, intrinsic.max, (start, nargs, dest) => {
                    // an intrinsic whose value is that of the call itself (see `tail`) is a call and then a return
                    opts.nodes.push({ t: "HostCall", pos: intrinsic.pos, startReg: start, nargs, isTail: opts.isTail && intrinsic.tail, destReg: dest })
                })
                return
            }
        }

        this.#compileNormalCall(expr, opts)
    }

    #compileBegin(expr: any[], opts: CmpOpts) {
        this.#compileBody(expr.slice(1), opts)
    }

    // expressions in order, the last one giving the value (<#void> if there are none)
    #compileBody(body: any[], opts: CmpOpts) {
        if (body.length === 0) {
            if (opts.destReg === undefined) return 
            opts.nodes.push({t: "LoadValue", constant: undefined, destReg: opts.destReg})
            return
        }
        body.forEach((e, i) => {
            const isLastChild = i === body.length - 1;
            this.#compile(e, { ...opts, destReg: isLastChild ? opts.destReg : undefined, isTail: isLastChild && opts.isTail });
        });
    }

    // compiles both if calls as well as code that is converted into if calls
    // (%if c1 e1 c2 e2 ... [else]): the first ei whose ci is true, else `else` (or <#void>). One chain whatever the number
    // of clauses: IF c1 L1; e1; ELSE end; L1: <c2>; ELSEIF c2 L2; e2; ELSE end; L2: ...; else; ENDIF; end:
    #compileIfCall(expr: any[], opts: CmpOpts) {
        const args = expr.slice(1)
        if (args.length < 2) {
            throw new VMError(Msg.IfArgs, [args.length])
        }
        const endLabel = new JumpLabel()
        for (let i = 0; i + 1 < args.length; i += 2) {
            const condReg = opts.scope.allocTemp()
            this.#compile(args[i], { ...opts, destReg: condReg, isTail: false })
            const nextLabel = new JumpLabel()
            opts.nodes.push({ t: i === 0 ? "If" : "ElseIf", reg: condReg, elseLabel: nextLabel })
            opts.scope.freeTemp(condReg)
            this.#compile(args[i + 1], opts)
            opts.nodes.push({ t: "Else", endLabel })
            opts.nodes.push({ t: "Label", label: nextLabel })
        }
        this.#compile(args.length % 2 === 1 ? args[args.length - 1] : undefined, opts)
        opts.nodes.push({ t: "EndIf" })
        opts.nodes.push({ t: "Label", label: endLabel })
    }

    #compileQuote(expr: any[], opts: CmpOpts) {
        if (expr.length !== 2) {
            throw new VMError(Msg.QuoteArgs, [expr.length - 1])
        }
        if (opts.destReg === undefined) return
        opts.nodes.push({t: "LoadValue", constant: normalizeExpr(expr[1]), destReg: opts.destReg})
    }

    // note that the syntax transformer alr handles defines inside a lambda so
    #compileDefine(expr: any[], opts: CmpOpts) {
        const [, sym, val] = expr;
        if (typeof sym !== "symbol") throw new Error("internal error: complex defines should be transformed by AnimaTransform prior to reaching here")
        this.#ensureNotIntrinsic(sym, "define")

        // We need to compile the second arg first and leave it on a temp reg
        const valReg = opts.scope.allocTemp();
        this.#compile(val, { ...opts, destReg: valReg, isTail: false, name: sym.description });
        opts.nodes.push({t: "SetGlobal", srcReg: valReg, sym})
        opts.scope.freeTemp(valReg)
        if (opts.destReg !== undefined) {
            opts.nodes.push({t: "LoadValue", destReg: opts.destReg, constant: undefined})
        }
    }

    #compileSet(expr: any[], opts: CmpOpts) {
        const [, sym, val] = expr;
        if (typeof sym !== "symbol") throw new VMError(Msg.SetTarget, [sym])
        this.#ensureNotIntrinsic(sym, "set!")

        // We need to compile the second arg first and leave it on a temp reg
        const valReg = opts.scope.allocTemp();
        this.#compile(val, { ...opts, destReg: valReg, isTail: false, name: sym.description });
        const res = this.#setVar(sym, opts, valReg)
        if(res) opts.nodes.push(...res)
        opts.scope.freeTemp(valReg)
        if (opts.destReg !== undefined) {
            opts.nodes.push({t: "LoadValue", destReg: opts.destReg, constant: undefined})
        }
    }

    // [%case-lambda, [%lambda ...] ...]: the clauses' closures, in a block, made into one procedure (%make-case-lambda)
    #compileCaseLambda(expr: any[], opts: CmpOpts, name?: string) {
        const clauses = expr.slice(1)
        if (clauses.length === 0 || clauses.some(c => !Array.isArray(c) || c[0] !== CORE_LAMBDA)) throw new VMError(Msg.CaseLambdaForm, [])
        const startReg = opts.scope.regAlloc.allocBlock(clauses.length)
        clauses.forEach((clause, i) => this.#compile(clause, { ...opts, destReg: startReg + i, isTail: false, name }))
        this.#withDest(opts, opts.destReg, destReg => opts.nodes.push({ t: "IntCall", pos: corePos("%make-case-lambda"), destReg, startReg, nargs: clauses.length }))
        opts.scope.regAlloc.freeBlock(startReg, clauses.length)
    }

    // [%lambda, params, rest, body ...]: params an array of symbols, rest a symbol or null
    #compileLambda(expr: any[], opts: CmpOpts, name?: string) {
        const lambdaScope = new CompilerScope(opts.scope)
        const ascope = opts.analyzer.scopeMap.get(expr)
        if (!ascope) throw new Error(`internal error: could not find ascope for expr ${expr}`)

        const params: symbol[] = expr[1]
        const remParams: symbol | null = expr[2]
        if (!Array.isArray(params) || (remParams !== null && typeof remParams !== "symbol")) throw new VMError(Msg.LambdaForm, [])
        const seen = new Set<symbol>()
        for (const p of params) ensureCanBind(p, seen, "lambda")
        if (remParams !== null) ensureCanBind(remParams, seen, "lambda")
        for (const p of params) this.#ensureNotIntrinsic(p, "lambda")
        this.#ensureNotIntrinsic(remParams, "lambda")
        const lambdaNodes: Node[] = []
        if (opts.pos !== undefined) lambdaNodes.push({ t: "Pos", pos: opts.pos })

        for(let i = 0; i < params.length; i++) {
            const reg = lambdaScope.addLocal(params[i])

            const inf = ascope.getVarinfo(params[i])
            if(!inf) throw new Error("Could not fetch varinfo")
            if(inf.isBoxed) lambdaNodes.push({t: "Box", destReg: reg, srcReg: reg})
        }
        if (remParams) {
            const reg = lambdaScope.addLocal(remParams)

            const inf = ascope.getVarinfo(remParams)
            if(!inf) throw new Error("Could not fetch varinfo")
            if(inf.isBoxed) lambdaNodes.push({t: "Box", destReg: reg, srcReg: reg})
        }

        // Once we've verified the syntax, we can then drop the entire lambda if its not actually needed
        if (opts.destReg === undefined) return

        // Compile lambda body
        const retReg = lambdaScope.allocTemp() // no need to free the temp reg as we return?
        this.#compile(bodyExpr(expr.slice(3)), {...opts, destReg: retReg, isTail: true, nodes: lambdaNodes, scope: lambdaScope, ascope, fnDepth: (opts.fnDepth ?? 0) + 1 })
        if (!this.#nodesEndsInRet(lambdaNodes)) {
            lambdaNodes.push({t: "Return", reg: retReg})
        }
        const displayName = name ?? (opts.pos !== undefined ? `lambda@${opts.pos.file}:${opts.pos.line}` : "lambda")
        const rest = remParams === null || ascope.getVarinfo(remParams)!.forwardsRest || this.intrinsics.pack === undefined ? "array" : "packed"
        const template = new ClosureTemplateIR(params, remParams, lambdaNodes, lambdaScope.numRegs, lambdaScope.upvars, displayName, rest);
        opts.nodes.push({t: "NewClosure", template: template, destReg: opts.destReg})
    }

    // (%let-values ((formals expr) ...) body ...): every expr is evaluated and spread into registers (UNPACK), then
    // all the variables are bound in a block, as in %let
    // clauses are [params, rest, init]
    #compileLetValues(expr: any[], opts: CmpOpts, strict: boolean) {
        const ascope = opts.analyzer.scopeMap.get(expr)
        if (!ascope) throw new Error(`internal error: could not find ascope for expr ${expr}`)
        const clauses: [symbol[], symbol | null, any][] = expr[1]

        const bound: { sym: symbol, reg: number }[] = []
        const blocks: { start: number, size: number }[] = []
        for (const [names, rest, init] of clauses) {
            const valReg = opts.scope.allocTemp()
            this.#compile(init, { ...opts, destReg: valReg, isTail: false })
            const size = names.length + (rest !== null ? 1 : 0)
            const start = opts.scope.regAlloc.allocBlock(size)
            opts.nodes.push({ t: "Unpack", srcReg: valReg, startReg: start, count: names.length, rest: rest !== null, strict })
            const pack = this.intrinsics.pack
            if (rest !== null && pack !== undefined) {
                const reg = start + names.length
                opts.nodes.push({ t: "IntApply", pos: pack.pos, destReg: reg, startReg: reg, nargs: 1 })
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
            const inf = ascope.getVarinfo(sym)
            if (!inf) throw new Error("Could not fetch varinfo")
            const destReg = opts.scope.addLocal(sym)
            opts.nodes.push({ t: inf.isBoxed ? "Box" : "Move", srcReg: reg, destReg })
        }
        this.#compileBody(expr.slice(2), { ...opts, ascope })
        opts.scope.exitBlock()
        for (const { start, size } of blocks) opts.scope.regAlloc.freeBlock(start, size)
    }

    // (%block name body ...): the value of the body, or of an (%escape name value) jumping to its end
    #compileBlock(expr: any[], opts: CmpOpts) {
        const end = new JumpLabel()
        const target: BlockTarget = {
            name: expr[1], end, destReg: opts.destReg, isTail: opts.isTail, fnDepth: opts.fnDepth ?? 0,
            markDepth: opts.markRegions?.length ?? 0, parent: opts.blocks,
        }
        opts.nodes.push({ t: "Block", end })
        this.#compileBody(expr.slice(2), { ...opts, blocks: target })
        opts.nodes.push({ t: "Label", label: end })
    }

    #compileEscape(expr: any[], opts: CmpOpts) {
        const name: symbol = expr[1]
        let target = opts.blocks
        while (target !== undefined && target.name !== name) target = target.parent
        if (target === undefined) throw new VMError(Msg.EscapeNoBlock, [name])
        if (target.fnDepth !== (opts.fnDepth ?? 0)) {
            throw new VMError(Msg.EscapeFromLambda, [name])
        }
        // the value is computed as if it were the block's own value: into its register, in its tail position
        const valueOpts = { ...opts, destReg: target.destReg, isTail: target.isTail }
        if (expr.length > 2) this.#compile(expr[2], valueOpts)
        else this.#compile(undefined, valueOpts)
        const regions = opts.markRegions ?? []
        if (regions.length > target.markDepth) opts.nodes.push({ t: "MarkRestore", reg: regions[target.markDepth] })
        opts.nodes.push({ t: "Jump", label: target.end })
    }

    // (%with-mark key value body): in tail position the mark goes on the current frame (replacing its value for the key)
    // and stays until the frame returns; otherwise the body runs as a new frame, so the marks are saved and put back after
    #compileWithMark(expr: any[], opts: CmpOpts) {
        const [, key, value, body] = expr
        const saved = opts.isTail ? -1 : opts.scope.regAlloc.allocBlock(2)
        if (!opts.isTail) opts.nodes.push({ t: "MarkSave", reg: saved })
        const kv = opts.scope.regAlloc.allocBlock(2)
        this.#compile(key, { ...opts, destReg: kv, isTail: false })
        this.#compile(value, { ...opts, destReg: kv + 1, isTail: false })
        opts.nodes.push({ t: "SetMark", keyReg: kv, valReg: kv + 1 })
        opts.scope.regAlloc.freeBlock(kv, 2)
        if (opts.isTail) {
            this.#compile(body, opts)
            return
        }
        this.#compile(body, { ...opts, markRegions: [...(opts.markRegions ?? []), saved] })
        opts.nodes.push({ t: "MarkRestore", reg: saved })
        opts.scope.regAlloc.freeBlock(saved, 2)
    }

    // (%loop body ...): repeats forever; only an %escape leaves it
    #compileLoop(expr: any[], opts: CmpOpts) {
        const head = new JumpLabel()
        const end = new JumpLabel()
        opts.nodes.push({ t: "Loop", end })
        opts.nodes.push({ t: "Label", label: head })
        for (const e of expr.slice(1)) this.#compile(e, { ...opts, destReg: undefined, isTail: false })
        opts.nodes.push({ t: "EndLoop", head })
        opts.nodes.push({ t: "Label", label: end })
    }

    #nodesEndsInRet(nodes: Node[]) {
        let last = nodes.length - 1
        while (last >= 0 && nodes[last].t === "Pos") last--
        if (last < 0) return false // we need a return if there is no code
        const lastNode = nodes[last]
        if (
            lastNode.t === "TailCall" ||
            lastNode.t === "Return" ||
            (lastNode.t === "HostCall" && lastNode.isTail)
        ) {
            return true // all of these ops alr return
        }
        return false
    }

    #compileDynamicWind(expr: any[], opts: CmpOpts) {
        if (expr.length !== 4) {
            throw new VMError(Msg.FormArgs, ["%dynamic-wind", "3 arguments (before, thunk, after)", expr.length - 1]);
        }
        // before and after are adjacent so they form the argument window of the wind runtime call
        const block = opts.scope.regAlloc.allocBlock(3);
        const beforeProcReg = block, afterProcReg = block + 1, thunkProcReg = block + 2;

        this.#compile(expr[1], { ...opts, destReg: beforeProcReg, isTail: false });
        this.#compile(expr[2], { ...opts, destReg: thunkProcReg, isTail: false });
        this.#compile(expr[3], { ...opts, destReg: afterProcReg, isTail: false });

        opts.nodes.push({ t: "Call", procReg: beforeProcReg, startReg: 0, nargs: 0 });
        this.#withDest(opts, undefined, destReg => opts.nodes.push({ t: "IntCall", pos: corePos("%wind"), destReg, startReg: beforeProcReg, nargs: 2 }));
        opts.nodes.push({ t: "Call", procReg: thunkProcReg, destReg: opts.destReg, startReg: 0, nargs: 0 });
        this.#withDest(opts, undefined, destReg => opts.nodes.push({ t: "IntCall", pos: corePos("%end-wind"), destReg, startReg: 0, nargs: 0 }));
        opts.nodes.push({ t: "Call", procReg: afterProcReg, startReg: 0, nargs: 0 });

        opts.scope.regAlloc.freeBlock(block, 3);
    }

    // always a non-tail call: the escape continuation is deactivated when it returns
    #compileCallEC(expr: any[], opts: CmpOpts) {
        if (expr.length !== 2) {
            throw new VMError(Msg.FormArgs, ["%call/ec", "1 argument", expr.length - 1]);
        }
        const procReg = opts.scope.allocTemp();
        const tokReg = opts.scope.allocTemp();
        this.#compile(expr[1], { ...opts, destReg: procReg, isTail: false });
        opts.nodes.push({ t: "CallEC", procReg, tokReg, destReg: opts.destReg });
        opts.scope.freeTemp(tokReg);
        opts.scope.freeTemp(procReg);
    }

    // (%catch thunk handler [pre]): CALLCATCH gives the value of (thunk), or a Caught when it raised, after which the
    // handler expression is evaluated and called with the error (in tail position if the %catch is); pre is evaluated
    // first, and runs on the error before unwinding
    #compileCatch(expr: any[], opts: CmpOpts) {
        if (expr.length !== 3 && expr.length !== 4) {
            throw new VMError(Msg.FormArgs, ["%catch", "2 or 3 arguments (thunk, handler, pre)", expr.length - 1]);
        }
        const procReg = opts.scope.allocTemp();
        const tokReg = opts.scope.allocTemp();
        const resReg = opts.scope.allocTemp();
        const preReg = expr.length === 4 ? opts.scope.allocTemp() : undefined;
        this.#compile(expr[1], { ...opts, destReg: procReg, isTail: false });
        if (preReg !== undefined) this.#compile(expr[3], { ...opts, destReg: preReg, isTail: false });
        opts.nodes.push({ t: "CallCatch", procReg, tokReg, preReg, destReg: resReg });
        if (preReg !== undefined) opts.scope.freeTemp(preReg);
        opts.scope.freeTemp(tokReg);
        opts.scope.freeTemp(procReg);

        const condReg = opts.scope.allocTemp();
        opts.nodes.push({ t: "IntCall", pos: corePos("%caught?"), destReg: condReg, startReg: resReg, nargs: 1 });
        const elseLabel = new JumpLabel();
        const endLabel = new JumpLabel();
        opts.nodes.push({ t: "If", reg: condReg, elseLabel });
        opts.scope.freeTemp(condReg);

        const call = opts.scope.regAlloc.allocBlock(2);
        this.#compile(expr[2], { ...opts, destReg: call, isTail: false });
        opts.nodes.push({ t: "IntCall", pos: corePos("%caught-value"), destReg: call + 1, startReg: resReg, nargs: 1 });
        if (opts.isTail) opts.nodes.push({ t: "TailCall", procReg: call, startReg: call + 1, nargs: 1 });
        else opts.nodes.push({ t: "Call", procReg: call, destReg: opts.destReg, startReg: call + 1, nargs: 1 });
        opts.scope.regAlloc.freeBlock(call, 2);

        opts.nodes.push({ t: "Else", endLabel });
        opts.nodes.push({ t: "Label", label: elseLabel });
        if (opts.destReg !== undefined) opts.nodes.push({ t: "Move", destReg: opts.destReg, srcReg: resReg });
        opts.nodes.push({ t: "EndIf" });
        opts.nodes.push({ t: "Label", label: endLabel });
        opts.scope.freeTemp(resReg);
    }

    #compileRuntimeOp(expr: any[], opts: CmpOpts, minArgs: number, maxArgs: number, emit: (startReg: number, nargs: number, destReg: number | undefined) => void) {
        const nargs = expr.length - 1
        if (nargs < minArgs || nargs > maxArgs) throw new VMError(Msg.Arity, [String(expr[0].description), minArgs, maxArgs, nargs])
        const startReg = opts.scope.regAlloc.allocBlock(nargs)
        for (let i = 0; i < nargs; i++) this.#compile(expr[i + 1], { ...opts, destReg: startReg + i, isTail: false })
        emit(startReg, nargs, opts.destReg)
        opts.scope.regAlloc.freeBlock(startReg, nargs)
    }

    #withRtResult(opts: CmpOpts, op: string, startReg: number, nargs: number, use: (reg: number) => void) {
        const reg = opts.scope.allocTemp()
        opts.nodes.push({ t: "IntCall", pos: corePos(op), destReg: reg, startReg, nargs })
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

    #resolveProcReg(procExpr: any, opts: CmpOpts): { procReg: number; isTemp: boolean } {
        if (typeof procExpr === "symbol" && this.#isIntrinsic(procExpr)) {
            throw new VMError(Msg.IntrinsicAsValue, [procExpr]);
        }
        const procReg = opts.scope.allocTemp();
        this.#compile(procExpr, { ...opts, destReg: procReg, isTail: false });
        return { procReg, isTemp: true };
    }

    #compileApply(expr: any[], opts: CmpOpts) {
        if (expr.length < 3) {
            throw new VMError(Msg.FormArgs, ["%apply", "at least 2 arguments (proc, ...args, array)", expr.length - 1]);
        }
        const procExpr = expr[1];
        const argExprs = expr.slice(2);
        argExprs[argExprs.length - 1] = this.#forwarded(argExprs[argExprs.length - 1], opts);
        const intrinsic = typeof procExpr === "symbol" ? this.intrinsics.get(procExpr) : undefined;
        if (intrinsic !== undefined) {
            this.#compileApplyIntrinsic(intrinsic, argExprs, opts);
            return;
        }
        this.#compileApplyCall(procExpr, argExprs, opts, argExprs.length === 1 && this.#isFresh(argExprs[0]) ? "%apply-fresh" : "%apply-array");
    }

    // a call of an intrinsic that returns a new array, or an %apply of one
    #isFresh(expr: any): boolean {
        if (!Array.isArray(expr) || typeof expr[0] !== "symbol") return false
        const op = expr[0] === OP_APPLY && typeof expr[1] === "symbol" ? expr[1] : expr[0]
        return this.intrinsics.get(op)?.fresh === true
    }

    // applying a procedure is a call of the core operation %apply-array (or %apply-fresh) over [proc, arg ..., array]
    #compileApplyCall(procExpr: any, argExprs: any[], opts: CmpOpts, op: string) {
        if (typeof procExpr === "symbol" && this.#isIntrinsic(procExpr)) {
            throw new VMError(Msg.IntrinsicAsValue, [procExpr]);
        }
        const nargs = 1 + argExprs.length;
        const startReg = opts.scope.regAlloc.allocBlock(nargs);
        this.#compile(procExpr, { ...opts, destReg: startReg, isTail: false });
        argExprs.forEach((arg, i) => this.#compile(arg, { ...opts, destReg: startReg + 1 + i, isTail: false }));
        opts.nodes.push({ t: "HostCall", pos: corePos(op), startReg, nargs, isTail: opts.isTail, destReg: opts.destReg });
        opts.scope.regAlloc.freeBlock(startReg, nargs);
    }

    // (%apply %intrinsic arg ... lst): the argument count is only known at run time, so APPLYINT checks it there
    #compileApplyIntrinsic(intrinsic: Intrinsic, argExprs: any[], opts: CmpOpts) {
        if (!intrinsic.leaf) throw new VMError(Msg.ApplyNonLeaf, [intrinsic.name]);
        const nargs = argExprs.length;
        const startReg = opts.scope.regAlloc.allocBlock(nargs);
        argExprs.forEach((arg, i) => this.#compile(arg, { ...opts, destReg: startReg + i, isTail: false }));
        this.#withDest(opts, opts.destReg, destReg => opts.nodes.push({ t: "IntApply", pos: intrinsic.pos, destReg, startReg, nargs }));
        opts.scope.regAlloc.freeBlock(startReg, nargs);
    }

    // (spread x) of a forwarded rest parameter is x itself (see VariableMetadata.forwardsRest)
    #forwarded(expr: any, opts: CmpOpts): any {
        if (!isSpreadOf(expr, this.intrinsics)) return expr
        const sym = expr[1]
        return opts.scope.resolve(sym).type === "Local" && opts.ascope.getVarinfo(sym)?.forwardsRest === true ? sym : expr
    }

    // a normal call
    #compileNormalCall(expr: any[], opts: CmpOpts) {
        // We need to compile the proc and place it on its own tempval
        const { procReg, isTemp } = this.#resolveProcReg(expr[0], opts);

        // Push all arguments to a contiguous reg block
        const nargs = expr.length - 1;
        const startReg = opts.scope.regAlloc.allocBlock(nargs);
        for (let i = 0; i < nargs; i++) this.#compile(expr[i + 1], { ...opts, destReg: startReg + i, isTail: false });

        if (opts.isTail) {
            opts.nodes.push({t: "TailCall", nargs, procReg, startReg})
        } else {
            opts.nodes.push({t: "Call", destReg: opts.destReg, nargs, procReg, startReg})
        }

        opts.scope.regAlloc.freeBlock(startReg, nargs)
        if (isTemp) opts.scope.freeTemp(procReg)
    }

    // (%let ((x init) ...) body ...): inits are evaluated in the outer scope, then bound in a block of this function
    // (%let* ((name init) ...) body ...): each init runs with the names before it bound, then its name is bound; all in
    // one block of the current function, as nested %lets would be, without the nesting
    #compileLetStar(expr: any[], opts: CmpOpts) {
        const bindings: [symbol, any][] = expr[1]
        opts.scope.enterBlock()
        let ascope = opts.ascope
        for (const binding of bindings) {
            const [sym, init] = binding
            ensureCanBind(sym, undefined, "let*")
            this.#ensureNotIntrinsic(sym, "let*")
            const reg = opts.scope.allocTemp()
            this.#compile(init, { ...opts, ascope, destReg: reg, isTail: false, name: sym.description })
            ascope = opts.analyzer.scopeMap.get(binding)!
            const inf = ascope.getVarinfo(sym)
            if (!inf) throw new Error("Could not fetch varinfo")
            const destReg = opts.scope.addLocal(sym)
            opts.nodes.push({ t: inf.isBoxed ? "Box" : "Move", srcReg: reg, destReg })
            opts.scope.freeTemp(reg)
        }
        this.#compileBody(expr.slice(2), { ...opts, ascope: opts.analyzer.scopeMap.get(expr)! })
        opts.scope.exitBlock()
    }

    #compileLet(expr: any[], opts: CmpOpts) {
        const ascope = opts.analyzer.scopeMap.get(expr)
        if (!ascope) throw new Error(`internal error: could not find ascope for expr ${expr}`)
        const bindings: [symbol, any][] = expr[1]

        const initRegs: number[] = []
        for (const [sym, init] of bindings) {
            const reg = opts.scope.allocTemp()
            this.#compile(init, { ...opts, destReg: reg, isTail: false, name: sym.description })
            initRegs.push(reg)
        }

        opts.scope.enterBlock()
        const seen = new Set<symbol>()
        for (let i = 0; i < bindings.length; i++) {
            const sym = bindings[i][0]
            ensureCanBind(sym, seen, "let")
            this.#ensureNotIntrinsic(sym, "let")
            const inf = ascope.getVarinfo(sym)
            if (!inf) throw new Error("Could not fetch varinfo")
            const destReg = opts.scope.addLocal(sym)
            opts.nodes.push({ t: inf.isBoxed ? "Box" : "Move", srcReg: initRegs[i], destReg })
        }
        this.#compileBody(expr.slice(2), { ...opts, ascope })
        opts.scope.exitBlock()
        for (const reg of initRegs) opts.scope.freeTemp(reg)
    }

    // (%letrec ((name init) ...) body ...): the names are bound first, so the inits can refer to any of them. The lambdas
    // are made first, all at once; the other inits then run in order. A name that is never assigned holds its value
    // directly, and the upvars captured before it existed are filled in once it does (FIXUPVAR); an assigned name (or
    // one a closure may copy before its init has run, see lateValues) is a box
    #compileLetrec(expr: any[], opts: CmpOpts) {
        const ascope = opts.analyzer.scopeMap.get(expr)
        if (!ascope) throw new Error(`internal error: could not find ascope for expr ${expr}`)
        const bindings: [symbol, any][] = expr[1]
        const isLambda = bindings.map(([, init]) => Array.isArray(init) && init[0] === CORE_LAMBDA)

        opts.scope.enterBlock()
        const seen = new Set<symbol>()
        const regs: number[] = []
        const boxed: boolean[] = []
        for (let i = 0; i < bindings.length; i++) {
            const sym = bindings[i][0]
            ensureCanBind(sym, seen, "letrec")
            this.#ensureNotIntrinsic(sym, "letrec")
            const inf = ascope.getVarinfo(sym)
            if (!inf) throw new Error("Could not fetch varinfo")
            const reg = opts.scope.addLocal(sym)
            regs.push(reg)
            boxed.push(inf.isBoxed)
            if (inf.isBoxed || !isLambda[i]) opts.nodes.push({ t: "LoadValue", constant: undefined, destReg: reg })
            if (inf.isBoxed) opts.nodes.push({ t: "Box", srcReg: reg, destReg: reg })
        }

        // every closure made here, with what it captured, so a name can be filled into them once its value exists
        const made: { reg: number, captures: readonly { index: number, local: boolean }[] }[] = []
        const temps: number[] = []
        const fillIn = (reg: number) => {
            for (const closure of made) {
                closure.captures.forEach((c, j) => {
                    if (c.local && c.index === reg) opts.nodes.push({ t: "FixUpvar", closureReg: closure.reg, upvarIdx: j, srcReg: reg })
                })
            }
        }
        const compileInit = (i: number) => {
            const dest = boxed[i] ? opts.scope.allocTemp() : regs[i]
            if (boxed[i]) temps.push(dest)
            const before = opts.nodes.length
            this.#compile(bindings[i][1], { ...opts, ascope, destReg: dest, isTail: false, name: bindings[i][0].description })
            if (boxed[i]) opts.nodes.push({ t: "SetBox", destReg: regs[i], srcReg: dest })
            return { dest, closure: opts.nodes.slice(before).reverse().find(n => n.t === "NewClosure") }
        }

        for (let i = 0; i < bindings.length; i++) {
            if (!isLambda[i]) continue
            const { dest, closure } = compileInit(i)
            made.push({ reg: dest, captures: closure?.t === "NewClosure" ? closure.template.upvarLocs : [] })
        }
        for (let i = 0; i < bindings.length; i++) if (isLambda[i] && !boxed[i]) fillIn(regs[i])
        for (let i = 0; i < bindings.length; i++) {
            if (isLambda[i]) continue
            compileInit(i)
            if (!boxed[i]) fillIn(regs[i])
        }
        for (const reg of temps) opts.scope.freeTemp(reg)

        this.#compileBody(expr.slice(2), { ...opts, ascope })
        opts.scope.exitBlock()
    }

    #getVar(varname: symbol, opts: CmpOpts, destReg?: number): Node[] {
        // Check if we can resolve it to a local/upvar
        const resolved = opts.scope.resolve(varname)
        //console.log(resolved)

        if (resolved.type === 'Local') {
            const aresolved = opts.ascope.getVarinfo(varname)
            if (!aresolved) throw new Error(`internal error: ${String(varname)} has no analysis info present`)
            if (aresolved.isBoxed) {
                if (destReg !== undefined) {
                    // Unbox
                    return [{t: "Unbox", srcReg: resolved.index, destReg }]
                }
            } else {
                // Move
                if (destReg !== undefined && resolved.index !== destReg) {
                    return [{t: "Move", srcReg: resolved.index, destReg }]
                }
            }
            return []
        } 
        
        if (resolved.type === 'Upvar') {
            const aresolved = opts.ascope.getVarinfo(varname)
            if (!aresolved) throw new Error(`internal error: ${String(varname)} has no analysis info present`)

            if (destReg !== undefined) {
                // right now, we need to load the upvalue in and unbox it (if boxed)
                return [{t: "LoadUpvar", upvarIdx: resolved.index, destReg, andUnbox: aresolved.isBoxed }]
            }
            return []
        }

        // Assume global
        if (destReg !== undefined) return [{t: "LoadGlobal", sym: varname, destReg}]
        const tmpReg = opts.scope.allocTemp()
        opts.scope.freeTemp(tmpReg)
        return [{t: "LoadGlobal", sym: varname, destReg: tmpReg}]
    }

    #setVar(varname: symbol, opts: CmpOpts, srcReg: number): Node[] {
        // Check if we can resolve it to a local/upvar
        const resolved = opts.scope.resolve(varname)

        if (resolved.type === 'Local') {
            const aresolved = opts.ascope.getVarinfo(varname)
            if (!aresolved) throw new Error(`internal error: ${String(varname)} has no analysis info present`)
            if (aresolved.isBoxed) {
                return [{ t: "SetBox", srcReg, destReg: resolved.index }]
            } else {
                if (srcReg !== resolved.index) {
                    return [{ t: "Move", srcReg, destReg: resolved.index }];
                }
            }
        } 
        
        if (resolved.type === 'Upvar') {
            const aresolved = opts.ascope.getVarinfo(varname)
            if (!aresolved) throw new Error(`internal error: ${String(varname)} has no analysis info present`)

            if (aresolved.isBoxed) {
                const tmpReg = opts.scope.allocTemp()
                const nodes: Node[] = [{t: "LoadUpvar", andUnbox: false, destReg: tmpReg, upvarIdx: resolved.index}, { t: "SetBox", destReg: tmpReg, srcReg }]
                opts.scope.freeTemp(tmpReg)
                return nodes
            } else {
                return [{ t: "SetUpvar", srcReg, upvarIdx: resolved.index, andBox: false }];
            }
        }

        // Assume global
        return [{t: "SetGlobal", sym: varname, srcReg}]
    }
}
