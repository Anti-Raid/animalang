import { ConstPool, type SourcePos } from "../common";
import { APPLY_TAIL, ByteCode, Closure, ClosureTemplate, NO_REG, OpCode, rtIdx, UNPACK_REST, UNPACK_STRICT, type UpVarLoc, type UsedIntrinsic } from "./exec";
import type { Intrinsics } from "./intrinsics";
import { OPCODES } from "./opcodes";

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
    // the next condition of an %if chain (like If, but continuing the chain an If started)
    t: "ElseIf",
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
    // APPLY_REST / APPLY_MULTI
    flags: number,
} | {
    t: "TailApply",
    procReg: number,
    startReg: number,
    nargs: number,
    flags: number,
} | {
    t: "Return",
    reg: number
} | {
    t: "NewClosure",
    destReg: number,
    template: ClosureTemplateIR
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
    t: "CallEC" | "CallCatch",
    procReg: number,
    tokReg: number,
    preReg?: number,
    destReg?: number
} | {
    t: "Raise",
    objReg: number,
    continuable: boolean,
    destReg?: number
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
    // spread the multiple values in srcReg over [startReg, startReg + count), plus a rest list after them
    t: "Unpack",
    srcReg: number,
    startReg: number,
    count: number,
    rest: boolean,
    strict: boolean
} | {
    // set a continuation mark on the current frame
    t: "SetMark",
    keyReg: number,
    valReg: number
} | {
    // save the marks into reg and reg + 1, then start a new logical frame
    t: "MarkSave",
    reg: number
} | {
    // put back marks saved by MarkSave
    t: "MarkRestore",
    reg: number
} | {
    t: "CurrentMarks",
    destReg: number
} | {
    // an intrinsic that is not a leaf: may return a tail request (CALLHOST)
    t: "HostCall",
    pos: number,
    startReg: number,
    nargs: number,
    isTail: boolean,
    destReg?: number
} | {
    // (%apply %intrinsic arg ... lst) of a leaf intrinsic (APPLYINT)
    t: "IntApply",
    pos: number,
    destReg: number,
    startReg: number,
    nargs: number,
    // the last argument is a forwarded rest array (APPLYINTR)
    restArray: boolean
} | {
    // a leaf intrinsic (CALLINT)
    t: "IntCall",
    pos: number,
    destReg: number,
    startReg: number,
    nargs: number
} | {
    t: "CurrentStack",
    skip: number,
    destReg?: number
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
    constructor(private readonly table: Intrinsics, private readonly debug: boolean = false) {}

    lower(nodes: Node[], numRegs: number): ByteCode {
        const cpool = new ConstPool()
        const inst: number[] = []
        // an instruction, with as many operands as OPCODES says it has
        const emit = (op: OpCode, ...operands: number[]): number => {
            if (operands.length !== OPCODES[op].operands.length) throw new Error(`internal error: ${OpCode[op]} takes ${OPCODES[op].operands.length} operands, got ${operands.length}`)
            return inst.push(op, ...operands)
        }

        const lineTable: number[] = []
        const files: string[] = []
        const jumpIdxs: Map<number, JumpLabel> = new Map()
        // the intrinsics used (the bytecode's metadata), by position
        const used = new Map<number, UsedIntrinsic>()
        const use = (pos: number): number => {
            if (!used.has(pos)) {
                const entry = this.table.entries[pos]
                used.set(pos, { pos, name: entry.name, leaf: entry.leaf })
            }
            return pos
        }
        const resolvedLabels: Map<JumpLabel, number> = new Map()
        for(let i = 0; i < nodes.length; i++) {
            const node = nodes[i]

            switch (node.t) {
                case "LoadValue": {
                    const v = node.constant

                    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xFFFFFFFF && !Object.is(v, -0)) {
                        emit(OpCode.LOADU32, node.destReg, v);
                    } else {
                        emit(OpCode.LOADCONST, node.destReg, cpool.push(v))
                    }
                    continue
                }
                case "LoadUpvar": {
                    emit(OpCode.LOADUPVAR, node.destReg, node.upvarIdx, node.andUnbox ? 1 : 0)
                    break
                }
                case "SetUpvar": {
                    emit(OpCode.SETUPVAR, node.srcReg, node.upvarIdx, node.andBox ? 1 : 0)
                    break
                }
                case "LoadGlobal": {
                    emit(OpCode.LOADGLOBAL, node.destReg, cpool.push(node.sym))
                    break
                }
                case "SetGlobal": {
                    emit(OpCode.SETGLOBAL, node.srcReg, cpool.push(node.sym))
                    break
                }
                case "Label": {
                    resolvedLabels.set(node.label, inst.length)
                    break
                }
                case "If": {
                    const jidx = emit(OpCode.IF, node.reg, -1) - 1
                    jumpIdxs.set(jidx, node.elseLabel)
                    break
                }
                case "ElseIf": {
                    const jidx = emit(OpCode.ELSEIF, node.reg, -1) - 1
                    jumpIdxs.set(jidx, node.elseLabel)
                    break
                }
                case "Else": {
                    const jidx = emit(OpCode.ELSE, -1) - 1
                    jumpIdxs.set(jidx, node.endLabel)
                    break
                }
                case "EndIf": {
                    emit(OpCode.ENDIF)
                    break
                }
                case "SetMark":
                    emit(OpCode.SETMARK, node.keyReg, node.valReg)
                    break
                case "MarkSave":
                    emit(OpCode.MARKSAVE, node.reg)
                    break
                case "MarkRestore":
                    emit(OpCode.MARKRESTORE, node.reg)
                    break
                case "CurrentMarks":
                    emit(OpCode.CURMARKS, node.destReg)
                    break
                case "HostCall":
                    emit(OpCode.CALLHOST, use(node.pos), node.startReg, node.nargs, node.isTail ? 1 : 0)
                    if (!node.isTail && node.destReg !== undefined) emit(OpCode.MOVEACC, node.destReg)
                    break
                case "IntCall":
                    emit(OpCode.CALLINT, use(node.pos), node.destReg, node.startReg, node.nargs)
                    break
                case "IntApply":
                    emit(node.restArray ? OpCode.APPLYINTR : OpCode.APPLYINT, use(node.pos), node.destReg, node.startReg, node.nargs)
                    break
                case "CurrentStack":
                    emit(OpCode.CURSTACK, node.skip)
                    if (node.destReg !== undefined) emit(OpCode.MOVEACC, node.destReg)
                    break
                case "Unpack": {
                    emit(OpCode.UNPACK, node.srcReg, node.startReg, node.count, (node.rest ? UNPACK_REST : 0) | (node.strict ? UNPACK_STRICT : 0))
                    break
                }
                case "Block":
                case "Loop":
                case "EndLoop":
                case "Jump": {
                    const op = { Block: OpCode.BLOCK, Loop: OpCode.LOOP, EndLoop: OpCode.ENDLOOP, Jump: OpCode.JUMP }[node.t]
                    const jidx = emit(op, -1) - 1
                    jumpIdxs.set(jidx, node.t === "EndLoop" ? node.head : node.t === "Jump" ? node.label : node.end)
                    break
                }
                case "Call": {
                    emit(OpCode.CALL, node.procReg, node.startReg, node.nargs, 0)
                    if (node.destReg !== undefined) emit(OpCode.MOVEACC, node.destReg)
                    break
                }
                case "TailCall": {
                    emit(OpCode.CALL, node.procReg, node.startReg, node.nargs, 1)
                    break
                }
                case "Apply": {
                    emit(OpCode.APPLY, node.procReg, node.startReg, node.nargs, node.flags)
                    if (node.destReg !== undefined) emit(OpCode.MOVEACC, node.destReg)
                    break
                }
                case "TailApply": {
                    emit(OpCode.APPLY, node.procReg, node.startReg, node.nargs, node.flags | APPLY_TAIL)
                    break
                }
                case "Return": {
                    emit(OpCode.RETURN, node.reg)
                    break
                }
                case "NewClosure": {
                    const closureBc = this.lower(node.template.code, node.template.numRegs)
                    const ct = new ClosureTemplate(node.template.params, node.template.remParams, closureBc, node.template.upvarLocs, node.template.name, node.template.restArray)
                    if(ct.upvarLocs.length === 0) {
                        // We can just directly push the template as a raw constant in the pool
                        const cidx = cpool.mutPush(Closure.fromTemplate(ct))
                        emit(OpCode.LOADCONST, node.destReg, cidx)
                    } else {
                        const ctidx = cpool.mutPush(ct)
                        emit(OpCode.NEWCLOSURE, node.destReg, ctidx)
                    }
                    break
                }
                case "Box": {
                    emit(OpCode.BOX, node.destReg, node.srcReg)
                    break
                }
                case "SetBox": {
                    emit(OpCode.SETBOX, node.destReg, node.srcReg)
                    break
                }
                case "Unbox": {
                    emit(OpCode.UNBOX, node.destReg, node.srcReg)
                    break
                }
                case "Move": {
                    emit(OpCode.MOVE, node.destReg, node.srcReg)
                    break
                }
                case "CallCC": {
                    emit(OpCode.CALLCC, node.procReg, 0);
                    if (node.destReg !== undefined) emit(OpCode.MOVEACC, node.destReg);
                    break;
                }
                case "TailCallCC": {
                    emit(OpCode.CALLCC, node.procReg, 1);
                    break;
                }
                case "Raise": {
                    emit(OpCode.RAISE, node.objReg, node.continuable ? 1 : 0);
                    if (node.continuable && node.destReg !== undefined) emit(OpCode.MOVEACC, node.destReg);
                    break;
                }
                case "CallEC":
                case "CallCatch": {
                    if (node.t === "CallEC") emit(OpCode.CALLEC, node.procReg, node.tokReg);
                    else emit(OpCode.CALLCATCH, node.procReg, node.tokReg, node.preReg ?? NO_REG);
                    if (node.destReg !== undefined) emit(OpCode.MOVEACC, node.destReg);
                    emit(OpCode.CALLRT, rtIdx("%end-escape"), node.tokReg, node.tokReg, 1);
                    break;
                }
                case "CoYield": {
                    emit(OpCode.COYIELD, node.valReg);
                    if (node.destReg !== undefined) emit(OpCode.MOVEACC, node.destReg);
                    break;
                }
                case "CoResume": {
                    emit(OpCode.CORESUME, node.coReg, node.listReg, node.isTail ? 1 : 0);
                    if (!node.isTail && node.destReg !== undefined) emit(OpCode.MOVEACC, node.destReg);
                    break;
                }
                case "RtCall": {
                    emit(OpCode.CALLRT, node.rtIdx, node.destReg, node.startReg, node.nargs);
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

        return new ByteCode(cpool.constants, new Uint32Array(inst), numRegs, new Uint32Array(lineTable), files, this.debug, used.size > 0 ? this.table : null, [...used.values()])
    }
}

/** A template for a closure that can then be bound to a scope */
export class ClosureTemplateIR {
    params: symbol[]; // base (individual param binds)
    remParams: symbol | null; // where the remaining params should be bound too (if any). This implicitly makes a closure variadic as well
    code: Node[]
    numRegs: number;
    upvarLocs: UpVarLoc[] // what upvars do we need to capture

    constructor(params: symbol[], remParams: symbol | null, code: Node[], numRegs: number, upvarLocs: UpVarLoc[], public name: string | null = null, public restArray: boolean = false) {
        this.params = params
        this.remParams = remParams
        this.code = code
        this.numRegs = numRegs
        this.upvarLocs = upvarLocs
    }
}
