// Type facts: the kind (see Kind) each register certainly holds, so inline templates can skip their type checks (see
// InlineFn's `known`). A check V8 cannot drop costs most on numbers it keeps unboxed (floats), which it must box to
// test. Facts come from literals (the front end's TypeSystem.ofConstant; booleans the VM knows), moves, and intrinsics
// that declare what they return (`returns`). The VM gives the kinds no meaning, but for "boolean" (truthiness)
import { Intrinsics, type Intrinsic, type Kind, type ArgKinds } from "../intrinsics";
import type { AotBlock, AotInst, AotTerm } from "./types";
import { windowRegs } from "./liveness";

export type Facts = Map<number, Kind>;
export type Aliases = Map<number, Set<number>>;

const kindOf = (value: any, table: Intrinsics | null): Kind | undefined =>
    typeof value === "boolean" ? "boolean" : table?.types?.ofConstant(value);

const removeAlias = (aliases: Aliases | undefined, reg: number): void => {
    if (!aliases) return;
    const set = aliases.get(reg);
    if (set) {
        set.delete(reg);
        if (set.size <= 1) {
            for (const other of set) aliases.delete(other);
        }
        aliases.delete(reg);
    }
};

const addAlias = (aliases: Aliases | undefined, a: number, b: number): void => {
    if (!aliases) return;
    removeAlias(aliases, a);
    const set = aliases.get(b) ?? new Set([b]);
    set.add(a);
    aliases.set(a, set);
    aliases.set(b, set);
};

const setWithAliases = (reg: number, kind: Kind | undefined, facts: Facts, aliases?: Aliases): void => {
    if (kind === undefined) {
        facts.delete(reg);
    } else {
        facts.set(reg, kind);
        const set = aliases?.get(reg);
        if (set) {
            for (const other of set) facts.set(other, kind);
        }
    }
};

