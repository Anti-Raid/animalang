import { ConstPool } from "../common";
import { BUILTINS_START, ByteCode, Closure, ClosureTemplate, OpCode, type UpVarLoc } from "./exec";

let nextLabelId = 0;

export class JumpLabel {
    public id: number = ++nextLabelId;
}

export type JumpCond = "True" | "False"

export type Node = {
    t: "LoadValue",
    destReg: number,
    constant: any // will later on become a LOADCONST or a LOADU32
} | {
    t: "Move",
    destReg: number,
    srcReg: number,
} | {
    t: "LoadUpvar",
    destReg: number,
    upvarIdx: number,
    andUnbox: boolean
} | {
    t: "SetUpvar",
    srcReg: number,
    upvarIdx: number,
    andBox: boolean
} | {
    t: "LoadGlobal",
    destReg: number,
    sym: symbol
} | {
    t: "SetGlobal",
    srcReg: number,
    sym: symbol
} | {
    t: "HasGlobal",
    sym: symbol
} | {
    t: "Label",
    label: JumpLabel
} | {
    t: "If",
    reg: number,
    elseLabel: JumpLabel,
} | {
    t: "Else",
    endLabel: JumpLabel,
} | {
    t: "EndIf",
} | {
    t: "Call",
    procReg: number,
    destReg?: number,
    startReg: number,
    nargs: number,
} | {
    t: "TailCall",
    procReg: number,
    // does not return to caller so no ret value needed
    startReg: number,
    nargs: number,
} | {
    t: "Apply",
    procReg: number,
    destReg?: number,
    startReg: number,
    nargs: number,
} | {
    t: "TailApply",
    procReg: number,
    startReg: number,
    nargs: number,
} | {
    t: "Return",
    reg: number
} | {
    t: "NewClosure",
    destReg: number,
    template: ClosureTemplateIR
} | {
    // A call to a builtin function
    t: "IBuiltin",
    builtinIdx: number,
    destReg: number,
    startReg: number,
    nargs: number
} | {
    // A call to a builtin function
    t: "IBuiltinTail",
    builtinIdx: number,
    startReg: number,
    nargs: number
} | {
    // reg[destReg] = [reg[srcReg]]
    t: "Box",
    destReg: number,
    srcReg: number
} | {
    // reg[destReg] = reg[srcReg][0]
    t: "Unbox",
    destReg: number,
    srcReg: number
} | {
    // reg[destReg][0] = reg[srcReg]
    t: "SetBox",
    destReg: number,
    srcReg: number
} | {
    t: "Wind",
    beforeReg: number,
    afterReg: number
} | {
    t: "EndWind"
} | {
    t: "CallCC",
    destReg?: number,
    procReg: number
} | {
    t: "TailCallCC",
    procReg: number
} | {
    t: "SetRaiseProc",
    srcReg: number
} | {
    t: "WindowOp",
    op: OpCode,
    destReg: number,
    startReg: number,
    nargs: number
} | {
    t: "IndexedOp",
    op: OpCode,
    idx: number,
    destReg: number,
    startReg: number,
    nargs: number
} | {
    t: "ApplyList",
    procReg: number,
    destReg?: number,
    listReg: number
} | {
    t: "TailApplyList",
    procReg: number,
    listReg: number
}

export class IR {
    constructor() {}

