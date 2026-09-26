import { ASTStringifier, ensureCanBind, normalizeExpr, CORE_BEGIN, CORE_IF, CORE_LAMBDA, CORE_QUOTE, CORE_SET, CORE_BLOCK, CORE_ESCAPE, CORE_LOOP, CORE_LET, CORE_LET_VALUES, CORE_LET_VALUES_STRICT, CORE_WITH_MARK, OP_CURRENT_MARKS, OP_CURRENT_STACK, CORE_CATCH, OP_RAISE, OP_DEFINE_GLOBAL, unpackLambdaExprArgs, wrapMulti, Cons, SOURCE_POS, type SourcePos } from "../common";
import { AstAnalysis } from "./analysis";
import { AnalysisScope, CompilerScope } from "./scope";
import { IR, type Node, JumpLabel, ClosureTemplateIR } from "./ir";
import { arityMessage, rtIdx } from "./exec";
import { CORE_OPS, isCompilerIntrinsic } from "./core";
import { Intrinsics, type Intrinsic } from "./intrinsics";

const OP_DYNAMIC_WIND = Symbol.for("%dynamic-wind");
const OP_CALLCC = Symbol.for("%call/cc");
const OP_CALLEC = Symbol.for("%call/ec");
const OP_CO_YIELD = Symbol.for("%coroutine-yield");
const OP_CO_YIELD_LIST = Symbol.for("%coroutine-yield-list");
const OP_CO_RESUME = Symbol.for("%coroutine-resume");
const OP_CO_RESUME_LIST = Symbol.for("%coroutine-resume-list");
const OP_APPLY = Symbol.for("%apply");
const OP_APPLY_MARGS = Symbol.for("%apply-multi")

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

export class Compiler {
    #s = new ASTStringifier()

    constructor(readonly intrinsics: Intrinsics = new Intrinsics(isCompilerIntrinsic), private readonly debug: boolean = false) {}

    compile(trExpr: any, debug: boolean = this.debug) {
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
        } else if (!(expr instanceof Cons)) { // non-cons (string, number, boolean, undefined, etc.)
            if (opts.destReg === undefined) return  
            opts.nodes.push({t: "LoadValue", constant: expr, destReg: opts.destReg})
            return
        }

        if (expr.isImproper()) {
            throw new Error(`bad syntax: illegal use of dotted pair in execution context (consider quoting e.g. '${this.#s.stringify(expr)}')`);
        }

