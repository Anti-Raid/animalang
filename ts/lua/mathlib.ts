// Luau's math library (VM/src/lmathlib.cpp), over a function's arguments (an array). What C's libm computes and JS's
// Math does not (round, modf, frexp, ldexp, pow) is written out; sin, exp, log and the like are the engine's, which may
// differ from a C library's in the last digit
import { MultipleValues } from "../common";
import { argInvalid, integerArg, numberArg, toInt, type Args } from "./args";
import { luauError } from "./errors";
import { luaPow } from "./number";

const RADIANS_PER_DEGREE = 3.14159265358979323846 / 180.0;

// a 64-bit unsigned integer as two halves, for the generator's state
export type Rng = { hi: number, lo: number };

// the high and low 32 bits of the product of two 32-bit unsigned integers
const mul32 = (a: number, b: number): [hi: number, lo: number] => {
    const a0 = a & 0xffff, a1 = a >>> 16, b0 = b & 0xffff, b1 = b >>> 16;
    const p00 = a0 * b0, p01 = a0 * b1, p10 = a1 * b0, p11 = a1 * b1;
    const mid = (p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff);
    return [(p11 + (p01 >>> 16) + (p10 >>> 16) + (mid >>> 16)) >>> 0, ((mid << 16) | (p00 & 0xffff)) >>> 0];
};

// pcg32_random: the state goes on (times 6364136223846793005, plus 105), and the number is made of the state it was
const MUL_HI = 0x5851f42d, MUL_LO = 0x4c957f2d;
const pcg32 = (state: Rng): number => {
    const hi = state.hi, lo = state.lo;
    const [carry, low] = mul32(lo, MUL_LO);
    const sum = low + 105;
    state.lo = sum >>> 0;
    state.hi = (carry + Math.imul(lo, MUL_HI) + Math.imul(hi, MUL_LO) + (sum > 0xffffffff ? 1 : 0)) >>> 0;
    // ((old >> 18) ^ old) >> 27, as 32 bits
    const xhi = (hi >>> 18) ^ hi, xlo = ((lo >>> 18) | (hi << 14)) ^ lo;
    const xorshifted = ((xlo >>> 27) | (xhi << 5)) >>> 0;
    const rot = hi >>> 27;
    return ((xorshifted >>> rot) | (xorshifted << (-rot & 31))) >>> 0;
};

// pcg32_seed, with the seed an int (so a negative one has every high bit set)
export const seedRng = (state: Rng, seedHi: number, seedLo: number): void => {
    state.hi = state.lo = 0;
    pcg32(state);
    const lo = state.lo + (seedLo >>> 0);
    state.lo = lo >>> 0;
    state.hi = (state.hi + (seedHi >>> 0) + (lo > 0xffffffff ? 1 : 0)) >>> 0;
    pcg32(state);
};

// C's round: halves away from zero
const round = (x: number): number => x < 0 ? -Math.round(-x) : Math.round(x);

// C's frexp: the fraction in [0.5, 1) and the exponent (what is not finite, and zero, is its own fraction)
const frexp = (x: number): [number, number] => {
    if (x === 0 || x !== x || x === Infinity || x === -Infinity) return [x, 0];
    let e = Math.max(-1023, Math.floor(Math.log2(Math.abs(x))) + 1);
    let m = x * 2 ** -e;
    // (a subnormal's fraction is still below a half, and log2 may be one off next to a power of two)
    while (Math.abs(m) < 0.5) { m *= 2; e--; }
    while (Math.abs(m) >= 1) { m /= 2; e++; }
    return [m, e];
};

// C's ldexp: x times 2 to the e, in steps that neither overflow nor lose bits before the result does
const ldexp = (x: number, e: number): number => {
    if (x === 0 || x !== x || x === Infinity || x === -Infinity) return x;
    if (e > 2200) e = 2200;
    else if (e < -2200) e = -2200;
    const [m, ex] = frexp(x);
    const exp = ex + e;
    if (exp > 1024) return m > 0 ? Infinity : -Infinity;
    if (exp >= -1021) return m * 2 ** (exp - 1) * 2;
    // a subnormal result: one rounding, of the fraction scaled into place
    return exp < -1100 ? (m > 0 ? 0 : -0) : m * 2 ** (exp + 1021) * 2 ** -1021;
};

