// Luau's operators (VM/src/lvmutils.cpp), as intrinsics: numbers, strings that read as numbers, vectors, and (a
// deviation from Luau) integers with integers
import { MultipleValues } from "../common";
import { severalValues } from "../magicvm/coreops";
import { luauError } from "./errors";
import type { ArgKinds, InlineFn, Intrinsics, Returns, TypeSystem } from "../magicvm/intrinsics";
import { integer, ipow } from "./integer";
import { toString, typeName } from "./messages";
import { num2str, str2number } from "./number";
import { LuaVector, vadd, vdiv, vidiv, vmul, vsub, vunm } from "./vector";

export type ArithOp = "add" | "sub" | "mul" | "div" | "idiv" | "mod" | "pow" | "unm";

// C's pow, where it differs from JS's **
export const luaPow = (a: number, b: number): number => a === 1 || (a === -1 && (b === Infinity || b === -Infinity)) ? 1 : a ** b;

const numeric = (op: ArithOp, a: number, b: number): number => {
    switch (op) {
        case "add": return a + b;
        case "sub": return a - b;
        case "mul": return a * b;
        case "div": return a / b;
        case "idiv": return Math.floor(a / b);
        case "mod": return a - Math.floor(a / b) * b;
        case "pow": return luaPow(a, b);
        case "unm": return -a;
    }
};

const integral = (op: ArithOp, a: bigint, b: bigint): bigint => {
    switch (op) {
        case "add": return integer.add(a, b);
        case "sub": return integer.sub(a, b);
        case "mul": return integer.mul(a, b);
        case "div": return integer.div(a, b);
        case "idiv": return integer.idiv(a, b);
        case "mod": return integer.mod(a, b);
        case "pow": return ipow(a, b);
        case "unm": return integer.neg(a);
    }
};

// luaV_tonumber: a number, or a string that reads as one
const tonumber = (v: any): number | undefined => typeof v === "number" ? v : typeof v === "string" ? str2number(v) : undefined;

const arithError = (op: ArithOp, a: any, b: any): Error => {
    const t1 = typeName(a), t2 = typeName(b);
    return luauError(t1 === t2 ? `attempt to perform arithmetic (${op}) on ${t1}` : `attempt to perform arithmetic (${op}) on ${t1} and ${t2}`);
};

// luaV_doarith: `b` is `a` for unm
export const arith = (op: ArithOp, a: any, b: any): any => {
    if (typeof a === "bigint" && typeof b === "bigint") return integral(op, a, b);
    const va = a instanceof LuaVector, vb = b instanceof LuaVector;
    if (va && vb) {
        switch (op) {
            case "add": return vadd(a, b);
            case "sub": return vsub(a, b);
            case "mul": return vmul(a, b);
            case "div": return vdiv(a, b);
            case "idiv": return vidiv(a, b);
            case "unm": return vunm(a);
        }
    } else if (va || vb) {
        const n = tonumber(va ? b : a);
        if (n !== undefined) {
            const [x, y] = va ? [a, n] : [n, b];
            switch (op) {
                case "mul": return vmul(x, y);
                case "div": return vdiv(x, y);
                case "idiv": return vidiv(x, y);
            }
        }
    }
    const na = tonumber(a), nb = tonumber(b);
    if (na !== undefined && nb !== undefined) return numeric(op, na, nb);
    throw arithError(op, a, b);
};

// luaV_concat of two values: strings, numbers and (a deviation from Luau) integers
const concatable = (v: any): boolean => typeof v === "string" || typeof v === "number" || typeof v === "bigint";

export const concat = (a: any, b: any): string => {
    if (typeof a === "string" && typeof b === "string") return a + b;
    if (!concatable(a) || !concatable(b)) throw luauError(`attempt to concatenate ${typeName(a)} with ${typeName(b)}`);
    return (typeof a === "number" ? num2str(a) : String(a)) + (typeof b === "number" ? num2str(b) : String(b));
};

// raw equality: the same value, or equal vectors (metamethods come later)
export const rawequal = (a: any, b: any): boolean => a === b || (a instanceof LuaVector && a.equals(b));

// luaV_lessthan / luaV_lessequal: numbers, strings (by bytes) and (a deviation from Luau) integers
const ordered = (a: any, b: any): boolean => {
    const t = typeof a;
    return t === typeof b && (t === "number" || t === "string" || t === "bigint");
};

