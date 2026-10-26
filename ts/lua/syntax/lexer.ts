// Luau's lexer (after Luau's Lexer.cpp), as a cursor: the current token is the lexer's own fields, so reading a token
// makes no objects. Names are interned (each one sliced once per source, keywords found by the same lookup), comments are
// skipped here (and collected only when asked), and plain decimal numbers are valued as they are read. Interpolated strings
// keep a stack of what each open brace is, so a `}` knows whether it closes a table or goes back into the string
import { Lines, RESERVED, Tok } from "./tokens";
import type { Comment, HotComment } from "./ast";

const ALPHA = 1, DIGIT = 2, SPACE = 4;
const CLASS = new Uint8Array(128);
for (let c = 97; c <= 122; c++) CLASS[c] = CLASS[c - 32] = ALPHA;
CLASS[95] = ALPHA;
for (let c = 48; c <= 57; c++) CLASS[c] = DIGIT;
for (const c of [32, 9, 13, 10, 11, 12]) CLASS[c] = SPACE;

const isAlpha = (c: number) => c < 128 && (CLASS[c] & ALPHA) !== 0 && c !== 95;
const isDigit = (c: number) => c >= 48 && c <= 57;
const isHex = (c: number) => isDigit(c) || ((c | 32) >= 97 && (c | 32) <= 102);
const isSpace = (c: number) => c < 128 && CLASS[c] === SPACE;
const isIdent = (c: number) => c < 128 && (CLASS[c] & (ALPHA | DIGIT)) !== 0;
const NEWLINE = 10;
const FNV_OFFSET = 0x811c9dc5, FNV_PRIME = 0x01000193;

const enum Brace { Normal, Interpolated }

export type LexerOptions = {
    // every comment
    comments?: Comment[] | null,
    // comments starting with !
    hotComments?: HotComment[] | null,
};

export class Lexer {
    readonly lines: Lines;
    // the current token: its kind and span; `text` as described in Tok ("" for a number `value` holds); `value` a
    // plain decimal number's value, else NaN
    kind = Tok.Eof;
    from = 0;
    to = 0;
    text = "";
    value = NaN;
    quote: "'" | "\"" | undefined = undefined;
    depth = 0;
    codepoint: number | undefined = undefined;
    // hot comments before the first token are the file's header
    hotHeader = true;

    #offset = 0;
    #braces: Brace[] = [];
    readonly #comments: Comment[] | null;
    readonly #hotComments: HotComment[] | null;
    // the interned names: open addressing on the name's hash
    #names: (string | undefined)[] = new Array(256);
    #hashes = new Int32Array(256);
    #nameKinds = new Uint8Array(256);
    #nameCount = 0;

    constructor(readonly source: string, options: LexerOptions = {}) {
        this.lines = new Lines(source);
        this.#comments = options.comments ?? null;
        this.#hotComments = options.hotComments ?? null;
        RESERVED.forEach((k, i) => {
            let h = FNV_OFFSET;
            for (let i = 0; i < k.length; i++) h = Math.imul(h ^ k.charCodeAt(i), FNV_PRIME);
            this.#insert(k, h, Tok.And + i);
        });
    }

    // the current token's text, sliced for a number that was valued instead
    get tokenText(): string {
        return this.kind === Tok.Number && this.text === "" ? this.source.slice(this.from, this.to) : this.text;
    }

    // to the next token that is not a comment (an unfinished comment is one: the parser reports it)
    next(): void {
        this.#scan(true);
    }

