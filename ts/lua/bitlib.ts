// Luau's bit32 library (VM/src/lbitlib.cpp), over a function's arguments (an array): numbers as 32-bit unsigned integers
import { argInvalid, integerArg, numberArg, optInteger, type Args } from "./args";
import { luauError } from "./errors";

const NBITS = 32;

// luaL_checkunsigned: C's (unsigned)(long long) of the number (as arm64 does it out of a long long's range)
const unsignedArg = (a: Args, n: number, name: string): number => {
    const d = numberArg(a, n, name);
    if (d !== d) return 0;
    if (d >= 9223372036854775808) return 0xffffffff;
    if (d <= -9223372036854775808) return 0;
    const t = Math.trunc(d);
    return (t - Math.floor(t / 4294967296) * 4294967296) >>> 0;
};

const mask = (n: number): number => ~((0xffffffff << 1) << (n - 1));

// b_shift: left by i, right by -i
const shift = (r: number, i: number): number => {
    if (i < 0) {
        i = -i | 0;
        return i >= NBITS || i < 0 ? (i < 0 ? r >>> i : 0) : r >>> i;
    }
    return i >= NBITS ? 0 : (r << i) >>> 0;
};

const rot = (a: Args, name: string, i: number): number => {
    const r = unsignedArg(a, 1, name);
    i &= NBITS - 1;
    return i !== 0 ? ((r << i) | (r >>> (NBITS - i))) >>> 0 : r;
};

// fieldargs: the field's first bit and its width
const fieldArgs = (a: Args, n: number, name: string): [f: number, w: number] => {
    const f = integerArg(a, n, name), w = optInteger(a, n + 1, name, 1);
    if (!(0 <= f)) throw argInvalid(n, name, "field cannot be negative");
    if (!(0 < w)) throw argInvalid(n + 1, name, "width must be positive");
    if (f + w > NBITS) throw luauError("trying to access non-existent bits");
    return [f, w];
};

const and = (a: Args, name: string): number => {
    let r = 0xffffffff;
    for (let i = 1; i <= a.length; i++) r &= unsignedArg(a, i, name);
    return r >>> 0;
};

export const BIT_LIBRARY: Record<string, (a: Args) => any> = {
    arshift: a => {
        const r = unsignedArg(a, 1, "arshift"), i = integerArg(a, 2, "arshift");
        if (i < 0 || (r & 0x80000000) === 0) return shift(r, -i | 0);
        return i >= NBITS ? 0xffffffff : ((r >>> i) | ~(0xffffffff >>> i)) >>> 0;
    },
    band: a => and(a, "band"),
    bnot: a => ~unsignedArg(a, 1, "bnot") >>> 0,
    bor: a => {
        let r = 0;
        for (let i = 1; i <= a.length; i++) r |= unsignedArg(a, i, "bor");
        return r >>> 0;
    },
    bxor: a => {
        let r = 0;
        for (let i = 1; i <= a.length; i++) r ^= unsignedArg(a, i, "bxor");
        return r >>> 0;
    },
    btest: a => and(a, "btest") !== 0,
    extract: a => {
        const r = unsignedArg(a, 1, "extract"), [f, w] = fieldArgs(a, 2, "extract");
        return ((r >>> f) & mask(w)) >>> 0;
    },
    lrotate: a => rot(a, "lrotate", integerArg(a, 2, "lrotate")),
    lshift: a => {
        const r = unsignedArg(a, 1, "lshift");
        return shift(r, integerArg(a, 2, "lshift"));
    },
    replace: a => {
        const r = unsignedArg(a, 1, "replace"), v = unsignedArg(a, 2, "replace"), [f, w] = fieldArgs(a, 3, "replace"), m = mask(w);
        return ((r & ~(m << f)) | ((v & m) << f)) >>> 0;
    },
    rrotate: a => rot(a, "rrotate", -integerArg(a, 2, "rrotate") | 0),
    rshift: a => {
        const r = unsignedArg(a, 1, "rshift");
        return shift(r, -integerArg(a, 2, "rshift") | 0);
    },
    countlz: a => Math.clz32(unsignedArg(a, 1, "countlz")),
    countrz: a => {
        const v = unsignedArg(a, 1, "countrz");
        return v === 0 ? NBITS : 31 - Math.clz32(v & -v);
    },
    byteswap: a => {
        const n = unsignedArg(a, 1, "byteswap");
        return ((n << 24) | ((n << 8) & 0xff0000) | ((n >>> 8) & 0xff00) | (n >>> 24)) >>> 0;
    },
};
