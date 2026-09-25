import { Cons } from "./list";
import { ErrorObject, IProcedure, packValues, unpackValues } from "./common";
import { Table } from "./table";

// AOT inlining: given the js expressions of the arguments and of a call to the builtin itself (the fallback, which
// reports errors), returns a js expression computing the result, or null to always call the builtin. `tmp` names a
// scratch variable the expression may assign; `MISSING` and `Table` are also in scope
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

const numAt = (name: string, regs: readonly any[], i: number): number => {
    const val = regs[i];
    if (typeof val !== "number") throw new Error(`${name} requires numbers, but received ${typeof val}`);
    return val;
};

const divisorArgs = (name: string, regs: readonly any[], start: number, nargs: number) => {
    if (nargs !== 2) throw new Error(`${name} requires 2 arguments`);
    const a = regs[start];
    const b = regs[start + 1];
    if (typeof a !== "number" || typeof b !== "number") throw new Error(`${name}: requires numbers, but received ${typeof a}/${typeof b}`);
    if (b === 0) throw new Error(`${name}: division by zero`);
};

export const opAdd = (regs: readonly any[], start: number, nargs: number) => {
    if (nargs === 0) return 0;
    let acc = numAt("+", regs, start);
    for (let i = start + 1; i < start + nargs; i++) acc += numAt("+", regs, i);
    return acc;
};

export const opMul = (regs: readonly any[], start: number, nargs: number) => {
    let acc = 1;
    for (let i = start; i < start + nargs; i++) acc *= numAt("*", regs, i);
    return acc;
};

export const opSub = (regs: readonly any[], start: number, nargs: number) => {
    if (nargs === 0) throw new Error("- requires at least 1 argument");
    let acc = numAt("-", regs, start);
    if (nargs === 1) return -acc;
    for (let i = start + 1; i < start + nargs; i++) acc -= numAt("-", regs, i);
    return acc;
};

export const opDiv = (regs: readonly any[], start: number, nargs: number) => {
    if (nargs === 0) throw new Error("/ requires at least 1 argument");
    let acc = numAt("/", regs, start);
    if (nargs === 1) {
        if (acc === 0) throw new Error("division by zero");
        return 1 / acc;
    }
    for (let i = start + 1; i < start + nargs; i++) {
        const val = numAt("/", regs, i);
        if (val === 0) throw new Error("division by zero");
        acc /= val;
    }
    return acc;
};

export const opMod = (regs: readonly any[], start: number, nargs: number) => {
    divisorArgs("modulo", regs, start, nargs);
    const a = regs[start], b = regs[start + 1];
    return ((a % b) + b) % b;
};

export const opRem = (regs: readonly any[], start: number, nargs: number) => {
    divisorArgs("remainder", regs, start, nargs);
    return regs[start] % regs[start + 1];
};

export const opNumEq = (regs: readonly any[], start: number, nargs: number) => {
    if (nargs === 0) throw new Error("= requires at least 1 argument");
    const first = numAt("=", regs, start);
    for (let i = start + 1; i < start + nargs; i++) {
        if (numAt("=", regs, i) !== first) return false;
    }
    return true;
};

export const opEq = (regs: readonly any[], start: number, nargs: number) => {
    if (nargs === 0) throw new Error("eq? requires at least 1 argument");
    const first = regs[start];
    for (let i = start + 1; i < start + nargs; i++) {
        if (regs[i] !== first) return false;
    }
    return true;
};

export const opLt = (regs: readonly any[], start: number, nargs: number) => {
    if (nargs === 0) throw new Error("< requires at least 1 argument");
    let prev = numAt("<", regs, start);
    for (let i = start + 1; i < start + nargs; i++) {
        const val = numAt("<", regs, i);
        if (!(prev < val)) return false;
        prev = val;
    }
    return true;
};

export const opLe = (regs: readonly any[], start: number, nargs: number) => {
    if (nargs === 0) throw new Error("<= requires at least 1 argument");
    let prev = numAt("<=", regs, start);
    for (let i = start + 1; i < start + nargs; i++) {
        const val = numAt("<=", regs, i);
        if (!(prev <= val)) return false;
        prev = val;
    }
    return true;
};

export const opGt = (regs: readonly any[], start: number, nargs: number) => {
    if (nargs === 0) throw new Error("> requires at least 1 argument");
    let prev = numAt(">", regs, start);
    for (let i = start + 1; i < start + nargs; i++) {
        const val = numAt(">", regs, i);
        if (!(prev > val)) return false;
        prev = val;
    }
    return true;
};

