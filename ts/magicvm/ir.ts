import { ConstPool, type SourcePos } from "../common";
import { Code, Closure, ClosureTemplate, type InlineSite, type UpVarLoc, type UsedIntrinsic } from "./exec";
import type { Intrinsics } from "./intrinsics";
import type { RestKind } from "./arity";
import { returnedFrom, type DistributiveOmit, type Op } from "./ops";

let nextLabelId = 0;

export class JumpLabel {
    public id: number = ++nextLabelId;
}

// What compiler.ts writes for a function: the instructions of ops.ts before their places are known (so with no `ip`
// or `where`), in order. An instruction that needs nothing more is written as it is. The others:
//  - a jump names a label, which a Label entry places
//  - a constant is its value (LoadValue), a global its symbol, a closure's template still its IR: lowering makes the
//    constant pool
//  - a call that is not a tail call may say where its value goes (`dst`), which is the MoveAcc after it
// and some entries are no instruction at all (Label, Pos, FunctionEntry, InlineEnter, InlineExit)
type Unplaced<K extends Op["k"]> = DistributiveOmit<Extract<Op, { k: K }>, "ip" | "where">;
export type Node =
    | Unplaced<"LoadUpvar" | "SetUpvar" | "FixUpvar" | "EndIf" | "Return" | "Move" | "Box" | "Unbox" | "SetBox" | "MoveAcc" | "SetMark" | "MarkSave" | "MarkRestore" | "CurMarks" | "IntCall" | "IntApply">
    | { k: "LoadValue"; dst: number; constant: any }
    | { k: "LoadGlobal"; dst: number; sym: symbol }
    | { k: "SetGlobal"; src: number; sym: symbol }
    | { k: "NewClosure"; dst: number; template: ClosureTemplateIR }
    // `elseif`: the next condition of an %if chain (like an If, but continuing the chain one started)
    | { k: "If"; cond: number; else: JumpLabel; elseif: boolean }
    | { k: "Else"; end: JumpLabel }
    // a %block whose escapes jump to `end`, a %loop ending there (its head is the label right after), its back edge
    | { k: "Block" | "Loop"; end: JumpLabel }
    | { k: "EndLoop"; head: JumpLabel }
    | { k: "Jump"; target: JumpLabel }
    // `one`: the call wants one value, the first the procedure returns (or <#void>); `many`: its values are bound at
    // once to that many names
    | { k: "Call"; proc: number; start: number; nargs: number; tail: boolean; one?: boolean; many?: number; dst?: number }
    // a call of an intrinsic that is not a leaf (it may return a request)
    | { k: "HostCall"; pos: number; start: number; nargs: number; tail: boolean; dst?: number }
    | { k: "Unpack"; src: number; start: number; count: number; flags: number; many?: boolean }
    | { k: "Label"; label: JumpLabel }
    // the code up to the matching InlineExit is the body of `name`, inlined at `at` (in tail position if `tail`):
    // tracebacks show it as that procedure's frame (see Code.inlines)
    | { k: "InlineEnter"; name: string; at: SourcePos | null; tail: boolean }
    | { k: "InlineExit" }
    // where a function's body starts, after its parameters are set up (see passes/interrupts.ts)
    | { k: "FunctionEntry" }
    // where the code that follows came from: its instructions' `where`
    | { k: "Pos"; pos: SourcePos };

