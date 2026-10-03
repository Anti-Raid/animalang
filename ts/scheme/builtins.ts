import { Env, ErrorObject, IProcedure, OpaqueValue, isDeepEqual, symGen } from "../common";
import { Table } from "./table";
import { ASTStringifier } from "./printer";
import { add, div, exact, isExactInteger, isNum, modulo, mul, neg, quotient, remainder, requireNum, sameKind, sub, type Num } from "./numbers";
import { Cons, MCons } from "./list";
import { ContinuationMarkSet } from "../marks";
import { hostError } from "../errors";
import type { ArgKinds, InlineFn, IntrinsicFn, Intrinsics, Returns, TypeSystem } from "../bytecode-rvm/intrinsics";

// Scheme's builtins, one entry each: registered as the leaf intrinsic %name (with its AOT template, if any), called
// directly as (name arg ...) (see SCHEME_ALIASES) and as a value through the prelude's $name wrapper. The argument count
// is always within [min, max] when a builtin runs: the compiler checks direct calls and IntApply checks applied ones
export type SchemeBuiltin = {
    readonly name: string,
    readonly min: number,
    readonly max: number,
    readonly fn: IntrinsicFn,
    readonly inline?: InlineFn,
    // what it always returns (or else throws), for the AOT compiler's type facts
    readonly returns?: Returns,
    readonly refineArgs?: (known: ArgKinds) => ArgKinds,
    readonly branchNarrow?: (known: ArgKinds) => { then?: ArgKinds, else?: ArgKinds },
    readonly invertBranch?: boolean,
}

const builtin = (name: string, min: number, max: number, fn: IntrinsicFn, inline?: InlineFn): SchemeBuiltin => ({ name, min, max, fn, inline });

// --- AOT templates (see InlineFn): each falls back to the builtin itself, so its errors are unchanged ---

// the checks that the arguments not already known to be numbers are
const numberChecks = (args: string[], known: ArgKinds) => args.filter((_, i) => known[i] !== "number").map(a => `typeof ${a} === "number"`);

const allBigints = (known: ArgKinds, n: number) => n > 0 && known.length === n && known.every(k => k === "bigint");

// `value` when every check holds, else `slow`; no check at all when every argument is known
const guarded = (checks: string[], value: string, slow: string) => checks.length === 0 ? `(${value})` : `(${checks.join(" && ")} ? ${value} : ${slow})`;

// (op a b c) => ((a op b) op c) when every argument is a number; `unary` handles a single argument
const foldInline = (op: string, empty: string | null, unary: (a: string) => string, divisors = false): InlineFn => (args, slow, _tmp, _d, known) => {
    if (args.length === 0) return empty;
    const nonZero = divisors ? (args.length === 1 ? args : args.slice(1)).map(d => `${d} !== 0`) : [];
    const value = args.length === 1 ? unary(args[0]) : args.slice(1).reduce((acc, b) => `(${acc} ${op} ${b})`, args[0]);
    // known bigints: JS does bigint arithmetic itself (division keeps its checks, in the builtin)
    if (!divisors && args.length > 1 && allBigints(known, args.length)) return `(${value})`;
    return guarded([...numberChecks(args, known), ...nonZero], value, slow);
};

// (op a b c) => a op b && b op c when every argument is a number
const chainInline = (op: string): InlineFn => (args, slow, _tmp, _d, known) => {
    if (args.length === 0) return null;
    const tests = args.slice(1).map((b, i) => `${args[i]} ${op} ${b}`);
    if (args.length > 1 && allBigints(known, args.length)) return `(${tests.join(" && ")})`;
    return guarded(numberChecks(args, known), tests.length > 0 ? tests.join(" && ") : "true", slow);
};

// a one-argument operation; the argument is always a register name, so it may be repeated freely
const unaryInline = (inline: (a: string, slow: string, d: Readonly<Record<string, string>>) => string): InlineFn =>
    (args, slow, _tmp, d) => args.length === 1 ? inline(args[0], slow, d) : null;

const vectorIndexOk = (v: string, k: string) => `Array.isArray(${v}) && Number.isInteger(${k}) && ${k} >= 0 && ${k} < ${v}.length`;

// --- helpers ---

const numAt = (name: string, regs: readonly any[], i: number): Num => requireNum(name, regs[i]);

// every argument a number, and each pair of neighbours in the relation
const chain = (name: string, holds: (a: Num, b: Num) => boolean): IntrinsicFn => (regs, start, nargs) => {
    let prev = numAt(name, regs, start);
    for (let i = start + 1; i < start + nargs; i++) {
        const val = numAt(name, regs, i);
        sameKind(name, prev, val);
        if (!holds(prev, val)) return false;
        prev = val;
    }
    return true;
};

// every argument the same as the first, by `same`
const allSame = (same: (a: any, b: any) => boolean): IntrinsicFn => (regs, start, nargs) => {
    for (let i = start + 1; i < start + nargs; i++) if (!same(regs[i], regs[start])) return false;
    return true;
};

const cxrPaths = (depth: number): string[] => depth === 0 ? [""] : cxrPaths(depth - 1).flatMap(p => ["a" + p, "d" + p]);

