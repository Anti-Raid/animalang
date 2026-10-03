import { ConstPool, type SourcePos } from "../common";
import { Code, Closure, ClosureTemplate, type InlineSite, type UpVarLoc, type UsedIntrinsic } from "./exec";
import type { Intrinsics } from "./intrinsics";
import type { RestKind } from "./arity";
import { UNPACK_REST, UNPACK_STRICT, type DistributiveOmit, type Op } from "./ops";

let nextLabelId = 0;

export class JumpLabel {
    public id: number = ++nextLabelId;
}

export type JumpCond = "True" | "False"

export type Node = {
    t: "LoadValue",
    destReg: number,
    constant: any // will later on become a LoadConst or a LoadInt
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
    // reg[closureReg].upvars[upvarIdx] = reg[srcReg]
    t: "FixUpvar",
    closureReg: number,
    upvarIdx: number,
    srcReg: number
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
    // an intrinsic that is not a leaf: may return a tail request
    t: "HostCall",
    pos: number,
    startReg: number,
    nargs: number,
    isTail: boolean,
    destReg?: number
} | {
    // (%apply %intrinsic arg ... array) of a leaf intrinsic
    t: "IntApply",
    pos: number,
    destReg: number,
    startReg: number,
    nargs: number
} | {
    // a leaf intrinsic
    t: "IntCall",
    pos: number,
    destReg: number,
    startReg: number,
    nargs: number
} | {
    // an %escape: jump to the end of a %block
    t: "Jump",
    label: JumpLabel
} | {
    // reg[destReg] = the accumulator (the result of the call the code was entered from; VM helper code only)
    t: "MoveAcc",
    destReg: number
} | {
    // the code up to the matching InlineExit is the body of `name`, inlined at `at` (in tail position if `tail`):
    // tracebacks show it as that procedure's frame (emits nothing; see Code.inlines)
    t: "InlineEnter",
    name: string,
    at: SourcePos | null,
    tail: boolean
} | {
    t: "InlineExit"
} | {
    // where a function's body starts, after its parameters are set up (emits nothing; see passes/interrupts.ts)
    t: "FunctionEntry"
} | {
    // marks where the following code came from (goes into the line table, emits nothing)
    t: "Pos",
    pos: SourcePos
}

