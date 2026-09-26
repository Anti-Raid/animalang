import { CORE_INTRINSICS } from "./exec";
import { Intrinsics } from "./intrinsics";

// Compiler intrinsics the compiler compiles itself. `leaf`: never calls back into the VM (so no continuation can be
// captured while it runs); the forms that are not leaves call a procedure or leave the frame. The VM's own operations,
// including its control operations (%call/cc, %raise, the coroutine operations), are intrinsics in every table instead
// (CORE_INTRINSICS)
export const CORE_FORMS: ReadonlyMap<symbol, { leaf: boolean }> = new Map([
    ...["%if", "%lambda", "%quote", "%begin", "%set!", "%block", "%escape", "%loop", "%let", "%let-values",
        "%let-values/strict", "%with-mark", "%current-marks", "%define-global"].map(name => [name, true] as const),
    ...["%catch", "%dynamic-wind", "%call/ec", "%apply", "%apply-multi"].map(name => [name, false] as const),
].map(([name, leaf]) => [Symbol.for(name), Object.freeze({ leaf })]))

export const isCoreForm = (sym: symbol): boolean => CORE_FORMS.has(sym)

// a table for a compiler and VM: the core operations first, then `base`'s intrinsics (a table made this way, e.g. a
// front end's), then whatever is registered on it
export const newIntrinsics = (base: Intrinsics = CORE_INTRINSICS): Intrinsics => new Intrinsics(isCoreForm, base)

// whether `table` starts with the core operations, as every table the compiler and VM use must
export const hasCore = (table: Intrinsics): boolean => CORE_INTRINSICS.entries.every((entry, pos) => table.entries[pos] === entry)
