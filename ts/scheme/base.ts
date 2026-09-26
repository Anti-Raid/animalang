import { Intrinsics } from "../bytecode-rvm/intrinsics";
import { isCompilerIntrinsic } from "../bytecode-rvm/core";
import { registerSchemeIntrinsics, SCHEME_ALIASES } from "./intrinsics";
import { SCHEME_RESERVED, SCHEME_SPECIAL_FORMS } from "./symbols";

// What every Scheme instance's intrinsics start as: the builtins' intrinsics and the reserved names, built once and frozen
// (never changed after). Instances copy it, so they all have the builtins at the same positions, and code bound to it
// (the cached prelude) runs the same in any of them
let base: Intrinsics | null = null;

export const schemeBase = (): Intrinsics => {
    if (base !== null) return base;
    const table = new Intrinsics(isCompilerIntrinsic);
    registerSchemeIntrinsics(table);
    for (const sym of SCHEME_SPECIAL_FORMS) table.reserved.set(sym, "special form");
    for (const sym of [...SCHEME_ALIASES.keys(), ...SCHEME_RESERVED]) table.reserved.set(sym, "builtin");
    return base = table.freeze();
};