export const lessThan = (a: any, b: any): boolean => {
    if (ordered(a, b)) return a < b;
    throw luauError(`attempt to compare ${typeName(a)} < ${typeName(b)}`);
};

export const lessEqual = (a: any, b: any): boolean => {
    if (ordered(a, b)) return a <= b;
    throw luauError(`attempt to compare ${typeName(a)} <= ${typeName(b)}`);
};

// luaV_prepareFORN: a numeric for's initial value, limit or step, as a number
export const forNumber = (v: any, what: string): number => {
    const n = tonumber(v);
    if (n === undefined) throw luauError(`invalid 'for' ${what} (number expected, got ${typeName(v)})`);
    return n;
};

// Luau's kinds: numbers, and integers (bigints)
export const LUAU_TYPES: TypeSystem = {
    ofConstant: v => typeof v === "number" ? "number" : typeof v === "bigint" ? "integer" : undefined,
    guard: (kind, e) => kind === "number" ? `typeof ${e} === "number"` : kind === "integer" ? `typeof ${e} === "bigint"` : null,
    coerce: (kind, e) => kind === "number" ? `+${e}` : null,
    // the lowering takes one value of a call before it binds or assigns it (a call it keeps whole is never returned
    // from a variable)
    oneValueVariables: true,
};

const sameKind: Returns = (kinds: ArgKinds) => kinds.every(k => k === "number") ? "number" : kinds.every(k => k === "integer") ? "integer" : undefined;

// the js of `op` on numbers and on integers, given the arguments' expressions, the deps' names
const NUMBER_JS: Record<ArithOp, (a: string, b: string, d: Readonly<Record<string, string>>) => string> = {
    add: (a, b) => `${a} + ${b}`,
    sub: (a, b) => `${a} - ${b}`,
    mul: (a, b) => `${a} * ${b}`,
    div: (a, b) => `${a} / ${b}`,
    idiv: (a, b) => `Math.floor(${a} / ${b})`,
    mod: (a, b) => `${a} - Math.floor(${a} / ${b}) * ${b}`,
    pow: (a, b, d) => `${d.luaPow}(${a}, ${b})`,
    unm: a => `-${a}`,
};
const INTEGER_JS: Partial<Record<ArithOp, (a: string, b: string) => string>> = {
    add: (a, b) => `BigInt.asIntN(64, ${a} + ${b})`,
    sub: (a, b) => `BigInt.asIntN(64, ${a} - ${b})`,
    mul: (a, b) => `BigInt.asIntN(64, ${a} * ${b})`,
    unm: a => `BigInt.asIntN(64, -${a})`,
};

const arithInline = (op: ArithOp): InlineFn => (args, slow, _tmp, d, known) => {
    const [a, b] = op === "unm" ? [args[0], args[0]] : args;
    const ints = INTEGER_JS[op];
    if (ints !== undefined && known.length > 0 && known.every(k => k === "integer")) return `(${ints(a, b)})`;
    const checks = [...new Set(args.filter((_, i) => known[i] !== "number"))].map(x => `typeof ${x} === "number"`);
    const value = NUMBER_JS[op](a, b, d);
    return checks.length === 0 ? `(${value})` : `(${checks.join(" && ")} ? ${value} : ${slow})`;
};

export const ARITH_OPS: readonly ArithOp[] = ["add", "sub", "mul", "div", "idiv", "mod", "pow", "unm"];

