import { ErrorObject, IProcedure, isDeepEqual, isTruthy, symGen, Table } from "../common";
import { Cons } from "../list";
import { ContinuationMarkSet } from "../marks";
import { hostError } from "../errors";
import type { InlineFn, IntrinsicFn, Intrinsics } from "../bytecode-rvm/intrinsics";

// Scheme's builtins, one entry each: registered as the leaf intrinsic %name (with its AOT template, if any), called
// directly as (name arg ...) (see SCHEME_ALIASES) and as a value through the prelude's $name wrapper. The argument count
// is always within [min, max] when a builtin runs: the compiler checks direct calls and APPLYINT applied ones
export type SchemeBuiltin = {
    readonly name: string,
    readonly min: number,
    readonly max: number,
    readonly fn: IntrinsicFn,
    readonly inline?: InlineFn,
}

const builtin = (name: string, min: number, max: number, fn: IntrinsicFn, inline?: InlineFn): SchemeBuiltin => ({ name, min, max, fn, inline });

// --- AOT templates (see InlineFn): each falls back to the builtin itself, so its errors are unchanged ---

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
const unaryInline = (inline: (a: string, slow: string, d: Readonly<Record<string, string>>) => string): InlineFn =>
    (args, slow, _tmp, d) => args.length === 1 ? inline(args[0], slow, d) : null;

const vectorIndexOk = (v: string, k: string) => `Array.isArray(${v}) && Number.isInteger(${k}) && ${k} >= 0 && ${k} < ${v}.length`;

// --- helpers ---

const numAt = (name: string, regs: readonly any[], i: number): number => {
    const val = regs[i];
    if (typeof val !== "number") throw hostError(`${name} requires numbers, but received ${typeof val}`);
    return val;
};

// both numbers, the second not 0
const divisorArgs = (name: string, regs: readonly any[], start: number) => {
    const a = regs[start], b = regs[start + 1];
    if (typeof a !== "number" || typeof b !== "number") throw hostError(`${name}: requires numbers, but received ${typeof a}/${typeof b}`);
    if (b === 0) throw hostError(`${name}: division by zero`);
};