// (cadr x) and the like: the path is read from the innermost accessor
const cxr = (name: string, path: string): SchemeBuiltin => builtin(name, 1, 1, (regs, start) => {
    let val = regs[start];
    for (let i = path.length - 1; i >= 0; i--) {
        if (!(val instanceof Cons)) throw hostError(val === null ? `${name}: list is too short` : `${name}: expected a pair but got ${new ASTStringifier().stringify(val)}`);
        val = path[i] === "a" ? val.car : val.cdr;
    }
    return val;
}, unaryInline((a, slow, d) => {
    const checks: string[] = [];
    let expr = a;
    for (let i = path.length - 1; i >= 0; i--) {
        checks.push(`${expr} instanceof ${d.Cons}`);
        expr = `${expr}.${path[i] === "a" ? "car" : "cdr"}`;
    }
    return `(${checks.join(" && ")} ? ${expr} : ${slow})`;
}));

const requireInteger = (name: string, val: any): number => {
    if (typeof val !== "number" || !Number.isInteger(val)) throw hostError(`${name} requires an integer`);
    return val;
};

const requireTable = (name: string, val: any): Table => {
    if (!(val instanceof Table)) throw hostError(`${name} requires a table`);
    return val;
};

const requireVector = (name: string, val: any): any[] => {
    if (!Array.isArray(val)) throw hostError(`${name} requires a vector`);
    return val;
};

const vectorIndex = (name: string, vec: any[], k: any): number => {
    if (typeof k !== "number" || !Number.isInteger(k) || k < 0 || k >= vec.length) throw hostError(`${name}: index ${new ASTStringifier().stringify(k)} out of bounds for vector of length ${vec.length}`);
    return k;
};

const predicate = (name: string, test: (val: any) => boolean, inline?: (a: string, slow: string, d: Readonly<Record<string, string>>) => string, branchNarrow?: (known: ArgKinds) => { then?: ArgKinds, else?: ArgKinds }): SchemeBuiltin =>
    ({ ...builtin(name, 1, 1, (regs, start) => test(regs[start]), inline && unaryInline(inline)), returns: "boolean", branchNarrow });

// a one-argument operation on a table
const onTable = (name: string, op: (tbl: Table) => any, inline?: (t: string) => string): SchemeBuiltin =>
    builtin(name, 1, 1, (regs, start) => op(requireTable(name, regs[start])), inline && unaryInline((t, slow, d) => `(${t} instanceof ${d.Table} ? ${inline(t)} : ${slow})`));

const MISSING_KEY = Symbol("missing key");

// (delay e) / (delay-force e) / (make-promise v): R7RS promises. A promise holds a box, which delay-force's forcing
// shares between the promises of a chain (see $force in the prelude), so a long chain is forced in constant space
export class SchemePromise extends OpaqueValue {
    constructor(public box: { done: boolean, value: any }) {
        super();
    }

    get typeName() {
        return "promise";
    }
}

// the continuation-mark key of a parameter (make-parameter), with its converter (or #f)
export class ParameterKey extends OpaqueValue {
    constructor(readonly converter: any) {
        super();
    }

    get typeName() {
        return "parameter";
    }
}

const PARAMETERS = new WeakMap<object, ParameterKey>();

export class PromptTag extends OpaqueValue {
    constructor(readonly name: any) {
        super();
    }

    get typeName() {
        return "continuation-prompt-tag";
    }
}

const DEFAULT_PROMPT_TAG = new PromptTag(Symbol.for("default"));

// (error message irritant ...): its message shows the irritants, error-object-message is the message alone
export class SchemeError extends Error {
    constructor(readonly errorMessage: any, readonly irritants: any[]) {
        const printer = new ASTStringifier();
        const text = typeof errorMessage === "string" ? errorMessage : printer.stringify(errorMessage);
        super(irritants.length === 0 ? text : `${text} ${irritants.map(i => printer.stringify(i)).join(" ")}`);
    }
}

const schemeError = (message: any, irritants: any[]): SchemeError => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    try {
        return new SchemeError(message, irritants);
    } finally {
        Error.stackTraceLimit = limit;
    }
};

const errorObject = (name: string, val: any): any => {
    if (!(val instanceof ErrorObject)) throw hostError(`${name}: expected an error object`);
    return val.error;
};

