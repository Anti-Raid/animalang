// Luau's string library (VM/src/lstrlib.cpp), over a function's arguments (an array): each gives its value, or several
// as multiple values. Strings are of bytes, so JS's own string operations do what C's do on them, but for the cases
// noted. pack, unpack and packsize are not here yet
import { IProcedure, MultipleValues } from "../common";
import { hostCall } from "../magicvm/exec";
import { argError, argInvalid, integerArg, numberArg, optInteger, stringArg, toInt, type Args } from "./args";
import { luauError } from "./errors";
import { formatChar, formatFloat, formatInteger, formatString, formatUnsigned, type Spec } from "./format";
import { capturesOf, matcherOf, type Found, type Matcher } from "./matcher";
import { toString, typeName } from "./messages";
import { num2str } from "./number";
import { noSpecials } from "./pattern";
import { LuaTable } from "./table";

const MAXSSIZE = 1 << 30;

const values = (vs: any[]): any => vs.length === 1 ? vs[0] : new MultipleValues(vs);

// a position counted from the end when negative
const posrelat = (pos: number, len: number): number => {
    if (pos < 0) pos += len + 1;
    return pos >= 0 ? pos : 0;
};

// C's toupper and tolower change the 26 letters only (JS's change other characters too)
const HIGH = /[\x80-\xff]/;
const upper = (s: string): string => HIGH.test(s) ? s.replace(/[a-z]+/g, m => m.toUpperCase()) : s.toUpperCase();
const lower = (s: string): string => HIGH.test(s) ? s.replace(/[A-Z]+/g, m => m.toLowerCase()) : s.toLowerCase();

const text = (v: string | number): string => typeof v === "number" ? num2str(v) : v;

// str_find_aux
const find = (a: Args, name: "find" | "match"): any => {
    const s = stringArg(a, 1, name), p = stringArg(a, 2, name);
    let init = posrelat(optInteger(a, 3, name, 1), s.length);
    if (init < 1) init = 1;
    else if (init > s.length + 1) return undefined;
    if (name === "find" && ((a[3] !== undefined && a[3] !== false) || noSpecials(p))) {
        const at = s.indexOf(p, init - 1);
        return at === -1 ? undefined : new MultipleValues([at + 1, at + p.length]);
    }
    const anchor = p.charCodeAt(0) === 94;
    const found = matcherOf(p, anchor ? 1 : 0).find(s, init - 1, anchor);
    if (found === null) return undefined;
    return values(name === "find" ? [found.start + 1, found.end, ...capturesOf(found, false)] : capturesOf(found, true));
};

// what gmatch's function goes on from
export type GmatchState = { readonly s: string, readonly matcher: Matcher, pos: number };

export const gmatchState = (a: Args): GmatchState => ({ s: stringArg(a, 1, "gmatch"), matcher: matcherOf(stringArg(a, 2, "gmatch"), 0), pos: 0 });

// gmatch_aux: the next match's captures, or nothing
export const gmatchNext = (state: GmatchState): any => {
    const found = state.pos > state.s.length ? null : state.matcher.find(state.s, state.pos, false);
    if (found === null) return new MultipleValues([]);
    state.pos = found.end === found.start ? found.end + 1 : found.end;
    return values(capturesOf(found, true));
};

// add_s: a replacement string, with %0 the match, %1 to %9 its captures, and %% a %
const substituted = (repl: string, src: string, found: Found): string => {
    if (!repl.includes("%")) return repl;
    let out = "";
    for (let i = 0; i < repl.length; i++) {
        if (repl[i] !== "%") {
            out += repl[i];
            continue;
        }
        i++;
        const c = repl.charCodeAt(i);
        if (!(c >= 48 && c <= 57)) {
            if (repl[i] !== "%") throw luauError("invalid use of '%' in replacement string");
            out += "%";
        } else if (c === 48) out += src.slice(found.start, found.end);
        else out += text(found.capture(c - 49));
    }
    return out;
};

