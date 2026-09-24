import { Cons } from "./list";

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
    let acc = 0;
    for (let i = start; i < start + nargs; i++) acc += numAt("+", regs, i);
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

export const makeList = (regs: readonly any[], start: number, nargs: number) => {
    let tail: Cons | null = null;
    for (let i = start + nargs - 1; i >= start; i--) tail = new Cons(regs[i], tail);
    return tail;
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

export const opIsNull = (regs: readonly any[], start: number, nargs: number) => {
    if (nargs !== 1) throw new Error("null? requires 1 argument");
    return regs[start] === null;
};

export const opIsPair = (regs: readonly any[], start: number, nargs: number) => {
    if (nargs !== 1) throw new Error("pair? requires 1 argument");
    return regs[start] instanceof Cons;
};
