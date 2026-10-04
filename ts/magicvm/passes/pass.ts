// A compiler pass: one job, from its input to its output. The compiler runs its passes in order (Compiler.compile)
import type { Intrinsics } from "../intrinsics";

export type PassContext = {
    readonly intrinsics: Intrinsics,
    readonly debug: boolean,
    // whether to run the optimizer (passes/cp0.ts)
    readonly optimize: boolean,
    // whether a continuation may run a frame of the code more than once (see AnimaOptions)
    readonly reentrant: boolean,
    // the intrinsics the optimizer folded or dropped calls of: every function compiled records them as used (see
    // Code.bind), as what it computes depends on them
    readonly assumed: Set<number>,
    // called with each pass's output, e.g. by tests, to see or check it
    readonly trace?: (pass: string, output: unknown) => void,
};

export type Pass<In, Out> = { readonly name: string, run(input: In, ctx: PassContext): Out };

export const runPass = <In, Out>(pass: Pass<In, Out>, input: In, ctx: PassContext): Out => {
    const output = pass.run(input, ctx);
    ctx.trace?.(pass.name, output);
    return output;
};
