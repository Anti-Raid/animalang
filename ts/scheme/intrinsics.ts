import { ErrorObject, IProcedure, isDeepEqual, isTruthy, symGen, Table } from "../common";
import { Cons } from "../list";
import { ContinuationMarkSet } from "../marks";
import { ARITHMETIC, opCons, CXR_PATHS, CXR_FNS, PREDICATES, PREDICATE_FNS } from "./ops";
import { hostError } from "../errors";
import type { InlineFn, IntrinsicFn, Intrinsics } from "../bytecode-rvm/intrinsics";

// A Scheme builtin: registered as the leaf intrinsic %name, called directly as (name arg ...) (see the transformer's
// aliases) and as a value through the prelude's $name wrapper
export type SchemeBuiltin = {
    readonly name: string,
    readonly min: number,
    readonly max: number,
    readonly fn: IntrinsicFn,
}

const builtin = (name: string, min: number, max: number, fn: IntrinsicFn): SchemeBuiltin => ({ name, min, max, fn });

const ARITHMETIC_ARITY: Record<string, [number, number]> = {
    "+": [0, Infinity], "*": [0, Infinity], "-": [1, Infinity], "/": [1, Infinity], "modulo": [2, 2], "remainder": [2, 2],
    "=": [1, Infinity], "eq?": [1, Infinity], "<": [1, Infinity], "<=": [1, Infinity], ">": [1, Infinity], ">=": [1, Infinity],
};

const MISSING_KEY = Symbol("missing key");

