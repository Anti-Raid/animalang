import type { InlineFn } from "./intrinsics";

// AOT templates of the runtime operations (CALLRT), by name (see InlineFn). They may use the names in exec.ts's JIT_DEPS
// (Cons, MultipleValues, ...), `ctx` and `executor`.
export type { InlineFn };

// a one-argument operation; the argument is always a register name, so it may be repeated freely
const unaryInline = (inline: (a: string, slow: string) => string): InlineFn => (args, slow) => args.length === 1 ? inline(args[0], slow) : null;

export const RUNTIME_INLINES = new Map<string, InlineFn>([
    ["%wind", ([before, after]) => `(ctx.wind = new WindPoint(ctx.wind, ${before}, ${after}), undefined)`],
    ["%end-wind", () => `(ctx.wind !== null && (ctx.wind = ctx.wind.parent), undefined)`],
    ["%end-escape", () => `undefined`],
    ["%caught?", unaryInline(v => `${v} instanceof Caught`)],
    ["%caught-value", unaryInline(v => `${v}.error`)],
    ["%make-caught", unaryInline(v => `new Caught(${v})`)],
    ["%handler-key", () => `EXCEPTION_HANDLERS`],
    ["%values-cons", ([x, v]) => `(${v} instanceof MultipleValues ? new MultipleValues([${x}, ...${v}.values]) : new MultipleValues([${x}, ${v}]))`],
    ["%first-value", unaryInline(v => `(${v} instanceof MultipleValues ? ${v}.values[0] : ${v})`)],
    ["%list", args => args.reduceRight((tail, arg) => `new Cons(${arg}, ${tail})`, "null")],
]);