export const SCHEME_BUILTINS: readonly SchemeBuiltin[] = [
    // arithmetic and comparison
    builtin("+", 0, Infinity, (regs, start, nargs) => {
        if (nargs === 0) return 0;
        let acc = numAt("+", regs, start);
        for (let i = start + 1; i < start + nargs; i++) acc = add(acc, numAt("+", regs, i));
        return acc;
    }, foldInline("+", "0", a => a)),
    builtin("-", 1, Infinity, (regs, start, nargs) => {
        let acc = numAt("-", regs, start);
        if (nargs === 1) return neg(acc);
        for (let i = start + 1; i < start + nargs; i++) acc = sub(acc, numAt("-", regs, i));
        return acc;
    }, foldInline("-", null, a => `-${a}`)),
    builtin("*", 0, Infinity, (regs, start, nargs) => {
        if (nargs === 0) return 1;
        let acc = numAt("*", regs, start);
        for (let i = start + 1; i < start + nargs; i++) acc = mul(acc, numAt("*", regs, i));
        return acc;
    }, foldInline("*", "1", a => a)),
    builtin("/", 1, Infinity, (regs, start, nargs) => {
        let acc = numAt("/", regs, start);
        if (nargs === 1) return div(typeof acc === "bigint" ? 1n : 1, acc);
        for (let i = start + 1; i < start + nargs; i++) acc = div(acc, numAt("/", regs, i));
        return acc;
    }, foldInline("/", null, a => `1 / ${a}`, true)),
    builtin("modulo", 2, 2, (regs, start) => modulo("modulo", numAt("modulo", regs, start), numAt("modulo", regs, start + 1))),
    builtin("remainder", 2, 2, (regs, start) => remainder("remainder", numAt("remainder", regs, start), numAt("remainder", regs, start + 1))),
    builtin("quotient", 2, 2, (regs, start) => quotient(numAt("quotient", regs, start), numAt("quotient", regs, start + 1))),
    builtin("=", 1, Infinity, chain("=", (a, b) => a === b), chainInline("===")),
    builtin("eq?", 1, Infinity, allSame((a, b) => a === b), args => args.length === 0 ? null : `(${args.length === 1 ? "true" : args.slice(1).map(b => `${args[0]} === ${b}`).join(" && ")})`),
    builtin("<", 1, Infinity, chain("<", (a, b) => a < b), chainInline("<")),
    builtin("<=", 1, Infinity, chain("<=", (a, b) => a <= b), chainInline("<=")),
    builtin(">", 1, Infinity, chain(">", (a, b) => a > b), chainInline(">")),
    builtin(">=", 1, Infinity, chain(">=", (a, b) => a >= b), chainInline(">=")),
    // DEVIATION: normal scheme requires arity 2, anima extends this to arity >=1
    builtin("eqv?", 1, Infinity, allSame(Object.is)),
    builtin("equal?", 1, Infinity, allSame(isDeepEqual)),

    // exactness: (bigint x) of an integer double or a string of digits; (exact x) an integer as itself or, past a
    // double's exact integers, a bigint; (inexact x) a double
    builtin("bigint", 1, 1, (regs, start) => {
        const v = regs[start];
        if (typeof v === "string" && /^[+-]?\d+$/.test(v)) return BigInt(v);
        if (typeof v === "bigint" || Number.isInteger(v)) return BigInt(v);
        throw hostError(`bigint: expected an integer but got ${new ASTStringifier().stringify(v)}`);
    }),
    builtin("exact", 1, 1, (regs, start) => exact("exact", numAt("exact", regs, start))),
    builtin("inexact", 1, 1, (regs, start) => Number(numAt("inexact", regs, start))),

    // lists
    builtin("cons", 2, 2, (regs, start) => Cons.pair(regs[start], regs[start + 1]), (args, _slow, _tmp, d) => args.length === 2 ? `${d.Cons}.pair(${args[0]}, ${args[1]})` : null),
    // (cons* a ... tail): the pairs of a ... in front of tail, whose length is read once for all of them
    builtin("cons*", 1, Infinity, (regs, start, nargs) => {
        let tail = regs[start + nargs - 1];
        const rest = Cons.lengthOf(tail);
        for (let i = nargs - 2; i >= 0; i--) tail = new Cons(regs[start + i], tail, rest + nargs - 1 - i);
        return tail;
    }, (args, _slow, tmp, d) => {
        const tail = args[args.length - 1];
        if (args.length === 1) return tail;
        const pairs = args.slice(0, -1).reduceRight((acc, arg, i) => `new ${d.Cons}(${arg}, ${acc}, ${tmp} + ${args.length - 1 - i})`, tail);
        return `(${tmp} = ${d.Cons}.lengthOf(${tail}), ${pairs})`;
    }),
    cxr("car", "a"),
    cxr("cdr", "d"),
    ...[2, 3, 4].flatMap(depth => cxrPaths(depth)).map(path => cxr(`c${path}r`, path)),
    cxr("first", "a"),
    cxr("second", "ad"),
    cxr("third", "add"),

    // predicates
    predicate("null?", val => val === null, a => `${a} === null`),
    predicate("pair?", val => val instanceof Cons, (a, _slow, d) => `${a} instanceof ${d.Cons}`),
    predicate("list?", val => val === null || (val instanceof Cons && val.length >= 0), (a, _slow, d) => `(${a} === null || (${a} instanceof ${d.Cons} && ${a}.length >= 0))`),
    // mutable pairs (Racket's): not pairs, and not lists
    builtin("mcons", 2, 2, (regs, start) => new MCons(regs[start], regs[start + 1]), (args, _slow, _tmp, d) => args.length === 2 ? `new ${d.MCons}(${args[0]}, ${args[1]})` : null),
    predicate("mpair?", val => val instanceof MCons, (a, _slow, d) => `${a} instanceof ${d.MCons}`),
    ...(["car", "cdr"] as const).map(field => builtin(`m${field}`, 1, 1, (regs, start) => {
        const p = regs[start];
        if (!(p instanceof MCons)) throw hostError(`m${field}: expected a mutable pair but got ${new ASTStringifier().stringify(p)}`);
        return p[field];
    }, unaryInline((a, slow, d) => `(${a} instanceof ${d.MCons} ? ${a}.${field} : ${slow})`))),
    ...(["car", "cdr"] as const).map(field => builtin(`set-m${field}!`, 2, 2, (regs, start) => {
        const p = regs[start];
        if (!(p instanceof MCons)) throw hostError(`set-m${field}!: expected a mutable pair but got ${new ASTStringifier().stringify(p)}`);
        p[field] = regs[start + 1];
    })),
    predicate("number?", isNum, a => `(typeof ${a} === "number" || typeof ${a} === "bigint")`),
    predicate("integer?", isExactInteger, a => `(Number.isInteger(${a}) || typeof ${a} === "bigint")`),
    predicate("exact-integer?", isExactInteger, a => `(Number.isInteger(${a}) || typeof ${a} === "bigint")`),
    predicate("bigint?", val => typeof val === "bigint", a => `typeof ${a} === "bigint"`, () => ({ then: ["bigint"] })),
    predicate("positive?", val => isNum(val) && val > 0, a => `(typeof ${a} === "number" ? ${a} > 0 : typeof ${a} === "bigint" && ${a} > 0n)`),
    predicate("negative?", val => isNum(val) && val < 0, a => `(typeof ${a} === "number" ? ${a} < 0 : typeof ${a} === "bigint" && ${a} < 0n)`),
    predicate("zero?", val => isNum(val) && val == 0, a => `(${a} === 0 || ${a} === 0n)`),
    predicate("even?", val => typeof val === "bigint" ? val % 2n === 0n : requireInteger("even?", val) % 2 === 0, (a, slow) => `(Number.isInteger(${a}) ? ${a} % 2 === 0 : ${slow})`),
    predicate("odd?", val => typeof val === "bigint" ? val % 2n !== 0n : Math.abs(requireInteger("odd?", val) % 2) === 1, (a, slow) => `(Number.isInteger(${a}) ? Math.abs(${a} % 2) === 1 : ${slow})`),
    predicate("infinite?", val => typeof val === "number" && (val === Infinity || val === -Infinity), a => `(${a} === Infinity || ${a} === -Infinity)`),
    predicate("finite?", val => typeof val === "bigint" || (typeof val === "number" && Number.isFinite(val)), a => `(Number.isFinite(${a}) || typeof ${a} === "bigint")`),
    predicate("nan?", val => typeof val === "number" && Number.isNaN(val), a => `Number.isNaN(${a})`),
    predicate("boolean?", val => typeof val === "boolean", a => `typeof ${a} === "boolean"`, () => ({ then: ["boolean"] })),
    predicate("void?", val => typeof val === "undefined", a => `${a} === undefined`),
    predicate("symbol?", val => typeof val === "symbol", a => `typeof ${a} === "symbol"`),
    predicate("string?", val => typeof val === "string", a => `typeof ${a} === "string"`),
    predicate("procedure?", val => val instanceof IProcedure, (a, _slow, d) => `${a} instanceof ${d.IProcedure}`),
    predicate("error?", val => val instanceof ErrorObject, (a, _slow, d) => `${a} instanceof ${d.ErrorObject}`),
    predicate("vector?", val => Array.isArray(val), a => `Array.isArray(${a})`),
    predicate("table?", val => val instanceof Table, (a, _slow, d) => `${a} instanceof ${d.Table}`),
    predicate("empty?", val => val === null || (Array.isArray(val) && val.length === 0) || (typeof val === "string" && val.length === 0) || (val instanceof Table && val.size === 0),
        (a, _slow, d) => `(${a} === null || ((Array.isArray(${a}) || typeof ${a} === "string") && ${a}.length === 0) || (${a} instanceof ${d.Table} && ${a}.size === 0))`),
    predicate("vector-empty?", val => requireVector("vector-empty?", val).length === 0, (a, slow) => `(Array.isArray(${a}) ? ${a}.length === 0 : ${slow})`),
    onTable("table-empty?", tbl => tbl.size === 0, t => `${t}.size === 0`),
    onTable("table-frozen?", tbl => tbl.frozen, t => `${t}.frozen`),
    predicate("continuation-mark-set?", val => val instanceof ContinuationMarkSet, (a, _slow, d) => `${a} instanceof ${d.ContinuationMarkSet}`),

    builtin("last", 1, 1, (regs, start) => {
        const val = regs[start];
        if (val === null) throw hostError("last requires a non-empty list");
        if (!(val instanceof Cons)) throw hostError("last requires a list");
        let curr: any = val;
        while (curr.cdr instanceof Cons) curr = curr.cdr;
        return curr.cdr === null ? curr.car : curr.cdr;
    }),
    // a list's length is known from when it was made (see Cons)
    builtin("length", 1, 1, (regs, start) => {
        const val = regs[start];
        if (val === null) return 0;
        if (val instanceof Cons) return val.length >= 0 ? val.length : val.toArray().length;
        return typeof val === "string" ? val.length : 0;
    }, unaryInline((a, slow, d) => `(${a} === null ? 0 : ${a} instanceof ${d.Cons} && ${a}.length >= 0 ? ${a}.length : ${slow})`)),
    builtin("member", 2, 2, (regs, start) => {
        const list = regs[start], item = regs[start + 1];
        if (list === null) return false;
        if (!(list instanceof Cons)) throw hostError("member? requires the first argument to be a list");
        for (let s: any = list; s instanceof Cons; s = s.cdr) if (isDeepEqual(s.car, item)) return s;
        return false;
    }),
    // (append list ... x): copies of the lists, then x itself (which may be anything)
    builtin("append", 0, Infinity, (regs, start, nargs) => {
        if (nargs === 0) return null;
        let result = regs[start + nargs - 1];
        for (let i = start + nargs - 2; i >= start; i--) {
            const lst = regs[i];
            if (lst === null) continue;
            if (!(lst instanceof Cons) || lst.length < 0) throw hostError(`append: expected a list but got ${new ASTStringifier().stringify(lst)}`);
            result = Cons.copyOnto(lst, result);
        }
        return result;
    }),
    builtin("reverse", 1, 1, (regs, start) => {
        const lst = regs[start];
        if (lst === null) return null;
        if (!(lst instanceof Cons) || lst.length < 0) throw hostError("reverse requires a proper list");
        return Cons.reverse(lst);
    }),
    builtin("contains?", 2, 2, (regs, start) => {
        const list = regs[start], item = regs[start + 1];
        if (Array.isArray(list)) return list.includes(item);
        return list instanceof Cons ? list.includes(item) : false;
    }),

    // misc
    builtin("not", 1, 1, (regs, start) => regs[start] === false, unaryInline(a => `${a} === false`)),
    builtin("display", 1, 1, (regs, start) => {
        console.log(regs[start]);
        return undefined;
    }),
    builtin("error", 1, Infinity, (regs, start, nargs) => {
        throw schemeError(regs[start], regs.slice(start + 1, start + nargs));
    }),
    predicate("error-object?", val => val instanceof ErrorObject, (a, _slow, d) => `${a} instanceof ${d.ErrorObject}`),
    builtin("error-object-message", 1, 1, (regs, start) => {
        const err = errorObject("error-object-message", regs[start]);
        return err instanceof SchemeError ? err.errorMessage : err instanceof Error ? err.message : err;
    }),
    builtin("error-object-irritants", 1, 1, (regs, start) => {
        const err = errorObject("error-object-irritants", regs[start]);
        return Cons.fromArray(err instanceof SchemeError ? err.irritants : []);
    }),
    predicate("promise?", val => val instanceof SchemePromise),
    builtin("make-continuation-prompt-tag", 0, 1, (regs, start, nargs) => new PromptTag(nargs === 1 ? regs[start] : false)),
    builtin("default-continuation-prompt-tag", 0, 0, () => DEFAULT_PROMPT_TAG),
    predicate("continuation-prompt-tag?", val => val instanceof PromptTag),
    builtin("make-promise", 1, 1, (regs, start) => regs[start] instanceof SchemePromise ? regs[start] : new SchemePromise({ done: true, value: regs[start] })),
    builtin("make-error-object", 1, 1, (regs, start) => new ErrorObject(regs[start])),
    builtin("error-message", 1, 1, (regs, start) => {
        if (!(regs[start] instanceof ErrorObject)) throw hostError("error-message requires the first argument to be an instance of ErrorObject");
        const err = regs[start].error;
        if (err instanceof Error) return err.message;
        if (typeof err === "string") return err;
        return err?.message?.toString() || String(err);
    }),
    builtin("gensym", 0, 1, (regs, start, nargs) => {
        if (nargs === 0) return symGen("g");
        if (typeof regs[start] !== "string") throw hostError("gensym requires the first argument to be a string");
        return symGen(regs[start]);
    }),

    // vectors
    builtin("make-vector", 1, 2, (regs, start, nargs) => {
        const len = regs[start];
        if (typeof len !== "number" || !Number.isInteger(len) || len < 0) throw hostError("make-vector: length must be a non-negative integer");
        return new Array(len).fill(nargs === 2 ? regs[start + 1] : 0);
    }),
    builtin("vector", 0, Infinity, (regs, start, nargs) => {
        const vec = new Array(nargs);
        for (let i = 0; i < nargs; i++) vec[i] = regs[start + i];
        return vec;
    }),
    builtin("vector-length", 1, 1, (regs, start) => requireVector("vector-length", regs[start]).length, unaryInline((v, slow) => `(Array.isArray(${v}) ? ${v}.length : ${slow})`)),
    builtin("vector-ref", 2, 2, (regs, start) => {
        const vec = requireVector("vector-ref", regs[start]);
        return vec[vectorIndex("vector-ref", vec, regs[start + 1])];
    }, (args, slow) => args.length !== 2 ? null : `(${vectorIndexOk(args[0], args[1])} ? ${args[0]}[${args[1]}] : ${slow})`),
    builtin("vector-set!", 3, 3, (regs, start) => {
        const vec = requireVector("vector-set!", regs[start]);
        vec[vectorIndex("vector-set!", vec, regs[start + 1])] = regs[start + 2];
        return undefined;
    }, (args, slow) => args.length !== 3 ? null : `(${vectorIndexOk(args[0], args[1])} ? (${args[0]}[${args[1]}] = ${args[2]}, undefined) : ${slow})`),
    builtin("vector->list", 1, 1, (regs, start) => Cons.fromArray(requireVector("vector->list", regs[start]))),
    builtin("list->vector", 1, 1, (regs, start) => {
        const lst = regs[start];
        if (lst === null) return [];
        if (lst instanceof Cons && lst.length >= 0) return lst.toArray();
        throw hostError("list->vector requires a proper list");
    }),
    builtin("vector-fill!", 2, 2, (regs, start) => {
        requireVector("vector-fill!", regs[start]).fill(regs[start + 1]);
        return undefined;
    }),
    builtin("vector-copy", 1, 1, (regs, start) => [...requireVector("vector-copy", regs[start])]),
    builtin("vector-append", 0, Infinity, (regs, start, nargs) => {
        const result: any[] = [];
        for (let i = 0; i < nargs; i++) {
            const vec = regs[start + i];
            if (!Array.isArray(vec)) throw hostError("vector-append requires all arguments to be vectors");
            for (let j = 0; j < vec.length; j++) result.push(vec[j]);
        }
        return result;
    }),

    // tables
    builtin("table", 0, Infinity, (regs, start, nargs) => {
        if (nargs % 2 !== 0) throw hostError("table requires an even number of arguments (key-value pairs)");
        const tbl = new Table();
        for (let i = 0; i < nargs; i += 2) tbl.set(regs[start + i], regs[start + i + 1]);
        return tbl;
    }),
    builtin("table-ref", 2, 3, (regs, start, nargs) => {
        const tbl = requireTable("table-ref", regs[start]);
        const key = regs[start + 1];
        const val = tbl.lookup(key, MISSING_KEY);
        if (val !== MISSING_KEY) return val;
        if (nargs === 3) return regs[start + 2];
        throw hostError(`table-ref: key not found: ${String(key)}`);
    }, ([t, k, ...rest], slow, tmp, d) => k === undefined || rest.length > 0 ? null : `(${t} instanceof ${d.Table} && (${tmp} = ${t}.lookup(${k}, ${d.MISSING})) !== ${d.MISSING} ? ${tmp} : ${slow})`),
    builtin("table-is?", 3, 4, (regs, start, nargs) => {
        const tbl = requireTable("table-is?", regs[start]);
        let val = tbl.lookup(regs[start + 1], MISSING_KEY);
        if (val === MISSING_KEY) {
            if (nargs !== 4) return false;
            val = regs[start + 3];
        }
        return isDeepEqual(val, regs[start + 2]);
    }),
    builtin("table-set!", 3, 3, (regs, start) => {
        requireTable("table-set!", regs[start]).set(regs[start + 1], regs[start + 2]);
        return undefined;
    }, (args, slow, _tmp, d) => args.length !== 3 ? null : `(${args[0]} instanceof ${d.Table} && !${args[0]}.frozen ? (${args[0]}.set(${args[1]}, ${args[2]}), undefined) : ${slow})`),
    builtin("table-has?", 2, 2, (regs, start) => requireTable("table-has?", regs[start]).has(regs[start + 1]),
        (args, slow, _tmp, d) => args.length !== 2 ? null : `(${args[0]} instanceof ${d.Table} ? ${args[0]}.has(${args[1]}) : ${slow})`),
    builtin("table-delete!", 2, 2, (regs, start) => requireTable("table-delete!", regs[start]).delete(regs[start + 1])),
    onTable("table-clear!", tbl => { tbl.clear(); }),
    onTable("table-size", tbl => tbl.size),
    onTable("table-keys", tbl => [...tbl.keys()]),
    onTable("table-values", tbl => [...tbl.values()]),
    onTable("table-copy", tbl => tbl.clone()),
    onTable("table-entries", tbl => [...tbl.entries()]),
    onTable("table-freeze!", tbl => {
        tbl.frozen = true;
        return tbl;
    }),
    builtin("table-merge!", 2, 2, (regs, start) => {
        const target = regs[start], source = regs[start + 1];
        if (!(target instanceof Table) || !(source instanceof Table)) throw hostError("table-merge! requires both arguments to be tables");
        for (const [k, v] of source.entries()) target.set(k, v);
        return target;
    }),
];