export const SCHEME_BUILTINS: readonly SchemeBuiltin[] = [
    ...ARITHMETIC.map(([name, fn]) => builtin(name, ...ARITHMETIC_ARITY[name], fn)),
    builtin("eqv?", 1, Infinity, (regs, startReg, nargs) => {
        // DEVIATION: normal scheme requires arity 2, anima extends this to arity >=1
        if (nargs === 0) throw hostError("eqv? requires at least 1 argument");
        
        let start = regs[startReg];
        let res = true
        for (let i = startReg+1; i < startReg+nargs; i++) {
            const val = regs[i]
            if (!Object.is(val, start)) {
                res = false
                break
            }
        }
        return res
    }),
    builtin("equal?", 1, Infinity, (regs, startReg, nargs) => {
        if (nargs === 0) throw hostError("equal? requires at least 1 argument");
        
        let start = regs[startReg];
        let res = true
        for (let i = startReg+1; i < startReg+nargs; i++) {
            const val = regs[i]
            if (!isDeepEqual(val, start)) {
                res = false
                break
            }
        }
        return res
    }),
    // list builtins
    builtin("cons", 2, 2, opCons),
    ...CXR_PATHS.map(([name], i) => builtin(name, 1, 1, CXR_FNS[i])),
    ...PREDICATES.map(([name], i) => builtin(name, 1, 1, PREDICATE_FNS[i])),
    builtin("last", 1, 1, (regs, startReg, nargs) => {
        if (nargs != 1) throw hostError("last requires 1 argument");
        const val = regs[startReg];
        if (val instanceof Cons) {
            let curr: any = val;
            while (curr.cdr instanceof Cons) {
                curr = curr.cdr;
            }
            return curr.cdr === null ? curr.car : curr.cdr;
        } else if (val === null) {
            throw hostError("last requires a non-empty list");
        } else {
            throw hostError("last requires a list");
        }
    }),
    builtin("length", 1, 1, (regs, startReg, nargs) => {
        if (nargs != 1) throw hostError("length requires 1 argument");
        const val = regs[startReg];
        if (val === null) {
            return 0; // empty list
        }
        if (val instanceof Cons) {
            if (val.isCyclic()) throw hostError("length: circular list has no length");
            if (val.isImproper()) {
                return val.toArray().length;
            }
            return val.length;
        }
        if (typeof val === "string") {
            return val.length;
        }
        return 0;
    }),
    builtin("member", 2, 2, (regs, startReg, nargs) => {
        if (nargs != 2) throw hostError("member requires 2 arguments");
        const list = regs[startReg];
        const item = regs[startReg+1];
        if (list === null) {
            return false;
        }
        if (!(list instanceof Cons)) throw hostError("member? requires the first argument to be a list");
        let s: any = list;
        while (s instanceof Cons) {
            if (isDeepEqual(s.car, item)) {
                return s;
            }
            s = s.cdr;
        }
        return false;
    }),
    builtin("not", 1, 1, (regs, startReg, nargs) => {
        if (nargs != 1) throw hostError("not requires 1 argument");
        return !isTruthy(regs[startReg]);
    }),
    builtin("display", 1, 1, (regs, startReg, nargs) => {
        if (nargs != 1) throw hostError("display requires 1 argument");
        console.log(regs[startReg])
        return undefined
    }),
    builtin("error", 1, 1, (regs, startReg, nargs) => {
        if (nargs != 1) throw hostError("");
        throw hostError(regs[startReg])
    }),
    builtin("make-error-object", 1, 1, (regs, startReg, nargs) => {
        if (nargs !== 1) throw hostError("make-error-object requires 1 argument");
        return new ErrorObject(regs[startReg]);
    }),
    builtin("error-message", 1, 1, (regs, startReg, nargs) => {
        if (nargs != 1) throw hostError("error-message requires 1 argument");
        if (!(regs[startReg] instanceof ErrorObject)) throw hostError("error-message requires the first argument to be an instance of ErrorObject");
        const err = regs[startReg].error;
        if (err instanceof Error) return err.message;
        if (typeof err === "string") return err;
        return err?.message?.toString() || String(err);
    }),
    // Builtin predicates
    builtin("contains?", 2, 2, (regs, startReg, nargs) => {
        if (nargs != 2) throw hostError("contains? requires 2 arguments");
        const list = regs[startReg];
        const item = regs[startReg+1];
        if (Array.isArray(list)) return list.includes(item);
        return (list instanceof Cons) ? list.includes(item) : false;
    }),
    builtin("gensym", 0, 1, (regs, startReg, nargs) => {
        if (nargs > 1) throw hostError("gensym requires 0 or 1 arguments");
        switch (nargs) {
        case 0:
            return symGen('g')
        case 1:
            if (typeof regs[startReg] !== 'string') throw hostError("gensym requires the first argument to be a string")
            return symGen(regs[startReg])
        }
    }),
    // Vector operations
    builtin("make-vector", 1, 2, (regs, startReg, nargs) => {
        if (nargs < 1 || nargs > 2) throw hostError("make-vector requires 1 or 2 arguments");
        const len = regs[startReg];
        if (typeof len !== "number" || !Number.isInteger(len) || len < 0) {
            throw hostError("make-vector: length must be a non-negative integer");
        }
        const fill = nargs === 2 ? regs[startReg + 1] : 0;
        const vec = new Array(len);
        vec.fill(fill);
        return vec;
    }),
    builtin("vector", 0, Infinity, (regs, startReg, nargs) => {
        const vec = new Array(nargs);
        for (let i = 0; i < nargs; i++) {
            vec[i] = regs[startReg + i];
        }
        return vec;
    }),
    builtin("vector-length", 1, 1, (regs, startReg, nargs) => {
        if (nargs !== 1) throw hostError("vector-length requires 1 argument");
        const vec = regs[startReg];
        if (!Array.isArray(vec)) throw hostError("vector-length requires a vector");
        return vec.length;
    }),
    builtin("vector-ref", 2, 2, (regs, startReg, nargs) => {
        if (nargs !== 2) throw hostError("vector-ref requires 2 arguments (vector-ref vec k)");
        const vec = regs[startReg];
        const k = regs[startReg + 1];
        if (!Array.isArray(vec)) throw hostError("vector-ref requires a vector");
        if (typeof k !== "number" || !Number.isInteger(k) || k < 0 || k >= vec.length) {
            throw hostError(`vector-ref: index ${k} out of bounds for vector of length ${vec.length}`);
        }
        return vec[k];
    }),
    builtin("vector-set!", 3, 3, (regs, startReg, nargs) => {
        if (nargs !== 3) throw hostError("vector-set! requires 3 arguments (vector-set! vec k val)");
        const vec = regs[startReg];
        const k = regs[startReg + 1];
        const val = regs[startReg + 2];
        if (!Array.isArray(vec)) throw hostError("vector-set! requires a vector");
        if (typeof k !== "number" || !Number.isInteger(k) || k < 0 || k >= vec.length) {
            throw hostError(`vector-set!: index ${k} out of bounds for vector of length ${vec.length}`);
        }
        vec[k] = val;
        return undefined;
    }),
    builtin("vector->list", 1, 1, (regs, startReg, nargs) => {
        if (nargs !== 1) throw hostError("vector->list requires 1 argument");
        const vec = regs[startReg];
        if (!Array.isArray(vec)) throw hostError("vector->list requires a vector");
        return Cons.fromArray(vec);
    }),
    builtin("list->vector", 1, 1, (regs, startReg, nargs) => {
        if (nargs !== 1) throw hostError("list->vector requires 1 argument");
        const lst = regs[startReg];
        if (lst === null) return [];
        if (lst instanceof Cons && !lst.isImproper() && !lst.isCyclic()) {
            return lst.toArray();
        }
        throw hostError("list->vector requires a proper list");
    }),
    builtin("vector-fill!", 2, 2, (regs, startReg, nargs) => {
        if (nargs !== 2) throw hostError("vector-fill! requires 2 arguments (vector-fill! vec fill)");
        const vec = regs[startReg];
        const fill = regs[startReg + 1];
        if (!Array.isArray(vec)) throw hostError("vector-fill! requires a vector");
        vec.fill(fill);
        return undefined;
    }),
    builtin("vector-copy", 1, 1, (regs, startReg, nargs) => {
        if (nargs !== 1) throw hostError("vector-copy requires 1 argument");
        const vec = regs[startReg];
        if (!Array.isArray(vec)) throw hostError("vector-copy requires a vector");
        return [...vec];
    }),
    builtin("vector-append", 0, Infinity, (regs, startReg, nargs) => {
        const result: any[] = [];
        for (let i = 0; i < nargs; i++) {
            const vec = regs[startReg + i];
            if (!Array.isArray(vec)) throw hostError("vector-append requires all arguments to be vectors");
            for (let j = 0; j < vec.length; j++) {
                result.push(vec[j]);
            }
        }
        return result;
    }),
    // Table operations
    builtin("table", 0, Infinity, (regs, startReg, nargs) => {
        if (nargs % 2 !== 0) throw hostError("table requires an even number of arguments (key-value pairs)");
        const tbl = new Table();
        for (let i = 0; i < nargs; i += 2) {
            tbl.set(regs[startReg + i], regs[startReg + i + 1]);
        }
        return tbl;
    }),
    builtin("table-ref", 2, 3, (regs, startReg, nargs) => {
        if (nargs < 2 || nargs > 3) throw hostError("table-ref requires 2 or 3 arguments (table-ref tbl key [default])");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw hostError("table-ref requires a table");
        const key = regs[startReg + 1];
        const val = tbl.lookup(key, MISSING_KEY);
        if (val !== MISSING_KEY) return val;
        if (nargs === 3) {
            return regs[startReg + 2];
        }
        throw hostError(`table-ref: key not found: ${String(key)}`);
    }),
    builtin("table-is?", 3, 4, (regs, startReg, nargs) => {
        if (nargs < 3 || nargs > 4) throw hostError("table-is? requires 3 or 4 arguments (table-is? tbl key expected [default])");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw hostError("table-is? requires a table");
        const key = regs[startReg + 1];
        const expected = regs[startReg + 2];
        let val = tbl.lookup(key, MISSING_KEY);
        if (val === MISSING_KEY) {
            if (nargs !== 4) return false;
            val = regs[startReg + 3];
        }
        return isDeepEqual(val, expected);
    }),
    builtin("table-set!", 3, 3, (regs, startReg, nargs) => {
        if (nargs !== 3) throw hostError("table-set! requires 3 arguments (table-set! tbl key val)");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw hostError("table-set! requires a table");
        tbl.set(regs[startReg + 1], regs[startReg + 2]);
        return undefined;
    }),
    builtin("table-has?", 2, 2, (regs, startReg, nargs) => {
        if (nargs !== 2) throw hostError("table-has? requires 2 arguments (table-has? tbl key)");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw hostError("table-has? requires a table");
        return tbl.has(regs[startReg + 1]);
    }),
    builtin("table-delete!", 2, 2, (regs, startReg, nargs) => {
        if (nargs !== 2) throw hostError("table-delete! requires 2 arguments (table-delete! tbl key)");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw hostError("table-delete! requires a table");
        return tbl.delete(regs[startReg + 1]);
    }),
    builtin("table-clear!", 1, 1, (regs, startReg, nargs) => {
        if (nargs !== 1) throw hostError("table-clear! requires 1 argument");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw hostError("table-clear! requires a table");
        tbl.clear();
        return undefined;
    }),
    builtin("table-size", 1, 1, (regs, startReg, nargs) => {
        if (nargs !== 1) throw hostError("table-size requires 1 argument");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw hostError("table-size requires a table");
        return tbl.size;
    }),
    builtin("table-keys", 1, 1, (regs, startReg, nargs) => {
        if (nargs !== 1) throw hostError("table-keys requires 1 argument");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw hostError("table-keys requires a table");
        return [...tbl.keys()];
    }),
    builtin("table-values", 1, 1, (regs, startReg, nargs) => {
        if (nargs !== 1) throw hostError("table-values requires 1 argument");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw hostError("table-values requires a table");
        return [...tbl.values()];
    }),
    builtin("table-copy", 1, 1, (regs, startReg, nargs) => {
        if (nargs !== 1) throw hostError("table-copy requires 1 argument");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw hostError("table-copy requires a table");
        return tbl.copy();
    }),
    builtin("table-entries", 1, 1, (regs, startReg, nargs) => {
        if (nargs !== 1) throw hostError("table-entries requires 1 argument");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw hostError("table-entries requires a table");
        return [...tbl.entries()];
    }),
    builtin("table-freeze!", 1, 1, (regs, startReg, nargs) => {
        if (nargs !== 1) throw hostError("table-freeze! requires 1 argument");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw hostError("table-freeze! requires a table");
        tbl.frozen = true;
        return tbl;
    }),
    builtin("table-merge!", 2, 2, (regs, startReg, nargs) => {
        if (nargs !== 2) throw hostError("table-merge! requires 2 arguments (table-merge! target source)");
        const target = regs[startReg];
        const source = regs[startReg + 1];
        if (!(target instanceof Table) || !(source instanceof Table)) {
            throw hostError("table-merge! requires both arguments to be tables");
        }
        for (const [k, v] of source.entries()) {
            target.set(k, v);
        }
        return target;
    }),
    builtin("table-border", 1, 1, (regs, startReg, nargs) => {
        if (nargs !== 1) throw hostError("table-border requires 1 argument");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw hostError("table-border requires a table");
        return tbl.border();
    }),
    builtin("reverse", 1, 1, (regs, startReg, nargs) => {
        if (nargs !== 1) throw hostError("reverse requires 1 argument");
        let lst = regs[startReg];
        if (lst instanceof Cons && lst.isCyclic()) throw hostError("reverse: circular list");
        let out: Cons | null = null;
        while (lst instanceof Cons) {
            out = new Cons(lst.car, out);
            lst = lst.cdr;
        }
        if (lst !== null) throw hostError("reverse requires a proper list");
        return out;
    }),
]

