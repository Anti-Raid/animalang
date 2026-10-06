// Luau's conversions between numbers and strings: luai_num2str (VM/src/lnumprint.cpp), luaO_str2d (C's strtod, as
// tonumber and arithmetic on strings use it) and tonumber's strtoull for other bases. Strings are byte strings, which C
// reads up to the first "\0"

// the shortest digits that read back as `n`, laid out as Luau lays them out
export const num2str = (n: number): string => {
    if (n !== n) return "nan";
    if (n === Infinity) return "inf";
    if (n === -Infinity) return "-inf";
    if (n === 0) return Object.is(n, -0) ? "-0" : "0";
    // (JS lays a number out the same way where neither uses an exponent)
    const abs = n < 0 ? -n : n;
    if (abs >= 1e-5 && abs < 1e21) return String(n);
    const sign = n < 0 ? "-" : "";
    const [mantissa, exp] = Math.abs(n).toExponential().split("e");
    const digits = mantissa.replace(".", "");
    const dot = Number(exp) + 1;
    if (dot >= -5 && dot <= 21) {
        if (dot <= 0) return `${sign}0.${"0".repeat(-dot)}${digits}`;
        if (dot >= digits.length) return sign + digits + "0".repeat(dot - digits.length);
        return `${sign}${digits.slice(0, dot)}.${digits.slice(dot)}`;
    }
    const e = dot - 1;
    const rest = digits.length > 1 ? `.${digits.slice(1)}` : "";
    return `${sign}${digits[0]}${rest}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
};

const isspace = (c: string): boolean => c === " " || (c >= "\t" && c <= "\r");

const cstring = (s: string): string => {
    const nul = s.indexOf("\0");
    return nul < 0 ? s : s.slice(0, nul);
};

// m * 2^e, correctly rounded (to nearest, ties to even, subnormals included)
const ldexpBig = (m: bigint, e: number): number => {
    if (m === 0n) return 0;
    const shift = Math.max(0, m.toString(2).length - 53, -1074 - e);
    let r = m >> BigInt(shift);
    if (shift > 0) {
        const half = 1n << BigInt(shift - 1);
        const rem = m & ((half << 1n) - 1n);
        if (rem > half || (rem === half && (r & 1n) === 1n)) r++;
    }
    let v = Number(r);
    e += shift;
    while (e > 0 && v !== Infinity) {
        const step = Math.min(e, 1000);
        v *= 2 ** step;
        e -= step;
    }
    while (e < 0 && v !== 0) {
        const step = Math.min(-e, 1000);
        v /= 2 ** step;
        e += step;
    }
    return v;
};

const hexValue = (c: string): number => {
    const d = parseInt(c, 16);
    return Number.isNaN(d) ? -1 : d;
};

// strtod over `s` from `i`: [value, the index after what it read], or undefined if it read nothing
const strtod = (s: string, i: number): [number, number] | undefined => {
    while (i < s.length && isspace(s[i])) i++;
    let neg = false;
    if (s[i] === "+" || s[i] === "-") neg = s[i++] === "-";
    const signed = (v: number) => neg ? -v : v;
    const lower = s.slice(i, i + 8).toLowerCase();
    if (lower.startsWith("inf")) return [signed(Infinity), i + (lower === "infinity" ? 8 : 3)];
    if (lower.startsWith("nan")) {
        let j = i + 3;
        if (s[j] === "(") {
            let k = j + 1;
            while (k < s.length && /[0-9A-Za-z_]/.test(s[k])) k++;
            if (s[k] === ")") j = k + 1;
        }
        return [NaN, j];
    }
    if (s[i] === "0" && (s[i + 1] === "x" || s[i + 1] === "X")) {
        let j = i + 2, m = 0n, scale = 0, any = false;
        for (; hexValue(s[j] ?? "") >= 0; j++, any = true) m = m * 16n + BigInt(hexValue(s[j]));
        if (s[j] === ".") {
            for (j++; hexValue(s[j] ?? "") >= 0; j++, any = true) {
                m = m * 16n + BigInt(hexValue(s[j]));
                scale -= 4;
            }
        }
        if (any) {
            const exp = /^[pP][+-]?\d+/.exec(s.slice(j));
            if (exp !== null) j += exp[0].length;
            const e = exp === null ? 0 : Math.max(-1e6, Math.min(1e6, Number(exp[0].slice(1))));
            return [signed(ldexpBig(m, e + scale)), j];
        }
        return [signed(0), i + 1];
    }
    const num = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(s.slice(i));
    if (num === null) return undefined;
    return [signed(Number(num[0])), i + num[0].length];
};

const trailingSpace = (s: string, i: number): boolean => {
    while (i < s.length && isspace(s[i])) i++;
    return i === s.length;
};

const DECIMAL = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
const SHORT_HEX = /^0[xX][0-9a-fA-F]{1,13}$/;

// luaO_str2d: the number `s` spells (surrounding space allowed), or undefined (nil)
export const str2number = (s: string): number | undefined => {
    // (JS reads a plain decimal as C does, and a short hex integer is exact)
    if (DECIMAL.test(s)) return Number(s);
    if (SHORT_HEX.test(s)) return parseInt(s, 16);
    s = cstring(s);
    const read = strtod(s, 0);
    return read !== undefined && trailingSpace(s, read[1]) ? read[0] : undefined;
};

const ULLONG_MAX = (1n << 64n) - 1n;

// strtoull's (and strtoll's) reading of `s` in `base`: the sign, the digits' value, and the index after them, or undefined
// if there are no digits
export const strtoint = (s: string, base: number): [neg: boolean, n: bigint, end: number] | undefined => {
    let i = 0;
    while (i < s.length && isspace(s[i])) i++;
    let neg = false;
    if (s[i] === "+" || s[i] === "-") neg = s[i++] === "-";
    const digit = (c: string | undefined) => {
        const d = c === undefined ? -1 : parseInt(c, 36);
        return Number.isNaN(d) || d >= base ? -1 : d;
    };
    if (base === 16 && s[i] === "0" && (s[i + 1] === "x" || s[i + 1] === "X") && digit(s[i + 2]) >= 0) i += 2;
    const start = i;
    let n = 0n;
    for (; digit(s[i]) >= 0; i++) n = n * BigInt(base) + BigInt(digit(s[i]));
    return i === start ? undefined : [neg, n, i];
};

// strtoull's value: a negative wraps around 2^64, an overflow is ULLONG_MAX
export const ullong = (neg: boolean, n: bigint): bigint => n > ULLONG_MAX ? ULLONG_MAX : neg ? (-n) & ULLONG_MAX : n;

// tonumber(s, base) for a base other than 10 (2..36)
export const str2integer = (s: string, base: number): number | undefined => {
    s = cstring(s);
    const read = strtoint(s, base);
    return read !== undefined && trailingSpace(s, read[2]) ? Number(ullong(read[0], read[1])) : undefined;
};

export { cstring, trailingSpace };