export const registerLuauOps = (table: Intrinsics): void => {
    for (const op of ARITH_OPS) {
        const unary = op === "unm";
        table.register(`%luau-${op}`, unary ? (regs, s) => arith(op, regs[s], regs[s]) : (regs, s) => arith(op, regs[s], regs[s + 1]), {
            args: unary ? [1, 1] : [2, 2], leaf: true, foldable: true, oneValue: true,
            inline: arithInline(op), deps: { luaPow }, returns: sameKind, wants: "number",
        });
    }
    table.register("%luau-concat", (regs, s) => concat(regs[s], regs[s + 1]), {
        args: [2, 2], leaf: true, foldable: true, oneValue: true,
        inline: (args, slow) => `(typeof ${args[0]} === "string" && typeof ${args[1]} === "string" ? ${args[0]} + ${args[1]} : ${slow})`,
    });
    const bool = { leaf: true, foldable: true, returns: "boolean" } as const;
    table.register("%luau-truthy", (regs, s) => regs[s] !== undefined && regs[s] !== false, {
        ...bool, args: [1, 1], effectFree: true, inline: ([a]) => `(${a} !== undefined && ${a} !== false)`,
    });
    table.register("%luau-not", (regs, s) => regs[s] === undefined || regs[s] === false, {
        ...bool, args: [1, 1], effectFree: true, inline: ([a]) => `(${a} === undefined || ${a} === false)`,
    });
    // only two vectors are equal other than by ===
    const eqInline = (negate: boolean): InlineFn => ([a, b], slow, _tmp, _d, known) =>
        known.some(k => k !== undefined) ? `(${a} ${negate ? "!==" : "==="} ${b})`
            : `(${a} === ${b} ? ${!negate} : typeof ${a} === "object" && ${a} !== null ? ${slow} : ${negate})`;
    table.register("%luau-eq", (regs, s) => rawequal(regs[s], regs[s + 1]), { ...bool, args: [2, 2], effectFree: true, inline: eqInline(false) });
    table.register("%luau-ne", (regs, s) => !rawequal(regs[s], regs[s + 1]), { ...bool, args: [2, 2], effectFree: true, inline: eqInline(true) });
    // a > b and a >= b are b < a and b <= a, as Luau compiles them (its messages say so)
    const compare = (name: string, op: string, fn: (a: any, b: any) => boolean, swap: boolean) => {
        table.register(name, swap ? (regs, s) => fn(regs[s + 1], regs[s]) : (regs, s) => fn(regs[s], regs[s + 1]), {
            ...bool, args: [2, 2], wants: "number",
            inline: (args, slow, _tmp, _d, known) => {
                const [a, b] = swap ? [args[1], args[0]] : args;
                const checks = [...new Set(args.filter((_, i) => known[i] !== "number"))].map(x => `typeof ${x} === "number"`);
                return checks.length === 0 ? `(${a} ${op} ${b})` : `(${checks.join(" && ")} ? ${a} ${op} ${b} : ${slow})`;
            },
        });
    };
    compare("%luau-lt", "<", lessThan, false);
    compare("%luau-le", "<=", lessEqual, false);
    compare("%luau-gt", "<", lessThan, true);
    compare("%luau-ge", "<=", lessEqual, true);
    table.register("%luau-for-number", (regs, s) => forNumber(regs[s], regs[s + 1]), {
        args: [2, 2], leaf: true, returns: "number",
        inline: ([v], slow) => `(typeof ${v} === "number" ? ${v} : ${slow})`,
    });
    // whether a numeric for goes on: the same test entering and looping, so NaNs behave alike
    table.register("%luau-for-test", (regs, s) => regs[s + 2] > 0 ? regs[s] <= regs[s + 1] : regs[s + 1] <= regs[s], {
        ...bool, args: [3, 3], effectFree: true,
        inline: ([i, limit, step]) => `(${step} > 0 ? ${i} <= ${limit} : ${limit} <= ${i})`,
    });
    // an element of `...` (an array), nil past its end
    table.register("%luau-arg", (regs, s) => regs[s][regs[s + 1]], { args: [2, 2], leaf: true, effectFree: true, oneValue: true, inline: ([a, i]) => `${a}[${i}]` });
    // all of `...` as values (the array is never changed, so several values keep it)
    table.register("%luau-varargs", (regs, s) => regs[s].length === 1 ? regs[s][0] : new MultipleValues(regs[s]), {
        args: [1, 1], leaf: true, effectFree: true, deps: { MultipleValues },
        inline: ([a], _slow, _tmp, d) => `(${a}.length === 1 ? ${a}[0] : new ${d.MultipleValues}(${a}))`,
    });
    // whether a call gave other than one value
    table.register("%luau-several?", (regs, s) => regs[s] instanceof MultipleValues, {
        ...bool, foldable: false, args: [1, 1], effectFree: true, inline: ([v], _slow, _tmp, d) => `(${severalValues(v, d)})`, deps: { MultipleValues },
    });
    table.register("%luau-tostring", (regs, s) => toString(regs[s]), { args: [1, 1], leaf: true, oneValue: true });
};
