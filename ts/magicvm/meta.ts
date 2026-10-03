// How an instance compiles code: optimized (passes/cp0.ts), and as debug code (exact error positions and tail-call
// trails in tracebacks) or not
export type AnimaOptions = { readonly debug: boolean, readonly optimize: boolean };

export const impl: AnimaOptions = { debug: false, optimize: true };
export const implDebug: AnimaOptions = { debug: true, optimize: false };
