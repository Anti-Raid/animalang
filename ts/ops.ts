import { Cons } from "./list";
import { ErrorObject, IProcedure, packValues, unpackValues } from "./common";
import { Table } from "./table";

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

export const ARITHMETIC: [name: string, fn: (regs: readonly any[], start: number, nargs: number) => any][] = [
    ["+", opAdd],
    ["-", opSub],
    ["*", opMul],
    ["/", opDiv],
    ["modulo", opMod],
    ["remainder", opRem],
    ["=", opNumEq],
    ["eq?", opEq],
    ["<", opLt],
    ["<=", opLe],
    [">", opGt],
    [">=", opGe],
];

export const ARITHMETIC_FNS = ARITHMETIC.map(([, fn]) => fn);

export const makeList = (regs: readonly any[], start: number, nargs: number) => {
    let tail: Cons | null = null;
    for (let i = start + nargs - 1; i >= start; i--) tail = new Cons(regs[i], tail);
    return tail;
};

export const valuesToList = (regs: readonly any[], start: number, nargs: number) => {
    if (nargs !== 1) throw new Error("%values->list requires 1 argument");
    return Cons.fromArray(unpackValues(regs[start]));
};

export const opCons = (regs: readonly any[], start: number, nargs: number) => {
    if (nargs !== 2) throw new Error("cons requires 2 arguments [cons a d]");
    return Cons.pair(regs[start], regs[start + 1]);
};

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

const requireInteger = (name: string, val: any): number => {
    if (typeof val !== "number" || !Number.isInteger(val)) throw new Error(`${name} requires an integer`);
    return val;
};

const requireTable = (name: string, val: any): Table => {
    if (!(val instanceof Table)) throw new Error(`${name} requires a table`);
    return val;
};

export const PREDICATES: [name: string, test: (val: any) => boolean][] = [
    ["null?", val => val === null],
    ["pair?", val => val instanceof Cons],
    ["list?", val => val === null || (val instanceof Cons && !val.isImproper() && !val.isCyclic())],
    ["number?", val => typeof val === "number"],
    ["integer?", val => typeof val === "number" && Number.isInteger(val)],
    ["positive?", val => typeof val === "number" && val > 0],
    ["negative?", val => typeof val === "number" && val < 0],
    ["zero?", val => typeof val === "number" && val === 0],
    ["even?", val => requireInteger("even?", val) % 2 === 0],
    ["odd?", val => Math.abs(requireInteger("odd?", val) % 2) === 1],
    ["infinite?", val => typeof val === "number" && (val === Infinity || val === -Infinity)],
    ["finite?", val => typeof val === "number" && Number.isFinite(val)],
    ["nan?", val => typeof val === "number" && Number.isNaN(val)],
    ["boolean?", val => typeof val === "boolean"],
    ["void?", val => typeof val === "undefined"],
    ["symbol?", val => typeof val === "symbol"],
    ["string?", val => typeof val === "string"],
    ["procedure?", val => val instanceof IProcedure],
    ["error?", val => val instanceof ErrorObject],
    ["vector?", val => Array.isArray(val)],
    ["table?", val => val instanceof Table],
    ["empty?", val => val === null || (Array.isArray(val) && val.length === 0) || (typeof val === "string" && val.length === 0) || (val instanceof Table && val.size === 0)],
    ["vector-empty?", val => {
        if (!Array.isArray(val)) throw new Error("vector-empty? requires a vector");
        return val.length === 0;
    }],
    ["table-empty?", val => requireTable("table-empty?", val).size === 0],
    ["table-frozen?", val => requireTable("table-frozen?", val).frozen],
];

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