// str_gsub. A replacement that is a function is called for each match, and the search goes on when it returns
const gsub = (a: Args): any => {
    const src = stringArg(a, 1, "gsub"), p = stringArg(a, 2, "gsub");
    const repl = a[2];
    const max = optInteger(a, 4, "gsub", src.length + 1);
    const byText = typeof repl === "string" || typeof repl === "number";
    if (!byText && !(repl instanceof IProcedure) && !(repl instanceof LuaTable)) throw argError(a, 3, "gsub", "string/function/table");
    const anchor = p.charCodeAt(0) === 94;
    const matcher = matcherOf(p, anchor ? 1 : 0);
    if (typeof repl === "string" && !anchor && max > src.length && matcher.replaceAll !== undefined && !repl.includes("%")) {
        return new MultipleValues(matcher.replaceAll(src, repl));
    }
    // add_value: what a function or a table gave for a match (nil or false: the match itself)
    const given = (found: Found, value: any): string => {
        const v = value instanceof MultipleValues ? value.values[0] : value;
        if (v === undefined || v === false) return src.slice(found.start, found.end);
        if (typeof v !== "string" && typeof v !== "number") throw luauError(`invalid replacement value (a ${typeName(v)})`);
        return text(v);
    };
    // from `pos`, with `n` matches replaced so far and `out` the result up to there
    const run = (pos: number, n: number, out: string): any => {
        while (n < max) {
            // (Luau tries each position in turn, copying the character at one where nothing matches)
            const found = matcher.find(src, pos, anchor);
            if (found === null) break;
            out += src.slice(pos, found.start);
            const after = (replaced: string): [number, string, boolean] => {
                let next = found.end, result = out + replaced, done = anchor;
                if (found.end === found.start) {
                    if (found.start < src.length) result += src[next++];
                    else done = true;
                }
                return [next, result, done];
            };
            if (repl instanceof IProcedure) {
                const count = n + 1;
                return hostCall(repl, capturesOf(found, true), value => {
                    const [next, result, done] = after(given(found, value));
                    return done ? finish(next, count, result) : run(next, count, result);
                });
            }
            const [next, result, done] = after(byText ? substituted(text(repl), src, found) : given(found, repl.rawget(found.capture(0))));
            pos = next;
            out = result;
            n++;
            if (done) break;
        }
        return finish(pos, n, out);
    };
    const finish = (pos: number, n: number, out: string) => new MultipleValues([out + src.slice(pos), n]);
    return run(0, 0, "");
};

// addquoted
const quoted = (s: string): string => `"${s.replace(/["\\\n\r\0]/g, c => c === "\r" ? "\\r" : c === "\0" ? "\\000" : "\\" + c)}"`;

const digit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";

// C's (int64_t) and (uint64_t) of a number, as arm64 does them
const toInt64 = (d: number): bigint => d !== d ? 0n : d >= 2 ** 63 ? 2n ** 63n - 1n : d <= -(2 ** 63) ? -(2n ** 63n) : BigInt(Math.trunc(d));
const toUint64 = (d: number): bigint => d !== d || d <= 0 ? (d < 0 ? BigInt.asUintN(64, toInt64(d)) : 0n) : d >= 2 ** 64 ? 2n ** 64n - 1n : BigInt(Math.trunc(d));

// a format's pieces: text as it is, `%*`, a conversion, or what is wrong with the format from there on
type Piece = string | { conv: string, spec: Spec, plain: boolean } | { error: string };
const STAR = { conv: "*", spec: null as unknown as Spec, plain: true };

// scanformat, for each `%` of a format
const piecesOf = (f: string): Piece[] => {
    const out: Piece[] = [];
    let lit = "";
    for (let i = 0; i < f.length;) {
        const percent = f.indexOf("%", i);
        if (percent === -1) {
            lit += f.slice(i);
            break;
        }
        lit += f.slice(i, percent);
        i = percent + 1;
        if (f[i] === "%") {
            lit += "%";
            i++;
            continue;
        }
        if (lit !== "") out.push(lit);
        lit = "";
        if (f[i] === "*") {
            out.push(STAR);
            i++;
            continue;
        }
        // flags, a width and a precision of two digits at most
        let p = i;
        while (p < f.length && "-+ #0".includes(f[p])) p++;
        if (p - i >= 6) return [...out, { error: "invalid format (repeated flags)" }];
        const flags = f.slice(i, p);
        const w = p;
        if (digit(f[p])) p++;
        if (digit(f[p])) p++;
        const width = p > w ? Number(f.slice(w, p)) : 0;
        let precision: number | null = null;
        if (f[p] === ".") {
            const q = ++p;
            if (digit(f[p])) p++;
            if (digit(f[p])) p++;
            precision = p > q ? Number(f.slice(q, p)) : 0;
        }
        if (digit(f[p])) return [...out, { error: "invalid format (width or precision too long)" }];
        const spec: Spec = { left: flags.includes("-"), plus: flags.includes("+"), space: flags.includes(" "), alt: flags.includes("#"), zero: flags.includes("0"), width, precision };
        out.push({ conv: f[p] ?? "\0", spec, plain: p === i });
        i = p + 1;
    }
    if (lit !== "") out.push(lit);
    return out;
};

