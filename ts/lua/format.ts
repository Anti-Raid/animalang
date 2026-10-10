// C's printf conversions, as string.format uses them (snprintf in str_format, VM/src/lstrlib.cpp): a number's digits
// are exact, rounded to nearest and a tie to even, as a C library gives them. JS's toFixed rounds a tie up, so it is
// not used
export type Spec = { left: boolean, plus: boolean, space: boolean, alt: boolean, zero: boolean, width: number, precision: number | null };

// pads `body` (after its `sign` or prefix) to the width: on the right, with zeros after the sign, or on the left
const pad = (spec: Spec, sign: string, body: string, zeros: boolean): string => {
    const fill = spec.width - sign.length - body.length;
    if (fill <= 0) return sign + body;
    if (spec.left) return sign + body + " ".repeat(fill);
    return zeros ? sign + "0".repeat(fill) + body : " ".repeat(fill) + sign + body;
};

const signOf = (spec: Spec, negative: boolean): string => negative ? "-" : spec.plus ? "+" : spec.space ? " " : "";

// %d and %i of a 64-bit integer (a number: one that is whole)
export const formatInteger = (spec: Spec, value: bigint | number): string => {
    const negative = value < 0;
    let digits = (negative ? -value : value).toString();
    if (spec.precision !== null) digits = spec.precision === 0 && digits === "0" ? "" : digits.padStart(spec.precision, "0");
    return pad(spec, signOf(spec, negative), digits, spec.zero && spec.precision === null);
};

// %o, %u, %x and %X of an unsigned 64-bit integer
export const formatUnsigned = (spec: Spec, conv: string, value: bigint): string => {
    const radix = conv === "o" ? 8 : conv === "u" ? 10 : 16;
    let digits = value.toString(radix);
    if (conv === "X") digits = digits.toUpperCase();
    if (spec.precision !== null) digits = spec.precision === 0 && value === 0n ? "" : digits.padStart(spec.precision, "0");
    let prefix = "";
    if (spec.alt && conv === "o" && !digits.startsWith("0")) digits = "0" + digits;
    if (spec.alt && radix === 16 && value !== 0n) prefix = conv === "x" ? "0x" : "0X";
    return pad(spec, prefix, digits, spec.zero && spec.precision === null);
};

const bits = new DataView(new ArrayBuffer(8));

// a finite number, not negative, as mantissa * 2^exponent
const decompose = (x: number): [bigint, number] => {
    bits.setFloat64(0, x);
    const hi = bits.getUint32(0), lo = bits.getUint32(4);
    const exp = (hi >>> 20) & 0x7ff;
    const frac = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
    return exp === 0 ? [frac, -1074] : [frac | (1n << 52n), exp - 1075];
};

// x * 10^scale rounded to an integer, a tie to even
const scaled = (x: number, scale: number): bigint => {
    const [m, e] = decompose(x);
    let num = m, den = 1n;
    if (e >= 0) num <<= BigInt(e);
    else den <<= BigInt(-e);
    if (scale >= 0) num *= 10n ** BigInt(scale);
    else den *= 10n ** BigInt(-scale);
    const q = num / den, r = num % den;
    return 2n * r > den || (2n * r === den && (q & 1n) === 1n) ? q + 1n : q;
};

// the digits of %.<p>f
const fixed = (x: number, p: number): string => {
    // (JS's toFixed is exact too, but rounds a tie up: x is one when x * 2^(p + 1) is an odd integer)
    if (x < 1e21 && (x * 2 ** (p + 1)) % 2 !== 1) return x.toFixed(p);
    const digits = scaled(x, p).toString().padStart(p + 1, "0");
    return p === 0 ? digits : `${digits.slice(0, -p)}.${digits.slice(-p)}`;
};

// the p + 1 significant digits of %.<p>e, and the decimal exponent
const exponential = (x: number, p: number): [string, number] => {
    if (x === 0) return ["0".repeat(p + 1), 0];
    let e10 = Number(x.toExponential(20).split("e")[1]);
    let digits = scaled(x, p - e10).toString();
    // rounding may carry into one more digit
    if (digits.length > p + 1) {
        e10++;
        digits = scaled(x, p - e10).toString();
    }
    return [digits, e10];
};

const withPoint = (digits: string, alt: boolean): string => digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : alt ? `${digits}.` : digits;
const exponentOf = (e10: number, upper: boolean): string => `${upper ? "E" : "e"}${e10 < 0 ? "-" : "+"}${String(Math.abs(e10)).padStart(2, "0")}`;

// %e, %E, %f, %g and %G of a number
export const formatFloat = (spec: Spec, conv: string, value: number): string => {
    const upper = conv === "E" || conv === "G";
    const negative = value < 0 || Object.is(value, -0);
    const sign = signOf(spec, negative && !Number.isNaN(value));
    if (!Number.isFinite(value)) {
        // (a NaN has no sign, as the C library Luau is checked against writes it; others write its sign bit)
        const text = Number.isNaN(value) ? "nan" : "inf";
        return pad(spec, Number.isNaN(value) ? "" : sign, upper ? text.toUpperCase() : text, false);
    }
    const x = Math.abs(value);
    const precision = spec.precision ?? 6;
    let body: string;
    if (conv === "f") {
        body = fixed(x, precision);
        if (spec.alt && precision === 0) body += ".";
    } else if (conv === "e" || conv === "E") {
        const [digits, e10] = exponential(x, precision);
        body = withPoint(digits, spec.alt) + exponentOf(e10, upper);
    } else {
        // %g: as %e when the exponent is below -4 or not below the precision, else as %f; without trailing zeros
        const p = precision === 0 ? 1 : precision;
        const [digits, e10] = exponential(x, p - 1);
        const strip = (s: string) => spec.alt || !s.includes(".") ? s : s.replace(/\.?0+$/, "");
        if (e10 < -4 || e10 >= p) body = strip(withPoint(digits, spec.alt)) + exponentOf(e10, upper);
        else {
            body = fixed(x, p - 1 - e10);
            if (spec.alt && p - 1 - e10 === 0) body += ".";
            body = strip(body);
        }
    }
    return pad(spec, sign, body, spec.zero);
};

// %s (C stops at a NUL) and %c
export const formatString = (spec: Spec, s: string): string => {
    const nul = s.indexOf("\0");
    let body = nul === -1 ? s : s.slice(0, nul);
    if (spec.precision !== null) body = body.slice(0, spec.precision);
    return pad(spec, "", body, spec.zero);
};

export const formatChar = (spec: Spec, code: number): string => pad(spec, "", String.fromCharCode(code & 255), spec.zero);
