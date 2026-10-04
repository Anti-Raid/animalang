// Luau's integer (VM/src/lintlib.cpp): a 64-bit two's complement integer, a JS bigint kept in the signed range, so
// typeof, === and Map keys tell it from a number and compare it by value. Every result is wrapped back to the range
// (BigInt.asIntN(64, ...), which V8 compiles to native 64-bit arithmetic). Checking that an argument is an integer is the
// caller's
import { hostError } from "../errors";
import { cstring, strtoint, trailingSpace, ullong } from "./number";

const I = (x: bigint): bigint => BigInt.asIntN(64, x);
const U = (x: bigint): bigint => BigInt.asUintN(64, x);

const MAX = (1n << 63n) - 1n;
const MIN = -(1n << 63n);

const divisor = (b: bigint): void => {
    if (b === 0n) throw hostError("division by zero");
};

const field = (f: bigint, w: bigint, fArg: number, name: string): void => {
    if (!(0n <= f && f <= 63n)) throw hostError(`invalid argument #${fArg} to '${name}' (field cannot be negative)`);
    if (!(0n < w)) throw hostError(`invalid argument #${fArg + 1} to '${name}' (width must be positive)`);
    if (f + w > 64n) throw hostError("trying to access non-existent bits");
};

const scratch = new DataView(new ArrayBuffer(8));

export const integer = {
    maxsigned: MAX,
    minsigned: MIN,

    create: (x: number): bigint | undefined => x >= -(2 ** 63) && x < 2 ** 63 && Number.isInteger(x) ? BigInt(x) : undefined,

    fromstring: (s: string, base: number = 10): bigint | undefined => {
        base = Math.trunc(base);
        if (!(2 <= base && base <= 36)) throw hostError("invalid argument #2 to 'fromstring' (base out of range)");
        s = cstring(s);
        let read = strtoint(s, base);
        if (read === undefined) return undefined;
        let n: bigint;
        if (base === 10) {
            const [neg, m] = read;
            n = neg ? (m > -MIN ? MIN : -m) : (m > MAX ? MAX : m);
            if (s[read[2]] === "x" || s[read[2]] === "X") {
                read = strtoint(s, 16)!;
                n = I(ullong(read[0], read[1]));
            }
        } else n = I(ullong(read[0], read[1]));
        return trailingSpace(s, read[2]) ? n : undefined;
    },

    tonumber: (n: bigint): number => Number(n),

    neg: (a: bigint): bigint => I(-a),
    add: (a: bigint, b: bigint): bigint => I(a + b),
    sub: (a: bigint, b: bigint): bigint => I(a - b),
    mul: (a: bigint, b: bigint): bigint => I(a * b),

    div: (a: bigint, b: bigint): bigint => {
        divisor(b);
        if (a === MIN && b === -1n) throw hostError("integer overflow");
        return a / b;
    },
    idiv: (a: bigint, b: bigint): bigint => {
        divisor(b);
        if (a === MIN && b === -1n) throw hostError("integer overflow");
        const q = a / b;
        return (a < 0n) !== (b < 0n) && a % b !== 0n ? q - 1n : q;
    },
    rem: (a: bigint, b: bigint): bigint => {
        divisor(b);
        return a % b;
    },
    mod: (a: bigint, b: bigint): bigint => {
        divisor(b);
        const r = a % b;
        return r !== 0n && (a < 0n) !== (b < 0n) ? r + b : r;
    },
    udiv: (a: bigint, b: bigint): bigint => {
        divisor(b);
        return I(U(a) / U(b));
    },
    urem: (a: bigint, b: bigint): bigint => {
        divisor(b);
        return I(U(a) % U(b));
    },

    min: (a: bigint, ...rest: bigint[]): bigint => rest.reduce((m, x) => x < m ? x : m, a),
    max: (a: bigint, ...rest: bigint[]): bigint => rest.reduce((m, x) => x > m ? x : m, a),
    clamp: (a: bigint, min: bigint, max: bigint): bigint => {
        if (!(min <= max)) throw hostError("invalid argument #3 to 'clamp' (max must be greater than or equal to min)");
        return a < min ? min : a > max ? max : a;
    },

    bnot: (a: bigint): bigint => ~a,
    band: (...xs: bigint[]): bigint => xs.reduce((r, x) => r & x, -1n),
    bor: (...xs: bigint[]): bigint => xs.reduce((r, x) => r | x, 0n),
    bxor: (...xs: bigint[]): bigint => xs.reduce((r, x) => r ^ x, 0n),
    btest: (...xs: bigint[]): boolean => xs.reduce((r, x) => r & x, -1n) !== 0n,

    lt: (a: bigint, b: bigint): boolean => a < b,
    le: (a: bigint, b: bigint): boolean => a <= b,
    gt: (a: bigint, b: bigint): boolean => a > b,
    ge: (a: bigint, b: bigint): boolean => a >= b,
    ult: (a: bigint, b: bigint): boolean => U(a) < U(b),
    ule: (a: bigint, b: bigint): boolean => U(a) <= U(b),
    ugt: (a: bigint, b: bigint): boolean => U(a) > U(b),
    uge: (a: bigint, b: bigint): boolean => U(a) >= U(b),

    lshift: (n: bigint, i: bigint): bigint => i < -63n || i > 63n ? 0n : i < 0n ? I(U(n) >> -i) : I(n << i),
    rshift: (n: bigint, i: bigint): bigint => i < -63n || i > 63n ? 0n : i < 0n ? I(n << -i) : I(U(n) >> i),
    arshift: (n: bigint, i: bigint): bigint => i < -63n ? 0n : i > 63n ? (n < 0n ? -1n : 0n) : i < 0n ? I(n << -i) : n >> i,
    lrotate: (n: bigint, i: bigint): bigint => {
        const s = U(i) % 64n, u = U(n);
        return s === 0n ? n : I((u << s) | (u >> (64n - s)));
    },
    rrotate: (n: bigint, i: bigint): bigint => {
        const s = U(i) % 64n, u = U(n);
        return s === 0n ? n : I((u >> s) | (u << (64n - s)));
    },

    extract: (n: bigint, f: bigint, w: bigint = 1n): bigint => {
        field(f, w, 2, "extract");
        return I((U(n) >> f) & ((1n << w) - 1n));
    },
    replace: (n: bigint, r: bigint, f: bigint, w: bigint = 1n): bigint => {
        field(f, w, 3, "replace");
        const mask = (1n << w) - 1n;
        return I((U(n) & ~(mask << f)) | ((U(r) & mask) << f));
    },

    countrz: (n: bigint): bigint => {
        const lo = Number(U(n) & 0xffffffffn);
        if (lo !== 0) return BigInt(31 - Math.clz32(lo & -lo));
        const hi = Number(U(n) >> 32n);
        return hi === 0 ? 64n : BigInt(63 - Math.clz32(hi & -hi));
    },
    countlz: (n: bigint): bigint => {
        const hi = Number(U(n) >> 32n);
        return BigInt(hi !== 0 ? Math.clz32(hi) : 32 + Math.clz32(Number(U(n) & 0xffffffffn)));
    },
    bswap: (n: bigint): bigint => {
        scratch.setBigInt64(0, n, true);
        return scratch.getBigInt64(0, false);
    },
};
