// Luau's tokens (see Luau's Lexer.h). Positions are 0-based lines and columns (UTF-16 code units), plus the offset
export type Pos = { readonly line: number, readonly column: number, readonly offset: number };

// where each line of a source starts, to turn offsets into lines and columns when asked
export class Lines {
    readonly #starts: number[] = [0];

    constructor(source: string) {
        for (let i = source.indexOf("\n"); i !== -1; i = source.indexOf("\n", i + 1)) this.#starts.push(i + 1);
    }

    line(offset: number): number {
        const starts = this.#starts;
        let lo = 0, hi = starts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (starts[mid] <= offset) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    column(offset: number, line: number): number {
        return offset - this.#starts[line];
    }

    pos(offset: number): Pos {
        const line = this.line(offset);
        return { line, column: offset - this.#starts[line], offset };
    }
}

export const RESERVED = [
    "and", "break", "do", "else", "elseif", "end", "false", "for", "function", "if", "in",
    "local", "nil", "not", "or", "repeat", "return", "then", "true", "until", "while",
] as const;
// a token's kind; the reserved words are And to While, in RESERVED's order
export enum Tok {
    Eof, Name, Number,
    // a quoted string; `text` is what is between the quotes, still escaped
    String,
    // a long string [==[ ... ]==]; `text` is what is inside the brackets
    RawString,
    // the parts of an interpolated string: `text{`, }text{, }text`, and one with nothing interpolated
    InterpBegin, InterpMid, InterpEnd, InterpSimple,
    Comment, BlockComment,
    // @name (`text` the name, "" if missing) and @[
    Attribute, AttributeOpen,
    BrokenString, BrokenComment, BrokenUnicode, BrokenInterpDoubleBrace,
    // any other character: `text` is it
    Char,
    And, Break, Do, Else, ElseIf, End, False, For, Function, If, In, Local,
    Nil, Not, Or, Repeat, Return, Then, True, Until, While,
    LParen, RParen, LBracket, RBracket, LBrace, RBrace, Semicolon, Comma, Hash, Question, Amp, Pipe,
    Plus, Minus, Star, Slash, Percent, Caret, Assign, Lt, Gt, Dot, Colon, Tilde,
    Eq, Le, Ge, Ne, Concat, Dots, Arrow, DoubleColon, FloorDiv, PlusAssign, MinusAssign, StarAssign,
    SlashAssign, FloorDivAssign, PercentAssign, CaretAssign, ConcatAssign,
}

export const isReserved = (k: Tok): boolean => k >= Tok.And && k <= Tok.While;

// how each kind is written (its word or punctuation), indexed by kind
export const TOK_TEXT: readonly string[] = [
    "eof", "name", "number", "string", "rawString", "interpBegin", "interpMid", "interpEnd", "interpSimple", "comment",
    "blockComment", "attribute", "attributeOpen", "brokenString", "brokenComment", "brokenUnicode",
    "brokenInterpDoubleBrace", "char", "and", "break", "do", "else", "elseif", "end", "false", "for", "function", "if",
    "in", "local", "nil", "not", "or", "repeat", "return", "then", "true", "until", "while", "(", ")", "[", "]", "{",
    "}", ";", ",", "#", "?", "&", "|", "+", "-", "*", "/", "%", "^", "=", "<", ">", ".", ":", "~", "==", "<=", ">=",
    "~=", "..", "...", "->", "::", "//", "+=", "-=", "*=", "/=", "//=", "%=", "^=", "..=",
];

// what messages need of a token
export type Described = { readonly kind: Tok, readonly text: string, readonly codepoint?: number };

// how Luau names a token in its messages
export const describe = (t: Described): string => {
    switch (t.kind) {
        case Tok.Eof: return "<eof>";
        case Tok.String: case Tok.RawString: return `"${t.text}"`;
        case Tok.InterpBegin: return `\`${t.text}{`;
        case Tok.InterpMid: return `}${t.text}{`;
        case Tok.InterpEnd: return `}${t.text}\``;
        case Tok.InterpSimple: return `\`${t.text}\``;
        case Tok.Number: case Tok.Name: return `'${t.text}'`;
        case Tok.Comment: case Tok.BlockComment: return "comment";
        case Tok.Attribute: return `'${t.text}'`;
        case Tok.AttributeOpen: return "'@['";
        case Tok.BrokenString: return "malformed string";
        case Tok.BrokenComment: return "unfinished comment";
        case Tok.BrokenInterpDoubleBrace: return "'{{', which is invalid (did you mean '\\{'?)";
        case Tok.BrokenUnicode: return t.codepoint !== undefined ? `Unicode character U+${t.codepoint.toString(16)}` : "invalid UTF-8 sequence";
        case Tok.Char: return `'${t.text}'`;
        default: return `'${TOK_TEXT[t.kind]}'`;
    }
};

// how Luau names an expected token kind
export const describeKind = (kind: Tok): string => {
    switch (kind) {
        case Tok.Eof: return "<eof>";
        case Tok.Name: return "identifier";
        case Tok.String: case Tok.RawString: return "string";
        case Tok.Number: return "number";
        case Tok.AttributeOpen: return "'@['";
        default: return `'${TOK_TEXT[kind]}'`;
    }
};
