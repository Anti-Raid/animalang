import { IBUILTINS_IDX_MAP } from "../scheme/builtins";
import { CXR_PATHS, PREDICATES, ARITHMETIC } from "../ops";
import { RUNTIME, RUNTIME_IDX } from "./exec";

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

// Compiler intrinsics the compiler compiles itself. `leaf`: never calls back into the VM (so no continuation can be
// captured while it runs); the forms that are not leaves call a procedure or leave the frame
export const CORE_FORMS: ReadonlyMap<symbol, { leaf: boolean }> = new Map([
    ...["%if", "%lambda", "%quote", "%begin", "%set!", "%block", "%escape", "%loop", "%let", "%let-values",
        "%let-values/strict", "%with-mark", "%current-marks", "%current-stack", "%define-global"].map(name => [name, true] as const),
    ...["%catch", "%raise", "%dynamic-wind", "%call/cc", "%call/ec", "%apply", "%apply-multi", "%coroutine-yield",
        "%coroutine-yield-list", "%coroutine-resume", "%coroutine-resume-list"].map(name => [name, false] as const),
].map(([name, leaf]) => [Symbol.for(name), Object.freeze({ leaf })]))

// Compiler intrinsics that are runtime operations: CALLRT of a fixed index into RUNTIME
export const CORE_OPS: ReadonlyMap<symbol, { idx: number, min: number, max: number, leaf: boolean }> = new Map(
    RUNTIME.map(({ name, args: [min, max], leaf }) => [Symbol.for(name), Object.freeze({ idx: RUNTIME_IDX.get(name)!, min, max, leaf })])
)

export const isCompilerIntrinsic = (sym: symbol): boolean => CORE_FORMS.has(sym) || CORE_OPS.has(sym)

// names an intrinsics table may not register: compiler intrinsics, and the builtins until they become intrinsics
export const isTakenName = (sym: symbol): boolean => isCompilerIntrinsic(sym) || BUILTIN_INTRINSICS.has(sym) || IBUILTINS_IDX_MAP.has(sym)