// every argument a number, and each pair of neighbours in the relation
const chain = (name: string, holds: (a: number, b: number) => boolean): IntrinsicFn => (regs, start, nargs) => {
    let prev = numAt(name, regs, start);
    for (let i = start + 1; i < start + nargs; i++) {
        const val = numAt(name, regs, i);
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
        if (!(val instanceof Cons)) throw hostError(val === null ? `${name}: list is too short` : `${name}: expected a pair but got ${val}`);
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
    if (typeof k !== "number" || !Number.isInteger(k) || k < 0 || k >= vec.length) throw hostError(`${name}: index ${k} out of bounds for vector of length ${vec.length}`);
    return k;
};

const predicate = (name: string, test: (val: any) => boolean, inline?: (a: string, slow: string, d: Readonly<Record<string, string>>) => string): SchemeBuiltin =>
    builtin(name, 1, 1, (regs, start) => test(regs[start]), inline && unaryInline(inline));

// a one-argument operation on a table
const onTable = (name: string, op: (tbl: Table) => any, inline?: (t: string) => string): SchemeBuiltin =>
    builtin(name, 1, 1, (regs, start) => op(requireTable(name, regs[start])), inline && unaryInline((t, slow, d) => `(${t} instanceof ${d.Table} ? ${inline(t)} : ${slow})`));

const MISSING_KEY = Symbol("missing key");

export const SCHEME_BUILTINS: readonly SchemeBuiltin[] = [
    // arithmetic and comparison
    builtin("+", 0, Infinity, (regs, start, nargs) => {
        if (nargs === 0) return 0;
        let acc = numAt("+", regs, start);
        for (let i = start + 1; i < start + nargs; i++) acc += numAt("+", regs, i);
        return acc;
    }, foldInline("+", "0", a => a)),
    builtin("-", 1, Infinity, (regs, start, nargs) => {
        let acc = numAt("-", regs, start);
        if (nargs === 1) return -acc;
        for (let i = start + 1; i < start + nargs; i++) acc -= numAt("-", regs, i);
        return acc;
    }, foldInline("-", null, a => `-${a}`)),
    builtin("*", 0, Infinity, (regs, start, nargs) => {
        let acc = 1;
        for (let i = start; i < start + nargs; i++) acc *= numAt("*", regs, i);
        return acc;
    }, foldInline("*", "1", a => a)),
    builtin("/", 1, Infinity, (regs, start, nargs) => {
        let acc = numAt("/", regs, start);
        if (nargs === 1) {
            if (acc === 0) throw hostError("division by zero");
            return 1 / acc;
        }
        for (let i = start + 1; i < start + nargs; i++) {
            const val = numAt("/", regs, i);
            if (val === 0) throw hostError("division by zero");
            acc /= val;
        }
        return acc;
    }, foldInline("/", null, a => `1 / ${a}`, true)),
    builtin("modulo", 2, 2, (regs, start) => {
        divisorArgs("modulo", regs, start);
        const a = regs[start], b = regs[start + 1];
        return ((a % b) + b) % b;
    }),
    builtin("remainder", 2, 2, (regs, start) => {
        divisorArgs("remainder", regs, start);
        return regs[start] % regs[start + 1];
    }),
    builtin("=", 1, Infinity, chain("=", (a, b) => a === b), chainInline("===")),
    builtin("eq?", 1, Infinity, allSame((a, b) => a === b), args => args.length === 0 ? null : `(${args.length === 1 ? "true" : args.slice(1).map(b => `${args[0]} === ${b}`).join(" && ")})`),
    builtin("<", 1, Infinity, chain("<", (a, b) => a < b), chainInline("<")),
    builtin("<=", 1, Infinity, chain("<=", (a, b) => a <= b), chainInline("<=")),
    builtin(">", 1, Infinity, chain(">", (a, b) => a > b), chainInline(">")),
    builtin(">=", 1, Infinity, chain(">=", (a, b) => a >= b), chainInline(">=")),
    // DEVIATION: normal scheme requires arity 2, anima extends this to arity >=1
    builtin("eqv?", 1, Infinity, allSame(Object.is)),
    builtin("equal?", 1, Infinity, allSame(isDeepEqual)),

    // lists
    builtin("cons", 2, 2, (regs, start) => Cons.pair(regs[start], regs[start + 1]), (args, _slow, _tmp, d) => args.length === 2 ? `${d.Cons}.pair(${args[0]}, ${args[1]})` : null),
    cxr("car", "a"),
    cxr("cdr", "d"),
    ...[2, 3, 4].flatMap(depth => cxrPaths(depth)).map(path => cxr(`c${path}r`, path)),
    cxr("first", "a"),
    cxr("second", "ad"),
    cxr("third", "add"),

    // predicates
    predicate("null?", val => val === null, a => `${a} === null`),
    predicate("pair?", val => val instanceof Cons, (a, _slow, d) => `${a} instanceof ${d.Cons}`),
    predicate("list?", val => val === null || (val instanceof Cons && !val.isImproper() && !val.isCyclic()), (a, _slow, d) => `(${a} === null || (${a} instanceof ${d.Cons} && !${a}.isImproper() && !${a}.isCyclic()))`),
    predicate("number?", val => typeof val === "number", a => `typeof ${a} === "number"`),
    predicate("integer?", val => typeof val === "number" && Number.isInteger(val), a => `Number.isInteger(${a})`),
    predicate("positive?", val => typeof val === "number" && val > 0, a => `(typeof ${a} === "number" && ${a} > 0)`),
    predicate("negative?", val => typeof val === "number" && val < 0, a => `(typeof ${a} === "number" && ${a} < 0)`),
    predicate("zero?", val => typeof val === "number" && val === 0, a => `${a} === 0`),
    predicate("even?", val => requireInteger("even?", val) % 2 === 0, (a, slow) => `(Number.isInteger(${a}) ? ${a} % 2 === 0 : ${slow})`),
    predicate("odd?", val => Math.abs(requireInteger("odd?", val) % 2) === 1, (a, slow) => `(Number.isInteger(${a}) ? Math.abs(${a} % 2) === 1 : ${slow})`),
    predicate("infinite?", val => typeof val === "number" && (val === Infinity || val === -Infinity), a => `(${a} === Infinity || ${a} === -Infinity)`),
    predicate("finite?", val => typeof val === "number" && Number.isFinite(val), a => `Number.isFinite(${a})`),
    predicate("nan?", val => typeof val === "number" && Number.isNaN(val), a => `Number.isNaN(${a})`),
    predicate("boolean?", val => typeof val === "boolean", a => `typeof ${a} === "boolean"`),
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
    builtin("length", 1, 1, (regs, start) => {
        const val = regs[start];
        if (val === null) return 0;
        if (val instanceof Cons) {
            if (val.isCyclic()) throw hostError("length: circular list has no length");
            return val.isImproper() ? val.toArray().length : val.length;
        }
        return typeof val === "string" ? val.length : 0;
    }),
    builtin("member", 2, 2, (regs, start) => {
        const list = regs[start], item = regs[start + 1];
        if (list === null) return false;
        if (!(list instanceof Cons)) throw hostError("member? requires the first argument to be a list");
        for (let s: any = list; s instanceof Cons; s = s.cdr) if (isDeepEqual(s.car, item)) return s;
        return false;
    }),
    builtin("reverse", 1, 1, (regs, start) => {
        let lst = regs[start];
        if (lst instanceof Cons && lst.isCyclic()) throw hostError("reverse: circular list");
        let out: Cons | null = null;
        for (; lst instanceof Cons; lst = lst.cdr) out = new Cons(lst.car, out);
        if (lst !== null) throw hostError("reverse requires a proper list");
        return out;
    }),
    builtin("contains?", 2, 2, (regs, start) => {
        const list = regs[start], item = regs[start + 1];
        if (Array.isArray(list)) return list.includes(item);
        return list instanceof Cons ? list.includes(item) : false;
    }),

    // misc
    builtin("not", 1, 1, (regs, start) => !isTruthy(regs[start])),
    builtin("display", 1, 1, (regs, start) => {
        console.log(regs[start]);
        return undefined;
    }),
    builtin("error", 1, 1, (regs, start) => {
        throw hostError(regs[start]);
    }),
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
        if (lst instanceof Cons && !lst.isImproper() && !lst.isCyclic()) return lst.toArray();
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
    onTable("table-copy", tbl => tbl.copy()),
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
    onTable("table-border", tbl => tbl.border(), t => `${t}.border()`),
];

// what the templates may refer to
const INLINE_DEPS = { Cons, Table, IProcedure, ErrorObject, ContinuationMarkSet, MISSING: MISSING_KEY };

// Registers every builtin as the leaf intrinsic %name, always in the same order (so the cached prelude's intrinsics are at
// the same positions in every instance)
export const registerSchemeIntrinsics = (intrinsics: Intrinsics): void => {
    for (const { name, min, max, fn, inline } of SCHEME_BUILTINS) {
        intrinsics.register(`%${name}`, fn, { args: [min, max], leaf: true, inline, deps: inline === undefined ? undefined : INLINE_DEPS });
    }
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
    // the VM's own operations: list and values, and the control operations
    alias("list", "%list", 0, Infinity, false),
    alias("values", "%values", 0, Infinity, false),
    alias("call/cc", "%call/cc", 1, 1),
    alias("call-with-current-continuation", "%call/cc", 1, 1),
    alias("call/ec", "%call/ec", 1, 1),
    alias("call-with-escape-continuation", "%call/ec", 1, 1),
    alias("dynamic-wind", "%dynamic-wind", 3, 3),
    alias("raise", "%raise", 1, 1),
    alias("apply", "%apply", 2, Infinity),
    alias("coroutine-create", "%coroutine-create", 1, 1),
    alias("coroutine-status", "%coroutine-status", 1, 1),
    alias("coroutine-close", "%coroutine-close", 1, 1),
    alias("coroutine-resume", "%coroutine-resume", 1, Infinity),
    alias("coroutine-raise", "%coroutine-raise", 2, 2),
    alias("coroutine-yield", "%coroutine-yield", 0, Infinity),
]);

// The prelude's first-class procedures for the aliases: a fixed-arity wrapper, or for a variadic builtin an %apply of the
// rest arguments (the other variadic ones are defined in the prelude itself)
export const ALIAS_WRAPPERS = [
    ...[...SCHEME_ALIASES].filter(([, { wrapper }]) => wrapper).map(([sym, { target, min, max }]) => {
        const name = Symbol.keyFor(sym)!, op = Symbol.keyFor(target)!;
        if (min !== max) return `(define ($${name} . args) (%apply ${op} args))`;
        const params = Array.from({ length: min }, (_, i) => ` a${i}`).join("");
        return `(define ($${name}${params}) (${op}${params}))`;
    }),
    "(define ($list . args) args)",
    "(define ($values . args) (%list->values args))",
].join("\n");