const FORMATS = 512;
const formats = new Map<string, Piece[]>();

// str_format
const format = (a: Args): string => {
    const f = stringArg(a, 1, "format");
    let pieces = formats.get(f);
    if (pieces === undefined) {
        if (formats.size >= FORMATS) formats.clear();
        formats.set(f, pieces = piecesOf(f));
    }
    let arg = 1, out = "";
    for (const piece of pieces) {
        if (typeof piece === "string") {
            out += piece;
            continue;
        }
        if (++arg > a.length) throw luauError(`missing argument #${arg}`);
        if (piece === STAR) {
            out += toString(a[arg - 1]);
            continue;
        }
        if ("error" in piece) throw luauError(piece.error);
        const { conv, spec } = piece;
        const v = a[arg - 1];
        switch (conv) {
            case "c": out += formatChar(spec, toInt(numberArg(a, arg, "format"))); break;
            case "d": case "i": {
                const d = typeof v === "bigint" ? v : numberArg(a, arg, "format");
                out += formatInteger(spec, typeof d === "bigint" ? d : d > -(2 ** 53) && d < 2 ** 53 ? Math.trunc(d) : toInt64(d));
                break;
            }
            case "o": case "u": case "x": case "X":
                out += formatUnsigned(spec, conv, typeof v === "bigint" ? BigInt.asUintN(64, v) : toUint64(numberArg(a, arg, "format")));
                break;
            case "e": case "E": case "f": case "g": case "G": out += formatFloat(spec, conv, numberArg(a, arg, "format")); break;
            case "q": out += quoted(stringArg(a, arg, "format")); break;
            case "s": {
                const s = stringArg(a, arg, "format");
                // as it is, when there is nothing to format or it is too long for C's buffer and has no precision
                out += piece.plain || (spec.precision === null && s.length >= 100) ? s : formatString(spec, s);
                break;
            }
            case "*": throw luauError("'%*' does not take a form");
            // (C writes the character and stops at a NUL, which is what ends the format)
            default: throw luauError(conv === "\0" ? "invalid option '%" : `invalid option '%${conv}' to 'format'`);
        }
    }
    return out;
};

export const STRING_LIBRARY: Record<string, (a: Args) => any> = {
    len: a => stringArg(a, 1, "len").length,
    sub: a => {
        const s = stringArg(a, 1, "sub");
        const start = Math.max(posrelat(integerArg(a, 2, "sub"), s.length), 1);
        const end = Math.min(posrelat(optInteger(a, 3, "sub", -1), s.length), s.length);
        return start <= end ? s.slice(start - 1, end) : "";
    },
    reverse: a => stringArg(a, 1, "reverse").split("").reverse().join(""),
    lower: a => lower(stringArg(a, 1, "lower")),
    upper: a => upper(stringArg(a, 1, "upper")),
    rep: a => {
        const s = stringArg(a, 1, "rep"), n = integerArg(a, 2, "rep");
        if (n <= 0) return "";
        if (s.length > Math.floor(MAXSSIZE / n)) throw luauError("resulting string too large");
        return s.repeat(n);
    },
    byte: a => {
        const s = stringArg(a, 1, "byte");
        const posi = posrelat(optInteger(a, 2, "byte", 1), s.length);
        const first = Math.max(posi, 1), last = Math.min(posrelat(optInteger(a, 3, "byte", posi), s.length), s.length);
        if (first === last) return s.charCodeAt(first - 1);
        const out: number[] = [];
        for (let i = first; i <= last; i++) out.push(s.charCodeAt(i - 1));
        return new MultipleValues(out);
    },
    char: a => {
        let out = "";
        for (let i = 1; i <= a.length; i++) {
            const c = integerArg(a, i, "char");
            if (c < 0 || c > 255) throw argInvalid(i, "char", "invalid value");
            out += String.fromCharCode(c);
        }
        return out;
    },
    find: a => find(a, "find"),
    match: a => find(a, "match"),
    gsub,
    format,
    split: a => {
        const s = stringArg(a, 1, "split");
        const parts = s.split(a[1] === undefined ? "," : stringArg(a, 2, "split"));
        return LuaTable.of(parts, parts.length, 0);
    },
};
