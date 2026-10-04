// Luau's operators (VM/src/lvmutils.cpp), as intrinsics: numbers, strings that read as numbers, vectors, and (a
// deviation from Luau) integers with integers
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

// Luau's kinds: numbers, and integers (bigints)
export const LUAU_TYPES: TypeSystem = {
    ofConstant: v => typeof v === "number" ? "number" : typeof v === "bigint" ? "integer" : undefined,
    guard: (kind, e) => kind === "number" ? `typeof ${e} === "number"` : kind === "integer" ? `typeof ${e} === "bigint"` : null,
    coerce: (kind, e) => kind === "number" ? `+${e}` : null,
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
            args: unary ? [1, 1] : [2, 2], leaf: true, foldable: true,
            inline: arithInline(op), deps: { luaPow }, returns: sameKind, wants: "number",
        });
    }
    table.register("%luau-concat", (regs, s) => concat(regs[s], regs[s + 1]), {
        args: [2, 2], leaf: true, foldable: true,
        inline: (args, slow) => `(typeof ${args[0]} === "string" && typeof ${args[1]} === "string" ? ${args[0]} + ${args[1]} : ${slow})`,
    });
    table.register("%luau-tostring", (regs, s) => toString(regs[s]), { args: [1, 1], leaf: true });
};
