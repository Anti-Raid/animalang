// Type facts: which registers hold a number or a boolean for certain, so inline templates can skip their type checks
// (see InlineFn's `known`). A check V8 cannot drop costs most on numbers it keeps unboxed (floats), which it must box
// to test. Facts come from literals, moves, and intrinsics that declare what they return (`returns`)
import type { Intrinsics } from "../intrinsics";
import type { AotBlock, AotInst, AotTerm } from "./types";

export type Kind = "number" | "boolean";
export type Facts = Map<number, Kind>;

const kindOf = (value: any): Kind | undefined => typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : undefined;

// `facts` after `inst`
export const transfer = (inst: AotInst, facts: Facts, table: Intrinsics | null, constants: readonly any[]): void => {
    const set = (reg: number, kind: Kind | undefined) => kind === undefined ? facts.delete(reg) : facts.set(reg, kind);
    switch (inst.k) {
        case "LoadInt":
            return void facts.set(inst.dst, "number");
        case "LoadConst":
            return void set(inst.dst, kindOf(constants[inst.idx]));
        case "Move":
            return void set(inst.dst, facts.get(inst.src));
        case "IntCall":
        case "IntApply":
            return void set(inst.dst, table?.entries[inst.pos]?.returns);
        case "Unpack":
            for (let i = 0; i <= inst.count; i++) facts.delete(inst.start + i);
            return;
        case "MarkSave":
            facts.delete(inst.reg);
            facts.delete(inst.reg + 1);
            return;
        case "LoadUpvar": case "LoadGlobal": case "Box": case "Unbox": case "NewClosure": case "MoveAcc": case "CurMarks":
            return void facts.delete(inst.dst);
        case "SetUpvar": case "FixUpvar": case "SetGlobal": case "SetBox": case "SetMark": case "MarkRestore":
            return;
        default: {
            const _: never = inst;
        }
    }
};

const successors = (term: AotTerm): number[] => {
    switch (term.k) {
        case "Jump": return [term.target];
        case "Block": case "Loop": return [term.body];
        case "Branch": return [term.then, term.else];
        case "Call": case "CallEC": case "CallCatch": return [term.resume];
        case "HostCall": return term.isTail ? [] : [term.resume];
        case "TailCall": case "MaybeSelfTailCall": case "Return": return [];
    }
};

const meet = (a: Facts, b: Facts): Facts => {
    const out: Facts = new Map();
    for (const [reg, kind] of a) if (b.get(reg) === kind) out.set(reg, kind);
    return out;
};

const same = (a: Facts, b: Facts): boolean => a.size === b.size && [...a].every(([reg, kind]) => b.get(reg) === kind);

// The facts at the start of each block (by its start ip) of a function entered only at its start, as its direct entry
// is: a block's are those every way into it agrees on, to a fixpoint through loops. (Resume code is entered at any
// block, with registers read back from a frame, so it keeps facts only within a block)
// `seed`: what is known on entry (a version of the function for number parameters)
export const blockFacts = (blocks: AotBlock[], table: Intrinsics | null, constants: readonly any[], seed: Facts | null = null): Map<number, Facts> => {
    const index = new Map(blocks.map((b, i) => [b.start, i]));
    const entry = new Map<number, Facts>([[blocks[0]?.start ?? 0, new Map(seed ?? [])]]);
    const out = new Map<number, Facts>();
    const work = [0];
    while (work.length > 0) {
        const i = work.pop()!;
        const block = blocks[i];
        const facts = new Map(entry.get(block.start)!);
        for (const inst of block.insts) transfer(inst, facts, table, constants);
        if (block.term.k === "CallEC" || block.term.k === "CallCatch") facts.delete(block.term.tok);
        const before = out.get(block.start);
        if (before !== undefined && same(before, facts)) continue;
        out.set(block.start, facts);
        for (const target of successors(block.term)) {
            const j = index.get(target);
            if (j === undefined) continue;
            const known = entry.get(target);
            const next = known === undefined ? new Map(facts) : meet(known, facts);
            if (known === undefined || !same(known, next)) {
                entry.set(target, next);
                work.push(j);
            }
        }
    }
    return entry;
};