// what the other builtins always return (the predicates declare theirs)
// arithmetic: a number of numbers, a bigint of bigints (the two never mix, see numbers.ts)
const sameKindResult: Returns = kinds => kinds.every(k => k === "number") ? "number" : kinds.length > 0 && kinds.every(k => k === "bigint") ? "bigint" : undefined;

const RETURNS: Readonly<Record<string, Returns>> = {
    "+": sameKindResult, "-": sameKindResult, "*": sameKindResult, "/": sameKindResult,
    "modulo": sameKindResult, "remainder": sameKindResult, "quotient": sameKindResult,
    "length": "number", "vector-length": "number",
    "=": "boolean", "<": "boolean", "<=": "boolean", ">": "boolean", ">=": "boolean",
    "not": "boolean", "eq?": "boolean", "eqv?": "boolean", "equal?": "boolean",
};

// the builtins whose fast paths want numbers (a function's version for number parameters reads them)
const NUMERIC = new Set(["+", "-", "*", "/", "modulo", "remainder", "quotient", "=", "<", "<=", ">", ">="]);
const NUMERIC_CMP = new Set(["=", "<", "<=", ">", ">="]);

const refineNumeric = (known: ArgKinds): ArgKinds => {
    if (known.some(k => k === "number")) return known.map(() => "number");
    if (known.some(k => k === "bigint")) return known.map(() => "bigint");
    return known;
};

