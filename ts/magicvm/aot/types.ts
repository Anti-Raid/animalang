// The AOT compiler's decoded instructions and block terminators
import type { Arity } from "../arity";
import type { ClosureTemplate, UpVarLoc } from "../code";
import type { Op } from "../ops";
import type { Intrinsic } from "../intrinsics";

// an instruction that does not end a basic block: the compiler's own (ops.ts), at its `ip`
export type AotInst = Exclude<Op, { k: "If" | "Else" | "EndIf" | "Block" | "Loop" | "EndLoop" | "Jump" | "Call" | "HostCall" | "Return" }>;

// how a block ends, decoded from the instruction at `at`
export type AotTerm = { at?: number } & (
    // `escape` jumps leave a %block early; `loopBack` jumps close a %loop
    | { k: "Jump"; target: number; escape?: boolean; loopBack?: boolean }
    | { k: "Block" | "Loop"; body: number; end: number }
    | { k: "Branch"; cond: number; then: number; else: number; elseif: boolean }
    | { k: "Call"; proc: number; start: number; nargs: number; resume: number; one?: true; many?: number }
    | { k: "TailCall"; proc: number; start: number; nargs: number; ip: number }
    | { k: "MaybeSelfTailCall"; proc: number; start: number; nargs: number; ip: number; arity: Arity; restPos: number }
    | { k: "HostCall"; pos: number; start: number; nargs: number; isTail: boolean; resume: number }
    | { k: "Return"; reg: number });

export type AotBlock = { start: number; insts: AotInst[]; term: AotTerm };

export const STRUCTURE_MISMATCH = Symbol("structure mismatch");

export const MAX_STRUCTURED_NESTING = 250;

// what generated source depends on in an intrinsic it calls (not its function, so a cached source keeps none alive)
export type SourceUse = Pick<Intrinsic, "pos" | "inline" | "site" | "deps" | "name" | "min" | "max" | "returns" | "wants" | "refineArgs" | "branchNarrow" | "invertBranch">;

// the variables a NewClosure captures: its template's, among the code's constants
export const capturesOf = (inst: Extract<AotInst, { k: "NewClosure" }>, constants: readonly any[]): readonly UpVarLoc[] =>
    (constants[inst.tmpl] as ClosureTemplate).upvarLocs;
