import { IBUILTINS_IDX_MAP } from "../std";
import { CXR_PATHS, PREDICATES, ARITHMETIC } from "../ops";
import { RUNTIME_IDX } from "./exec";

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
    ["%set-raise-proc", "set-raise-proc", 1, 1],
    ["%handlers", "handlers", 0, 0],
    ["%set-handlers!", "set-handlers!", 1, 1],
    ["%coroutine-create", "coroutine-create", 1, 1],
    ["%coroutine-status", "coroutine-status", 1, 1],
    ["%coroutine-close", "coroutine-close", 1, 1],
    ["%values->list", "values->list", 1, 1],
    ["%debug-frames", "debug-frames", 2, 2],
    ["%debug-traceback", "debug-traceback", 2, 2],
    ["%first-value", "first-value", 1, 1],
] as [string, string, number, number][]).map(([form, name, min, max]) => [Symbol.for(form), { idx: RUNTIME_IDX.get(name)!, min, max }]))

// runtime intrinsics that may run Scheme code (closing a coroutine runs its dynamic-wind after-thunks)
export const RUNTIME_INTRINSICS_CALLING_SCHEME = new Set([Symbol.for("%coroutine-close")])
