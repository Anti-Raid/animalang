import { ASTStringifier, ensureCanBind, normalizeExpr, OP_BEGIN, OP_IF, OP_LAMBDA, OP_QUOTE, OP_SET, OP_DEFINE, OP_DEFINE_GLOBAL, unpackLambdaExprArgs, wrapMulti, Cons, SOURCE_POS, type SourcePos } from "../common";
import { AstAnalysis } from "./analysis";
import { AnalysisScope, CompilerScope } from "./scope";
import { IR, type Node, JumpLabel, ClosureTemplateIR } from "./ir";
import { IBUILTINS_IDX_MAP } from "../std";
import { CXR_PATHS, PREDICATES, ARITHMETIC } from "../ops";
import { BUILTINS_START, OpCode, RUNTIME_IDX } from "./exec";

const OP_DYNAMIC_WIND = Symbol.for("%dynamic-wind");
const OP_CALLCC = Symbol.for("%call/cc");
const OP_CO_YIELD = Symbol.for("%coroutine-yield");
const OP_CO_YIELD_LIST = Symbol.for("%coroutine-yield-list");
const OP_CO_RESUME = Symbol.for("%coroutine-resume");
const OP_CO_RESUME_LIST = Symbol.for("%coroutine-resume-list");
const OP_APPLY = Symbol.for("%apply");
const OP_APPLY_MARGS = Symbol.for("%apply-multi")

const BUILTIN_INTRINSICS = new Map<symbol, number>([
    ...[...ARITHMETIC, ...PREDICATES, ...CXR_PATHS].map(([name]) => name),
    "list",
    "cons",
    "vector-ref",
    "vector-set!",
    "vector-length",
].map(name => [Symbol.for(`%${name}`), IBUILTINS_IDX_MAP.get(Symbol.for(name))!]))

const RUNTIME_INTRINSICS = new Map<symbol, { idx: number, min: number, max: number }>(([
    ["%set-raise-proc", "set-raise-proc", 1, 1],
    ["%handlers", "handlers", 0, 0],
    ["%set-handlers!", "set-handlers!", 1, 1],
    ["%coroutine-create", "coroutine-create", 1, 1],
    ["%coroutine-status", "coroutine-status", 1, 1],
    ["%coroutine-close", "coroutine-close", 1, 1],
    ["%values->list", "values->list", 1, 1],
    ["%debug-frames", "debug-frames", 2, 2],
    ["%debug-traceback", "debug-traceback", 2, 2],
] as [string, string, number, number][]).map(([form, name, min, max]) => [Symbol.for(form), { idx: RUNTIME_IDX.get(name)!, min, max }]))

interface CmpOpts {
    destReg?: number // where to store dest reg
    isTail: boolean // whether this is a tail-call or not (for tco)
    nodes: Node[]
    scope: CompilerScope,
    pos?: SourcePos // position of the enclosing form
    name?: string // name for a lambda compiled directly as this value

    // From pass 1
    ascope: AnalysisScope,
    analyzer: AstAnalysis
}

export class Compiler {
    #s = new ASTStringifier()

    constructor(private readonly debug: boolean = false) {}

