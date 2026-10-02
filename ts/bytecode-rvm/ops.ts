// What the compiler lowers a function to, for the AOT compiler: a list of instructions, each at a position (`ip`) in
// the function. Positions are what frames resume at, the line table and caches are keyed by, and jumps target; an
// instruction takes `OP_SIZE` of them

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
    | { k: "IntCall" | "IntApply"; pos: number; dst: number; start: number; nargs: number });

export type OpKind = Op["k"];

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export const OP_SIZE: Readonly<Record<OpKind, number>> = Object.freeze({
    LoadConst: 3, LoadInt: 3, LoadUpvar: 4, SetUpvar: 4, FixUpvar: 4, LoadGlobal: 3, SetGlobal: 3,
    If: 3, Else: 2, EndIf: 1, Call: 5, Return: 2, NewClosure: 3, Move: 3, Box: 3, Unbox: 3, SetBox: 3, MoveAcc: 2,
    Block: 2, Loop: 2, EndLoop: 2, Jump: 2, Unpack: 5, SetMark: 3, MarkSave: 2, MarkRestore: 2, CurMarks: 2,
    HostCall: 5, IntCall: 5, IntApply: 5,
});

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
        if (splits(op)) starts.add(op.ip + OP_SIZE[op.k]);
    }
    return Array.from(starts).sort((a, b) => a - b);
};
