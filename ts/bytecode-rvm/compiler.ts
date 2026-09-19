import { ASTStringifier, ensureCanBind, normalizeExpr, OP_BEGIN, OP_IF, OP_LAMBDA, OP_QUOTE, OP_SET, OP_DEFINE, unpackLambdaExprArgs, wrapMulti, Cons } from "../common";
import { AstAnalysis } from "./analysis";
import { AnalysisScope, CompilerScope } from "./scope";
import { IR, type Node, JumpLabel, ClosureTemplateIR } from "./ir";
import { IBUILTINS_IDX_MAP } from "../std";
import { BUILTINS_START } from "./vm";

interface CmpOpts {
    destReg?: number // where to store dest reg
    isTail: boolean // whether this is a tail-call or not (for tco)
    nodes: Node[]
    scope: CompilerScope,

    // From pass 1
    ascope: AnalysisScope,
    analyzer: AstAnalysis
}

export class Compiler {
    #s = new ASTStringifier()

    constructor() {}

    compile(trExpr: any) {
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
        const ir = new IR()
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
                    this.#compileLambda(expr, opts)
                    return
            }
        }

        // intrinsic
        const builtinsIdx = IBUILTINS_IDX_MAP.get(operator)
        if (builtinsIdx !== undefined) {
            this.#optIntrinsicNormal(expr, BUILTINS_START+builtinsIdx, opts)
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
        opts.nodes.push({t: "CondJump", cond: "False", label: falseLabel, reg: condReg})
        opts.scope.freeTemp(condReg) // we can free the reg here
        // Place true code
        this.#compile(thenExpr, opts)
        // Place jump to end
        if (!this.#nodesEndsInRet(opts.nodes)) {
            opts.nodes.push({t: "Jump", label: endLabel})
        }
        // Place false code as well as jump to start of false code
        opts.nodes.push({t:"Label", label: falseLabel})
        this.#compile(elseExpr, opts)
        // Fix jump to end to now jump to after false code
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
        this.#compile(val, { ...opts, destReg: valReg, isTail: false });
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
        this.#compile(val, { ...opts, destReg: valReg, isTail: false });
        const res = this.#setVar(sym, opts, valReg)
        if(res) opts.nodes.push(...res)
        opts.scope.freeTemp(valReg)
        if (opts.destReg !== undefined) {
            opts.nodes.push({t: "LoadValue", destReg: opts.destReg, constant: undefined})
        }
    }

    #compileLambda(expr: Cons, opts: CmpOpts) {
        // AnimaTransform ensures lambdas are of correct form
        const lambdaScope = new CompilerScope(opts.scope)
        const ascope = opts.analyzer.scopeMap.get(expr)
        if (!ascope) throw new Error(`internal error: could not find ascope for expr ${expr}`)

        const { params, remParams } = unpackLambdaExprArgs(expr, "lambda")
        const lambdaNodes: Node[] = []

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
        const template = new ClosureTemplateIR(params, remParams, lambdaNodes, lambdaScope.numRegs, lambdaScope.upvars);
        opts.nodes.push({t: "NewClosure", template: template, destReg: opts.destReg})
    }

    #nodesEndsInRet(nodes: Node[]) {
        if (nodes.length === 0) return false // we need a return if nodes.length === 0
        const lastNode = nodes[nodes.length-1]
        if (lastNode.t === "TailCall" || lastNode.t === "IBuiltinTail" || lastNode.t === "Return") {
            return true // all of these ops alr return
        }
        return false
    }

    // a normal call
    #compileNormalCall(expr: Cons, opts: CmpOpts) {
        // Try IIFE optimizations
        if(this.#optIIFE(expr, opts)) {
            return
        }

        // We need to compile the proc and place it on its own tempval
        const procReg = opts.scope.allocTemp();
        this.#compile(expr.car, { ...opts, destReg: procReg, isTail: false })

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
            const targetReg = opts.destReg === undefined ? opts.scope.allocTemp() : opts.destReg!;
            opts.nodes.push({t: "Call", destReg: targetReg, nargs, procReg, startReg})
            if (opts.destReg === undefined) opts.scope.freeTemp(targetReg);
        }

        opts.scope.regAlloc.freeBlock(startReg, nargs)
        opts.scope.freeTemp(procReg)
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
                    this.#compile(args[i], { ...opts, destReg: tempReg, isTail: false });
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

    /** Optimizes intrinsic/builtin ops */ 
    #optIntrinsicNormal(expr: Cons, builtinIdx: number, opts: CmpOpts) {
        // Push args
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
            opts.nodes.push({t: "IBuiltinTail", startReg, nargs, builtinIdx})
        } else {
            const targetReg = opts.destReg === undefined ? opts.scope.allocTemp() : opts.destReg!;
            opts.nodes.push({t: "IBuiltin", destReg: targetReg, startReg, nargs, builtinIdx})
            if (opts.destReg === undefined) opts.scope.freeTemp(targetReg);
        }

        opts.scope.regAlloc.freeBlock(startReg, nargs)
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
        if (destReg === undefined) return [{t: "HasGlobal", sym: varname}]
        return [{t: "LoadGlobal", sym: varname, destReg}]
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
