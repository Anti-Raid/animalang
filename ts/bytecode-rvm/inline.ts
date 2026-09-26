import { CXR_PATHS } from "../ops";

// AOT inlining: given the js expressions of the arguments and of a call to the operation itself (the fallback, which
// reports errors), returns a js expression computing the result, or null to always make the call. `tmp` names a
// scratch variable the expression may assign. Expressions may use the names in exec.ts's JIT_DEPS (Cons, Table,
// MISSING, MultipleValues, ...) and, for runtime operations, `ctx` and `executor`.
export type InlineFn = (args: string[], slow: string, tmp: string) => string | null;

const allNumbers = (args: string[]) => args.map(a => `typeof ${a} === "number"`).join(" && ");

// (op a b c) => ((a op b) op c) when every argument is a number; `unary` handles a single argument
const foldInline = (op: string, empty: string | null, unary: (a: string) => string, divisors = false): InlineFn => (args, slow) => {
    if (args.length === 0) return empty;
    const nonZero = divisors ? (args.length === 1 ? args : args.slice(1)).map(d => ` && ${d} !== 0`).join("") : "";
    const value = args.length === 1 ? unary(args[0]) : args.slice(1).reduce((acc, b) => `(${acc} ${op} ${b})`, args[0]);
    return `(${allNumbers(args)}${nonZero} ? ${value} : ${slow})`;
};

// (op a b c) => a op b && b op c when every argument is a number
const chainInline = (op: string): InlineFn => (args, slow) => {
    if (args.length === 0) return null;
    const tests = args.slice(1).map((b, i) => `${args[i]} ${op} ${b}`);
    return `(${allNumbers(args)} ? ${tests.length > 0 ? tests.join(" && ") : "true"} : ${slow})`;
};

// a one-argument operation; the argument is always a register name, so it may be repeated freely
const unaryInline = (inline: (a: string, slow: string) => string): InlineFn => (args, slow) => args.length === 1 ? inline(args[0], slow) : null;

// walks the path from the innermost accessor, checking each step is a pair
const cxrInline = (path: string): InlineFn => unaryInline((a, slow) => {
    const checks: string[] = [];
    let expr = a;
    for (let i = path.length - 1; i >= 0; i--) {
        checks.push(`${expr} instanceof Cons`);
        expr = `${expr}.${path[i] === "a" ? "car" : "cdr"}`;
    }
    return `(${checks.join(" && ")} ? ${expr} : ${slow})`;
});

const vectorIndexOk = (v: string, k: string) => `Array.isArray(${v}) && Number.isInteger(${k}) && ${k} >= 0 && ${k} < ${v}.length`;

