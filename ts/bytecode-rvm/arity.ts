import type { IntrinsicFn } from "./intrinsics";
import { Msg, vmError } from "../common";

// How a procedure takes its arguments, for closures and intrinsics alike: between `min` and `max` of them. A closure's
// first `min` arguments are its positional parameters; with a `rest` parameter, the others are bound to it, as a plain
// array, or "packed" into the sequence of the table's pack intrinsic (ByteCode.restPos)
export type RestKind = "none" | "array" | "packed";

// `params`: how many positional parameters; `pad`: missing ones are <#void> and extra arguments are dropped (or go to
// the rest parameter), so any count is taken (min 0, max ∞)
export type Arity = {
    readonly min: number,
    readonly max: number,
    readonly rest: RestKind,
    readonly params: number,
    readonly pad: boolean,
};

export const closureArity = (params: number, rest: RestKind, pad: boolean = false): Arity =>
    ({ min: pad ? 0 : params, max: pad || rest !== "none" ? Infinity : params, rest, params, pad });

export const fitsArity = (arity: { readonly min: number, readonly max: number }, nargs: number): boolean =>
    nargs >= arity.min && nargs <= arity.max;

// the one message for a wrong argument count, whatever was called
export const checkArity = (name: string, arity: { readonly min: number, readonly max: number }, nargs: number): void => {
    if (nargs < arity.min || nargs > arity.max) throw vmError(Msg.Arity, name, arity.min, arity.max, nargs);
};

// binds the arguments src[start .. start+nargs) (the count already checked) to a closure's parameter registers
// dst[0 .. min] (the rest parameter last). dst may be src: the rest value is built before any positional is moved, and
// positionals move down (start >= 0), so the window is never overwritten before it is read. Every call runs this, so
// the common case (no rest parameter) is kept to the copy loop
export const bindArgs = (arity: Arity, dst: any[], src: readonly any[], start: number, nargs: number, pack: IntrinsicFn | null): void => {
    const n = arity.params;
    if (arity.rest === "none" && !arity.pad) {
        for (let i = 0; i < n; i++) dst[i] = src[start + i];
        return;
    }
    const extra = Math.max(nargs - n, 0);
    const rest = arity.rest === "none" ? undefined : pack !== null ? pack(src as any[], start + n, extra) : src.slice(start + n, start + n + extra);
    for (let i = 0; i < n; i++) dst[i] = i < nargs ? src[start + i] : undefined;
    if (arity.rest !== "none") dst[n] = rest;
};
