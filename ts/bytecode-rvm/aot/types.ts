// The AOT compiler's decoded instructions and block terminators
import type { Arity } from "../arity";
import type { UpVarLoc } from "../bytecode";
import type { Intrinsic } from "../intrinsics";

// `at` is the ip of the instruction an op or terminator was decoded from
export type AotInst = { at?: number } & (
    | { k: "LoadConst"; dst: number; idx: number }
    | { k: "LoadInt"; dst: number; value: number }
    | { k: "LoadUpvar"; dst: number; idx: number; unbox: boolean }
    | { k: "SetUpvar"; src: number; idx: number; box: boolean }
    | { k: "LoadGlobal"; dst: number; sym: number; ip: number }
    | { k: "SetGlobal"; src: number; sym: number }
    | { k: "Move" | "Box" | "Unbox" | "SetBox"; dst: number; src: number }
    | { k: "NewClosure"; dst: number; tmpl: number; captures: UpVarLoc[] }
    | { k: "MoveAcc"; dst: number }
    | { k: "IntCall" | "IntApply" | "IntApplyRest"; pos: number; dst: number; start: number; nargs: number }
    | { k: "Unpack"; src: number; start: number; count: number; flags: number }
    | { k: "SetMark"; key: number; val: number }
    | { k: "MarkSave" | "MarkRestore"; reg: number }
    | { k: "CurMarks"; dst: number });

export type AotTerm = { at?: number } & (
    // `escape` jumps leave a %block early; `loopBack` jumps close a %loop
    | { k: "Jump"; target: number; escape?: boolean; loopBack?: boolean }
    | { k: "Block" | "Loop"; body: number; end: number }
    | { k: "Branch"; cond: number; then: number; else: number; elseif: boolean }
    | { k: "Call"; proc: number; start: number; nargs: number; resume: number }
    | { k: "TailCall"; proc: number; start: number; nargs: number; ip: number }
    | { k: "MaybeSelfTailCall"; proc: number; start: number; nargs: number; ip: number; arity: Arity }
    | { k: "CallEC"; proc: number; tok: number; resume: number }
    | { k: "CallCatch"; proc: number; tok: number; pre: number; resume: number }
    | { k: "HostCall"; pos: number; start: number; nargs: number; isTail: boolean; resume: number }
    | { k: "Return"; reg: number });

export type AotBlock = { start: number; insts: AotInst[]; term: AotTerm };

export const STRUCTURE_MISMATCH = Symbol("structure mismatch");

export const MAX_STRUCTURED_NESTING = 250;

// what generated source depends on in an intrinsic it calls (not its function, so a cached source keeps none alive)
export type SourceUse = Pick<Intrinsic, "pos" | "inline" | "deps">;