const branchNumericCmp = (known: ArgKinds) => {
    if (known.some(k => k === "number")) {
        const nums = known.map(() => "number");
        return { then: nums, else: nums };
    }
    if (known.some(k => k === "bigint")) {
        const bigs = known.map(() => "bigint");
        return { then: bigs, else: bigs };
    }
    return {};
};

// Scheme's kinds: doubles are "number", bigints "bigint" (booleans the VM knows itself)
export const SCHEME_TYPES: TypeSystem = {
    ofConstant: v => typeof v === "number" ? "number" : typeof v === "bigint" ? "bigint" : undefined,
    guard: (kind, e) => kind === "number" ? `typeof ${e} === "number"` : kind === "bigint" ? `typeof ${e} === "bigint"` : null,
    coerce: (kind, e) => kind === "number" ? `+${e}` : null,
};

// what the templates may refer to
const INLINE_DEPS = { Cons, MCons, Table, IProcedure, ErrorObject, ContinuationMarkSet, MISSING: MISSING_KEY };

// (apply proc arg ... lst): the elements of lst, as the VM's %apply takes them
const spreadList = (lst: any, into: any[] = []): any[] => {
    let p = lst;
    for (; p instanceof Cons; p = p.cdr) into.push(p.car);
    if (p !== null) throw hostError(`apply: last argument must be a list but got ${new ASTStringifier().stringify(lst)}`);
    return into;
};

