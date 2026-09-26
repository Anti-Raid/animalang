import { Cons } from "../list";
import { hostError } from "../errors";

// How a procedure takes its arguments, for closures and intrinsics alike: between `min` and `max` of them. A closure's
// first `min` arguments are its positional parameters; with a `rest` parameter, the others are bound to it, as a list,
// or as a plain array when the compiler proved it is only ever spread back into a call (see VariableMetadata.forwardsRest)
export type RestKind = "none" | "list" | "array";

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
export const arityMessage = (name: string, min: number, max: number, nargs: number): string => {
    const expected = min === max ? `exactly ${min}` : max === Infinity ? `at least ${min}` : `${min} to ${max}`;
    return `${name}: expected ${expected} args, got ${nargs}`;
};

export const checkArity = (name: string, arity: { readonly min: number, readonly max: number }, nargs: number): void => {
    if (nargs < arity.min || nargs > arity.max) throw hostError(arityMessage(name, arity.min, arity.max, nargs));
};

// a rest list of src[from .. to)
export const restList = (src: readonly any[], from: number, to: number): Cons | null => {
    let list: Cons | null = null;
    for (let i = to - 1; i >= from; i--) list = new Cons(src[i], list);
    return list;
};

// the rest parameter's value for the arguments src[from .. to). `owned`: src is a fresh array nothing else holds, so
// an array rest may be src itself
export const restValue = (rest: RestKind, src: readonly any[], from: number, to: number, owned: boolean = false): any => {
    if (rest === "list") return restList(src, from, to);
    return owned && from === 0 && to === src.length ? src : src.slice(from, to);
};

// binds the arguments src[start .. start+nargs) (the count already checked) to a closure's parameter registers
// dst[0 .. min] (the rest parameter last). dst may be src: the rest value is built before any positional is moved, and
// positionals move down (start >= 0), so the window is never overwritten before it is read. Every call runs this, so
// the common case (no rest parameter) is kept to the copy loop
export const bindArgs = (arity: Arity, dst: any[], src: readonly any[], start: number, nargs: number): void => {
    const min = arity.min;
    if (arity.rest === "none") {
        for (let i = 0; i < min; i++) dst[i] = src[start + i];
        return;
    }
    const rest = arity.rest === "list" ? restList(src, start + min, start + nargs) : src.slice(start + min, start + nargs);
    for (let i = 0; i < min; i++) dst[i] = src[start + i];
    dst[min] = rest;
};