export const opGe = (regs: readonly any[], start: number, nargs: number) => {
    if (nargs === 0) throw new Error(">= requires at least 1 argument");
    let prev = numAt(">=", regs, start);
    for (let i = start + 1; i < start + nargs; i++) {
        const val = numAt(">=", regs, i);
        if (!(prev >= val)) return false;
        prev = val;
    }
    return true;
};

export const ARITHMETIC: [name: string, fn: (regs: readonly any[], start: number, nargs: number) => any, inline?: InlineFn][] = [
    ["+", opAdd, foldInline("+", "0", a => a)],
    ["-", opSub, foldInline("-", null, a => `-${a}`)],
    ["*", opMul, foldInline("*", "1", a => a)],
    ["/", opDiv, foldInline("/", null, a => `1 / ${a}`, true)],
    ["modulo", opMod],
    ["remainder", opRem],
    ["=", opNumEq, chainInline("===")],
    ["eq?", opEq, args => args.length === 0 ? null : `(${args.length === 1 ? "true" : args.slice(1).map(b => `${args[0]} === ${b}`).join(" && ")})`],
    ["<", opLt, chainInline("<")],
    ["<=", opLe, chainInline("<=")],
    [">", opGt, chainInline(">")],
    [">=", opGe, chainInline(">=")],
];

export const ARITHMETIC_FNS = ARITHMETIC.map(([, fn]) => fn);

export const makeList = (regs: readonly any[], start: number, nargs: number) => {
    let tail: Cons | null = null;
    for (let i = start + nargs - 1; i >= start; i--) tail = new Cons(regs[i], tail);
    return tail;
};

export const listInline: InlineFn = args => args.reduceRight((tail, arg) => `new Cons(${arg}, ${tail})`, "null");

export const valuesToList = (regs: readonly any[], start: number, nargs: number) => {
    if (nargs !== 1) throw new Error("%values->list requires 1 argument");
    return Cons.fromArray(unpackValues(regs[start]));
};

export const opCons = (regs: readonly any[], start: number, nargs: number) => {
    if (nargs !== 2) throw new Error("cons requires 2 arguments [cons a d]");
    return Cons.pair(regs[start], regs[start + 1]);
};

export const consInline: InlineFn = args => args.length === 2 ? `Cons.pair(${args[0]}, ${args[1]})` : null;

const cxrPaths = (depth: number): string[] => depth === 0 ? [""] : cxrPaths(depth - 1).flatMap(p => ["a" + p, "d" + p]);

export const CXR_PATHS: [name: string, path: string][] = [
    ["car", "a"],
    ["cdr", "d"],
    ...[2, 3, 4].flatMap(depth => cxrPaths(depth)).map((path): [string, string] => [`c${path}r`, path]),
    ["first", "a"],
    ["second", "ad"],
    ["third", "add"],
];

export const makeCxr = (name: string, path: string) => {
    return (regs: readonly any[], start: number, nargs: number) => {
        if (nargs !== 1) throw new Error(`${name} requires 1 argument`);
        let val = regs[start];
        for (let i = path.length - 1; i >= 0; i--) {
            if (!(val instanceof Cons)) {
                throw new Error(val === null ? `${name}: list is too short` : `${name}: expected a pair but got ${val}`);
            }
            val = path[i] === "a" ? val.car : val.cdr;
        }
        return val;
    };
};

export const CXR_FNS = CXR_PATHS.map(([name, path]) => makeCxr(name, path));

// walks the path from the innermost accessor, checking each step is a pair
const cxrInline = (path: string): InlineFn => (args, slow) => {
    if (args.length !== 1) return null;
    const checks: string[] = [];
    let expr = args[0];
    for (let i = path.length - 1; i >= 0; i--) {
        checks.push(`${expr} instanceof Cons`);
        expr = `${expr}.${path[i] === "a" ? "car" : "cdr"}`;
    }
    return `(${checks.join(" && ")} ? ${expr} : ${slow})`;
};

export const CXR_INLINES = CXR_PATHS.map(([, path]) => cxrInline(path));

const requireInteger = (name: string, val: any): number => {
    if (typeof val !== "number" || !Number.isInteger(val)) throw new Error(`${name} requires an integer`);
    return val;
};

const requireTable = (name: string, val: any): Table => {
    if (!(val instanceof Table)) throw new Error(`${name} requires a table`);
    return val;
};

