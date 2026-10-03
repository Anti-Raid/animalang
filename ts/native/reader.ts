// native-scheme's reader: s-expressions read straight into arrays. It names VM values only: `( ... )` (or `[ ... ]`) an
// array, a name a symbol, numbers (and `123n` bigints), strings, `#t` / `#f`, `#null` and `#void` (undefined); `'x` is
// (%quote x), `%[f x ...]` a call, (%call f x ...), or of an intrinsic, (%intcall %name x ...). `;` comments out the rest
// of a line, `#| ... |#` what it encloses (nested too), and `#;` the next form. Every list keeps where it was read (SOURCE_POS). A front end's meaning for quoted data comes from
// `datum`, called on what each (%quote x) quotes
import { CORE_BEGIN, CORE_CALL, CORE_INTCALL, CORE_QUOTE, SOURCE_POS, formatPos, type SourcePos } from "../common";
import { isCoreForm } from "../magicvm/core";

export type NativeReadOptions = { datum?: (x: any) => any };

export class NativeReadError extends Error {
    constructor(readonly what: string, readonly at: SourcePos) {
        super(`read: ${what} at ${formatPos(at)}`);
        this.name = "NativeReadError";
    }
}

const OPEN = 40, CLOSE = 41, OPEN_BRACKET = 91, CLOSE_BRACKET = 93, QUOTE = 34, SEMI = 59, NL = 10, BACKSLASH = 92, APOSTROPHE = 39, PERCENT = 37, HASH = 35, BAR = 124;
const isSpace = (c: number) => c === 32 || c === 9 || c === NL || c === 13 || c === 12;
const isDelimiter = (c: number) => isSpace(c) || c === OPEN || c === CLOSE || c === OPEN_BRACKET || c === CLOSE_BRACKET || c === QUOTE || c === SEMI;
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const BIGINT = /^[+-]?\d+n$/;
const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0", '"': '"', "\\": "\\" };
const LITERALS: Record<string, any> = { "#t": true, "#f": false, "#null": null, "#void": undefined };

// the forms in `src`: one is itself, several a %begin of them
export const readNative = (src: string, file: string = "<native>", options: NativeReadOptions = {}): any => {
    const datum = options.datum;
    let i = 0, line = 1, lineStart = 0;
    const here = (): SourcePos => ({ file, line, col: i - lineStart + 1 });
    const fail = (what: string, at: SourcePos): never => {
        throw new NativeReadError(what, at);
    };

    const skip = () => {
        while (i < src.length) {
            const c = src.charCodeAt(i);
            if (c === SEMI) {
                while (i < src.length && src.charCodeAt(i) !== NL) i++;
            } else if (c === HASH && src.charCodeAt(i + 1) === BAR) {
                const at = here();
                i += 2;
                for (let depth = 1; depth > 0;) {
                    if (i >= src.length) fail("unclosed #| comment", at);
                    const d = src.charCodeAt(i);
                    if (d === HASH && src.charCodeAt(i + 1) === BAR) {
                        depth++;
                        i += 2;
                    } else if (d === BAR && src.charCodeAt(i + 1) === HASH) {
                        depth--;
                        i += 2;
                    } else {
                        if (d === NL) {
                            line++;
                            lineStart = i + 1;
                        }
                        i++;
                    }
                }
            } else if (c === HASH && src.charCodeAt(i + 1) === SEMI) {
                const at = here();
                i += 2;
                skip();
                if (i >= src.length) fail("nothing after #;", at);
                form();
            } else if (isSpace(c)) {
                if (c === NL) {
                    line++;
                    lineStart = i + 1;
                }
                i++;
            } else {
                return;
            }
        }
    };

    const string = (at: SourcePos): string => {
        let out = "";
        let from = ++i;
        for (;;) {
            if (i >= src.length) fail("unclosed string", at);
            const c = src.charCodeAt(i);
            if (c === QUOTE) break;
            if (c === NL) {
                line++;
                lineStart = i + 1;
            }
            if (c !== BACKSLASH) {
                i++;
                continue;
            }
            out += src.slice(from, i);
            const e = src[i + 1];
            if (e === "u" && src[i + 2] === "{") {
                const end = src.indexOf("}", i + 3);
                const code = end === -1 ? NaN : parseInt(src.slice(i + 3, end), 16);
                if (!(code >= 0 && code <= 0x10ffff)) fail(`bad escape ${src.slice(i, end === -1 ? i + 3 : end + 1)} in a string`, here());
                out += String.fromCodePoint(code);
                i = end + 1;
            } else if (e !== undefined && e in ESCAPES) {
                out += ESCAPES[e];
                i += 2;
            } else {
                fail(`bad escape \\${e ?? ""} in a string`, here());
            }
            from = i;
        }
        out += src.slice(from, i++);
        return out;
    };

    const atom = (at: SourcePos): any => {
        const from = i;
        while (i < src.length && !isDelimiter(src.charCodeAt(i))) i++;
        const text = src.slice(from, i);
        if (text in LITERALS) return LITERALS[text];
        if (NUMBER.test(text)) return Number(text);
        if (BIGINT.test(text)) return BigInt(text.slice(0, -1));
        if (text.startsWith("#")) fail(`bad token ${text}`, at);
        return Symbol.for(text);
    };

    const quoted = (x: any, at: SourcePos): any[] => {
        const out = [CORE_QUOTE, datum !== undefined ? datum(x) : x];
        SOURCE_POS.set(out, at);
        return out;
    };

    // the forms up to `close`, the list having opened at `at`
    const items = (close: number, at: SourcePos): any[] => {
        const out: any[] = [];
        for (;;) {
            skip();
            if (i >= src.length) fail("unclosed list", at);
            const c = src.charCodeAt(i);
            if (c === close) break;
            if (c === CLOSE || c === CLOSE_BRACKET) fail(`${String.fromCharCode(c)} closes a list opened with ${close === CLOSE ? "(" : "["}`, here());
            out.push(form());
        }
        i++;
        return out;
    };

    const form = (): any => {
        const at = here();
        const c = src.charCodeAt(i);
        if (c === QUOTE) return string(at);
        if (c === CLOSE || c === CLOSE_BRACKET) fail(`unexpected ${String.fromCharCode(c)}`, at);
        if (c === APOSTROPHE) {
            i++;
            skip();
            if (i >= src.length) fail("nothing after '", at);
            return quoted(form(), at);
        }
        if (c === PERCENT && src.charCodeAt(i + 1) === OPEN_BRACKET) {
            i += 2;
            const call = items(CLOSE_BRACKET, at);
            const head = call[0];
            if (call.length === 0) fail("%[] calls nothing", at);
            if (typeof head === "symbol" && isCoreForm(head)) fail(`%[ calls procedures and intrinsics; ${head.description} is a core form`, at);
            const out = typeof head === "symbol" && head.description!.charCodeAt(0) === PERCENT ? [CORE_INTCALL, ...call] : [CORE_CALL, ...call];
            SOURCE_POS.set(out, at);
            return out;
        }
        if (c !== OPEN && c !== OPEN_BRACKET) return atom(at);
        i++;
        const list = items(c === OPEN ? CLOSE : CLOSE_BRACKET, at);
        if (list[0] === CORE_QUOTE && list.length === 2) return quoted(list[1], at);
        SOURCE_POS.set(list, at);
        return list;
    };

    const forms: any[] = [];
    for (skip(); i < src.length; skip()) forms.push(form());
    return forms.length === 1 ? forms[0] : [CORE_BEGIN, ...forms];
};
