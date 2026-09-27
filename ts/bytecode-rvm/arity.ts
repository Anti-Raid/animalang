import type { IntrinsicFn } from "./intrinsics";
import { Msg, vmError } from "../common";

// How a procedure takes its arguments, for closures and intrinsics alike: between `min` and `max` of them. A closure's
// first `min` arguments are its positional parameters; with a `rest` parameter, the others are bound to it, as a plain
// array, or "packed" into the sequence of the table's pack intrinsic (ByteCode.restPos)
export type RestKind = "none" | "array" | "packed";

export type Arity = {
    readonly min: number,
    readonly max: number,
    readonly rest: RestKind,
};

export const closureArity = (params: number, rest: RestKind): Arity =>
    ({ min: params, max: rest === "none" ? params : Infinity, rest });

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
    const min = arity.min;
    if (arity.rest === "none") {
        for (let i = 0; i < min; i++) dst[i] = src[start + i];
        return;
    }
    const rest = pack !== null ? pack(src as any[], start + min, nargs - min) : src.slice(start + min, start + nargs);
    for (let i = 0; i < min; i++) dst[i] = src[start + i];
    dst[min] = rest;
};
