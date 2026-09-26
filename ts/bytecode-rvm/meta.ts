import type { ExecutionMode } from "./exec";

// How an instance compiles and runs code: interpreted, or compiled to JS ("aot"); and as debug code (exact error
// positions and tail-call trails in tracebacks)
export type AnimaOptions = { readonly mode: ExecutionMode, readonly debug: boolean };

export const impl: AnimaOptions = { mode: "interp", debug: false };
export const implAot: AnimaOptions = { mode: "aot", debug: false };
export const implDebug: AnimaOptions = { mode: "interp", debug: true };
export const implAotDebug: AnimaOptions = { mode: "aot", debug: true };