// a function's code from its IR nodes (see Op)
export const lowerOps = (nodes: Node[], table: Intrinsics, cpool: ConstPool, lowerTemplate: (t: ClosureTemplateIR) => ClosureTemplate) => {
    const ops: Op[] = []
    let ip = 0
    // the position the instructions pushed now come from (the last Pos node)
    let where: SourcePos | null = null
    const push = (op: DistributiveOmit<Op, "ip">): Op => {
        const full = op as Op
        full.ip = ip
        full.where = where
        ops.push(full)
        ip++
        return full
    }
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
    // code that runs inlined procedures starts (and a self tail call restarts it) outside any: its first instruction,
    // after the positions it starts at
    let reset = nodes.some(n => n.k === "InlineEnter")
    const fixups: [op: any, field: string, label: JumpLabel][] = []
    const jump = (op: Op, field: string, label: JumpLabel) => fixups.push([op, field, label])
    for (const node of nodes) {
        if (reset && node.k !== "Pos") {
            push({ k: "InlineSite", site: -1 })
            reset = false
        }
        switch (node.k) {
            case "LoadValue": {
                const v = node.constant
                if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xFFFFFFFF && !Object.is(v, -0)) push({ k: "LoadInt", dst: node.dst, value: v })
                else push({ k: "LoadConst", dst: node.dst, idx: cpool.push(v) })
                break
            }
            case "LoadGlobal": push({ k: "LoadGlobal", dst: node.dst, sym: cpool.push(node.sym) }); break
            case "SetGlobal": push({ k: "SetGlobal", src: node.src, sym: cpool.push(node.sym) }); break
            case "Label": labels.set(node.label, ip); break
            case "FunctionEntry": break
            case "Pos": where = node.pos; break
            case "InlineEnter": {
                const site = inlines.push({ start: ip, end: ip, name: node.name, at: node.at, tail: node.tail, parent: open.length > 0 ? open[open.length - 1] : -1 }) - 1
                open.push(site)
                push({ k: "InlineSite", site })
                break
            }
            case "InlineExit": {
                const site = open.pop()!
                inlines[site].end = ip
                push({ k: "InlineSite", site: returnedFrom(site) })
                break
            }
            case "If": jump(push({ k: "If", cond: node.cond, else: -1, elseif: node.elseif }), "else", node.else); break
            case "Else": jump(push({ k: "Else", end: -1 }), "end", node.end); break
            case "Block": case "Loop": jump(push({ k: node.k, end: -1 }), "end", node.end); break
            case "EndLoop": jump(push({ k: "EndLoop", head: -1 }), "head", node.head); break
            case "Jump": jump(push({ k: "Jump", target: -1 }), "target", node.target); break
            case "HostCall":
                push({ k: "HostCall", pos: use(node.pos), start: node.start, nargs: node.nargs, tail: node.tail })
                if (!node.tail && node.dst !== undefined) push({ k: "MoveAcc", dst: node.dst })
                break
            case "Call":
                if (node.tail) push({ k: "Call", proc: node.proc, start: node.start, nargs: node.nargs, tail: true })
                else {
                    push({ k: "Call", proc: node.proc, start: node.start, nargs: node.nargs, tail: false, ...(node.one ? { one: true as const } : {}), ...(node.many !== undefined ? { many: node.many } : {}) })
                    if (node.dst !== undefined) push({ k: "MoveAcc", dst: node.dst, ...(node.one ? { one: true as const } : {}) })
                }
                break
            case "Unpack": push({ k: "Unpack", src: node.src, start: node.start, count: node.count, flags: node.flags, ...(node.many ? { many: true as const } : {}) }); break
            case "NewClosure": {
                const ct = lowerTemplate(node.template)
                // a closure that captures nothing is made once, as a constant
                if (ct.upvarLocs.length === 0) push({ k: "LoadConst", dst: node.dst, idx: cpool.mutPush(Closure.fromTemplate(ct)) })
                else push({ k: "NewClosure", dst: node.dst, tmpl: cpool.mutPush(ct) })
                break
            }
            case "IntCall": case "IntApply": push({ ...node, pos: use(node.pos) }); break
            // an instruction as it is
            default: push({ ...node })
        }
    }
    for (const [op, field, label] of fixups) {
        const target = labels.get(label)
        if (target === undefined) throw new Error(`unresolved label ${label.id}`)
        op[field] = target
    }
    return { ops, used, use, inlines }
}

export class IR {
    constructor(private readonly table: Intrinsics, private readonly debug: boolean = false, private readonly assumed: ReadonlySet<number> = new Set(), private readonly reentrant: boolean = true) {}

    lower(nodes: Node[], numRegs: number, packRest: boolean = false): Code {
        const cpool = new ConstPool()
        const lowerTemplate = (t: ClosureTemplateIR) =>
            new ClosureTemplate(t.params, t.remParams, this.lower(t.code, t.numRegs, t.rest === "packed"), t.upvarLocs, t.name, t.rest, t.pad)
        const { ops, used, use, inlines } = lowerOps(nodes, this.table, cpool, lowerTemplate)
        for (const pos of this.assumed) use(pos)
        const restPos = packRest ? use(this.table.pack!.pos) : -1
        const code = new Code(cpool.constants, ops, numRegs, this.debug, used.size > 0 ? this.table : null, [...used.values()])
        code.restPos = restPos
        code.interrupts = this.table.interrupts
        code.reentrant = this.reentrant
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
