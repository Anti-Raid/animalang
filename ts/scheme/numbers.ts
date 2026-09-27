import { hostError } from "../errors";

// Scheme's numbers: doubles, and bigints (written 123n) for exact integers too big for a double to hold. The two do not
// mix: arithmetic and comparisons take two doubles or two bigints (JS itself throws on mixing them), and (bigint x) /
// (inexact x) convert
export type Num = number | bigint;

export const isNum = (v: any): v is Num => typeof v === "number" || typeof v === "bigint";

export const isExactInteger = (v: any): boolean => typeof v === "bigint" || Number.isInteger(v);

export const requireNum = (name: string, v: any): Num => {
    if (!isNum(v)) throw hostError(`${name} requires numbers, but received ${typeof v}`);
    return v;
};

// the two, of one kind
export const sameKind = (name: string, a: Num, b: Num): void => {
    if (typeof a !== typeof b) throw hostError(`${name}: cannot mix a bigint and a double (convert with bigint or inexact)`);
};

export const add = (a: Num, b: Num): Num => { sameKind("+", a, b); return (a as any) + (b as any); };
export const sub = (a: Num, b: Num): Num => { sameKind("-", a, b); return (a as any) - (b as any); };
export const mul = (a: Num, b: Num): Num => { sameKind("*", a, b); return (a as any) * (b as any); };
export const neg = (a: Num): Num => -a;

const zero = (x: Num) => x === 0 || x === 0n;

// a bigint quotient must be whole (there are no fractions): quotient truncates
export const div = (a: Num, b: Num): Num => {
    sameKind("/", a, b);
    if (zero(b)) throw hostError("division by zero");
    if (typeof a === "bigint") {
        if (a % (b as bigint) !== 0n) throw hostError(`/: ${a} / ${b} is not a whole bigint (use quotient)`);
        return a / (b as bigint);
    }
    return a / (b as number);
};

export const quotient = (a: Num, b: Num): Num => {
    sameKind("quotient", a, b);
    if (zero(b)) throw hostError("quotient: division by zero");
    return typeof a === "bigint" ? a / (b as bigint) : Math.trunc(a / (b as number));
};

export const remainder = (name: string, a: Num, b: Num): Num => {
    sameKind(name, a, b);
    if (zero(b)) throw hostError(`${name}: division by zero`);
    return (a as any) % (b as any);
};

export const modulo = (name: string, a: Num, b: Num): Num => {
    sameKind(name, a, b);
    if (zero(b)) throw hostError(`${name}: division by zero`);
    return (((a as any) % (b as any)) + (b as any)) % (b as any);
};

// (exact x): an integer double as it is, or a bigint past what a double holds exactly
export const exact = (name: string, v: any): Num => {
    if (typeof v === "bigint") return v;
    if (!Number.isInteger(v)) throw hostError(`${name}: no exact integer for ${String(v)}`);
    return Number.isSafeInteger(v) ? v : BigInt(v);
};
