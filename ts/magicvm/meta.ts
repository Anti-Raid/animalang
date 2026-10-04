// How an instance compiles code: optimized (passes/cp0.ts), and as debug code (exact error positions and tail-call
// trails in tracebacks) or not
// `reentrant` (the default): a continuation may run a captured frame of the code more than once, so an assigned variable
// read after a call is kept in a box. A front end with no such continuations (no %call/cc, no %call/comp) says false:
// those variables stay in registers, and running a captured frame of its code a second time is an error
export type AnimaOptions = { readonly debug: boolean, readonly optimize: boolean, readonly reentrant?: boolean };

export const impl: AnimaOptions = { debug: false, optimize: true };
export const implDebug: AnimaOptions = { debug: true, optimize: false };