        const pos = SOURCE_POS.get(expr)
        if (pos !== undefined && pos !== opts.pos) {
            opts.nodes.push({ t: "Pos", pos })
            this.#compileForm(expr, { ...opts, pos })
            if (opts.pos !== undefined) opts.nodes.push({ t: "Pos", pos: opts.pos })
            return
        }
        this.#compileForm(expr, opts)
    }

    #compileForm(expr: Cons, opts: CmpOpts) {
        const name = opts.name
        if (name !== undefined) opts = { ...opts, name: undefined }
        const operator = expr.car;

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
                case CORE_LAMBDA:
                    this.#compileLambda(expr, opts, name)
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
                case OP_CURRENT_STACK: {
                    const skip = expr.cdr === null ? 0 : expr.cdr.car
                    if (expr.length > 2 || !Number.isInteger(skip) || skip < 0) throw new Error("%current-stack takes an optional literal count of frames to skip")
                    opts.nodes.push({ t: "CurrentStack", skip, destReg: opts.destReg })
                    return
                }
                case OP_CURRENT_MARKS:
                    if (opts.destReg !== undefined) opts.nodes.push({ t: "CurrentMarks", destReg: opts.destReg })
                    return
                case OP_DYNAMIC_WIND:
                    this.#compileDynamicWind(expr, opts)
                    return
                case OP_CALLCC:
                    this.#compileCallCC(expr, opts)
                    return
                case OP_CALLEC:
                    this.#compileCallEC(expr, opts)
                    return
                case CORE_CATCH:
                    this.#compileCatch(expr, opts)
                    return
                case OP_RAISE:
                    this.#compileRaise(expr, opts)
                    return
                case OP_DEFINE_GLOBAL:
                    this.#compileDefine(expr, opts)
                    return
                case OP_CO_YIELD:
                    this.#compileRuntimeOp(expr, opts, 0, Infinity, (start, nargs, dest) => {
                        if (nargs === 1) {
                            opts.nodes.push({ t: "CoYield", valReg: start, destReg: dest })
                            return
                        }
                        this.#withRtResult(opts, "%values", start, nargs, valReg => opts.nodes.push({ t: "CoYield", valReg, destReg: dest }))
                    })
                    return
                case OP_CO_RESUME:
                    this.#compileRuntimeOp(expr, opts, 1, Infinity, (start, nargs, dest) => {
                        this.#withRtResult(opts, "%list", start + 1, nargs - 1, listReg => {
                            opts.nodes.push({ t: "CoResume", coReg: start, listReg, isTail: opts.isTail, destReg: dest })
                        })
                    })
                    return
                case OP_CO_RESUME_LIST:
                    this.#compileRuntimeOp(expr, opts, 2, 2, (start, nargs, dest) => {
                        opts.nodes.push({ t: "CoResume", coReg: start, listReg: start + 1, isTail: opts.isTail, destReg: dest })
                    })
                    return
                case OP_CO_YIELD_LIST:
                    this.#compileRuntimeOp(expr, opts, 1, 1, (start, nargs, dest) => {
                        this.#withDest(opts, undefined, valReg => {
                            opts.nodes.push({ t: "RtCall", rtIdx: rtIdx("%list->values"), destReg: valReg, startReg: start, nargs })
                            opts.nodes.push({ t: "CoYield", valReg, destReg: dest })
                        })
                    })
                    return
                case OP_APPLY:
                    this.#compileApply(expr, opts)
                    return
                case OP_APPLY_MARGS:
                    this.#compileApplyMulti(expr, opts)
                    return
            }

            const op = CORE_OPS.get(operator)
            if (op !== undefined) {
                this.#compileRuntimeOp(expr, opts, op.min, op.max, (start, nargs, dest) => {
                    this.#withDest(opts, dest, destReg => opts.nodes.push({ t: "RtCall", rtIdx: op.idx, destReg, startReg: start, nargs }))
                })
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
                    opts.nodes.push({ t: "HostCall", pos: intrinsic.pos, startReg: start, nargs, isTail: opts.isTail, destReg: dest })
                })
                return
            }
        }

        this.#compileNormalCall(expr, opts)
    }

    #compileBegin(expr: Cons, opts: CmpOpts) {
        // We need to load a void if we see an empty begin block
        if (expr.cdr === null) {
            if (opts.destReg === undefined) return 
            opts.nodes.push({t: "LoadValue", constant: undefined, destReg: opts.destReg})
            return
        }

        let curr: any = expr.cdr;
        while (curr instanceof Cons) {
            const isLastChild = (curr.cdr === null);
            const childIsTail = isLastChild && opts.isTail;
            this.#compile(curr.car, { ...opts, destReg: isLastChild ? opts.destReg : undefined, isTail: childIsTail });
            curr = curr.cdr;
        }
    }

    // compiles both if calls as well as code that is converted into if calls
    // (%if c1 e1 c2 e2 ... [else]): the first ei whose ci is true, else `else` (or <#void>). One chain whatever the number
    // of clauses: IF c1 L1; e1; ELSE end; L1: <c2>; ELSEIF c2 L2; e2; ELSE end; L2: ...; else; ENDIF; end:
    #compileIfCall(expr: Cons, opts: CmpOpts) {
        const args = expr.cdr instanceof Cons ? expr.cdr.toArray() : []
        if (args.length < 2) {
            throw new Error(`%if requires at least a condition and a branch: (%if c1 e1 c2 e2 ... [else]), but got ${args.length} arguments`)
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

    #compileQuote(expr: Cons, opts: CmpOpts) {
        if (expr.length !== 2) {
            throw new Error(`quote must be in format ["quote", expr] but have ${expr.length-1} arguments`)
        }
        if (opts.destReg === undefined) return
        opts.nodes.push({t: "LoadValue", constant: normalizeExpr(expr.cdr.car), destReg: opts.destReg})
    }

    // note that the syntax transformer alr handles defines inside a lambda so
    #compileDefine(expr: Cons, opts: CmpOpts) {
        const sym = expr.cdr.car;
        const val = expr.cdr.cdr.car;
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

    #compileSet(expr: Cons, opts: CmpOpts) {
        // AnimaTransform ensures sets are of correct form
        const sym = expr.cdr.car;
        this.#ensureNotIntrinsic(sym, "set!")
        const val = expr.cdr.cdr.car;

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

    #compileLambda(expr: Cons, opts: CmpOpts, name?: string) {
        // AnimaTransform ensures lambdas are of correct form
        const lambdaScope = new CompilerScope(opts.scope)
        const ascope = opts.analyzer.scopeMap.get(expr)
        if (!ascope) throw new Error(`internal error: could not find ascope for expr ${expr}`)

        const { params, remParams } = unpackLambdaExprArgs(expr, "lambda")
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
        const body = expr.cdr.cdr;
        this.#compile(wrapMulti(body), {...opts, destReg: retReg, isTail: true, nodes: lambdaNodes, scope: lambdaScope, ascope, fnDepth: (opts.fnDepth ?? 0) + 1 })
        if (!this.#nodesEndsInRet(lambdaNodes)) {
            lambdaNodes.push({t: "Return", reg: retReg})
        }
        const displayName = name ?? (opts.pos !== undefined ? `lambda@${opts.pos.file}:${opts.pos.line}` : "lambda")
        const template = new ClosureTemplateIR(params, remParams, lambdaNodes, lambdaScope.numRegs, lambdaScope.upvars, displayName);
        opts.nodes.push({t: "NewClosure", template: template, destReg: opts.destReg})
    }

    // (%let-values ((formals expr) ...) body ...): every expr is evaluated and spread into registers (UNPACK), then
    // all the variables are bound in a block, as in %let
    #compileLetValues(expr: Cons, opts: CmpOpts, strict: boolean) {
        const ascope = opts.analyzer.scopeMap.get(expr)
        if (!ascope) throw new Error(`internal error: could not find ascope for expr ${expr}`)
        const clauses = expr.cdr.car === null ? [] : (expr.cdr.car as Cons).toArray() as Cons[]

        const bound: { sym: symbol, reg: number }[] = []
        const blocks: { start: number, size: number }[] = []
        for (const clause of clauses) {
            const names: symbol[] = []
            let formals: any = clause.car
            while (formals instanceof Cons) {
                names.push(formals.car)
                formals = formals.cdr
            }
            const rest: symbol | null = formals
            const valReg = opts.scope.allocTemp()
            this.#compile(clause.cdr.car, { ...opts, destReg: valReg, isTail: false })
            const size = names.length + (rest !== null ? 1 : 0)
            const start = opts.scope.regAlloc.allocBlock(size)
            opts.nodes.push({ t: "Unpack", srcReg: valReg, startReg: start, count: names.length, rest: rest !== null, strict })
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
        this.#compileBegin(new Cons(CORE_BEGIN, expr.cdr.cdr), { ...opts, ascope })
        opts.scope.exitBlock()
        for (const { start, size } of blocks) opts.scope.regAlloc.freeBlock(start, size)
    }

    // (%block name body ...): the value of the body, or of an (%escape name value) jumping to its end
    #compileBlock(expr: Cons, opts: CmpOpts) {
        const end = new JumpLabel()
        const target: BlockTarget = {
            name: expr.cdr.car, end, destReg: opts.destReg, isTail: opts.isTail, fnDepth: opts.fnDepth ?? 0,
            markDepth: opts.markRegions?.length ?? 0, parent: opts.blocks,
        }
        opts.nodes.push({ t: "Block", end })
        this.#compileBegin(new Cons(CORE_BEGIN, expr.cdr.cdr), { ...opts, blocks: target })
        opts.nodes.push({ t: "Label", label: end })
    }

    #compileEscape(expr: Cons, opts: CmpOpts) {
        const name: symbol = expr.cdr.car
        let target = opts.blocks
        while (target !== undefined && target.name !== name) target = target.parent
        if (target === undefined) throw new Error(`%escape: no enclosing block named ${String(name.description)}`)
        if (target.fnDepth !== (opts.fnDepth ?? 0)) {
            throw new Error(`%escape: cannot escape to block ${String(name.description)} from inside a lambda`)
        }
        // the value is computed as if it were the block's own value: into its register, in its tail position
        const valueOpts = { ...opts, destReg: target.destReg, isTail: target.isTail }
        if (expr.cdr.cdr !== null) this.#compile(expr.cdr.cdr.car, valueOpts)
        else this.#compile(undefined, valueOpts)
        const regions = opts.markRegions ?? []
        if (regions.length > target.markDepth) opts.nodes.push({ t: "MarkRestore", reg: regions[target.markDepth] })
        opts.nodes.push({ t: "Jump", label: target.end })
    }

    // (%with-mark key value body): in tail position the mark goes on the current frame (replacing its value for the key)
    // and stays until the frame returns; otherwise the body runs as a new frame, so the marks are saved and put back after
    #compileWithMark(expr: Cons, opts: CmpOpts) {
        const [key, value, body] = expr.cdr.toArray()
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
    #compileLoop(expr: Cons, opts: CmpOpts) {
        const head = new JumpLabel()
        const end = new JumpLabel()
        opts.nodes.push({ t: "Loop", end })
        opts.nodes.push({ t: "Label", label: head })
        let curr: any = expr.cdr
        while (curr instanceof Cons) {
            this.#compile(curr.car, { ...opts, destReg: undefined, isTail: false })
            curr = curr.cdr
        }
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
            lastNode.t === "TailApply" ||
            lastNode.t === "Return" ||
            lastNode.t === "TailCallCC" ||
            (lastNode.t === "HostCall" && lastNode.isTail) ||
            (lastNode.t === "CoResume" && lastNode.isTail)
        ) {
            return true // all of these ops alr return
        }
        return false
    }

    #compileDynamicWind(expr: Cons, opts: CmpOpts) {
        if (expr.length !== 4) {
            throw new Error(`%dynamic-wind requires 3 arguments (before, thunk, after), got ${expr.length - 1}`);
        }
        // before and after are adjacent so they form the argument window of the wind runtime call
        const block = opts.scope.regAlloc.allocBlock(3);
        const beforeProcReg = block, afterProcReg = block + 1, thunkProcReg = block + 2;

        this.#compile(expr.cdr.car, { ...opts, destReg: beforeProcReg, isTail: false });
        this.#compile(expr.cdr.cdr.car, { ...opts, destReg: thunkProcReg, isTail: false });
        this.#compile(expr.cdr.cdr.cdr.car, { ...opts, destReg: afterProcReg, isTail: false });

        opts.nodes.push({ t: "Call", procReg: beforeProcReg, startReg: 0, nargs: 0 });
        this.#withDest(opts, undefined, destReg => opts.nodes.push({ t: "RtCall", rtIdx: rtIdx("%wind"), destReg, startReg: beforeProcReg, nargs: 2 }));
        opts.nodes.push({ t: "Call", procReg: thunkProcReg, destReg: opts.destReg, startReg: 0, nargs: 0 });
        this.#withDest(opts, undefined, destReg => opts.nodes.push({ t: "RtCall", rtIdx: rtIdx("%end-wind"), destReg, startReg: 0, nargs: 0 }));
        opts.nodes.push({ t: "Call", procReg: afterProcReg, startReg: 0, nargs: 0 });

        opts.scope.regAlloc.freeBlock(block, 3);
    }

    #compileCallCC(expr: Cons, opts: CmpOpts) {
        if (expr.length !== 2) {
            throw new Error(`%call/cc requires 1 argument, got ${expr.length - 1}`);
        }
        const procReg = opts.scope.allocTemp();
        this.#compile(expr.cdr.car, { ...opts, destReg: procReg, isTail: false });
        if (opts.isTail) {
            opts.nodes.push({ t: "TailCallCC", procReg });
        } else {
            opts.nodes.push({ t: "CallCC", destReg: opts.destReg, procReg });
        }
        opts.scope.freeTemp(procReg);
    }

    // always a non-tail call: the escape continuation is deactivated when it returns
    #compileCallEC(expr: Cons, opts: CmpOpts) {
        if (expr.length !== 2) {
            throw new Error(`%call/ec requires 1 argument, got ${expr.length - 1}`);
        }
        const procReg = opts.scope.allocTemp();
        const tokReg = opts.scope.allocTemp();
        this.#compile(expr.cdr.car, { ...opts, destReg: procReg, isTail: false });
        opts.nodes.push({ t: "CallEC", procReg, tokReg, destReg: opts.destReg });
        opts.scope.freeTemp(tokReg);
        opts.scope.freeTemp(procReg);
    }

    // (%raise obj [continuable]): continuable must be a literal
    #compileRaise(expr: Cons, opts: CmpOpts) {
        if (expr.length !== 2 && expr.length !== 3) {
            throw new Error(`%raise requires 1 or 2 arguments (obj, continuable), got ${expr.length - 1}`);
        }
        const flag = expr.length === 3 ? expr.cdr.cdr.car : false;
        if (typeof flag !== "boolean") throw new Error("%raise: continuable must be #t or #f");
        const objReg = opts.scope.allocTemp();
        this.#compile(expr.cdr.car, { ...opts, destReg: objReg, isTail: false });
        opts.nodes.push({ t: "Raise", objReg, continuable: flag, destReg: opts.destReg });
        opts.scope.freeTemp(objReg);
    }

    // (%catch thunk handler [pre]): CALLCATCH gives the value of (thunk), or a Caught when it raised, after which the
    // handler expression is evaluated and called with the error (in tail position if the %catch is); pre is evaluated
    // first, and runs on the error before unwinding
    #compileCatch(expr: Cons, opts: CmpOpts) {
        if (expr.length !== 3 && expr.length !== 4) {
            throw new Error(`%catch requires 2 or 3 arguments (thunk, handler, pre), got ${expr.length - 1}`);
        }
        const procReg = opts.scope.allocTemp();
        const tokReg = opts.scope.allocTemp();
        const resReg = opts.scope.allocTemp();
        const preReg = expr.length === 4 ? opts.scope.allocTemp() : undefined;
        this.#compile(expr.cdr.car, { ...opts, destReg: procReg, isTail: false });
        if (preReg !== undefined) this.#compile(expr.cdr.cdr.cdr.car, { ...opts, destReg: preReg, isTail: false });
        opts.nodes.push({ t: "CallCatch", procReg, tokReg, preReg, destReg: resReg });
        if (preReg !== undefined) opts.scope.freeTemp(preReg);
        opts.scope.freeTemp(tokReg);
        opts.scope.freeTemp(procReg);

        const condReg = opts.scope.allocTemp();
        opts.nodes.push({ t: "RtCall", rtIdx: rtIdx("%caught?"), destReg: condReg, startReg: resReg, nargs: 1 });
        const elseLabel = new JumpLabel();
        const endLabel = new JumpLabel();
        opts.nodes.push({ t: "If", reg: condReg, elseLabel });
        opts.scope.freeTemp(condReg);

        const call = opts.scope.regAlloc.allocBlock(2);
        this.#compile(expr.cdr.cdr.car, { ...opts, destReg: call, isTail: false });
        opts.nodes.push({ t: "RtCall", rtIdx: rtIdx("%caught-value"), destReg: call + 1, startReg: resReg, nargs: 1 });
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

    #compileRuntimeOp(expr: Cons, opts: CmpOpts, minArgs: number, maxArgs: number, emit: (startReg: number, nargs: number, destReg: number | undefined) => void) {
        const nargs = expr.cdr === null ? 0 : expr.cdr.length
        if (nargs < minArgs || nargs > maxArgs) throw new Error(arityMessage(String(expr.car.description), minArgs, maxArgs, nargs))
        const startReg = opts.scope.regAlloc.allocBlock(nargs)
        let curr: any = expr.cdr
        let i = 0
        while (curr instanceof Cons) {
            this.#compile(curr.car, { ...opts, destReg: startReg + i, isTail: false })
            i++
            curr = curr.cdr
        }
        emit(startReg, nargs, opts.destReg)
        opts.scope.regAlloc.freeBlock(startReg, nargs)
    }

    #withRtResult(opts: CmpOpts, op: string, startReg: number, nargs: number, use: (reg: number) => void) {
        const reg = opts.scope.allocTemp()
        opts.nodes.push({ t: "RtCall", rtIdx: rtIdx(op), destReg: reg, startReg, nargs })
        use(reg)
        opts.scope.freeTemp(reg)
    }

    #withDest(opts: CmpOpts, dest: number | undefined, push: (destReg: number) => void) {
        const destReg = dest ?? opts.scope.allocTemp()
        push(destReg)
        if (dest === undefined) opts.scope.freeTemp(destReg)
    }

    #isIntrinsic(sym: symbol): boolean {
        return isCompilerIntrinsic(sym) || this.intrinsics.get(sym) !== undefined
    }

    // a call of an intrinsic's name always calls the intrinsic, so the name cannot be a variable too; nor can the names
    // the front end reserved
    #ensureNotIntrinsic(sym: any, syntaxCtx: string) {
        if (typeof sym !== "symbol") return
        const reserved = this.intrinsics.reserved.get(sym)
        if (reserved === "special form") throw new Error(`${String(sym)}: bad syntax`)
        if (reserved === "builtin") throw new Error(`${syntaxCtx}: cannot bind builtin ${Symbol.keyFor(sym)}`)
        if (this.#isIntrinsic(sym)) throw new Error(`${syntaxCtx}: cannot bind ${String(sym.description)}, which is an intrinsic`)
    }

    #resolveProcReg(procExpr: any, opts: CmpOpts): { procReg: number; isTemp: boolean } {
        if (typeof procExpr === "symbol" && this.#isIntrinsic(procExpr)) {
            throw new Error(`${String(procExpr.description)} is an intrinsic and cannot be used as a procedure value`);
        }
        const procReg = opts.scope.allocTemp();
        this.#compile(procExpr, { ...opts, destReg: procReg, isTail: false });
        return { procReg, isTemp: true };
    }

    #compileApply(expr: Cons, opts: CmpOpts) {
        if (expr.length < 3) {
            throw new Error(`%apply requires at least 2 arguments (proc, ...args, args-lst), got ${expr.length - 1}`);
        }
        const procExpr = expr.cdr.car;
        const argsExprList = expr.cdr.cdr;
        const intrinsic = typeof procExpr === "symbol" ? this.intrinsics.get(procExpr) : undefined;
        if (intrinsic !== undefined) {
            this.#compileApplyIntrinsic(intrinsic, argsExprList, opts);
            return;
        }
        const { procReg, isTemp } = this.#resolveProcReg(procExpr, opts);

        const nargs = argsExprList === null ? 0 : argsExprList.length;
        const startReg = opts.scope.regAlloc.allocBlock(nargs);
        let curr: any = argsExprList;
        let i = 0;
        while (curr instanceof Cons) {
            this.#compile(curr.car, { ...opts, destReg: startReg + i, isTail: false });
            i++;
            curr = curr.cdr;
        }

        this.#emitApplyNode(opts, procReg, startReg, nargs);

        opts.scope.regAlloc.freeBlock(startReg, nargs);
        if (isTemp) opts.scope.freeTemp(procReg);
    }

    // (%apply %intrinsic arg ... lst): the argument count is only known at run time, so APPLYINT checks it there
    #compileApplyIntrinsic(intrinsic: Intrinsic, argsExprList: any, opts: CmpOpts) {
        if (!intrinsic.leaf) throw new Error(`%apply: ${intrinsic.name} is not a leaf intrinsic, so it cannot be applied`);
        const nargs = argsExprList === null ? 0 : argsExprList.length;
        const startReg = opts.scope.regAlloc.allocBlock(nargs);
        let curr: any = argsExprList;
        let i = 0;
        while (curr instanceof Cons) {
            this.#compile(curr.car, { ...opts, destReg: startReg + i, isTail: false });
            i++;
            curr = curr.cdr;
        }
        this.#withDest(opts, opts.destReg, destReg => opts.nodes.push({ t: "IntApply", pos: intrinsic.pos, destReg, startReg, nargs }));
        opts.scope.regAlloc.freeBlock(startReg, nargs);
    }

    #compileApplyMulti(expr: Cons, opts: CmpOpts) {
        if (expr.length !== 3) {
            throw new Error(`%apply-multi requires exactly 2 arguments (proc, args-list), got ${expr.length - 1}`);
        }
        const procExpr = expr.cdr.car;
        const lstExpr = expr.cdr.cdr.car;

        const { procReg, isTemp } = this.#resolveProcReg(procExpr, opts);

        const listReg = opts.scope.allocTemp();
        this.#compile(lstExpr, { ...opts, destReg: listReg, isTail: false });
        opts.nodes.push({ t: "RtCall", rtIdx: rtIdx("%apply-args"), destReg: listReg, startReg: listReg, nargs: 1 });
        this.#emitApplyNode(opts, procReg, listReg, 1);

        opts.scope.freeTemp(listReg);
        if (isTemp) opts.scope.freeTemp(procReg);
    }

    #emitApplyNode(opts: CmpOpts, procReg: number, startReg: number, nargs: number) {
        if (opts.isTail) {
            opts.nodes.push({ t: "TailApply", procReg, startReg, nargs });
        } else {
            opts.nodes.push({ t: "Apply", destReg: opts.destReg, procReg, startReg, nargs });
        }
    }
    // a normal call
    #compileNormalCall(expr: Cons, opts: CmpOpts) {
        // We need to compile the proc and place it on its own tempval
        const { procReg, isTemp } = this.#resolveProcReg(expr.car, opts);

        // Push all arguments to a contiguous reg block
        const nargs = expr.cdr === null ? 0 : expr.cdr.length;
        const startReg = opts.scope.regAlloc.allocBlock(nargs);
        let curr: any = expr.cdr;
        let i = 0;
        while (curr instanceof Cons) {
            this.#compile(curr.car, { ...opts, destReg: startReg + i, isTail: false });
            i++;
            curr = curr.cdr;
        }

        if (opts.isTail) {
            opts.nodes.push({t: "TailCall", nargs, procReg, startReg})
        } else {
            opts.nodes.push({t: "Call", destReg: opts.destReg, nargs, procReg, startReg})
        }

        opts.scope.regAlloc.freeBlock(startReg, nargs)
        if (isTemp) opts.scope.freeTemp(procReg)
    }

    // (%let ((x init) ...) body ...): inits are evaluated in the outer scope, then bound in a block of this function
    #compileLet(expr: Cons, opts: CmpOpts) {
        const ascope = opts.analyzer.scopeMap.get(expr)
        if (!ascope) throw new Error(`internal error: could not find ascope for expr ${expr}`)
        const bindings = expr.cdr.car === null ? [] : (expr.cdr.car as Cons).toArray() as Cons[]

        const initRegs: number[] = []
        for (const binding of bindings) {
            const reg = opts.scope.allocTemp()
            this.#compile(binding.cdr.car, { ...opts, destReg: reg, isTail: false, name: binding.car.description })
            initRegs.push(reg)
        }

        opts.scope.enterBlock()
        const seen = new Set<symbol>()
        for (let i = 0; i < bindings.length; i++) {
            const sym = bindings[i].car
            ensureCanBind(sym, seen, "let")
            this.#ensureNotIntrinsic(sym, "let")
            const inf = ascope.getVarinfo(sym)
            if (!inf) throw new Error("Could not fetch varinfo")
            const destReg = opts.scope.addLocal(sym)
            opts.nodes.push({ t: inf.isBoxed ? "Box" : "Move", srcReg: initRegs[i], destReg })
        }
        this.#compileBegin(new Cons(CORE_BEGIN, expr.cdr.cdr), { ...opts, ascope })
        opts.scope.exitBlock()
        for (const reg of initRegs) opts.scope.freeTemp(reg)
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
