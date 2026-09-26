import { SOURCE_POS, type SourcePos } from "../common";
import { OP_BEGIN, OP_QUOTE } from "./symbols";
import { Cons } from "../list";

export class ASPTokenError extends Error {
    pos: number;
    curtok?: string;
    constructor(message: string, pos: number, curtok?: string) {
        super(message);
        this.name = 'ASPTokenError';
        this.pos = pos
        this.curtok = curtok
    }
}

export class ASPParseError extends Error {
    pos?: number;
    curtok?: string;
    constructor(message: string, pos?: number, curtok?: string) {
        super(message);
        this.name = 'ASPParseError';
        this.pos = pos
        this.curtok = curtok
    }
}

const STRING_ESCAPES: Record<string, string> = {
    'n': "\n", 't': "\t", 'r': "\r", 'b': "\b", 'f': "\f", 'v': "\v", '0': "\0", 'a': "\x07",
    '"': '"', '\\': '\\', '/': '/',
}

// raw characters (including control characters like literal newlines and tabs) are kept as-is
const unescapeString = (body: string): string => {
    let out = ""
    for (let i = 0; i < body.length; i++) {
        const ch = body[i]
        if (ch !== '\\') {
            out += ch
            continue
        }
        const esc = body[++i]
        if (esc === 'u') {
            const hex = body.slice(i + 1, i + 5)
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad \\u escape '\\u${hex}'`)
            out += String.fromCharCode(parseInt(hex, 16))
            i += 4
        } else if (esc === 'x') {
            const end = body.indexOf(';', i)
            const hex = end === -1 ? "" : body.slice(i + 1, end)
            if (!/^[0-9a-fA-F]{1,6}$/.test(hex)) throw new Error(`bad \\x escape, expected \\x<hex>;`)
            out += String.fromCodePoint(parseInt(hex, 16))
            i = end
        } else if (esc !== undefined && esc in STRING_ESCAPES) {
            out += STRING_ESCAPES[esc]
        } else {
            throw new Error(`unknown escape '\\${esc ?? ""}'`)
        }
    }
    return out
}

const ASP_SPECIAL_TOKENS = new Set(['(', ')', '[', ']', '{', '}', ';', '"', "'"])
const ASP_CLOSING_TOKENS = new Set([')', ']', '}'])

export class ASP {    
    #str: string;
    #currPos: number;
    #supportsDottedPairs: boolean = false // only bytecode compiler supports these, AST interpreter does not
    #file: string
    #tokenOffsets: number[] = []
    constructor(str: string, supportsDottedPairs: boolean = false, file: string = "<input>") {
        this.#str = str
        this.#currPos = 0
        this.#supportsDottedPairs = supportsDottedPairs
        this.#file = file
    }

    #lineStarts: number[] | null = null

    #posAt(offset: number): SourcePos {
        if (this.#lineStarts === null) {
            this.#lineStarts = [0]
            for (let i = 0; i < this.#str.length; i++) {
                if (this.#str.charCodeAt(i) === 10) this.#lineStarts.push(i + 1)
            }
        }
        const starts = this.#lineStarts
        let lo = 0, hi = starts.length - 1
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1
            if (starts[mid] <= offset) lo = mid
            else hi = mid - 1
        }
        return { file: this.#file, line: lo + 1, col: offset - starts[lo] + 1 }
    }

    /** Look at the current character without moving forward */
    private peek(): string {
        return this.#str[this.#currPos] || "";
    }

    /** Consume the current character and move forward */
    private advance(): string {
        return this.#str[this.#currPos++] || "";
    }

    /** are we done yet? */
    private isEOF(): boolean {
        return this.#currPos >= this.#str.length;
    }

    /** skip over trivia (like whitespace,comments etc.) */
    private skipTrivia(): void {
        while (!this.isEOF()) {
            const char = this.peek();
    
            // Drop whitespace
            if (/\s/.test(char)) {
                this.advance();
            } else if (char === ';') {
                // If we see a comment, consume everything until a newline
                while (!this.isEOF() && this.peek() !== '\n') {
                    this.advance();
                }
            } else {
                // We're done
                break; 
            }
        }    
    }
    
    /** Tokenize the input into a list of tokens to then parse */
    private tokenize(): string[] {
        const tokens: string[] = [];
        let start = 0;
        const push = (tok: string) => {
            tokens.push(tok);
            this.#tokenOffsets.push(start);
        };

        while (!this.isEOF()) {
            this.skipTrivia();
            if (this.isEOF()) break;
            start = this.#currPos;
            const char = this.peek();

            // Vectors: #( or #[
            if (char === '#' && (this.#str[this.#currPos + 1] === '(' || this.#str[this.#currPos + 1] === '[')) {
                this.advance(); // consume '#'
                push('#' + this.advance()); // push '#(' or '#['
                continue;
            }

            // Lists & Tables
            if (char === '(' || char === ')' || char === '[' || char === ']' || char === '{' || char === '}') {
                push(this.advance());
                continue;
            }

            // Quote/'reader' has similar behavior to lists
            if (char === "'") {
                push(this.advance());
                continue;
            }

            // String literals
            if (char === '"') {
                let strToken = this.advance(); // Open "
                
                while (!this.isEOF() && this.peek() !== '"') {
                    if (this.peek() === '\\') {
                        strToken += this.advance(); // consume the slash (we will then consume the character in the general strToken advancer)
                    }
                    strToken += this.advance(); // consume the character
                }
                
                if (this.peek() === '"') {
                    strToken += this.advance(); // Consume the closing quote
                } else {
                    throw new ASPTokenError(`Unterminated string literal`, this.#currPos, strToken);
                }
                
                push(strToken);
                continue;
            }

            // All other literals (numbers, symbols, booleans etc)
            let atom = "";
            while (
                !this.isEOF() && 
                !/\s/.test(this.peek()) && 
                !ASP_SPECIAL_TOKENS.has(this.peek())
            ) {
                atom += this.advance();
            }
            push(atom);
        }

        return tokens
    }

    /** Parses tokenized string and builds the final expr */
    public parse(): any {
        const tokens = this.tokenize();
        let current = 0;

        const walk = (): any => {
            if (current >= tokens.length) {
                throw new ASPParseError(`Unexpected end of input: Missing closing bracket.`, current);
            }

            let token = tokens[current];

            const startOffset = this.#tokenOffsets[current];

            // Quote
            if (token === "'") {
                current++; // Skip the quote
                if (current >= tokens.length) {
                    throw new ASPParseError("Unexpected end of input: Missing expression after '", current);
                }
                const nextExpr = walk(); // Parse the next expr after the quote
                return Cons.list(OP_QUOTE, nextExpr);  // Wrap in quote builtin proc
            }

            // Vectors
            if (token === '#(' || token === '#[') {
                const expectedClose = token === '#(' ? ')' : ']';
                current++;
                const vec: any[] = [];
                while (tokens[current] !== expectedClose) {
                    if (current >= tokens.length || ASP_CLOSING_TOKENS.has(tokens[current])) {
                        throw new ASPParseError(`Mismatched or missing closing bracket for '${token}'`, current);
                    }
                    vec.push(walk());
                }
                current++;
                return vec;
            }

            // Lists
            if (token === '(' || token === '[') {
                const expectedClose = token === '(' ? ')' : ']';
                current++; 
                const lst: any[] = [];
                let rest: any = null;
                let isDotted = false;

                while (tokens[current] !== expectedClose) {
                    if (current >= tokens.length || ASP_CLOSING_TOKENS.has(tokens[current])) {
                        throw new ASPParseError(`Mismatched or missing closing bracket for '${token}'`, current);
                    }

                    if (this.#supportsDottedPairs && tokens[current] === '.') {
                        current++; // consume .
                        if (tokens[current] === expectedClose) {
                            throw new Error(`Syntax error: trailing '.' is not allowed`);
                        }
                        // Parse rest and make sure its the final guy
                        rest = walk();
                        if (tokens[current] !== expectedClose) {
                            throw new Error(`Syntax error: multiple expressions after '.' is not allowed`);
                        }
                        current++;
                        isDotted = true;
                        break;
                    }
                    lst.push(walk());
                }
                
                if (!isDotted) {
                    current++; 
                }

                if (lst.length === 0 && !isDotted) {
                    return null;
                }

                let tail: any = rest;
                for (let i = lst.length - 1; i >= 0; i--) {
                    tail = new Cons(lst[i], tail);
                }
                if (tail instanceof Cons) SOURCE_POS.set(tail, this.#posAt(startOffset));
                return tail;
            }

            // Tables: { key1 val1 key2 val2 ... }
            if (token === '{') {
                current++;
                const items: any[] = [];
                while (tokens[current] !== '}') {
                    if (current >= tokens.length || ASP_CLOSING_TOKENS.has(tokens[current])) {
                        throw new ASPParseError(`Mismatched or missing closing bracket for '{'`, current);
                    }
                    if (tokens[current] === '.') {
                        throw new ASPParseError(`Syntax error: '.' is not allowed in table literal`, current);
                    }
                    items.push(walk());
                }
                current++; // consume '}'
                if (items.length % 2 !== 0) {
                    throw new ASPParseError("table literal requires an even number of key-value expressions", current);
                }
                const table = Cons.list(Symbol.for("table"), ...items);
                if (table !== null) SOURCE_POS.set(table, this.#posAt(startOffset));
                return table;
            }

            // Stray closing brackets are not allowed
            if (token === ')' || token === ']' || token === '}') {
                throw new ASPParseError("Unexpected closing bracket", current, token);
            }

            // All other literals (numbers, symbols, booleans etc)
            current++; // consume current token

            // Booleans+null (which is empty list)
            if (token === '#t') return true;
            if (token === '#f') return false;
            if (token === 'null') return null;
            if (token === '<#void>') return undefined;

            // Infinities + NaN
            const lowerToken = token.toLowerCase();
            if (lowerToken === '+inf.0' || lowerToken === 'inf.0' || lowerToken === '+infinity' || lowerToken === 'infinity') return Infinity;
            if (lowerToken === '-inf.0' || lowerToken === '-infinity') return -Infinity;
            if (lowerToken === '+nan.0' || lowerToken === '-nan.0' || lowerToken === 'nan.0' || lowerToken === '+nan' || lowerToken === '-nan' || lowerToken === 'nan') return NaN;

            // Numbers
            if (token.trim() !== "") {
                const num = Number(token);
                if (!Number.isNaN(num)) return num;
            }

            // Strings must be unescaped
            if (token.startsWith('"') && token.endsWith('"')) {
                try {
                    return unescapeString(token.slice(1, -1));
                } catch (e) {
                    throw new ASPParseError(`String parse failed (${e})`, current, token)
                }
            }

            // Symbol
            return Symbol.for(token);
        };

        const exprs = []
        while (current < tokens.length) {
            exprs.push(walk());
        }
        if (exprs.length == 0) return null
        if (exprs.length == 1) return exprs[0]

        // Translate to begin
        return Cons.list(OP_BEGIN, ...exprs);
    }
}