// Registers every builtin as the leaf intrinsic %name, always in the same order (so the cached prelude's intrinsics are at
// the same positions in every instance). Lists are the table's sequences: rest parameters are lists (%list packs them),
// and %spread makes the array %apply takes of one
// for the optimizer (see IntrinsicOptions.foldable / effectFree): builtins whose value on constants may be computed when
// compiling (no effect, depends only on the arguments, and never a new object), and those a call of which may be dropped
// when its value is not used (no effect, never throws)
const PREDICATES = ["null?", "pair?", "list?", "mpair?", "number?", "integer?", "exact-integer?", "bigint?", "boolean?", "void?", "symbol?", "string?",
    "procedure?", "error?", "vector?", "table?", "continuation-mark-set?", "error-object?", "promise?", "continuation-prompt-tag?"];
const FOLDABLE = new Set(["+", "-", "*", "/", "modulo", "remainder", "quotient", "=", "<", "<=", ">", ">=", "eq?", "eqv?", "equal?", "not",
    "bigint", "exact", "inexact", "positive?", "negative?", "zero?", "even?", "odd?", "infinite?", "finite?", "nan?", "length", ...PREDICATES]);
const EFFECT_FREE = new Set(["eq?", "eqv?", "equal?", "not", "cons", "list", "vector", "mcons", ...PREDICATES]);