    lower(nodes: Node[], numRegs: number): ByteCode {
        const cpool = new ConstPool()
        const inst: number[] = []

        const jumpIdxs: Map<number, JumpLabel> = new Map()
        const resolvedLabels: Map<JumpLabel, number> = new Map()
        for(let i = 0; i < nodes.length; i++) {
            const node = nodes[i]

            switch (node.t) {
                case "LoadValue": {
                    const v = node.constant

                    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xFFFFFFFF && !Object.is(v, -0)) {
                        inst.push(OpCode.LOADU32, node.destReg, v);
                    } else {
                        inst.push(OpCode.LOADCONST, node.destReg, cpool.push(v))
                    }
                    continue
                }
                case "LoadUpvar": {
                    inst.push(OpCode.LOADUPVAR, node.destReg, node.upvarIdx, node.andUnbox ? 1 : 0)
                    break
                }
                case "SetUpvar": {
                    inst.push(OpCode.SETUPVAR, node.srcReg, node.upvarIdx, node.andBox ? 1 : 0)
                    break
                }
                case "LoadGlobal": {
                    inst.push(OpCode.LOADGLOBAL, node.destReg, cpool.push(node.sym))
                    break
                }
                case "SetGlobal": {
                    inst.push(OpCode.SETGLOBAL, node.srcReg, cpool.push(node.sym))
                    break
                }
                case "HasGlobal": {
                    inst.push(OpCode.HASGLOBAL, cpool.push(node.sym))
                    break
                }
                case "Label": {
                    resolvedLabels.set(node.label, inst.length)
                    break
                }
                case "If": {
                    const jidx = inst.push(OpCode.IF, node.reg, -1) - 1
                    jumpIdxs.set(jidx, node.elseLabel)
                    break
                }
                case "Else": {
                    const jidx = inst.push(OpCode.ELSE, -1) - 1
                    jumpIdxs.set(jidx, node.endLabel)
                    break
                }
                case "EndIf": {
                    inst.push(OpCode.ENDIF)
                    break
                }
                case "Call": {
                    if (node.procReg >= BUILTINS_START) throw new Error("internal error: builtin calls must use IBuiltin")
                    inst.push(OpCode.CALL, node.procReg, node.startReg, node.nargs)
                    if (node.destReg !== undefined) inst.push(OpCode.MOVEACC, node.destReg)
                    break
                }
                case "TailCall": {
                    inst.push(OpCode.TAILCALL, node.procReg, node.startReg, node.nargs)
                    break
                }
                case "Apply": {
                    inst.push(OpCode.APPLY, node.procReg, node.startReg, node.nargs)
                    if (node.destReg !== undefined) inst.push(OpCode.MOVEACC, node.destReg)
                    break
                }
                case "TailApply": {
                    inst.push(OpCode.TAILAPPLY, node.procReg, node.startReg, node.nargs)
                    break
                }
                case "IBuiltin": {
                    inst.push(OpCode.CALLBUILTIN, node.builtinIdx - BUILTINS_START, node.destReg, node.startReg, node.nargs)
                    break
                }
                case "IBuiltinTail": {
                    inst.push(OpCode.TAILCALL, node.builtinIdx, node.startReg, node.nargs)
                    break
                }   
                case "Return": {
                    inst.push(OpCode.RETURN, node.reg)
                    break
                }
                case "NewClosure": {
                    const closureBc = this.lower(node.template.code, node.template.numRegs)
                    const ct = new ClosureTemplate(node.template.params, node.template.remParams, closureBc, node.template.upvarLocs)
                    if(ct.upvarLocs.length === 0) {
                        // We can just directly push the template as a raw constant in the pool
                        const cidx = cpool.mutPush(Closure.fromTemplate(ct))
                        inst.push(OpCode.LOADCONST, node.destReg, cidx)
                    } else {
                        const ctidx = cpool.mutPush(ct)
                        inst.push(OpCode.NEWCLOSURE, node.destReg, ctidx)
                    }
                    break
                }
                case "Box": {
                    inst.push(OpCode.BOX, node.destReg, node.srcReg)
                    break
                }
                case "SetBox": {
                    inst.push(OpCode.SETBOX, node.destReg, node.srcReg)
                    break
                }
                case "Unbox": {
                    inst.push(OpCode.UNBOX, node.destReg, node.srcReg)
                    break
                }
                case "Move": {
                    inst.push(OpCode.MOVE, node.destReg, node.srcReg)
                    break
                }
                case "Wind": {
                    inst.push(OpCode.WIND, node.beforeReg, node.afterReg);
                    break;
                }
                case "EndWind": {
                    inst.push(OpCode.ENDWIND);
                    break;
                }
                case "CallCC": {
                    inst.push(OpCode.CALLCC, node.procReg);
                    if (node.destReg !== undefined) inst.push(OpCode.MOVEACC, node.destReg);
                    break;
                }
                case "TailCallCC": {
                    inst.push(OpCode.TAILCALLCC, node.procReg);
                    break;
                }
                case "SetRaiseProc": {
                    inst.push(OpCode.SETRAISEPROC, node.srcReg);
                    break;
                }
                case "WindowOp": {
                    inst.push(node.op, node.destReg, node.startReg, node.nargs);
                    break;
                }
                case "IndexedOp": {
                    inst.push(node.op, node.destReg, node.startReg, node.nargs, node.idx);
                    break;
                }
                case "ApplyList": {
                    inst.push(OpCode.APPLYLIST, node.procReg, node.listReg);
                    if (node.destReg !== undefined) inst.push(OpCode.MOVEACC, node.destReg);
                    break;
                }
                case "TailApplyList": {
                    inst.push(OpCode.TAILAPPLYLIST, node.procReg, node.listReg);
                    break;
                }
                default:
                    let _: never = node;
            }
        }

        for(const [jump, label] of jumpIdxs) {
            const resolvedOffset = resolvedLabels.get(label)
            if(resolvedOffset === undefined) throw new Error(`unresolved label ${label.id}`)
            if(inst[jump] !== -1) throw new Error(`inst[jump] !== -1`)
            inst[jump] = resolvedOffset
        }

        return new ByteCode(cpool.constants, new Uint32Array(inst), numRegs)
    }
}

/** A template for a closure that can then be bound to a scope */
export class ClosureTemplateIR {
    params: symbol[]; // base (individual param binds)
    remParams: symbol | null; // where the remaining params should be bound too (if any). This implicitly makes a closure variadic as well
    code: Node[]
    numRegs: number;
    upvarLocs: UpVarLoc[] // what upvars do we need to capture

    constructor(params: symbol[], remParams: symbol | null, code: Node[], numRegs: number, upvarLocs: UpVarLoc[]) {
        this.params = params
        this.remParams = remParams
        this.code = code
        this.numRegs = numRegs
        this.upvarLocs = upvarLocs
    }
}
