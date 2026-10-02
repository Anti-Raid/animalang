// How an instance compiles code: as debug code (exact error positions and tail-call trails in tracebacks) or not
export type AnimaOptions = { readonly debug: boolean };

export const impl: AnimaOptions = { debug: false };
export const implDebug: AnimaOptions = { debug: true };