    compile(trExpr: any, debug: boolean = this.debug) {
        // Step 1 is to analyze our variables so we know what to box and what not to box
        let analyzer = new AstAnalysis()
        const ascope = analyzer.analyze(trExpr)

        const scope = new CompilerScope(null)
        const nodes: Node[] = []
        const retReg = scope.allocTemp(); // no need to free the temp reg as we return?
        this.#compile(trExpr, {destReg: retReg, isTail: true, nodes, scope, ascope, analyzer})
        if (!this.#nodesEndsInRet(nodes)) {
            nodes.push({t: "Return", reg: retReg})
        }
        const ir = new IR(debug)
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
                case OP_BEGIN:
                    this.#compileBegin(expr, opts)
                    return
                case OP_IF:
                    this.#compileIfCall(expr, opts)
                    return
                case OP_QUOTE:
                    this.#compileQuote(expr, opts)
                    return
                case OP_DEFINE:
                    this.#compileDefine(expr, opts)
                    return
                case OP_SET:
                    this.#compileSet(expr, opts)
                    return
                case OP_LAMBDA:
                    this.#compileLambda(expr, opts, name)
                    return
                case OP_DYNAMIC_WIND:
                    this.#compileDynamicWind(expr, opts)
                    return
                case OP_CALLCC:
                    this.#compileCallCC(expr, opts)
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
                        this.#withBuiltinResult(opts, "values", start, nargs, valReg => opts.nodes.push({ t: "CoYield", valReg, destReg: dest }))
                    })
                    return
                case OP_CO_RESUME:
                    this.#compileRuntimeOp(expr, opts, 1, Infinity, (start, nargs, dest) => {
                        this.#withBuiltinResult(opts, "list", start + 1, nargs - 1, listReg => {
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
                            opts.nodes.push({ t: "RtCall", rtIdx: RUNTIME_IDX.get("list->values")!, destReg: valReg, startReg: start, nargs })
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

            const runtime = RUNTIME_INTRINSICS.get(operator)
            if (runtime !== undefined) {
                this.#compileRuntimeOp(expr, opts, runtime.min, runtime.max, (start, nargs, dest) => {
                    this.#withDest(opts, dest, destReg => opts.nodes.push({ t: "RtCall", rtIdx: runtime.idx, destReg, startReg: start, nargs }))
                })
                return
            }

            const builtinIdx = BUILTIN_INTRINSICS.get(operator)
            if (builtinIdx !== undefined) {
                this.#compileWindowIntrinsic(expr, builtinIdx, opts)
                return
            }
        }

        // intrinsic
        const builtinsIdx = IBUILTINS_IDX_MAP.get(operator)
        if (builtinsIdx !== undefined) {
            this.#compileWindowIntrinsic(expr, builtinsIdx, opts)
            return
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
    #compileIfCall(expr: Cons, opts: CmpOpts) {
        if (expr.length !== 4) {
            throw new Error(`if condition must be in format ["if", condition, true_expr, false_expr] but only have ${expr.length-1} arguments`)
        }

        const cond = expr.cdr.car;
        const thenExpr = expr.cdr.cdr.car;
        const elseExpr = expr.cdr.cdr.cdr.car;

        // We need to compile the first arg first and leave it to a temp reg
        const condReg = opts.scope.allocTemp()
        this.#compile(cond, { ...opts, destReg: condReg, isTail: false })
        // we place the bytecode as <jumpiffalse [false code]><true code><jump [|]><false code>|
        const falseLabel = new JumpLabel()
        const endLabel = new JumpLabel()
        opts.nodes.push({t: "If", reg: condReg, elseLabel: falseLabel})
        opts.scope.freeTemp(condReg) // we can free the reg here
        // Place true code
        this.#compile(thenExpr, opts)
        // Place else separator
        opts.nodes.push({t: "Else", endLabel})
        // Place false code as well as jump to start of false code
        opts.nodes.push({t:"Label", label: falseLabel})
        this.#compile(elseExpr, opts)
        // Place EndIf and end label
        opts.nodes.push({t: "EndIf"})
        opts.nodes.push({t: "Label", label: endLabel})
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
        this.#compile(wrapMulti(body), {...opts, destReg: retReg, isTail: true, nodes: lambdaNodes, scope: lambdaScope, ascope })
        if (!this.#nodesEndsInRet(lambdaNodes)) {
            lambdaNodes.push({t: "Return", reg: retReg})
        }
        const displayName = name ?? (opts.pos !== undefined ? `lambda@${opts.pos.file}:${opts.pos.line}` : "lambda")
        const template = new ClosureTemplateIR(params, remParams, lambdaNodes, lambdaScope.numRegs, lambdaScope.upvars, displayName);
        opts.nodes.push({t: "NewClosure", template: template, destReg: opts.destReg})
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
        this.#withDest(opts, undefined, destReg => opts.nodes.push({ t: "RtCall", rtIdx: RUNTIME_IDX.get("wind")!, destReg, startReg: beforeProcReg, nargs: 2 }));
        opts.nodes.push({ t: "Call", procReg: thunkProcReg, destReg: opts.destReg, startReg: 0, nargs: 0 });
        this.#withDest(opts, undefined, destReg => opts.nodes.push({ t: "RtCall", rtIdx: RUNTIME_IDX.get("end-wind")!, destReg, startReg: 0, nargs: 0 }));
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

    #compileRuntimeOp(expr: Cons, opts: CmpOpts, minArgs: number, maxArgs: number, emit: (startReg: number, nargs: number, destReg: number | undefined) => void) {
        const nargs = expr.cdr === null ? 0 : expr.cdr.length
        if (nargs < minArgs || nargs > maxArgs) {
            const expected = minArgs === maxArgs ? `${minArgs}` : maxArgs === Infinity ? `at least ${minArgs}` : `${minArgs} to ${maxArgs}`
            throw new Error(`${String(expr.car.description)} requires ${expected} arguments, got ${nargs}`)
        }
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

    #withBuiltinResult(opts: CmpOpts, builtin: string, startReg: number, nargs: number, use: (reg: number) => void) {
        const reg = opts.scope.allocTemp()
        opts.nodes.push({ t: "IBuiltin", builtinIdx: BUILTINS_START + IBUILTINS_IDX_MAP.get(Symbol.for(builtin))!, destReg: reg, startReg, nargs })
        use(reg)
        opts.scope.freeTemp(reg)
    }

    #withDest(opts: CmpOpts, dest: number | undefined, push: (destReg: number) => void) {
        const destReg = dest ?? opts.scope.allocTemp()
        push(destReg)
        if (dest === undefined) opts.scope.freeTemp(destReg)
    }

    #compileWindowIntrinsic(expr: Cons, builtinIdx: number, opts: CmpOpts) {
        const nargs = expr.cdr === null ? 0 : expr.cdr.length
        const startReg = opts.scope.regAlloc.allocBlock(nargs)
        let curr: any = expr.cdr
        let i = 0
        while (curr instanceof Cons) {
            this.#compile(curr.car, { ...opts, destReg: startReg + i, isTail: false })
            i++
            curr = curr.cdr
        }

        const destReg = opts.destReg ?? opts.scope.allocTemp()
        opts.nodes.push({ t: "IBuiltin", builtinIdx: BUILTINS_START + builtinIdx, destReg, startReg, nargs })
        if (opts.destReg === undefined) opts.scope.freeTemp(destReg)
        opts.scope.regAlloc.freeBlock(startReg, nargs)
    }

    #resolveProcReg(procExpr: any, opts: CmpOpts): { procReg: number; isTemp: boolean } {
        if (BUILTIN_INTRINSICS.has(procExpr) || RUNTIME_INTRINSICS.has(procExpr)) {
            throw new Error(`${String(procExpr.description)} is an intrinsic and cannot be used as a procedure value`);
        }
        if (typeof procExpr === "symbol") {
            const resolved = opts.scope.resolve(procExpr);
            if (resolved.type === "Global") {
                const builtinsIdx = IBUILTINS_IDX_MAP.get(procExpr);
                if (builtinsIdx !== undefined) {
                    return { procReg: BUILTINS_START + builtinsIdx, isTemp: false };
                }
            }
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

    #compileApplyMulti(expr: Cons, opts: CmpOpts) {
        if (expr.length !== 3) {
            throw new Error(`%apply-multi requires exactly 2 arguments (proc, args-list), got ${expr.length - 1}`);
        }
        const procExpr = expr.cdr.car;
        const lstExpr = expr.cdr.cdr.car;

        const { procReg, isTemp } = this.#resolveProcReg(procExpr, opts);

        const listReg = opts.scope.allocTemp();
        this.#compile(lstExpr, { ...opts, destReg: listReg, isTail: false });
        opts.nodes.push({ t: "RtCall", rtIdx: RUNTIME_IDX.get("apply-args")!, destReg: listReg, startReg: listReg, nargs: 1 });
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
        // Try IIFE optimizations
        if(this.#optIIFE(expr, opts)) {
            return
        }

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

    #optIIFE(expr: Cons, opts: CmpOpts): boolean {
        // if we have a non-variadic IIFE ((lambda (params...) body) args...), then we can optimize it down
        // to BLOCK/ENDBLOCK instead of doing a whole function call
        const first = expr.car;
        if (first instanceof Cons && (first.car === OP_LAMBDA)) {
            const rawParams = first.cdr.car;
            // Non-variadic params: null (empty list) or proper Cons list
            if (rawParams === null || (rawParams instanceof Cons && !rawParams.isImproper())) {
                const ascope = opts.analyzer.scopeMap.get(first);
                if (!ascope) throw new Error(`internal error: could not find ascope for expr ${first}`);

                const params = rawParams === null ? [] : rawParams.toArray();
                const body = first.cdr.cdr;
                const args = expr.cdr === null ? [] : expr.cdr.toArray();
                if (params.length !== args.length) {
                    throw new Error(`expected exactly ${params.length} args, got ${args.length}`);
                }
                
                // Bind all arguments outside new block scope
                const argRegs: number[] = [];
                for(let i = 0; i < args.length; i++) {
                    const tempReg = opts.scope.allocTemp();
                    this.#compile(args[i], { ...opts, destReg: tempReg, isTail: false, name: typeof params[i] === "symbol" ? params[i].description : undefined });
                    argRegs.push(tempReg);
                }

                // Now enter block
                opts.scope.enterBlock()
                const seen = new Set<symbol>();
                for(let i = 0; i < params.length; i++) {
                    ensureCanBind(params[i], seen, "lambda")
                    const inf = ascope.getVarinfo(params[i]);
                    if(!inf) throw new Error("Could not fetch varinfo")
                    
                    const destReg = opts.scope.addLocal(params[i])            
                    if(inf.isBoxed) {
                        opts.nodes.push({ t: "Box", srcReg: argRegs[i], destReg });
                    } else {
                        opts.nodes.push({ t: "Move", srcReg: argRegs[i], destReg });
                    }
                }

                this.#compile(wrapMulti(body), {...opts, ascope})
                opts.scope.exitBlock()
                for (const reg of argRegs) {
                    opts.scope.freeTemp(reg);
                }
                return true;
            }
        }
        return false;
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