// a function's code from its IR nodes (see Op)
export const lowerOps = (nodes: Node[], table: Intrinsics, cpool: ConstPool, lowerTemplate: (t: ClosureTemplateIR) => ClosureTemplate) => {
    const ops: Op[] = []
    let ip = 0
    const push = (op: DistributiveOmit<Op, "ip">): Op => {
        const full = op as Op
        full.ip = ip
        ops.push(full)
        ip++
        return full
    }
    const lineTable: number[] = []
    const files: string[] = []
    const used = new Map<number, UsedIntrinsic>()
    const use = (pos: number): number => {
        if (!used.has(pos)) {
            const entry = table.entries[pos]
            used.set(pos, { pos, name: entry.name, leaf: entry.leaf })
        }
        return pos
    }
    const labels = new Map<JumpLabel, number>()
    const inlines: InlineSite[] = []
    const open: number[] = []
    const fixups: [op: any, field: string, label: JumpLabel][] = []
    const jump = (op: Op, field: string, label: JumpLabel) => fixups.push([op, field, label])
    for (const node of nodes) {
        switch (node.t) {
            case "LoadValue": {
                const v = node.constant
                if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xFFFFFFFF && !Object.is(v, -0)) push({ k: "LoadInt", dst: node.destReg, value: v })
                else push({ k: "LoadConst", dst: node.destReg, idx: cpool.push(v) })
                break
            }
            case "LoadUpvar": push({ k: "LoadUpvar", dst: node.destReg, idx: node.upvarIdx, unbox: node.andUnbox }); break
            case "SetUpvar": push({ k: "SetUpvar", src: node.srcReg, idx: node.upvarIdx, box: node.andBox }); break
            case "FixUpvar": push({ k: "FixUpvar", clo: node.closureReg, idx: node.upvarIdx, src: node.srcReg }); break
            case "LoadGlobal": push({ k: "LoadGlobal", dst: node.destReg, sym: cpool.push(node.sym) }); break
            case "SetGlobal": push({ k: "SetGlobal", src: node.srcReg, sym: cpool.push(node.sym) }); break
            case "Label": labels.set(node.label, ip); break
            case "FunctionEntry": break
            case "InlineEnter":
                open.push(inlines.push({ start: ip, end: ip, name: node.name, at: node.at, tail: node.tail, parent: open.length > 0 ? open[open.length - 1] : -1 }) - 1)
                break
            case "InlineExit":
                inlines[open.pop()!].end = ip
                break
            case "If": case "ElseIf": jump(push({ k: "If", cond: node.reg, else: -1, elseif: node.t === "ElseIf" }), "else", node.elseLabel); break
            case "Else": jump(push({ k: "Else", end: -1 }), "end", node.endLabel); break
            case "EndIf": push({ k: "EndIf" }); break
            case "SetMark": push({ k: "SetMark", key: node.keyReg, val: node.valReg }); break
            case "MarkSave": push({ k: "MarkSave", reg: node.reg }); break
            case "MarkRestore": push({ k: "MarkRestore", reg: node.reg }); break
            case "CurrentMarks": push({ k: "CurMarks", dst: node.destReg }); break
            case "HostCall":
                push({ k: "HostCall", pos: use(node.pos), start: node.startReg, nargs: node.nargs, tail: node.isTail })
                if (!node.isTail && node.destReg !== undefined) push({ k: "MoveAcc", dst: node.destReg })
                break
            case "MoveAcc": push({ k: "MoveAcc", dst: node.destReg }); break
            case "IntCall": push({ k: "IntCall", pos: use(node.pos), dst: node.destReg, start: node.startReg, nargs: node.nargs }); break
            case "IntApply": push({ k: "IntApply", pos: use(node.pos), dst: node.destReg, start: node.startReg, nargs: node.nargs }); break
            case "Unpack": push({ k: "Unpack", src: node.srcReg, start: node.startReg, count: node.count, flags: (node.rest ? UNPACK_REST : 0) | (node.strict ? UNPACK_STRICT : 0) }); break
            case "Block": case "Loop": jump(push({ k: node.t, end: -1 }), "end", node.end); break
            case "EndLoop": jump(push({ k: "EndLoop", head: -1 }), "head", node.head); break
            case "Jump": jump(push({ k: "Jump", target: -1 }), "target", node.label); break
            case "Call":
                push({ k: "Call", proc: node.procReg, start: node.startReg, nargs: node.nargs, tail: false })
                if (node.destReg !== undefined) push({ k: "MoveAcc", dst: node.destReg })
                break
            case "TailCall": push({ k: "Call", proc: node.procReg, start: node.startReg, nargs: node.nargs, tail: true }); break
            case "Return": push({ k: "Return", src: node.reg }); break
            case "NewClosure": {
                const ct = lowerTemplate(node.template)
                // a closure that captures nothing is made once, as a constant
                if (ct.upvarLocs.length === 0) push({ k: "LoadConst", dst: node.destReg, idx: cpool.mutPush(Closure.fromTemplate(ct)) })
                else push({ k: "NewClosure", dst: node.destReg, tmpl: cpool.mutPush(ct) })
                break
            }
            case "Box": case "SetBox": case "Unbox": case "Move": push({ k: node.t, dst: node.destReg, src: node.srcReg }); break
            case "Pos": {
                let fileIdx = files.indexOf(node.pos.file)
                if (fileIdx === -1) fileIdx = files.push(node.pos.file) - 1
                const n = lineTable.length
                if (n > 0 && lineTable[n - 4] === ip) lineTable.length = n - 4
                const m = lineTable.length
                if (m > 0 && lineTable[m - 3] === fileIdx && lineTable[m - 2] === node.pos.line && lineTable[m - 1] === node.pos.col) break
                lineTable.push(ip, fileIdx, node.pos.line, node.pos.col)
                break
            }
            default: { const _: never = node }
        }
    }
    for (const [op, field, label] of fixups) {
        const target = labels.get(label)
        if (target === undefined) throw new Error(`unresolved label ${label.id}`)
        op[field] = target
    }
    return { ops, lineTable: new Uint32Array(lineTable), files, used, use, inlines }
}

export class IR {
    constructor(private readonly table: Intrinsics, private readonly debug: boolean = false, private readonly assumed: ReadonlySet<number> = new Set()) {}

    lower(nodes: Node[], numRegs: number, packRest: boolean = false): Code {
        const cpool = new ConstPool()
        const lowerTemplate = (t: ClosureTemplateIR) =>
            new ClosureTemplate(t.params, t.remParams, this.lower(t.code, t.numRegs, t.rest === "packed"), t.upvarLocs, t.name, t.rest, t.pad)
        const { ops, lineTable, files, used, use, inlines } = lowerOps(nodes, this.table, cpool, lowerTemplate)
        for (const pos of this.assumed) use(pos)
        const restPos = packRest ? use(this.table.pack!.pos) : -1
        const code = new Code(cpool.constants, ops, numRegs, lineTable, files, this.debug, used.size > 0 ? this.table : null, [...used.values()])
        code.restPos = restPos
        code.interrupts = this.table.interrupts
        code.inlines = inlines
        return code
    }
}

/** A template for a closure that can then be bound to a scope */
export class ClosureTemplateIR {
    params: symbol[]; // base (individual param binds)
    remParams: symbol | null; // where the remaining params should be bound too (if any). This implicitly makes a closure variadic as well
    code: Node[]
    numRegs: number;
    upvarLocs: UpVarLoc[] // what upvars do we need to capture

    constructor(params: symbol[], remParams: symbol | null, code: Node[], numRegs: number, upvarLocs: UpVarLoc[], public name: string | null = null, public rest: RestKind = "array", public pad: boolean = false) {
        this.params = params
        this.remParams = remParams
        this.code = code
        this.numRegs = numRegs
        this.upvarLocs = upvarLocs
    }
}