export const registerSchemeIntrinsics = (intrinsics: Intrinsics): void => {
    for (const { name, min, max, fn, inline, returns, refineArgs, branchNarrow, invertBranch } of SCHEME_BUILTINS) {
        intrinsics.register(`%${name}`, fn, {
            args: [min, max],
            leaf: true,
            inline,
            deps: inline === undefined ? undefined : INLINE_DEPS,
            returns: returns ?? RETURNS[name],
            wants: NUMERIC.has(name) ? "number" : undefined,
            refineArgs: refineArgs ?? (NUMERIC.has(name) ? refineNumeric : undefined),
            branchNarrow: branchNarrow ?? (NUMERIC_CMP.has(name) ? branchNumericCmp : undefined),
            invertBranch: invertBranch ?? (name === "not" ? true : undefined),
            foldable: FOLDABLE.has(name),
            effectFree: EFFECT_FREE.has(name),
        });
    }
    intrinsics.register("%list", (regs, start, nargs) => {
        let tail: Cons | null = null;
        for (let i = start + nargs - 1; i >= start; i--) tail = new Cons(regs[i], tail, start + nargs - i);
        return tail;
    }, { leaf: true, sequence: "pack", effectFree: true, inline: (args, _slow, _tmp, d) => args.reduceRight((tail, arg, i) => `new ${d.Cons}(${arg}, ${tail}, ${args.length - i})`, "null"), deps: INLINE_DEPS });
    intrinsics.register("%spread", (regs, start) => spreadList(regs[start]), { args: [1, 1], leaf: true, sequence: "spread" });
    // promises: (%make-lazy thunk) is (delay-force (thunk)); see $force in the prelude
    intrinsics.register("%make-lazy", (regs, start) => new SchemePromise({ done: false, value: regs[start] }), { args: [1, 1], leaf: true });
    intrinsics.register("%promise-done?", (regs, start) => regs[start].box.done, { args: [1, 1], leaf: true });
    intrinsics.register("%promise-value", (regs, start) => regs[start].box.value, { args: [1, 1], leaf: true });
    // (%promise-update! new old): old takes new's state, and they share old's box from then on
    intrinsics.register("%promise-update!", (regs, start) => {
        const next = regs[start], old = regs[start + 1];
        if (!(next instanceof SchemePromise)) throw hostError("delay-force: the expression must give a promise");
        old.box.done = next.box.done;
        old.box.value = next.box.value;
        next.box = old.box;
    }, { args: [2, 2], leaf: true });
    // parameters: (%parameter-key-new converter), (%parameter-bind! proc key) (returns proc), and for parameterize
    // (%parameter-key p) and (%parameter-converter key)
    intrinsics.register("%parameter-key-new", (regs, start) => new ParameterKey(regs[start]), { args: [1, 1], leaf: true });
    intrinsics.register("%parameter-bind!", (regs, start) => {
        PARAMETERS.set(regs[start], regs[start + 1]);
        return regs[start];
    }, { args: [2, 2], leaf: true });
    intrinsics.register("%parameter-key", (regs, start) => {
        const key = PARAMETERS.get(regs[start]);
        if (key === undefined) throw hostError(`parameterize: not a parameter: ${new ASTStringifier().stringify(regs[start])}`);
        return key;
    }, { args: [1, 1], leaf: true });
    intrinsics.register("%parameter-converter", (regs, start) => regs[start].converter, { args: [1, 1], leaf: true });
    // map / for-each over several lists: (%map-cars lists) is an array of their cars, or #f once one has ended;
    // (%map-cdrs lists) the list of their cdrs
    intrinsics.register("%map-cars", (regs, start) => {
        const cars: any[] = [];
        for (let p = regs[start]; p instanceof Cons; p = p.cdr) {
            const lst = p.car;
            if (lst === null) return false;
            if (!(lst instanceof Cons)) throw hostError(`map: expected a list but got ${new ASTStringifier().stringify(lst)}`);
            cars.push(lst.car);
        }
        return cars;
    }, { args: [1, 1], leaf: true, fresh: true });
    intrinsics.register("%map-cdrs", (regs, start) => {
        const cdrs: any[] = [];
        for (let p = regs[start]; p instanceof Cons; p = p.cdr) cdrs.push(p.car.cdr);
        return Cons.fromArray(cdrs);
    }, { args: [1, 1], leaf: true });
    // (%splice-list x): x, a list spliced last in a quasiquote
    intrinsics.register("%splice-list", (regs, start) => {
        const lst = regs[start];
        if (lst === null || (lst instanceof Cons && lst.length >= 0)) return lst;
        throw hostError(`unquote-splicing: expected a list but got ${new ASTStringifier().stringify(lst)}`);
    }, { args: [1, 1], leaf: true, inline: unaryInline((a, slow, d) => `(${a} === null || (${a} instanceof ${d.Cons} && ${a}.length >= 0) ? ${a} : ${slow})`), deps: INLINE_DEPS });
    // (%apply-args arg ... lst): the arguments of (apply proc arg ... lst)
    intrinsics.register("%apply-args", (regs, start, nargs) => spreadList(regs[start + nargs - 1], regs.slice(start, start + nargs - 1)), { args: [1, Infinity], leaf: true, fresh: true });
    // what a program that redefines a builtin binds its name to first, so reading it before the definition runs is an error
    intrinsics.register("%unbound", () => Env.UNDEFINED, { args: [0, 0], leaf: true });
};