    // the next token that is not a comment, without moving to it. The brace stack changes by one at most, so only its
    // length and top are kept (as Luau's lexer does)
    lookahead(): { kind: Tok, from: number, to: number } {
        const { kind, from, to, text, value, quote, depth, codepoint } = this;
        const offset = this.#offset;
        const braces = this.#braces.length;
        const top = braces > 0 ? this.#braces[braces - 1] : Brace.Normal;
        this.#scan(false);
        const ahead = { kind: this.kind, from: this.from, to: this.to };
        this.kind = kind; this.from = from; this.to = to; this.text = text; this.value = value; this.quote = quote; this.depth = depth; this.codepoint = codepoint;
        this.#offset = offset;
        if (this.#braces.length < braces) this.#braces.push(top);
        else if (this.#braces.length > braces) this.#braces.pop();
        return ahead;
    }

    // whether an interpolated string is open around the current position
    get inInterpolation(): boolean | null {
        return this.#braces.length === 0 ? null : this.#braces[this.#braces.length - 1] === Brace.Interpolated;
    }

    #scan(collect: boolean): void {
        const src = this.source;
        while (true) {
            while (this.#offset < src.length && isSpace(src.charCodeAt(this.#offset))) this.#offset++;
            if (src.charCodeAt(this.#offset) !== 45 || src.charCodeAt(this.#offset + 1) !== 45) break;
            this.#comment(this.#offset);
            if (this.kind === Tok.BrokenComment) {
                if (collect && this.#comments !== null) this.#comments.push({ kind: "brokenComment", from: this.from, to: this.to });
                return;
            }
            if (collect) this.#collect();
        }
        this.#read();
    }

    #collect(): void {
        if (this.#comments !== null) this.#comments.push({ kind: this.kind === Tok.Comment ? "comment" : "blockComment", from: this.from, to: this.to });
        if (this.#hotComments !== null && this.kind === Tok.Comment && this.source.charCodeAt(this.from + 2) === 33) {
            this.#hotComments.push({ header: this.hotHeader, from: this.from, to: this.to, content: this.text.slice(1).replace(/[ \t\r\n\v\f]+$/, "") });
        }
    }

    #set(kind: Tok, start: number, text: string = ""): void {
        this.kind = kind;
        this.from = start;
        this.to = this.#offset;
        this.text = text;
        this.value = NaN;
        this.quote = undefined;
        this.codepoint = undefined;
    }

    #peek(ahead: number = 0): number {
        const i = this.#offset + ahead;
        return i < this.source.length ? this.source.charCodeAt(i) : 0;
    }

    // `kind`, or `withEq` when an = follows
    #eq(start: number, kind: Tok, withEq: Tok): void {
        this.#offset++;
        if (this.#peek() === 61) {
            this.#offset++;
            this.#set(withEq, start);
        } else {
            this.#set(kind, start);
        }
    }

    #one(start: number, kind: Tok): void {
        this.#offset++;
        this.#set(kind, start);
    }

    #read(): void {
        const start = this.#offset;
        if (start >= this.source.length) return this.#set(Tok.Eof, start);
        const c = this.source.charCodeAt(start);
        if (c < 128 && (CLASS[c] & ALPHA) !== 0) return this.#name(start);
        switch (c) {
            case 45: // -
                if (this.#peek(1) === 62) { this.#offset += 2; return this.#set(Tok.Arrow, start); }
                if (this.#peek(1) === 61) { this.#offset += 2; return this.#set(Tok.MinusAssign, start); }
                return this.#one(start, Tok.Minus);
            case 91: { // [
                const sep = this.#longSeparator();
                if (sep >= 0) return this.#longString(start, sep, Tok.RawString, Tok.BrokenString);
                return this.#set(sep === -1 ? Tok.LBracket : Tok.BrokenString, start);
            }
            case 123: // {
                this.#offset++;
                if (this.#braces.length > 0) this.#braces.push(Brace.Normal);
                return this.#set(Tok.LBrace, start);
            case 125: { // }
                this.#offset++;
                if (this.#braces.length === 0) return this.#set(Tok.RBrace, start);
                const top = this.#braces.pop()!;
                if (top !== Brace.Interpolated) return this.#set(Tok.RBrace, start);
                return this.#interpSection(start, Tok.InterpMid, Tok.InterpEnd);
            }
            case 61: return this.#eq(start, Tok.Assign, Tok.Eq);
            case 60: return this.#eq(start, Tok.Lt, Tok.Le);
            case 62: return this.#eq(start, Tok.Gt, Tok.Ge);
            case 126: return this.#eq(start, Tok.Tilde, Tok.Ne);
            case 34: case 39: return this.#quoted(start);
            case 96: // `
                this.#offset++;
                return this.#interpSection(start, Tok.InterpBegin, Tok.InterpSimple);
            case 46: // .
                this.#offset++;
                if (this.#peek() === 46) {
                    this.#offset++;
                    if (this.#peek() === 46) { this.#offset++; return this.#set(Tok.Dots, start); }
                    if (this.#peek() === 61) { this.#offset++; return this.#set(Tok.ConcatAssign, start); }
                    return this.#set(Tok.Concat, start);
                }
                if (isDigit(this.#peek())) return this.#number(start);
                return this.#set(Tok.Dot, start);
            case 43: return this.#eq(start, Tok.Plus, Tok.PlusAssign);
            case 47: // /
                this.#offset++;
                if (this.#peek() === 61) { this.#offset++; return this.#set(Tok.SlashAssign, start); }
                if (this.#peek() === 47) {
                    this.#offset++;
                    if (this.#peek() === 61) { this.#offset++; return this.#set(Tok.FloorDivAssign, start); }
                    return this.#set(Tok.FloorDiv, start);
                }
                return this.#set(Tok.Slash, start);
            case 42: return this.#eq(start, Tok.Star, Tok.StarAssign);
            case 37: return this.#eq(start, Tok.Percent, Tok.PercentAssign);
            case 94: return this.#eq(start, Tok.Caret, Tok.CaretAssign);
            case 58: // :
                this.#offset++;
                if (this.#peek() === 58) { this.#offset++; return this.#set(Tok.DoubleColon, start); }
                return this.#set(Tok.Colon, start);
            case 40: return this.#one(start, Tok.LParen);
            case 41: return this.#one(start, Tok.RParen);
            case 93: return this.#one(start, Tok.RBracket);
            case 59: return this.#one(start, Tok.Semicolon);
            case 44: return this.#one(start, Tok.Comma);
            case 35: return this.#one(start, Tok.Hash);
            case 63: return this.#one(start, Tok.Question);
            case 38: return this.#one(start, Tok.Amp);
            case 124: return this.#one(start, Tok.Pipe);
            case 64: { // @
                if (this.#peek(1) === 91) { this.#offset += 2; return this.#set(Tok.AttributeOpen, start); }
                this.#offset++;
                const at = this.#offset;
                if (isAlpha(this.#peek()) || this.#peek() === 95) {
                    while (isIdent(this.#peek())) this.#offset++;
                }
                return this.#set(Tok.Attribute, start, this.source.slice(at, this.#offset));
            }
        }
        if (isDigit(c)) return this.#number(start);
        if (c >= 0x80) {
            const cp = this.source.codePointAt(start)!;
            this.#offset += cp > 0xffff ? 2 : 1;
            this.#set(Tok.BrokenUnicode, start);
            this.codepoint = cp;
            return;
        }
        this.#offset++;
        this.#set(Tok.Char, start, String.fromCharCode(c));
    }

    // a name, interned: an occurrence of one seen before gives the same string, found without slicing
    #name(start: number): void {
        const src = this.source;
        let i = start, h = FNV_OFFSET;
        for (let c = src.charCodeAt(i); isIdent(c); c = src.charCodeAt(++i)) h = Math.imul(h ^ c, FNV_PRIME);
        this.#offset = i;
        const len = i - start;
        const mask = this.#names.length - 1;
        for (let slot = h & mask; ; slot = (slot + 1) & mask) {
            const name = this.#names[slot];
            if (name === undefined) break;
            if (this.#hashes[slot] === h && name.length === len && src.startsWith(name, start)) return this.#set(this.#nameKinds[slot], start, name);
        }
        const name = src.slice(start, i);
        this.#insert(name, h, Tok.Name);
        this.#set(Tok.Name, start, name);
    }

    #insert(name: string, h: number, kind: Tok): void {
        if ((this.#nameCount + 1) * 2 > this.#names.length) this.#grow();
        const mask = this.#names.length - 1;
        let slot = h & mask;
        while (this.#names[slot] !== undefined) slot = (slot + 1) & mask;
        this.#names[slot] = name;
        this.#hashes[slot] = h;
        this.#nameKinds[slot] = kind;
        this.#nameCount++;
    }

    #grow(): void {
        const names = this.#names, hashes = this.#hashes, kinds = this.#nameKinds;
        this.#names = new Array(names.length * 2);
        this.#hashes = new Int32Array(names.length * 2);
        this.#nameKinds = new Uint8Array(names.length * 2);
        this.#nameCount = 0;
        for (let i = 0; i < names.length; i++) if (names[i] !== undefined) this.#insert(names[i]!, hashes[i], kinds[i]);
    }

    // a number-like run, as Lua's lexer skips it; the parser checks it. A run of at most 15 digits is valued here
    #number(start: number): void {
        const src = this.source;
        let value = 0, simple = true;
        let i = start;
        for (let c = src.charCodeAt(i); ; c = src.charCodeAt(++i)) {
            if (isDigit(c)) value = value * 10 + (c - 48);
            else if (c === 46 || c === 95) simple = false;
            else break;
        }
        if ((src.charCodeAt(i) | 32) === 101) {
            simple = false;
            i++;
            if (src.charCodeAt(i) === 43 || src.charCodeAt(i) === 45) i++;
        }
        while (isIdent(src.charCodeAt(i))) { simple = false; i++; }
        this.#offset = i;
        if (simple && i - start <= 15) {
            this.#set(Tok.Number, start);
            this.value = value;
        } else {
            this.#set(Tok.Number, start, src.slice(start, i));
        }
    }

    // after [ or ]: the number of = before the matching bracket, -1 if there is no second bracket, -N-1 if malformed.
    // Leaves the second bracket unconsumed
    #longSeparator(): number {
        const open = this.#peek();
        this.#offset++;
        let count = 0;
        while (this.#peek() === 61) { this.#offset++; count++; }
        return this.#peek() === open ? count : -count - 1;
    }

    #longString(start: number, sep: number, ok: Tok, broken: Tok): void {
        this.#offset++;
        const from = this.#offset;
        const src = this.source;
        while (this.#offset < src.length) {
            const close = src.indexOf("]", this.#offset);
            if (close === -1) break;
            this.#offset = close;
            if (this.#longSeparator() === sep) {
                this.#offset++;
                this.#set(ok, start, src.slice(from, close));
                this.depth = sep;
                return;
            }
        }
        this.#offset = src.length;
        this.#set(broken, start);
    }

    #comment(start: number): void {
        this.#offset += 2;
        if (this.#peek() === 91) {
            const sep = this.#longSeparator();
            if (sep >= 0) return this.#longString(start, sep, Tok.BlockComment, Tok.BrokenComment);
            this.#offset = start + 2;
        }
        const from = this.#offset;
        const src = this.source;
        let end = from;
        for (let c = src.charCodeAt(end); end < src.length && c !== 10 && c !== 13; c = src.charCodeAt(++end));
        this.#offset = end;
        this.#set(Tok.Comment, start, src.slice(from, end));
    }

    #backslash(): void {
        this.#offset++;
        switch (this.#peek()) {
            case 13:
                this.#offset++;
                if (this.#peek() === NEWLINE) this.#offset++;
                return;
            case 0:
                if (this.#offset < this.source.length) this.#offset++;
                return;
            case 122: // z
                this.#offset++;
                while (this.#offset < this.source.length && isSpace(this.#peek())) this.#offset++;
                return;
            default:
                this.#offset++;
        }
    }

    #quoted(start: number): void {
        const src = this.source;
        const quote = src.charCodeAt(start);
        let i = start + 1;
        const from = i;
        while (true) {
            if (i >= src.length) { this.#offset = i; return this.#set(Tok.BrokenString, start); }
            const c = src.charCodeAt(i);
            if (c === quote) break;
            if (c === 13 || c === NEWLINE) { this.#offset = i; return this.#set(Tok.BrokenString, start); }
            if (c === 92) {
                this.#offset = i;
                this.#backslash();
                i = this.#offset;
            } else {
                i++;
            }
        }
        this.#offset = i + 1;
        this.#set(Tok.String, start, src.slice(from, i));
        this.quote = quote === 34 ? "\"" : "'";
    }

    #interpSection(start: number, open: Tok, end: Tok): void {
        const from = this.#offset;
        while (this.#peek() !== 96 || this.#offset >= this.source.length) {
            if (this.#offset >= this.source.length) return this.#set(Tok.BrokenString, start);
            const c = this.#peek();
            if (c === 13 || c === NEWLINE) return this.#set(Tok.BrokenString, start);
            if (c === 92) {
                // \u{...} would otherwise be taken for an interpolation
                if (this.#peek(1) === 117 && this.#peek(2) === 123) this.#offset += 3;
                else this.#backslash();
                continue;
            }
            if (c === 123) {
                this.#braces.push(Brace.Interpolated);
                const text = this.source.slice(from, this.#offset);
                if (this.#peek(1) === 123) {
                    this.#offset += 2;
                    return this.#set(Tok.BrokenInterpDoubleBrace, start, text);
                }
                this.#offset++;
                return this.#set(open, start, text);
            }
            this.#offset++;
        }
        const text = this.source.slice(from, this.#offset);
        this.#offset++;
        this.#set(end, start, text);
    }
}

// A quoted string's value from its escaped text, or null if an escape is malformed. Strings are Lua's byte strings: the
// value has one char per byte (0-255), with characters outside ASCII in the source encoded as UTF-8
export const unescapeQuoted = (text: string): string | null => {
    if (isPlain(text, true)) return text;
    let out = "";
    for (let i = 0; i < text.length;) {
        const c = text.charCodeAt(i);
        if (c !== 92) {
            out += utf8Bytes(text, i);
            i += c >= 0xd800 && c <= 0xdbff ? unitsAt(text, i) : 1;
            continue;
        }
        if (i + 1 >= text.length) return null;
        const e = text.charCodeAt(i + 1);
        i += 2;
        switch (e) {
            case NEWLINE: out += "\n"; break;
            case 13:
                out += "\n";
                if (text.charCodeAt(i) === NEWLINE) i++;
                break;
            case 120: { // x
                if (i + 2 > text.length || !isHex(text.charCodeAt(i)) || !isHex(text.charCodeAt(i + 1))) return null;
                out += String.fromCharCode(parseInt(text.slice(i, i + 2), 16));
                i += 2;
                break;
            }
            case 122: // z
                while (i < text.length && isSpace(text.charCodeAt(i))) i++;
                break;
            case 117: { // u
                if (text.charCodeAt(i) !== 123 || text.charCodeAt(i + 1) === 125) return null;
                i++;
                let code = 0, digits = 0;
                while (i < text.length && text.charCodeAt(i) !== 125 && digits < 16) {
                    if (!isHex(text.charCodeAt(i))) return null;
                    code = code * 16 + parseInt(text[i], 16);
                    i++;
                    digits++;
                }
                if (text.charCodeAt(i) !== 125 || code >= 0x110000) return null;
                i++;
                out += utf8Encode(code);
                break;
            }
            default:
                if (isDigit(e)) {
                    let code = e - 48;
                    for (let j = 0; j < 2 && i < text.length && isDigit(text.charCodeAt(i)); j++, i++) code = code * 10 + text.charCodeAt(i) - 48;
                    if (code > 255) return null;
                    out += String.fromCharCode(code);
                } else {
                    out += ESCAPES[String.fromCharCode(e)] ?? utf8Bytes(text, i - 1);
                }
        }
    }
    return out;
};

// a long string's value: its first newline dropped, \r\n made \n
export const unescapeLong = (text: string): string => {
    let s = text.startsWith("\r\n") ? text.slice(2) : text.startsWith("\n") ? text.slice(1) : text;
    if (s.indexOf("\r") !== -1) s = s.replace(/\r\n/g, "\n");
    if (isPlain(s, false)) return s;
    let out = "";
    for (let i = 0; i < s.length;) {
        const c = s.charCodeAt(i);
        out += c < 0x80 ? s[i] : utf8Bytes(s, i);
        i += c >= 0xd800 && c <= 0xdbff ? unitsAt(s, i) : 1;
    }
    return out;
};

// whether text is all ASCII (and, with `escapes`, has no backslash), so is its own byte string
const isPlain = (text: string, escapes: boolean): boolean => {
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c >= 0x80 || (escapes && c === 92)) return false;
    }
    return true;
};

const ESCAPES: Record<string, string> = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };

const utf8Encode = (cp: number): string => {
    if (cp < 0x80) return String.fromCharCode(cp);
    if (cp < 0x800) return String.fromCharCode(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    if (cp < 0x10000) return String.fromCharCode(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    return String.fromCharCode(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
};

// the UTF-16 units of the code point at i: 2 for a surrogate pair, 1 for anything else (a lone surrogate included)
const unitsAt = (s: string, i: number): number => s.codePointAt(i)! > 0xffff ? 2 : 1;

const utf8Bytes = (s: string, i: number): string => {
    const c = s.charCodeAt(i);
    return c < 0x80 ? s[i] : utf8Encode(s.codePointAt(i)!);
};