// the inline form only sees a register name, so it may repeat it freely
export const PREDICATES: [name: string, test: (val: any) => boolean, inline: (a: string, slow: string) => string][] = [
    ["null?", val => val === null, a => `${a} === null`],
    ["pair?", val => val instanceof Cons, a => `${a} instanceof Cons`],
    ["list?", val => val === null || (val instanceof Cons && !val.isImproper() && !val.isCyclic()),
        a => `(${a} === null || (${a} instanceof Cons && !${a}.isImproper() && !${a}.isCyclic()))`],
    ["number?", val => typeof val === "number", a => `typeof ${a} === "number"`],
    ["integer?", val => typeof val === "number" && Number.isInteger(val), a => `Number.isInteger(${a})`],
    ["positive?", val => typeof val === "number" && val > 0, a => `(typeof ${a} === "number" && ${a} > 0)`],
    ["negative?", val => typeof val === "number" && val < 0, a => `(typeof ${a} === "number" && ${a} < 0)`],
    ["zero?", val => typeof val === "number" && val === 0, a => `${a} === 0`],
    ["even?", val => requireInteger("even?", val) % 2 === 0, (a, slow) => `(Number.isInteger(${a}) ? ${a} % 2 === 0 : ${slow})`],
    ["odd?", val => Math.abs(requireInteger("odd?", val) % 2) === 1, (a, slow) => `(Number.isInteger(${a}) ? Math.abs(${a} % 2) === 1 : ${slow})`],
    ["infinite?", val => typeof val === "number" && (val === Infinity || val === -Infinity), a => `(${a} === Infinity || ${a} === -Infinity)`],
    ["finite?", val => typeof val === "number" && Number.isFinite(val), a => `Number.isFinite(${a})`],
    ["nan?", val => typeof val === "number" && Number.isNaN(val), a => `Number.isNaN(${a})`],
    ["boolean?", val => typeof val === "boolean", a => `typeof ${a} === "boolean"`],
    ["void?", val => typeof val === "undefined", a => `${a} === undefined`],
    ["symbol?", val => typeof val === "symbol", a => `typeof ${a} === "symbol"`],
    ["string?", val => typeof val === "string", a => `typeof ${a} === "string"`],
    ["procedure?", val => val instanceof IProcedure, a => `${a} instanceof IProcedure`],
    ["error?", val => val instanceof ErrorObject, a => `${a} instanceof ErrorObject`],
    ["vector?", val => Array.isArray(val), a => `Array.isArray(${a})`],
    ["table?", val => val instanceof Table, a => `${a} instanceof Table`],
    ["empty?", val => val === null || (Array.isArray(val) && val.length === 0) || (typeof val === "string" && val.length === 0) || (val instanceof Table && val.size === 0),
        a => `(${a} === null || ((Array.isArray(${a}) || typeof ${a} === "string") && ${a}.length === 0) || (${a} instanceof Table && ${a}.size === 0))`],
    ["vector-empty?", val => {
        if (!Array.isArray(val)) throw new Error("vector-empty? requires a vector");
        return val.length === 0;
    }, (a, slow) => `(Array.isArray(${a}) ? ${a}.length === 0 : ${slow})`],
    ["table-empty?", val => requireTable("table-empty?", val).size === 0, (a, slow) => `(${a} instanceof Table ? ${a}.size === 0 : ${slow})`],
    ["table-frozen?", val => requireTable("table-frozen?", val).frozen, (a, slow) => `(${a} instanceof Table ? ${a}.frozen : ${slow})`],
];

export const PREDICATE_INLINES = PREDICATES.map(([, , inline]): InlineFn => (args, slow) => args.length === 1 ? inline(args[0], slow) : null);

export const PREDICATE_FNS = PREDICATES.map(([name, test]) => (regs: readonly any[], start: number, nargs: number) => {
    if (nargs !== 1) throw new Error(`${name} requires 1 argument`);
    return test(regs[start]);
});

export const listToArray = (lst: Cons | null): any[] => lst === null ? [] : [...lst];

const spliceLast = (args: any[]): any[] => {
    const finalArg = args.pop();
    if (finalArg instanceof Cons) {
        for (const v of finalArg) args.push(v);
    } else if (finalArg !== null) {
        throw new Error(`apply: last argument must be a list but got ${String(finalArg)}`);
    }
    return args;
};

export const windowApplyArgs = (regs: readonly any[], startReg: number, nargs: number): any[] => {
    return spliceLast(regs.slice(startReg, startReg + nargs));
};

export const applyArgsList = (regs: readonly any[], start: number, nargs: number) => {
    if (nargs !== 1) throw new Error("%apply-args requires 1 argument");
    const lst = regs[start];
    return Cons.fromArray(spliceLast(lst === null ? [] : [...lst]));
};

export const listToValues = (regs: readonly any[], start: number, nargs: number) => {
    if (nargs !== 1) throw new Error("%list->values requires 1 argument");
    return packValues(listToArray(regs[start]));
};
