// Core text: the core forms (see README.md) written as s-expressions, read straight into the arrays the compiler takes.
// It names VM values only: `( ... )` an array, a name a symbol, numbers (and `123n` bigints), strings, `#t` / `#f`,
// `#null` and `#void` (undefined). `;` starts a comment. Every list keeps where it was read (SOURCE_POS). A front end's
// meaning for quoted data comes from `datum`, called on what each (%quote x) quotes
import { CORE_BEGIN, CORE_QUOTE, Msg, SOURCE_POS, VMError, type SourcePos } from "../common";

export type CoreReadOptions = { datum?: (x: any) => any };

const OPEN = 40, CLOSE = 41, QUOTE = 34, SEMI = 59, NL = 10, BACKSLASH = 92;
const isSpace = (c: number) => c === 32 || c === 9 || c === NL || c === 13 || c === 12;
const isDelimiter = (c: number) => isSpace(c) || c === OPEN || c === CLOSE || c === QUOTE || c === SEMI;
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const BIGINT = /^[+-]?\d+n$/;
const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0", '"': '"', "\\": "\\" };
const LITERALS: Record<string, any> = { "#t": true, "#f": false, "#null": null, "#void": undefined };

// the forms in `src`: one is itself, several a %begin of them
export const readCore = (src: string, file: string = "<core>", options: CoreReadOptions = {}): any => {
    const datum = options.datum;
    let i = 0, line = 1, lineStart = 0;
    const here = (): SourcePos => ({ file, line, col: i - lineStart + 1 });
    const fail = (op: Msg, args: any[], at: SourcePos): never => {
        const err = new VMError(op, args);
        err.at = at;
        throw err;
    };

    const skip = () => {
        while (i < src.length) {
            const c = src.charCodeAt(i);
            if (c === SEMI) {
                while (i < src.length && src.charCodeAt(i) !== NL) i++;
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
            if (i >= src.length) fail(Msg.ReadUnclosed, ["string"], at);
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
                if (!(code >= 0 && code <= 0x10ffff)) fail(Msg.ReadBadEscape, [src.slice(i, end === -1 ? i + 3 : end + 1)], here());
                out += String.fromCodePoint(code);
                i = end + 1;
            } else if (e !== undefined && e in ESCAPES) {
                out += ESCAPES[e];
                i += 2;
            } else {
                fail(Msg.ReadBadEscape, [`\\${e ?? ""}`], here());
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
        if (text.startsWith("#")) fail(Msg.ReadBadToken, [text], at);
        return Symbol.for(text);
    };

    const form = (): any => {
        const at = here();
        const c = src.charCodeAt(i);
        if (c === QUOTE) return string(at);
        if (c === CLOSE) fail(Msg.ReadUnexpected, [")"], at);
        if (c !== OPEN) return atom(at);
        i++;
        const items: any[] = [];
        for (;;) {
            skip();
            if (i >= src.length) fail(Msg.ReadUnclosed, ["list"], at);
            if (src.charCodeAt(i) === CLOSE) break;
            items.push(form());
        }
        i++;
        const out = datum !== undefined && items[0] === CORE_QUOTE && items.length === 2 ? [CORE_QUOTE, datum(items[1])] : items;
        SOURCE_POS.set(out, at);
        return out;
    };

    const forms: any[] = [];
    for (skip(); i < src.length; skip()) forms.push(form());
    return forms.length === 1 ? forms[0] : [CORE_BEGIN, ...forms];
};