// builtins, by name (builtins cannot be rebound, so the name identifies the procedure)
export const BUILTIN_INLINES = new Map<string, InlineFn>([
    ["+", foldInline("+", "0", a => a)],
    ["-", foldInline("-", null, a => `-${a}`)],
    ["*", foldInline("*", "1", a => a)],
    ["/", foldInline("/", null, a => `1 / ${a}`, true)],
    ["=", chainInline("===")],
    ["<", chainInline("<")],
    ["<=", chainInline("<=")],
    [">", chainInline(">")],
    [">=", chainInline(">=")],
    ["eq?", args => args.length === 0 ? null : `(${args.length === 1 ? "true" : args.slice(1).map(b => `${args[0]} === ${b}`).join(" && ")})`],

    ["list", args => args.reduceRight((tail, arg) => `new Cons(${arg}, ${tail})`, "null")],
    ["cons", args => args.length === 2 ? `Cons.pair(${args[0]}, ${args[1]})` : null],
    ...CXR_PATHS.map(([name, path]): [string, InlineFn] => [name, cxrInline(path)]),

    ["null?", unaryInline(a => `${a} === null`)],
    ["pair?", unaryInline(a => `${a} instanceof Cons`)],
    ["list?", unaryInline(a => `(${a} === null || (${a} instanceof Cons && !${a}.isImproper() && !${a}.isCyclic()))`)],
    ["number?", unaryInline(a => `typeof ${a} === "number"`)],
    ["integer?", unaryInline(a => `Number.isInteger(${a})`)],
    ["positive?", unaryInline(a => `(typeof ${a} === "number" && ${a} > 0)`)],
    ["negative?", unaryInline(a => `(typeof ${a} === "number" && ${a} < 0)`)],
    ["zero?", unaryInline(a => `${a} === 0`)],
    ["even?", unaryInline((a, slow) => `(Number.isInteger(${a}) ? ${a} % 2 === 0 : ${slow})`)],
    ["odd?", unaryInline((a, slow) => `(Number.isInteger(${a}) ? Math.abs(${a} % 2) === 1 : ${slow})`)],
    ["infinite?", unaryInline(a => `(${a} === Infinity || ${a} === -Infinity)`)],
    ["finite?", unaryInline(a => `Number.isFinite(${a})`)],
    ["nan?", unaryInline(a => `Number.isNaN(${a})`)],
    ["boolean?", unaryInline(a => `typeof ${a} === "boolean"`)],
    ["void?", unaryInline(a => `${a} === undefined`)],
    ["symbol?", unaryInline(a => `typeof ${a} === "symbol"`)],
    ["string?", unaryInline(a => `typeof ${a} === "string"`)],
    ["procedure?", unaryInline(a => `${a} instanceof IProcedure`)],
    ["error?", unaryInline(a => `${a} instanceof ErrorObject`)],
    ["vector?", unaryInline(a => `Array.isArray(${a})`)],
    ["table?", unaryInline(a => `${a} instanceof Table`)],
    ["empty?", unaryInline(a => `(${a} === null || ((Array.isArray(${a}) || typeof ${a} === "string") && ${a}.length === 0) || (${a} instanceof Table && ${a}.size === 0))`)],
    ["vector-empty?", unaryInline((a, slow) => `(Array.isArray(${a}) ? ${a}.length === 0 : ${slow})`)],
    ["table-empty?", unaryInline((a, slow) => `(${a} instanceof Table ? ${a}.size === 0 : ${slow})`)],
    ["table-frozen?", unaryInline((a, slow) => `(${a} instanceof Table ? ${a}.frozen : ${slow})`)],
    ["continuation-mark-set?", unaryInline(a => `${a} instanceof ContinuationMarkSet`)],

    ["vector-length", unaryInline((v, slow) => `(Array.isArray(${v}) ? ${v}.length : ${slow})`)],
    ["vector-ref", (args, slow) => args.length !== 2 ? null : `(${vectorIndexOk(args[0], args[1])} ? ${args[0]}[${args[1]}] : ${slow})`],
    ["vector-set!", (args, slow) => args.length !== 3 ? null : `(${vectorIndexOk(args[0], args[1])} ? (${args[0]}[${args[1]}] = ${args[2]}, undefined) : ${slow})`],

    ["table-ref", ([t, k, ...rest], slow, tmp) => k === undefined || rest.length > 0 ? null : `(${t} instanceof Table && (${tmp} = ${t}.lookup(${k}, MISSING)) !== MISSING ? ${tmp} : ${slow})`],
    ["table-set!", (args, slow) => args.length !== 3 ? null : `(${args[0]} instanceof Table && !${args[0]}.frozen ? (${args[0]}.set(${args[1]}, ${args[2]}), undefined) : ${slow})`],
    ["table-has?", (args, slow) => args.length !== 2 ? null : `(${args[0]} instanceof Table ? ${args[0]}.has(${args[1]}) : ${slow})`],
    ["table-border", unaryInline((t, slow) => `(${t} instanceof Table ? ${t}.border() : ${slow})`)],
]);

// runtime operations (CALLRT), by name
export const RUNTIME_INLINES = new Map<string, InlineFn>([
    ["wind", ([before, after]) => `(ctx.wind = new WindPoint(ctx.wind, ${before}, ${after}), undefined)`],
    ["end-wind", () => `(ctx.wind !== null && (ctx.wind = ctx.wind.parent), undefined)`],
    ["end-escape", () => `undefined`],
    ["caught?", unaryInline(v => `${v} instanceof Caught`)],
    ["caught-value", unaryInline(v => `${v}.error`)],
    ["make-caught", unaryInline(v => `new Caught(${v})`)],
    ["handler-key", () => `EXCEPTION_HANDLERS`],
    ["values-cons", ([x, v]) => `(${v} instanceof MultipleValues ? new MultipleValues([${x}, ...${v}.values]) : new MultipleValues([${x}, ${v}]))`],
    ["first-value", unaryInline(v => `(${v} instanceof MultipleValues ? ${v}.values[0] : ${v})`)],
]);
