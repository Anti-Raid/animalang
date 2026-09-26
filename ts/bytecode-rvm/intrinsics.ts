import { IBUILTINS_IDX_MAP } from "../std";
import { CXR_PATHS, PREDICATES, ARITHMETIC } from "../ops";
import { RESERVED_BUILTINS } from "../common";
import { addRuntimeOp, HOST_FNS, RUNTIME_IDX } from "./exec";
import { RUNTIME_INLINES, type InlineFn } from "./inline";

// % forms that are calls of a public builtin (CALL of its index)
export const BUILTIN_INTRINSICS = new Map<symbol, number>([
    ...[...ARITHMETIC, ...PREDICATES, ...CXR_PATHS].map(([name]) => name),
    "list",
    "cons",
    "vector-ref",
    "vector-set!",
    "vector-length",
    "table-ref",
    "table-set!",
    "table-has?",
    "table-border",
].map(name => [Symbol.for(`%${name}`), IBUILTINS_IDX_MAP.get(Symbol.for(name))!]))

// % forms that are runtime operations (CALLRT)
export const RUNTIME_INTRINSICS = new Map<symbol, { idx: number, min: number, max: number }>(([
    ["%coroutine-create", "coroutine-create", 1, 1],
    ["%coroutine-status", "coroutine-status", 1, 1],
    ["%coroutine-close", "coroutine-close", 1, 1],
    ["%values->list", "values->list", 1, 1],
    ["%debug-frames", "debug-frames", 2, 2],
    ["%debug-traceback", "debug-traceback", 2, 2],
    ["%first-value", "first-value", 1, 1],
    ["%marks-first", "marks-first", 3, 3],
    ["%marks->list", "marks->list", 2, 2],
    ["%handler-key", "handler-key", 0, 0],
    ["%values-cons", "values-cons", 2, 2],
] as [string, string, number, number][]).map(([form, name, min, max]) => [Symbol.for(form), { idx: RUNTIME_IDX.get(name)!, min, max }]))

// runtime intrinsics that may run Scheme code (closing a coroutine runs its dynamic-wind after-thunks)
export const RUNTIME_INTRINSICS_CALLING_SCHEME = new Set([Symbol.for("%coroutine-close")])

// host intrinsics that are not leaves: they may return a tail request (hostTail), so they compile to CALLHOST
export const HOST_CALLING = new Set<symbol>()

export type HostIntrinsicOptions = {
    // [min, max] argument counts, checked at compile time
    args?: [number, number],
    // never calls back into Scheme (never returns a tail request): a plain CALLRT, and not a call for boxing analysis
    leaf?: boolean,
    // AOT template: given the argument expressions and the direct call of fn, a js expression (see inline.ts)
    inline?: InlineFn,
}

// Registers `(name arg ...)` as a compiler intrinsic that calls `fn`; code using it must be compiled afterwards
export const registerHostIntrinsic = (name: string, fn: (...args: any[]) => any, options: HostIntrinsicOptions = {}): void => {
    if (!name.startsWith("%")) throw new Error(`host intrinsic names start with '%', but got '${name}'`)
    const sym = Symbol.for(name)
    if (RUNTIME_INTRINSICS.has(sym) || BUILTIN_INTRINSICS.has(sym) || RESERVED_BUILTINS.has(sym)) throw new Error(`'${name}' is already defined`)
    const [min, max] = options.args ?? [0, Infinity]
    const idx = addRuntimeOp(name, (ctx, executor, regs, start, nargs) => fn(...regs.slice(start, start + nargs)))
    HOST_FNS[idx] = fn
    RUNTIME_INTRINSICS.set(sym, { idx, min, max })
    if (options.inline !== undefined) RUNTIME_INLINES.set(name, options.inline)
    if (!options.leaf) {
        HOST_CALLING.add(sym)
        RUNTIME_INTRINSICS_CALLING_SCHEME.add(sym)
    }
    RESERVED_BUILTINS.add(sym)
}