// AOT templates (see InlineFn); each falls back to the builtin itself, so its errors are unchanged
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

// walks the path from the innermost accessor, checking each step is a pair
const cxrInline = (path: string): InlineFn => unaryInline((a, slow, d) => {
    const checks: string[] = [];
    let expr = a;
    for (let i = path.length - 1; i >= 0; i--) {
        checks.push(`${expr} instanceof ${d.Cons}`);
        expr = `${expr}.${path[i] === "a" ? "car" : "cdr"}`;
    }
    return `(${checks.join(" && ")} ? ${expr} : ${slow})`;
});

const vectorIndexOk = (v: string, k: string) => `Array.isArray(${v}) && Number.isInteger(${k}) && ${k} >= 0 && ${k} < ${v}.length`;

const INLINES = new Map<string, InlineFn>([
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

    ["cons", (args, _slow, _tmp, d) => args.length === 2 ? `${d.Cons}.pair(${args[0]}, ${args[1]})` : null],
    ...CXR_PATHS.map(([name, path]): [string, InlineFn] => [name, cxrInline(path)]),

    ["null?", unaryInline(a => `${a} === null`)],
    ["pair?", unaryInline((a, _slow, d) => `${a} instanceof ${d.Cons}`)],
    ["list?", unaryInline((a, _slow, d) => `(${a} === null || (${a} instanceof ${d.Cons} && !${a}.isImproper() && !${a}.isCyclic()))`)],
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
    ["procedure?", unaryInline((a, _slow, d) => `${a} instanceof ${d.IProcedure}`)],
    ["error?", unaryInline((a, _slow, d) => `${a} instanceof ${d.ErrorObject}`)],
    ["vector?", unaryInline(a => `Array.isArray(${a})`)],
    ["table?", unaryInline((a, _slow, d) => `${a} instanceof ${d.Table}`)],
    ["empty?", unaryInline((a, _slow, d) => `(${a} === null || ((Array.isArray(${a}) || typeof ${a} === "string") && ${a}.length === 0) || (${a} instanceof ${d.Table} && ${a}.size === 0))`)],
    ["vector-empty?", unaryInline((a, slow) => `(Array.isArray(${a}) ? ${a}.length === 0 : ${slow})`)],
    ["table-empty?", unaryInline((a, slow, d) => `(${a} instanceof ${d.Table} ? ${a}.size === 0 : ${slow})`)],
    ["table-frozen?", unaryInline((a, slow, d) => `(${a} instanceof ${d.Table} ? ${a}.frozen : ${slow})`)],
    ["continuation-mark-set?", unaryInline((a, _slow, d) => `${a} instanceof ${d.ContinuationMarkSet}`)],

    ["vector-length", unaryInline((v, slow) => `(Array.isArray(${v}) ? ${v}.length : ${slow})`)],
    ["vector-ref", (args, slow) => args.length !== 2 ? null : `(${vectorIndexOk(args[0], args[1])} ? ${args[0]}[${args[1]}] : ${slow})`],
    ["vector-set!", (args, slow) => args.length !== 3 ? null : `(${vectorIndexOk(args[0], args[1])} ? (${args[0]}[${args[1]}] = ${args[2]}, undefined) : ${slow})`],

    ["table-ref", ([t, k, ...rest], slow, tmp, d) => k === undefined || rest.length > 0 ? null : `(${t} instanceof ${d.Table} && (${tmp} = ${t}.lookup(${k}, ${d.MISSING})) !== ${d.MISSING} ? ${tmp} : ${slow})`],
    ["table-set!", (args, slow, _tmp, d) => args.length !== 3 ? null : `(${args[0]} instanceof ${d.Table} && !${args[0]}.frozen ? (${args[0]}.set(${args[1]}, ${args[2]}), undefined) : ${slow})`],
    ["table-has?", (args, slow, _tmp, d) => args.length !== 2 ? null : `(${args[0]} instanceof ${d.Table} ? ${args[0]}.has(${args[1]}) : ${slow})`],
    ["table-border", unaryInline((t, slow, d) => `(${t} instanceof ${d.Table} ? ${t}.border() : ${slow})`)],
]);

