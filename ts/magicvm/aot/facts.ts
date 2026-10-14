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

// (the registers that hold one value are known to be of one kind, or none of them is: so one that is already known
// to be of `kind` has nothing to tell the others)
const setWithAliases = (reg: number, kind: Kind | undefined, facts: Facts, aliases?: Aliases): void => {
    if (kind === undefined) {
        facts.delete(reg);
    } else if (facts.get(reg) !== kind) {
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
            // (what else holds the value is known as `src` is)
            const srcKind = facts.get(inst.src);
            if (srcKind !== undefined) facts.set(inst.dst, srcKind);
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
        case "LoadUpvar": case "LoadGlobal": case "LoadImport": case "ImportGlobals": case "ImportRef": case "Box": case "Unbox": case "NewClosure": case "MoveAcc": case "CurMarks":
            removeAlias(aliases, inst.dst);
            return void facts.delete(inst.dst);
        case "SetUpvar": case "FixUpvar": case "SetGlobal": case "ImportSet": case "SetBox": case "SetMark": case "MarkRestore": case "InlineSite":
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
        case "LoadInt": case "LoadConst": case "Move": case "IntCall": case "IntApply": case "LoadUpvar": case "LoadGlobal": case "LoadImport": case "ImportGlobals": case "ImportRef":
        case "Box": case "Unbox": case "NewClosure": case "MoveAcc": case "CurMarks":
            return [inst.dst];
        case "SetUpvar": case "FixUpvar": case "SetGlobal": case "ImportSet": case "SetBox": case "SetMark": case "MarkRestore": case "InlineSite":
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
// The kind each parameter is wanted of: that of the intrinsics that may read it (their `wants`) as it came in, from its
// own register or one it was moved to; none for a parameter read as two kinds. Which parameters' values a register may
// hold is worked out block by block, as the kinds are below: a register holds what was last moved to it, so one used
// for a parameter and then for another value says nothing of the first where the second is read
const MAX_KINDED_PARAMS = 30;
export const paramKinds = (blocks: AotBlock[], table: Intrinsics | null, params: number): Map<number, Kind> => {
    const out = new Map<number, Kind>();
    if (params === 0 || blocks.length === 0 || table === null) return out;
    const index = new Map(blocks.map((b, i) => [b.start, i]));
    // (the parameters a register may hold: a bit for each)
    const step = (inst: AotInst, holds: Map<number, number>): void => {
        if (inst.k !== "Move") for (const reg of written(inst)) holds.delete(reg);
        else {
            const held = holds.get(inst.src);
            if (held === undefined) holds.delete(inst.dst);
            else holds.set(inst.dst, held);
        }
    };
    // what each register may hold where a block starts (the first block: the parameters' own, also when a tail call of
    // the function itself comes back to it, with its new arguments)
    const entry: (Map<number, number> | undefined)[] = new Array(blocks.length).fill(undefined);
    entry[0] = new Map(Array.from({ length: Math.min(params, MAX_KINDED_PARAMS) }, (_, i) => [i, 1 << i]));
    const pending = new Uint8Array(blocks.length);
    pending[0] = 1;
    for (let again = true; again;) {
        again = false;
        for (let i = 0; i < blocks.length; i++) {
            if (pending[i] === 0) continue;
            pending[i] = 0;
            const holds = new Map(entry[i]!);
            for (const inst of blocks[i].insts) step(inst, holds);
            for (const target of successors(blocks[i].term)) {
                const j = index.get(target);
                if (j === undefined || j === 0) continue;
                let known = entry[j], grew = known === undefined;
                if (known === undefined) entry[j] = known = new Map();
                for (const [reg, held] of holds) {
                    const before = known.get(reg) ?? 0;
                    if ((before | held) !== before) {
                        known.set(reg, before | held);
                        grew = true;
                    }
                }
                if (!grew) continue;
                pending[j] = 1;
                if (j <= i) again = true;
            }
        }
    }
    const wanted = new Map<number, Kind | null>();
    for (let i = 0; i < blocks.length; i++) {
        if (entry[i] === undefined) continue;
        const holds = new Map(entry[i]!);
        for (const inst of blocks[i].insts) {
            const kind = inst.k === "IntCall" || inst.k === "IntApply" ? table.entries[inst.pos]?.wants : undefined;
            if (kind !== undefined && holds.size > 0) {
                for (const reg of windowRegs((inst as { start: number }).start, (inst as { nargs: number }).nargs)) {
                    for (let held = holds.get(reg) ?? 0, param = 0; held !== 0; held >>>= 1, param++) {
                        if ((held & 1) !== 0) wanted.set(param, wanted.has(param) && wanted.get(param) !== kind ? null : kind);
                    }
                }
            }
            step(inst, holds);
        }
    }
    for (let param = 0; param < params; param++) {
        const kind = wanted.get(param);
        if (kind !== undefined && kind !== null) out.set(param, kind);
    }
    return out;
};

export const blockFacts = (blocks: AotBlock[], table: Intrinsics | null, constants: readonly any[], seed: Facts | null = null): Map<number, Facts> => {
    const index = new Map(blocks.map((b, i) => [b.start, i]));
    const entry = new Map<number, Facts>([[blocks[0]?.start ?? 0, new Map(seed ?? [])]]);
    const out = new Map<number, Facts>();
    // the blocks to go through (again), taken in order: one is then reached after the blocks before it that lead to
    // it, so only a loop's blocks are gone through more than once
    const pending = new Uint8Array(blocks.length);
    if (blocks.length > 0) pending[0] = 1;
    for (let again = true; again;) {
      again = false;
      for (let i = 0; i < blocks.length; i++) {
        if (pending[i] === 0) continue;
        pending[i] = 0;
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
                pending[j] = 1;
                if (j <= i) again = true;
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
    }
    return entry;
};
