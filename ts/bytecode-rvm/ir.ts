import { ConstPool, type SourcePos } from "../common";
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
    t: "CallCC",
    destReg?: number,
    procReg: number
} | {
    t: "TailCallCC",
    procReg: number
} | {
    t: "CoYield",
    valReg: number,
    destReg?: number
} | {
    t: "CoResume",
    coReg: number,
    listReg: number,
    isTail: boolean,
    destReg?: number
} | {
    // start of a %block whose escapes jump to `end`
    t: "Block",
    end: JumpLabel
} | {
    // start of a %loop ending at `end`; its head is the label right after
    t: "Loop",
    end: JumpLabel
} | {
    // back edge of a %loop
    t: "EndLoop",
    head: JumpLabel
} | {
    // an %escape: jump to the end of a %block
    t: "Jump",
    label: JumpLabel
} | {
    // marks where the following code came from (goes into the line table, emits nothing)
    t: "Pos",
    pos: SourcePos
} | {
    t: "RtCall",
    rtIdx: number,
    destReg: number,
    startReg: number,
    nargs: number
}

export class IR {
    constructor(private readonly debug: boolean = false) {}

    lower(nodes: Node[], numRegs: number): ByteCode {
        const cpool = new ConstPool()
        const inst: number[] = []

        const lineTable: number[] = []
        const files: string[] = []
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
                case "Block":
                case "Loop":
                case "EndLoop":
                case "Jump": {
                    const op = { Block: OpCode.BLOCK, Loop: OpCode.LOOP, EndLoop: OpCode.ENDLOOP, Jump: OpCode.JUMP }[node.t]
                    const jidx = inst.push(op, -1) - 1
                    jumpIdxs.set(jidx, node.t === "EndLoop" ? node.head : node.t === "Jump" ? node.label : node.end)
                    break
                }
                case "Call": {
                    inst.push(OpCode.CALL, node.procReg, node.startReg, node.nargs, 0)
                    if (node.destReg !== undefined) inst.push(OpCode.MOVEACC, node.destReg)
                    break
                }
                case "TailCall": {
                    inst.push(OpCode.CALL, node.procReg, node.startReg, node.nargs, 1)
                    break
                }
                case "Apply": {
                    inst.push(OpCode.APPLY, node.procReg, node.startReg, node.nargs, 0)
                    if (node.destReg !== undefined) inst.push(OpCode.MOVEACC, node.destReg)
                    break
                }
                case "TailApply": {
                    inst.push(OpCode.APPLY, node.procReg, node.startReg, node.nargs, 1)
                    break
                }
                case "IBuiltin": {
                    inst.push(OpCode.CALL, node.builtinIdx, node.startReg, node.nargs, 0, OpCode.MOVEACC, node.destReg)
                    break
                }
                case "Return": {
                    inst.push(OpCode.RETURN, node.reg)
                    break
                }
                case "NewClosure": {
                    const closureBc = this.lower(node.template.code, node.template.numRegs)
                    const ct = new ClosureTemplate(node.template.params, node.template.remParams, closureBc, node.template.upvarLocs, node.template.name)
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
                case "CallCC": {
                    inst.push(OpCode.CALLCC, node.procReg, 0);
                    if (node.destReg !== undefined) inst.push(OpCode.MOVEACC, node.destReg);
                    break;
                }
                case "TailCallCC": {
                    inst.push(OpCode.CALLCC, node.procReg, 1);
                    break;
                }
                case "CoYield": {
                    inst.push(OpCode.COYIELD, node.valReg);
                    if (node.destReg !== undefined) inst.push(OpCode.MOVEACC, node.destReg);
                    break;
                }
                case "CoResume": {
                    inst.push(OpCode.CORESUME, node.coReg, node.listReg, node.isTail ? 1 : 0);
                    if (!node.isTail && node.destReg !== undefined) inst.push(OpCode.MOVEACC, node.destReg);
                    break;
                }
                case "RtCall": {
                    inst.push(OpCode.CALLRT, node.rtIdx, node.destReg, node.startReg, node.nargs);
                    break;
                }
                case "Pos": {
                    let fileIdx = files.indexOf(node.pos.file);
                    if (fileIdx === -1) fileIdx = files.push(node.pos.file) - 1;
                    const n = lineTable.length;
                    if (n > 0 && lineTable[n - 4] === inst.length) lineTable.length = n - 4;
                    const m = lineTable.length;
                    if (m > 0 && lineTable[m - 3] === fileIdx && lineTable[m - 2] === node.pos.line && lineTable[m - 1] === node.pos.col) break;
                    lineTable.push(inst.length, fileIdx, node.pos.line, node.pos.col);
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

        return new ByteCode(cpool.constants, new Uint32Array(inst), numRegs, new Uint32Array(lineTable), files, this.debug)
    }
}

/** A template for a closure that can then be bound to a scope */
export class ClosureTemplateIR {
    params: symbol[]; // base (individual param binds)
    remParams: symbol | null; // where the remaining params should be bound too (if any). This implicitly makes a closure variadic as well
    code: Node[]
    numRegs: number;
    upvarLocs: UpVarLoc[] // what upvars do we need to capture

    constructor(params: symbol[], remParams: symbol | null, code: Node[], numRegs: number, upvarLocs: UpVarLoc[], public name: string | null = null) {
        this.params = params
        this.remParams = remParams
        this.code = code
        this.numRegs = numRegs
        this.upvarLocs = upvarLocs
    }
}