// what the templates may refer to
const INLINE_DEPS = { Cons, Table, IProcedure, ErrorObject, ContinuationMarkSet, MISSING: MISSING_KEY };

// Registers every builtin as the leaf intrinsic %name, always in the same order (so the cached prelude's intrinsics are at
// the same positions in every instance)
export const registerSchemeIntrinsics = (intrinsics: Intrinsics): void => {
    for (const { name, min, max, fn } of SCHEME_BUILTINS) {
        const inline = INLINES.get(name);
        intrinsics.register(`%${name}`, fn, { args: [min, max], leaf: true, inline, deps: inline === undefined ? undefined : INLINE_DEPS });
    }
};

// What (name arg ...) is rewritten to: the builtins' intrinsics, and the compiler's own %list and %values
export const SCHEME_ALIASES: ReadonlyMap<symbol, symbol> = new Map([
    ...SCHEME_BUILTINS.map(({ name }) => name),
    "list",
    "values",
].map(name => [Symbol.for(name), Symbol.for(`%${name}`)]));

// The prelude's first-class procedures for the builtins: a fixed-arity wrapper, or an %apply of the rest arguments
export const BUILTIN_WRAPPERS = [
    ...SCHEME_BUILTINS.map(({ name, min, max }) => {
        if (min !== max) return `(define ($${name} . args) (%apply %${name} args))`;
        const params = Array.from({ length: min }, (_, i) => `a${i}`).join(" ");
        return `(define ($${name}${params === "" ? "" : " " + params}) (%${name}${params === "" ? "" : " " + params}))`;
    }),
    "(define ($list . args) args)",
    "(define ($values . args) (%list->values args))",
].join("\n");
