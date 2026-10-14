// Luau's utf8 library (VM/src/lutf8lib.cpp), over a function's arguments (an array). A string is of bytes, one to a
// character here, and reads as C's does past its end: a zero byte
import { MultipleValues } from "../common";
import { argInvalid, integerArg, optInteger, stringArg, toInt, type Args } from "./args";
import { luauError } from "./errors";
import { str2number } from "./number";

const NONE = new MultipleValues([]);
const MAXUNICODE = 0x10ffff;
const MAXCSTACK = 8000;
const LIMITS = [0xff, 0x7f, 0x7ff, 0xffff];

const byteAt = (s: string, i: number): number => i < s.length ? s.charCodeAt(i) : 0;
const iscont = (s: string, i: number): boolean => (byteAt(s, i) & 0xc0) === 0x80;

const posrelat = (pos: number, len: number): number => pos >= 0 ? pos : -pos > len ? 0 : len + pos + 1;

// utf8_decode: the code at `pos` and where the next one starts, or null for bytes that are no UTF-8
const decode = (s: string, pos: number): [next: number, code: number] | null => {
    let c = byteAt(s, pos), res = 0;
    if (c < 0x80) return [pos + 1, c];
    let count = 0;
    while (c & 0x40) {
        const cc = byteAt(s, pos + ++count);
        if ((cc & 0xc0) !== 0x80) return null;
        res = ((res << 6) | (cc & 0x3f)) >>> 0;
        c = (c << 1) >>> 0;
    }
    if (count > 3) return null;
    res = (res | ((c & 0x7f) << (count * 5))) >>> 0;
    if (res > MAXUNICODE || res <= LIMITS[count]) return null;
    if (((res - 0xd800) >>> 0) < 0x800) return null;
    return [pos + count + 1, res];
};

// luaO_utf8esc
const encode = (x: number): string => {
    if (x < 0x80) return String.fromCharCode(x);
    let out = "", mfb = 0x3f;
    do {
        out = String.fromCharCode(0x80 | (x & 0x3f)) + out;
        x >>= 6;
        mfb >>= 1;
    } while (x > mfb);
    return String.fromCharCode(((~mfb << 1) | x) & 0xff) + out;
};

// iter_aux: what utf8.codes's function gives for the position before
export const utf8Next = (a: Args): any => {
    const s = stringArg(a, 1, null), len = s.length;
    const at = a[1], given = typeof at === "number" ? at : typeof at === "string" ? str2number(at) ?? 0 : 0;
    let n = toInt(given) - 1;
    if (n < 0) n = 0;
    else if (n < len) {
        n++;
        while (iscont(s, n)) n++;
    }
    if (n >= len) return NONE;
    const found = decode(s, n);
    if (found === null || iscont(s, found[0])) throw luauError("invalid UTF-8 code");
    return new MultipleValues([n + 1, found[1]]);
};

export const UTF8_CHARPATTERN = "[\0-\x7F\xC2-\xF4][\x80-\xBF]*";

export const UTF8_LIBRARY: Record<string, (a: Args) => any> = {
    offset: a => {
        const s = stringArg(a, 1, "offset"), len = s.length;
        let n = integerArg(a, 2, "offset");
        let posi = posrelat(optInteger(a, 3, "offset", n >= 0 ? 1 : len + 1), len);
        if (!(1 <= posi && --posi <= len)) throw argInvalid(3, "offset", "position out of range");
        if (n === 0) {
            while (posi > 0 && iscont(s, posi)) posi--;
        } else {
            if (iscont(s, posi)) throw luauError("initial position is a continuation byte");
            if (n < 0) {
                while (n < 0 && posi > 0) {
                    do posi--; while (posi > 0 && iscont(s, posi));
                    n++;
                }
            } else {
                n--;
                while (n > 0 && posi < len) {
                    do posi++; while (iscont(s, posi));
                    n--;
                }
            }
        }
        return n === 0 ? posi + 1 : undefined;
    },
    codepoint: a => {
        const s = stringArg(a, 1, "codepoint"), len = s.length;
        const posi = posrelat(optInteger(a, 2, "codepoint", 1), len);
        const pose = posrelat(optInteger(a, 3, "codepoint", posi), len);
        if (!(posi >= 1)) throw argInvalid(2, "codepoint", "out of range");
        if (!(pose <= len)) throw argInvalid(3, "codepoint", "out of range");
        if (posi > pose) return NONE;
        if (a.length + (pose - posi) + 1 > MAXCSTACK) throw luauError("stack overflow (string slice too long)");
        const codes: number[] = [];
        for (let at = posi - 1; at < pose;) {
            const found = decode(s, at);
            if (found === null) throw luauError("invalid UTF-8 code");
            codes.push(found[1]);
            at = found[0];
        }
        return codes.length === 1 ? codes[0] : new MultipleValues(codes);
    },
    char: a => {
        let out = "";
        for (let i = 1; i <= a.length; i++) {
            const code = integerArg(a, i, "char");
            if (!(0 <= code && code <= MAXUNICODE)) throw argInvalid(i, "char", "value out of range");
            out += encode(code);
        }
        return out;
    },
    len: a => {
        const s = stringArg(a, 1, "len"), len = s.length;
        let posi = posrelat(optInteger(a, 2, "len", 1), len), posj = posrelat(optInteger(a, 3, "len", -1), len);
        if (!(1 <= posi && --posi <= len)) throw argInvalid(2, "len", "initial position out of string");
        if (!(--posj < len)) throw argInvalid(3, "len", "final position out of string");
        let n = 0;
        while (posi <= posj) {
            const found = decode(s, posi);
            if (found === null) return new MultipleValues([undefined, posi + 1]);
            posi = found[0];
            n++;
        }
        return n;
    },
};