// `facts` after `inst`
export const transfer = (
    inst: AotInst,
    facts: Facts,
    table: Intrinsics | null,
    constants: readonly any[],
    aliases?: Aliases
): void => {
    const set = (reg: number, kind: Kind | undefined) => setWithAliases(reg, kind, facts, aliases);
    switch (inst.k) {
        case "LoadInt":
            removeAlias(aliases, inst.dst);
            return void set(inst.dst, kindOf(inst.value, table));
        case "LoadConst":
            removeAlias(aliases, inst.dst);
            return void set(inst.dst, kindOf(constants[inst.idx], table));
        case "Move": {
            addAlias(aliases, inst.dst, inst.src);
            const srcKind = facts.get(inst.src);
            if (srcKind !== undefined) set(inst.dst, srcKind);
            else facts.delete(inst.dst);
            return;
        }
        case "IntCall":
        case "IntApply": {
            const entry = table?.entries[inst.pos];
            if (entry === undefined) {
                removeAlias(aliases, inst.dst);
                return void facts.delete(inst.dst);
            }
            const kinds = inst.k === "IntCall" ? windowRegs(inst.start, inst.nargs).map(r => facts.get(r)) : null;
            let effectiveKinds: ArgKinds | null = kinds;
            if (kinds !== null && entry.refineArgs !== undefined) {
                const refined = entry.refineArgs(kinds);
                if (refined !== undefined) {
                    effectiveKinds = refined;
                    for (let i = 0; i < refined.length; i++) {
                        const k = refined[i];
                        if (k !== undefined) set(inst.start + i, k);
                    }
                }
            }
            removeAlias(aliases, inst.dst);
            return void set(inst.dst, Intrinsics.resultKind(entry, effectiveKinds));
        }
        case "Unpack":
            for (let i = 0; i <= inst.count; i++) {
                removeAlias(aliases, inst.start + i);
                facts.delete(inst.start + i);
            }
            return;
        case "MarkSave":
            removeAlias(aliases, inst.reg);
            removeAlias(aliases, inst.reg + 1);
            facts.delete(inst.reg);
            facts.delete(inst.reg + 1);
            return;
        case "LoadUpvar": case "LoadGlobal": case "Box": case "Unbox": case "NewClosure": case "MoveAcc": case "CurMarks":
            removeAlias(aliases, inst.dst);
            return void facts.delete(inst.dst);
        case "SetUpvar": case "FixUpvar": case "SetGlobal": case "SetBox": case "SetMark": case "MarkRestore": case "SetSite":
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
        case "Call": return [term.resume];
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

const written = (inst: AotInst): number[] => {
    switch (inst.k) {
        case "Unpack": return windowRegs(inst.start, inst.count + 1);
        case "MarkSave": return [inst.reg, inst.reg + 1];
        case "LoadInt": case "LoadConst": case "Move": case "IntCall": case "IntApply": case "LoadUpvar": case "LoadGlobal":
        case "Box": case "Unbox": case "NewClosure": case "MoveAcc": case "CurMarks":
            return [inst.dst];
        case "SetUpvar": case "FixUpvar": case "SetGlobal": case "SetBox": case "SetMark": case "MarkRestore": case "SetSite":
            return [];
    }
};

// the intrinsic call whose result a branch tests (through moves and invertBranch calls), if its arguments still hold
// what it was called with at the branch
const resolveBranchCondition = (
    condReg: number,
    insts: AotInst[],
    table: Intrinsics | null
): { entry: Intrinsic; start: number; nargs: number; inverted: boolean } | null => {
    let curr = condReg;
    let inverted = false;
    const later = new Set<number>();
    for (let i = insts.length - 1; i >= 0; i--) {
        const inst = insts[i];
        if (inst.k === "Move" && inst.dst === curr) {
            curr = inst.src;
        } else if (inst.k === "IntCall" && inst.dst === curr) {
            const entry = table?.entries[inst.pos];
            if (entry?.invertBranch && inst.nargs === 1) {
                inverted = !inverted;
                curr = inst.start;
            } else if (entry && !windowRegs(inst.start, inst.nargs).some(r => later.has(r))) {
                return { entry, start: inst.start, nargs: inst.nargs, inverted };
            } else {
                return null;
            }
        } else if (written(inst).includes(curr)) {
            return null;
        }
        for (const r of written(inst)) later.add(r);
    }
    return null;
};

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
        const aliases: Aliases = new Map();
        for (const inst of block.insts) transfer(inst, facts, table, constants, aliases);
        const before = out.get(block.start);
        if (before !== undefined && same(before, facts)) continue;
        out.set(block.start, facts);

        const propagate = (target: number, edgeFacts: Facts) => {
            const j = index.get(target);
            if (j === undefined) return;
            const known = entry.get(target);
            const next = known === undefined ? new Map(edgeFacts) : meet(known, edgeFacts);
            if (known === undefined || !same(known, next)) {
                entry.set(target, next);
                work.push(j);
            }
        };

        if (block.term.k === "Branch") {
            const term = block.term;
            const thenFacts = new Map(facts);
            const elseFacts = new Map(facts);

            if (facts.get(term.cond) === "boolean") {
                thenFacts.set(term.cond, "boolean");
                elseFacts.set(term.cond, "boolean");
            }

            const cond = resolveBranchCondition(term.cond, block.insts, table);
            if (cond !== null && cond.entry.branchNarrow !== undefined) {
                const kinds = windowRegs(cond.start, cond.nargs).map(r => facts.get(r));
                const narrow = cond.entry.branchNarrow(kinds);
                let thenKinds = narrow?.then;
                let elseKinds = narrow?.else;
                if (cond.inverted) {
                    const tmp = thenKinds;
                    thenKinds = elseKinds;
                    elseKinds = tmp;
                }
                if (thenKinds) {
                    for (let k = 0; k < thenKinds.length; k++) {
                        const kind = thenKinds[k];
                        if (kind !== undefined) {
                            const r = cond.start + k;
                            thenFacts.set(r, kind);
                            const set = aliases.get(r);
                            if (set) for (const other of set) thenFacts.set(other, kind);
                        }
                    }
                }
                if (elseKinds) {
                    for (let k = 0; k < elseKinds.length; k++) {
                        const kind = elseKinds[k];
                        if (kind !== undefined) {
                            const r = cond.start + k;
                            elseFacts.set(r, kind);
                            const set = aliases.get(r);
                            if (set) for (const other of set) elseFacts.set(other, kind);
                        }
                    }
                }
            }
            propagate(term.then, thenFacts);
            propagate(term.else, elseFacts);
        } else {
            for (const target of successors(block.term)) {
                propagate(target, facts);
            }
        }
    }
    return entry;
};
