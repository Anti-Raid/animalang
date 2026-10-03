// What the compiler lowers a function to, for the AOT compiler: a list of instructions, each at its index in the list
// (`ip`). Positions are what frames resume at, the line table and caches are keyed by, and jumps target

// Unpack flags
export const UNPACK_REST = 1;
export const UNPACK_STRICT = 2;

export type Op = { ip: number } & (
    | { k: "LoadConst"; dst: number; idx: number }
    | { k: "LoadInt"; dst: number; value: number }
    | { k: "LoadUpvar"; dst: number; idx: number; unbox: boolean }
    | { k: "SetUpvar"; src: number; idx: number; box: boolean }
    | { k: "FixUpvar"; clo: number; idx: number; src: number }
    | { k: "LoadGlobal"; dst: number; sym: number }
    | { k: "SetGlobal"; src: number; sym: number }
    // jump to `else` if reg[cond] is false; `elseif` continues the chain an If started
    | { k: "If"; cond: number; else: number; elseif: boolean }
    // end of a then branch: jump past the rest of the if
    | { k: "Else"; end: number }
    | { k: "EndIf" }
    | { k: "Call"; proc: number; start: number; nargs: number; tail: boolean }
    | { k: "Return"; src: number }
    | { k: "NewClosure"; dst: number; tmpl: number }
    | { k: "Move" | "Box" | "Unbox" | "SetBox"; dst: number; src: number }
    | { k: "MoveAcc"; dst: number }
    // start of a %block / %loop ending at `end`
    | { k: "Block" | "Loop"; end: number }
    | { k: "EndLoop"; head: number }
    // an %escape: jump to the end of a %block
    | { k: "Jump"; target: number }
    | { k: "Unpack"; src: number; start: number; count: number; flags: number }
    | { k: "SetMark"; key: number; val: number }
    | { k: "MarkSave" | "MarkRestore"; reg: number }
    | { k: "CurMarks"; dst: number }
    | { k: "HostCall"; pos: number; start: number; nargs: number; tail: boolean }
    | { k: "IntCall" | "IntApply"; pos: number; dst: number; start: number; nargs: number }
    // the code from here on runs in the inlined procedure `site` (an index into Code.inlines; -1: none), or has just
    // returned from it (returnedFrom(site)), for tracebacks (see Code.frameAt)
    | { k: "InlineSite"; site: number });

// the InlineSite of code that has just returned from the inlined procedure `site`, into the one around it
export const returnedFrom = (site: number): number => -site - 2;

export type OpKind = Op["k"];

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

// whether the instruction after `op` starts a basic block
const splits = (op: Op): boolean => {
    switch (op.k) {
        case "If": case "Block": case "Loop": case "EndLoop": case "Jump": return true;
        case "Call": case "HostCall": return !op.tail;
        default: return false;
    }
};

const targets = (op: Op): number[] => {
    switch (op.k) {
        case "If": return [op.else];
        case "Else": case "Block": case "Loop": return [op.end];
        case "EndLoop": return [op.head];
        case "Jump": return [op.target];
        default: return [];
    }
};

// the start of each basic block: the first instruction, every jump target, and the instruction after one that splits
export const blockStarts = (ops: readonly Op[]): number[] => {
    const starts = new Set<number>([0]);
    for (const op of ops) {
        for (const t of targets(op)) starts.add(t);
        if (splits(op)) starts.add(op.ip + 1);
    }
    return Array.from(starts).sort((a, b) => a - b);
};
