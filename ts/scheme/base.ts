import type { Intrinsics } from "../bytecode-rvm/intrinsics";
import { newIntrinsics } from "../bytecode-rvm/core";
import { registerSchemeIntrinsics, SCHEME_ALIASES } from "./builtins";
import { SCHEME_SPECIAL_FORMS } from "./symbols";

// What every Scheme instance's intrinsics start as: the builtins' intrinsics and the reserved names, built once and frozen
// (never changed after). Instances copy it, so they all have the builtins at the same positions, and code bound to it
// (the cached prelude) runs the same in any of them
let base: Intrinsics | null = null;

export const schemeBase = (): Intrinsics => {
    if (base !== null) return base;
    const table = newIntrinsics();
    registerSchemeIntrinsics(table);
    for (const sym of SCHEME_SPECIAL_FORMS) table.reserved.set(sym, "special form");
    for (const sym of SCHEME_ALIASES.keys()) table.reserved.set(sym, "builtin");
    return base = table.freeze();
};