// A procedure whose direct calls become a core form or intrinsic: (name arg ...) is rewritten to (target arg ...) when
// the argument count is within [min, max]; otherwise it stays an ordinary call of the prelude's $name procedure, which
// reports the wrong count when (and if) it runs. `wrapper`: the prelude defines $name by the same rewrite (fixed-arity
// ones, generated below); others have their own definitions there
export type SchemeAlias = { readonly target: symbol, readonly min: number, readonly max: number, readonly wrapper: boolean };

const alias = (name: string, target: string, min: number, max: number, wrapper = min === max): [symbol, SchemeAlias] =>
    [Symbol.for(name), { target: Symbol.for(target), min, max, wrapper }];

export const SCHEME_ALIASES: ReadonlyMap<symbol, SchemeAlias> = new Map([
    ...SCHEME_BUILTINS.map(({ name, min, max }) => alias(name, `%${name}`, min, max, true)),
    alias("list", "%list", 0, Infinity, false),
    // the VM's own operations: values, and the control operations
    alias("values", "%values", 0, Infinity, false),
    alias("call/cc", "%call/cc", 1, 1),
    alias("call-with-current-continuation", "%call/cc", 1, 1),
    alias("call/ec", "%call/ec", 1, 1),
    alias("call-with-escape-continuation", "%call/ec", 1, 1),
    alias("dynamic-wind", "%dynamic-wind", 3, 3),
    alias("raise", "%raise", 1, 1),
    alias("apply", "%apply", 2, Infinity),
    alias("coroutine-create", "%coroutine-create", 1, 2, true),
    alias("coroutine-status", "%coroutine-status", 1, 1),
    alias("coroutine-yieldable?", "%coroutine-yieldable?", 0, 0),
    alias("coroutine-close", "%coroutine-close", 1, 1),
    alias("coroutine-resume", "%coroutine-resume", 1, Infinity),
    alias("coroutine-raise", "%coroutine-raise", 2, 2),
    alias("coroutine-yield", "%coroutine-yield", 0, Infinity),
]);

// The prelude's first-class procedures for the aliases, in native-scheme: a fixed-arity wrapper, or for a variadic builtin
// an %intapply of the rest arguments (the other variadic ones are defined in the prelude itself)
export const ALIAS_WRAPPERS = [
    ...[...SCHEME_ALIASES].filter(([, { wrapper }]) => wrapper).map(([sym, { target, min, max }]) => {
        const name = Symbol.keyFor(sym)!, op = Symbol.keyFor(target)!;
        if (min !== max) return `(define ($${name} . args) (%intapply ${op} (%intcall %spread args)))`;
        const params = Array.from({ length: min }, (_, i) => ` a${i}`).join("");
        return `(define ($${name}${params}) (%intcall ${op}${params}))`;
    }),
    "(define ($list . args) args)",
    "(define ($values . args) (%intapply %values (%intcall %spread args)))",
].join("\n");
