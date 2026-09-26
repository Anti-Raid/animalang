// Which registers are live where, so heap code spills only those when it may leave the function
import type { AotBlock, AotInst, AotTerm } from "./types";
import { NO_REG, UNPACK_REST } from "../opcodes";

export const windowRegs = (start: number, nargs: number): number[] => Array.from({ length: nargs }, (_, i) => start + i);

// which registers each resume-mode block needs on entry, and which ones the function ever writes
export class Liveness {
    readonly written: number[];
    readonly #writtenSet: Set<number>;
    readonly liveIn: Map<number, Set<number>>;
    readonly entryLive: Set<number>;

    constructor(blocks: AotBlock[], numReg: number) {
        this.written = Liveness.#writtenRegs(blocks, numReg);
        this.#writtenSet = new Set(this.written);
        this.liveIn = Liveness.#compute(blocks);
        this.entryLive = new Set(this.liveIn.get(0));
        for (const block of blocks) {
            const resume = Liveness.#resumePoint(block.term);
            if (resume !== null) for (const r of this.liveIn.get(resume) ?? []) this.entryLive.add(r);
        }
    }

    // registers to write back to frame.regs before leaving at `resume`: live there and possibly changed, plus `extra`
    spillsFor(resume: number, extra: number[] = []): number[] {
        const regs = new Set(extra);
        for (const r of this.liveIn.get(resume) ?? []) if (this.#writtenSet.has(r)) regs.add(r);
        return [...regs].sort((a, b) => a - b);
    }

    static #resumePoint(term: AotTerm): number | null {
        switch (term.k) {
            case "Call": case "CallEC": case "CallCatch": return term.resume;
            case "HostCall": return term.isTail ? null : term.resume;
            default: return null;
        }
    }

    static #writtenRegs(blocks: AotBlock[], numReg: number): number[] {
        const written = new Set<number>();
        for (const block of blocks) {
            for (const inst of block.insts) {
                for (const r of Liveness.#instDefs(inst)) written.add(r);
            }
            const term = block.term;
            if (term.k === "MaybeSelfTailCall") {
                for (let i = 0; i < term.arity.min + (term.arity.rest === "none" ? 0 : 1); i++) written.add(i);
            }
            if (term.k === "CallEC" || term.k === "CallCatch") written.add(term.tok);
        }
        return [...written].filter(r => r < numReg).sort((a, b) => a - b);
    }

    static #instUses(inst: AotInst): number[] {
        switch (inst.k) {
            case "Move": case "Box": case "Unbox": return [inst.src];
            case "SetBox": return [inst.dst, inst.src];
            case "SetUpvar": case "SetGlobal": return [inst.src];
            case "NewClosure": return inst.captures.filter(c => c.local).map(c => c.index);
            case "IntCall": case "IntApply": case "IntApplyRest": return windowRegs(inst.start, inst.nargs);
            case "Unpack": return [inst.src];
            case "SetMark": return [inst.key, inst.val];
            case "MarkRestore": return [inst.reg, inst.reg + 1];
            default: return [];
        }
    }

    // registers an instruction overwrites
    static #instDefs(inst: AotInst): number[] {
        if (inst.k === "Unpack") return windowRegs(inst.start, inst.count + ((inst.flags & UNPACK_REST) !== 0 ? 1 : 0));
        if (inst.k === "MarkSave") return [inst.reg, inst.reg + 1];
        return "dst" in inst && inst.k !== "SetBox" ? [inst.dst] : [];
    }

    static #termUses(term: AotTerm): number[] {
        switch (term.k) {
            case "Branch": return [term.cond];
            case "Call": case "TailCall": case "MaybeSelfTailCall": return [term.proc, ...windowRegs(term.start, term.nargs)];
            case "CallEC": return [term.proc];
            case "CallCatch": return term.pre === NO_REG ? [term.proc] : [term.proc, term.pre];
            case "HostCall": return windowRegs(term.start, term.nargs);
            case "Return": return [term.reg];
            default: return [];
        }
    }

    static #successors(term: AotTerm): number[] {
        switch (term.k) {
            case "Jump": return [term.target];
            case "Block": case "Loop": return [term.body];
            case "Branch": return [term.then, term.else];
            case "Call": case "CallEC": case "CallCatch": return [term.resume];
            case "HostCall": return term.isTail ? [] : [term.resume];
            case "MaybeSelfTailCall": return [0];
            default: return [];
        }
    }

    static #compute(blocks: AotBlock[]): Map<number, Set<number>> {
        const liveIn = new Map<number, Set<number>>(blocks.map(b => [b.start, new Set<number>()]));
        let changed = true;
        while (changed) {
            changed = false;
            for (let b = blocks.length - 1; b >= 0; b--) {
                const block = blocks[b];
                const live = new Set<number>();
                for (const succ of Liveness.#successors(block.term)) {
                    for (const r of liveIn.get(succ) ?? []) live.add(r);
                }
                for (const r of Liveness.#termUses(block.term)) live.add(r);
                for (let i = block.insts.length - 1; i >= 0; i--) {
                    const inst = block.insts[i];
                    for (const r of Liveness.#instDefs(inst)) live.delete(r);
                    for (const r of Liveness.#instUses(inst)) live.add(r);
                }
                const prev = liveIn.get(block.start)!;
                if (live.size !== prev.size || [...live].some(r => !prev.has(r))) {
                    liveIn.set(block.start, live);
                    changed = true;
                }
            }
        }
        return liveIn;
    }
}