const kPerlinHash = [
    151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225, 140, 36, 103, 30, 69, 142, 8, 99, 37, 240, 21, 10, 23,
    190, 6, 148, 247, 120, 234, 75, 0, 26, 197, 62, 94, 252, 219, 203, 117, 35, 11, 32, 57, 177, 33, 88, 237, 149, 56, 87, 174, 20,
    125, 136, 171, 168, 68, 175, 74, 165, 71, 134, 139, 48, 27, 166, 77, 146, 158, 231, 83, 111, 229, 122, 60, 211, 133, 230, 220, 105, 92,
    41, 55, 46, 245, 40, 244, 102, 143, 54, 65, 25, 63, 161, 1, 216, 80, 73, 209, 76, 132, 187, 208, 89, 18, 169, 200, 196, 135, 130,
    116, 188, 159, 86, 164, 100, 109, 198, 173, 186, 3, 64, 52, 217, 226, 250, 124, 123, 5, 202, 38, 147, 118, 126, 255, 82, 85, 212, 207,
    206, 59, 227, 47, 16, 58, 17, 182, 189, 28, 42, 223, 183, 170, 213, 119, 248, 152, 2, 44, 154, 163, 70, 221, 153, 101, 155, 167, 43,
    172, 9, 129, 22, 39, 253, 19, 98, 108, 110, 79, 113, 224, 232, 178, 185, 112, 104, 218, 246, 97, 228, 251, 34, 242, 193, 238, 210, 144,
    12, 191, 179, 162, 241, 81, 51, 145, 235, 249, 14, 239, 107, 49, 192, 214, 31, 181, 199, 106, 157, 184, 84, 204, 176, 115, 121, 50, 45,
    127, 4, 150, 254, 138, 236, 205, 93, 222, 114, 67, 29, 24, 72, 243, 141, 128, 195, 78, 66, 215, 61, 156, 180, 151,
];
const kPerlinGrad = [
    [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
    [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1], [1, 1, 0], [0, -1, 1], [-1, 1, 0], [0, -1, -1],
];

// (single precision throughout, as the C is: every operation's result is rounded to it. A product that is added to
// is rounded once, with the sum, as the compiler makes of it where the processor has such an operation, arm64: `fma`.
// The product of two singles is exact in a double, so adding there and rounding once is that, but for the rare sum
// a double cannot hold)
const f = Math.fround;
const fma = (a: number, b: number, c: number): number => f(a * b + c);
const fade = (t: number): number => f(f(f(t * t) * t) * fma(t, fma(t, 6, -15), 10));
const lerp = (t: number, a: number, b: number): number => fma(t, f(b - a), a);
const grad = (hash: number, x: number, y: number, z: number): number => {
    const g = kPerlinGrad[hash & 15];
    return fma(g[2], z, fma(g[0], x, f(g[1] * y)));
};
const perlin = (x: number, y: number, z: number): number => {
    const xflr = Math.floor(x), yflr = Math.floor(y), zflr = Math.floor(z);
    const xi = toInt(xflr) & 255, yi = toInt(yflr) & 255, zi = toInt(zflr) & 255;
    const xf = f(x - xflr), yf = f(y - yflr), zf = f(z - zflr);
    const u = fade(xf), v = fade(yf), w = fade(zf);
    const p = kPerlinHash;
    const a = (p[xi] + yi) & 255, aa = (p[a] + zi) & 255, ab = (p[a + 1] + zi) & 255;
    const b = (p[xi + 1] + yi) & 255, ba = (p[b] + zi) & 255, bb = (p[b + 1] + zi) & 255;
    const la = lerp(u, grad(p[aa], xf, yf, zf), grad(p[ba], f(xf - 1), yf, zf));
    const lb = lerp(u, grad(p[ab], xf, f(yf - 1), zf), grad(p[bb], f(xf - 1), f(yf - 1), zf));
    const la1 = lerp(u, grad(p[aa + 1], xf, yf, f(zf - 1)), grad(p[ba + 1], f(xf - 1), yf, f(zf - 1)));
    const lb1 = lerp(u, grad(p[ab + 1], xf, f(yf - 1), f(zf - 1)), grad(p[bb + 1], f(xf - 1), f(yf - 1), f(zf - 1)));
    return lerp(w, lerp(v, la, lb), lerp(v, la1, lb1));
};

// lua_tonumberx for math.noise: a number, a string that reads as one, or (allowed for the second and third) nothing
const noiseArg = (a: Args, n: number, optional: boolean): number => {
    if (optional && a[n - 1] === undefined) return 0;
    return numberArg(a, n, "noise");
};

const one = (name: string, fn: (x: number) => number) => (a: Args): number => fn(numberArg(a, 1, name));
const two = (name: string, fn: (x: number, y: number) => number) => (a: Args): number => fn(numberArg(a, 1, name), numberArg(a, 2, name));

export const MATH_CONSTANTS: Record<string, number> = {
    pi: Math.PI, huge: Infinity, nan: NaN, e: 2.71828182845904523536, phi: 1.61803398874989484820, sqrt2: 1.41421356237309504880, tau: 6.28318530717958647692,
};

export const MATH_LIBRARY: Record<string, (a: Args, rng: Rng) => any> = {
    abs: one("abs", Math.abs),
    sin: one("sin", Math.sin),
    sinh: one("sinh", Math.sinh),
    cos: one("cos", Math.cos),
    cosh: one("cosh", Math.cosh),
    tan: one("tan", Math.tan),
    tanh: one("tanh", Math.tanh),
    asin: one("asin", Math.asin),
    acos: one("acos", Math.acos),
    atan: one("atan", Math.atan),
    atan2: two("atan2", Math.atan2),
    ceil: one("ceil", Math.ceil),
    floor: one("floor", Math.floor),
    fmod: two("fmod", (x, y) => x % y),
    modf: a => {
        const x = numberArg(a, 1, "modf");
        if (x === Infinity || x === -Infinity) return new MultipleValues([x, x > 0 ? 0 : -0]);
        const ip = Math.trunc(x), fp = x - ip;
        // (the fraction has the number's sign, zero too)
        return new MultipleValues([ip, fp === 0 && (x < 0 || Object.is(x, -0)) ? -0 : fp]);
    },
    sqrt: one("sqrt", Math.sqrt),
    pow: two("pow", luaPow),
    log: a => {
        const x = numberArg(a, 1, "log");
        if (a[1] === undefined) return Math.log(x);
        const base = numberArg(a, 2, "log");
        return base === 2 ? Math.log2(x) : base === 10 ? Math.log10(x) : Math.log(x) / Math.log(base);
    },
    log10: one("log10", Math.log10),
    exp: one("exp", Math.exp),
    deg: one("deg", x => x / RADIANS_PER_DEGREE),
    rad: one("rad", x => x * RADIANS_PER_DEGREE),
    frexp: a => new MultipleValues(frexp(numberArg(a, 1, "frexp"))),
    ldexp: a => ldexp(numberArg(a, 1, "ldexp"), integerArg(a, 2, "ldexp")),
    min: a => {
        let min = numberArg(a, 1, "min");
        for (let i = 2; i <= a.length; i++) {
            const d = numberArg(a, i, "min");
            if (d < min) min = d;
        }
        return min;
    },
    max: a => {
        let max = numberArg(a, 1, "max");
        for (let i = 2; i <= a.length; i++) {
            const d = numberArg(a, i, "max");
            if (d > max) max = d;
        }
        return max;
    },
    random: (a, rng) => {
        switch (a.length) {
            case 0: {
                const rl = pcg32(rng), rh = pcg32(rng);
                return (rh * 4294967296 + rl) * 2 ** -64;
            }
            case 1: {
                const u = integerArg(a, 1, "random");
                if (!(1 <= u)) throw argInvalid(1, "random", "interval is empty");
                return 1 + mul32(u, pcg32(rng))[0];
            }
            case 2: {
                const l = integerArg(a, 1, "random"), u = integerArg(a, 2, "random");
                if (!(l <= u)) throw argInvalid(2, "random", "interval is empty");
                const ul = (u - l) >>> 0;
                if (!(ul < 0xffffffff)) throw argInvalid(2, "random", "interval is too large");
                return (l + mul32(ul + 1, pcg32(rng))[0]) | 0;
            }
            default:
                throw luauError("wrong number of arguments");
        }
    },
    randomseed: (a, rng) => {
        const seed = integerArg(a, 1, "randomseed");
        seedRng(rng, seed < 0 ? 0xffffffff : 0, seed);
        return new MultipleValues([]);
    },
    noise: a => {
        const x = noiseArg(a, 1, false), y = noiseArg(a, 2, true), z = noiseArg(a, 3, true);
        return perlin(f(x), f(y), f(z));
    },
    clamp: a => {
        const v = numberArg(a, 1, "clamp"), min = numberArg(a, 2, "clamp"), max = numberArg(a, 3, "clamp");
        if (!(min <= max)) throw argInvalid(3, "clamp", "max must be greater than or equal to min");
        const r = v < min ? min : v;
        return r > max ? max : r;
    },
    sign: one("sign", v => v > 0 ? 1 : v < 0 ? -1 : 0),
    round: one("round", round),
    map: a => {
        const x = numberArg(a, 1, "map"), inmin = numberArg(a, 2, "map"), inmax = numberArg(a, 3, "map"), outmin = numberArg(a, 4, "map"), outmax = numberArg(a, 5, "map");
        return outmin + (x - inmin) * (outmax - outmin) / (inmax - inmin);
    },
    lerp: a => {
        const x = numberArg(a, 1, "lerp"), y = numberArg(a, 2, "lerp"), t = numberArg(a, 3, "lerp");
        return t === 1 ? y : x + (y - x) * t;
    },
    isnan: a => { const x = numberArg(a, 1, "isnan"); return x !== x; },
    isinf: a => { const x = numberArg(a, 1, "isinf"); return x === Infinity || x === -Infinity; },
    isfinite: a => Number.isFinite(numberArg(a, 1, "isfinite")),
};
