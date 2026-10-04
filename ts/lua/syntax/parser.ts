// Luau's parser, after Luau's Parser.cpp (function names and error messages follow it): recursive descent, expressions by
// precedence climbing, errors collected rather than thrown (with error forms in the tree), and names resolved to the
// locals they refer to as they are parsed. It makes prefix forms (see ast.ts)
import { Lexer, unescapeLong, unescapeQuoted } from "./lexer";
import { TOK_TEXT, Tok, describe, describeKind, isReserved } from "./tokens";
import { L } from "./ast";
import type * as C from "./ast";

export type ParseOptions = {
    // record every comment's location
    comments?: boolean,
    // keep going past ERROR_LIMIT errors
    noErrorLimit?: boolean,
};

const ERROR_LIMIT = 100;
const TYPE_LENGTH_LIMIT = 1000;
const ERROR_NAME = "%error-id%";

// ends parsing: the error limit, or a program nested past what the js stack takes
class Fatal {
    constructor(readonly from: number, readonly to: number, readonly message: string) {}
}

// the operator each token kind is, if any, by kind
const BINARY: (C.BinaryHead | undefined)[] = TOK_TEXT.map(() => undefined);
const COMPOUND: (C.BinaryHead | undefined)[] = TOK_TEXT.map(() => undefined);
const UNARY: (C.UnaryHead | undefined)[] = TOK_TEXT.map(() => undefined);
// a binary operator binds while its left priority is above the limit; the right one parses its right side
const LEFT = new Uint8Array(TOK_TEXT.length), RIGHT = new Uint8Array(TOK_TEXT.length);
const binary = (kind: Tok, op: C.BinaryHead, left: number, right: number, compound?: Tok) => {
    BINARY[kind] = op;
    LEFT[kind] = left;
    RIGHT[kind] = right;
    if (compound !== undefined) COMPOUND[compound] = op;
};
binary(Tok.Plus, L.ADD, 6, 6, Tok.PlusAssign);
binary(Tok.Minus, L.SUB, 6, 6, Tok.MinusAssign);
binary(Tok.Star, L.MUL, 7, 7, Tok.StarAssign);
binary(Tok.Slash, L.DIV, 7, 7, Tok.SlashAssign);
binary(Tok.FloorDiv, L.IDIV, 7, 7, Tok.FloorDivAssign);
binary(Tok.Percent, L.MOD, 7, 7, Tok.PercentAssign);
binary(Tok.Caret, L.POW, 10, 9, Tok.CaretAssign);
binary(Tok.Concat, L.CONCAT, 5, 4, Tok.ConcatAssign);
binary(Tok.Ne, L.NE, 3, 3);
binary(Tok.Eq, L.EQ, 3, 3);
binary(Tok.Lt, L.LT, 3, 3);
binary(Tok.Le, L.LE, 3, 3);
binary(Tok.Gt, L.GT, 3, 3);
binary(Tok.Ge, L.GE, 3, 3);
binary(Tok.And, L.AND, 2, 2);
binary(Tok.Or, L.OR, 1, 1);
UNARY[Tok.Not] = L.NOT;
UNARY[Tok.Minus] = L.NEG;
UNARY[Tok.Hash] = L.LEN;
const UNARY_PRIORITY = 8;

type Span = { from: number, to: number };
type Name = { name: string, from: number, to: number };
type Binding = { name: string, from: number, to: number, isConst: boolean };
// the token an expected closing token matches, for messages
type Match = { kind: Tok, from: number, to: number };
// what a type list held: how many types, whether any is named, whether a pack ends it
type TypeList = { types: number, named: boolean, tail: boolean };
type FunctionState = { vararg: boolean, loopDepth: number };
// what @deprecated's checks need of an item of the table it is given
type ItemInfo = { key: string | null, keyFrom: number, keyTo: number, value: C.Expr, valueFrom: number, valueTo: number };

const isTypeFollow = (k: Tok) => k === Tok.Pipe || k === Tok.Question || k === Tok.Amp;
// (no list starts with a head)
const isHead = (e: unknown, head: symbol): boolean => Array.isArray(e) && e[0] === head;
const isStatLast = (s: C.Stat) => s[0] === L.BREAK || s[0] === L.CONTINUE || s[0] === L.RETURN;
const isConstantLiteral = (e: C.Expr) => typeof e === "number" || typeof e === "bigint" || typeof e === "string" || typeof e === "boolean" || e === L.NIL;
const isLiteralTable = (e: C.Expr): boolean => {
    if (!isHead(e, L.TABLE)) return false;
    const t = e as C.Table;
    for (let i = 1; i < t.length - 1; i++) {
        const item = t[i] as C.Expr | C.Field | C.Pair;
        if (isHead(item, L.PAIR)) return false;
        const value = isHead(item, L.FIELD) ? (item as C.Field)[2] : item as C.Expr;
        if (!isConstantLiteral(value) && !isLiteralTable(value)) return false;
    }
    return true;
};
const ATTRIBUTES: ReadonlySet<string> = new Set(["checked", "native", "deprecated"]);
const NO_TYPES: TypeList = { types: 0, named: false, tail: false };

export const parseLuau = (source: string, options: ParseOptions = {}): C.ParseResult => new Parser(source, options).parse();

class Parser {
    readonly #lexer: Lexer;
    // the span of the previous token
    #prevFrom = 0;
    #prevTo = 0;
    // the span of the expression just parsed (forms keep only where they start)
    #exprFrom = 0;
    #exprTo = 0;
    readonly #errors: C.ParseError[] = [];
    readonly #comments: C.Comment[] = [];
    readonly #hotComments: C.HotComment[] = [];
    readonly #locals = new Map<string, C.Local>();
    readonly #localStack: C.Local[] = [];
    readonly #localNames: string[] = [];
    // what each local on the stack shadows, to restore when it goes out of scope
    readonly #shadowed: (C.Local | undefined)[] = [];
    readonly #consts = new Set<C.Local>();
    readonly #functions: FunctionState[] = [{ vararg: true, loopDepth: 0 }];
    // the locals of the type function being parsed, which may not refer to any other
    #typeFunctionLocals: Set<C.Local> | null = null;
    // of the last simple type parsed: whether it was a type pack (and one of one type), and where it starts
    #isPack = false;
    #singlePack = false;
    #typeFrom = 0;
    // set for the next table constructor to describe its items to (for attributes' arguments)
    #itemInfo: ItemInfo[] | null = null;
    // the table that last described its items
    #itemInfoOf: unknown = null;
    #endMismatchSuspect: Match;
    // tokens that stop the search for a missing closing token, with how many parsers above want them
    readonly #recoveryStop = new Map<Tok, number>([[Tok.Eof, 1]]);

    constructor(readonly source: string, readonly options: ParseOptions) {
        this.#lexer = new Lexer(source, { comments: options.comments ? this.#comments : null, hotComments: this.#hotComments });
        this.#endMismatchSuspect = { kind: Tok.Eof, from: 0, to: 0 };
        this.#lexer.next();
        this.#lexer.hotHeader = false;
    }

    parse(): C.ParseResult {
        let root: C.Block;
        try {
            root = this.#parseChunk();
        } catch (e) {
            const l = this.#lexer;
            if (e instanceof Fatal) this.#errors.push({ from: e.from, to: e.to, message: e.message });
            else if (e instanceof RangeError) this.#errors.push({ from: l.from, to: l.to, message: "Exceeded allowed recursion depth; the program is nested too deeply to parse" });
            else throw e;
            root = [L.BLOCK, l.from];
        }
        const lines = this.#lexer.lines;
        return {
            root,
            errors: this.#errors,
            lines,
            lineCount: lines.line(this.#lexer.to) + (this.source.length > 0 && !this.source.endsWith("\n") ? 1 : 0),
            hotComments: this.#hotComments,
            comments: this.#comments,
        };
    }

    // --- tokens ---

    // the current token: the lexer's own fields
    get #cur(): Lexer {
        return this.#lexer;
    }

    #describe(): string {
        const l = this.#lexer;
        return describe({ kind: l.kind, text: l.tokenText, codepoint: l.codepoint });
    }

    #take(): void {
        this.#prevFrom = this.#lexer.from;
        this.#prevTo = this.#lexer.to;
        this.#lexer.next();
    }

    #at(kind: Tok): boolean {
        return this.#lexer.kind === kind;
    }

    #match(): Match {
        return { kind: this.#lexer.kind, from: this.#lexer.from, to: this.#lexer.to };
    }

    #isName(text: string): boolean {
        return this.#lexer.kind === Tok.Name && this.#lexer.text === text;
    }

    #fn(): FunctionState {
        return this.#functions[this.#functions.length - 1];
    }

    #stop(kind: Tok, delta: number): void {
        this.#recoveryStop.set(kind, (this.#recoveryStop.get(kind) ?? 0) + delta);
    }

    // an expression, with its span
    #expr<T extends C.Expr>(e: T, from: number, to: number): T {
        this.#exprFrom = from;
        this.#exprTo = to;
        return e;
    }

    // --- errors ---

    #report(from: number, to: number, message: string): void {
        // one error per location, e.g. for 'local a = (((b + ' with several tokens missing
        const last = this.#errors[this.#errors.length - 1];
        if (last !== undefined && last.from === from && last.to === to) return;
        this.#errors.push({ from, to, message });
        if (this.#errors.length >= ERROR_LIMIT && !this.options.noErrorLimit) throw new Fatal(from, to, `Reached error limit (${ERROR_LIMIT})`);
    }

    #reportHere(message: string): void {
        this.#report(this.#lexer.from, this.#lexer.to, message);
    }

    #exprError(from: number, to: number, message: string): C.ErrorForm {
        this.#report(from, to, message);
        return this.#expr([L.ERROR, from], from, to);
    }

    #statError(from: number, to: number, message: string): C.ErrorForm {
        this.#report(from, to, message);
        return [L.ERROR, from];
    }

    #expectAndConsume(kind: Tok, context: string | null): boolean {
        if (this.#cur.kind === kind) {
            this.#take();
            return true;
        }
        this.#expectAndConsumeFail(kind, context);
        // an extra token before the expected one
        if (this.#lexer.lookahead().kind === kind) {
            this.#take();
            this.#take();
        }
        return false;
    }

    #expectAndConsumeFail(kind: Tok, context: string | null): void {
        const got = this.#describe();
        this.#reportHere(context !== null ? `Expected ${describeKind(kind)} when parsing ${context}, got ${got}` : `Expected ${describeKind(kind)}, got ${got}`);
    }

    #expectMatchAndConsume(kind: Tok, begin: Match, searchForMissing: boolean): boolean {
        if (this.#cur.kind === kind) {
            this.#take();
            return true;
        }
        this.#expectMatchAndConsumeFail(kind, begin);
        return this.#expectMatchAndConsumeRecover(kind, searchForMissing);
    }

    #expectMatchAndConsumeRecover(kind: Tok, searchForMissing: boolean): boolean {
        if (searchForMissing) {
            // look for it on the rest of the line, up to a token a parser above handles
            const at = this.#prevTo;
            while (this.#sameLine(at, this.#lexer.from) && this.#cur.kind !== kind && (this.#recoveryStop.get(this.#cur.kind) ?? 0) === 0) this.#take();
            if (this.#cur.kind === kind) {
                this.#take();
                return true;
            }
            return false;
        }
        if (this.#lexer.lookahead().kind === kind) {
            this.#take();
            this.#take();
            return true;
        }
        return false;
    }

    #expectMatchAndConsumeFail(kind: Tok, begin: Match, extra: string = ""): void {
        const open = this.#lexer.lines.pos(begin.from);
        const where = this.#lexer.lines.line(this.#lexer.from) === open.line ? `column ${open.column + 1}` : `line ${open.line + 1}`;
        this.#reportHere(`Expected ${describeKind(kind)} (to close ${describeKind(begin.kind)} at ${where}), got ${this.#describe()}${extra}`);
    }

    #expectMatchEndAndConsume(kind: Tok, begin: Match): boolean {
        if (this.#cur.kind !== kind) {
            const suspect = this.#endMismatchSuspect;
            const suspectLine = this.#lexer.lines.line(suspect.from);
            if (suspect.kind !== Tok.Eof && suspectLine > this.#lexer.lines.line(begin.from)) {
                this.#expectMatchAndConsumeFail(kind, begin, `; did you forget to close ${describeKind(suspect.kind)} at line ${suspectLine + 1}?`);
            } else {
                this.#expectMatchAndConsumeFail(kind, begin);
            }
            if (this.#lexer.lookahead().kind === kind) {
                this.#take();
                this.#take();
                return true;
            }
            return false;
        }
        // on another line and column than what it closes: misleading indentation, a likely culprit for a later mismatch
        const at = this.#lexer.from, open = begin.from;
        const lines = this.#lexer.lines;
        if (!this.#sameLine(open, at) && this.#column(at) !== this.#column(open) && lines.line(this.#endMismatchSuspect.from) < lines.line(open)) {
            this.#endMismatchSuspect = begin;
        }
        this.#take();
        return true;
    }

    // --- names and locals ---

    #parseNameOpt(context: string | null): Name | null {
        if (!this.#at(Tok.Name)) {
            const got = this.#describe();
            this.#reportHere(context !== null ? `Expected identifier when parsing ${context}, got ${got}` : `Expected identifier, got ${got}`);
            return null;
        }
        const name = { name: this.#lexer.text, from: this.#lexer.from, to: this.#lexer.to };
        this.#take();
        return name;
    }

    #parseName(context: string | null): Name {
        return this.#parseNameOpt(context) ?? { name: ERROR_NAME, from: this.#lexer.from, to: this.#lexer.from };
    }

    // after `.` or `:`: a keyword on the same line is taken for an unfinished name
    #parseIndexName(context: string | null, previous: number): Name {
        const name = this.#parseNameOpt(context);
        if (name !== null) return name;
        if (isReserved(this.#cur.kind) && this.#sameLine(previous, this.#lexer.from)) {
            const name = { name: TOK_TEXT[this.#lexer.kind], from: this.#lexer.from, to: this.#lexer.to };
            this.#take();
            return name;
        }
        return { name: ERROR_NAME, from: this.#lexer.from, to: this.#lexer.from };
    }

    // by the line table, not by scanning the source: a line can be a whole (minified) file
    #column(offset: number): number {
        const lines = this.#lexer.lines;
        return lines.column(offset, lines.line(offset));
    }

    // offsets a <= b; most are a token or two apart, so those are scanned
    #sameLine(a: number, b: number): boolean {
        if (b - a < 64) {
            for (let i = a; i < b; i++) if (this.source.charCodeAt(i) === 10) return false;
            return true;
        }
        const lines = this.#lexer.lines;
        return lines.line(a) === lines.line(b);
    }

    #pushLocal(b: Binding): C.Local {
        const local = Symbol(b.name);
        this.#shadowed.push(this.#locals.get(b.name));
        this.#locals.set(b.name, local);
        this.#localStack.push(local);
        this.#localNames.push(b.name);
        if (b.isConst) this.#consts.add(local);
        this.#typeFunctionLocals?.add(local);
        return local;
    }

    #saveLocals(): number {
        return this.#localStack.length;
    }

    #restoreLocals(n: number): void {
        for (let i = this.#localStack.length - 1; i >= n; i--) {
            const name = this.#localNames[i], shadowed = this.#shadowed[i];
            if (shadowed !== undefined) this.#locals.set(name, shadowed);
            else this.#locals.delete(name);
        }
        this.#localStack.length = n;
        this.#localNames.length = n;
        this.#shadowed.length = n;
    }

    // --- blocks and statements ---

    #blockFollow(): boolean {
        const k = this.#cur.kind;
        return k === Tok.Eof || k === Tok.Else || k === Tok.ElseIf || k === Tok.End || k === Tok.Until;
    }

    #parseChunk(): C.Block {
        const block = this.#parseBlock();
        if (!this.#at(Tok.Eof)) this.#expectAndConsumeFail(Tok.Eof, null);
        return block;
    }

    #parseBlock(): C.Block {
        const n = this.#saveLocals();
        const block = this.#parseBlockNoScope();
        this.#restoreLocals(n);
        return block;
    }

    #parseBlockNoScope(): C.Block {
        const block: unknown[] = [L.BLOCK];
        const from = this.#prevTo;
        while (!this.#blockFollow()) {
            const stat = this.#parseStat();
            if (this.#at(Tok.Semicolon)) this.#take();
            if (stat === null) continue;
            block.push(stat);
            if (isStatLast(stat)) break;
        }
        block.push(from);
        return block as C.Block;
    }

    // a statement, or null for one only types have (type aliases and functions)
    #parseStat(): C.Stat | null {
        switch (this.#cur.kind) {
            case Tok.If: return this.#parseIf();
            case Tok.While: return this.#parseWhile();
            case Tok.Do: return this.#parseDo();
            case Tok.For: return this.#parseFor();
            case Tok.Repeat: return this.#parseRepeat();
            case Tok.Function: return this.#parseFunctionStat(null, this.#lexer.from);
            case Tok.Local: return this.#parseLocal(this.#lexer.from, null, false);
            case Tok.Return: return this.#parseReturn();
            case Tok.Break: return this.#parseBreak();
            case Tok.Attribute: case Tok.AttributeOpen: return this.#parseAttributeStat();
        }
        const start = this.#lexer.from;
        // an assignment (lvalue = ...) or a call statement, told apart after the expression
        const expr = this.#parsePrimaryExpr(true);
        const from = this.#exprFrom, to = this.#exprTo;
        if (isHead(expr, L.CALL) || isHead(expr, L.METHOD)) return expr as C.Call | C.Method;
        if (this.#at(Tok.Comma) || this.#at(Tok.Assign)) return this.#parseAssignment(expr);
        const op = COMPOUND[this.#cur.kind];
        if (op !== undefined) return this.#parseCompoundAssignment(expr, op);

        // neither: a context-sensitive keyword
        const ident = isHead(expr, L.GLOBAL) ? (expr as C.Global)[1] : typeof expr === "symbol" && expr !== L.NIL ? expr.description : null;
        if (ident === "type") return this.#parseTypeAlias();
        if (ident === "export" && this.#isName("type")) {
            this.#take();
            return this.#parseTypeAlias();
        }
        if (ident === "continue") return this.#parseContinue(from, to);
        if (ident === "const") return this.#parseLocal(from, null, true);

        // the lexer could not move at all: skip the token, as statements are parsed in a loop
        if (start === this.#lexer.from) this.#take();
        return this.#statError(from, to, "Incomplete statement: expected assignment or a function call");
    }

    #parseIf(): C.If {
        const start = this.#lexer.from;
        this.#take(); // if / elseif
        const condition = this.#parseExpr();
        const matchThen = this.#match();
        this.#expectAndConsume(Tok.Then, "if statement");
        const thenBody = this.#parseBlock();

        let elseBody: C.Block | C.If | null = null;
        if (this.#at(Tok.ElseIf)) {
            elseBody = this.#parseIf();
        } else {
            let matchThenElse = matchThen;
            if (this.#at(Tok.Else)) {
                matchThenElse = this.#match();
                this.#take();
                const block = this.#parseBlock();
                block[block.length - 1] = matchThenElse.to;
                elseBody = block;
            }
            this.#expectMatchEndAndConsume(Tok.End, matchThenElse);
        }
        return [L.IF, condition, thenBody, elseBody, start];
    }

    #parseWhile(): C.While {
        const start = this.#lexer.from;
        this.#take();
        const condition = this.#parseExpr();
        const matchDo = this.#match();
        this.#expectAndConsume(Tok.Do, "while loop");
        this.#fn().loopDepth++;
        const body = this.#parseBlock();
        this.#fn().loopDepth--;
        this.#expectMatchEndAndConsume(Tok.End, matchDo);
        return [L.WHILE, condition, body, start];
    }

    #parseRepeat(): C.Repeat {
        const matchRepeat = this.#match();
        this.#take();
        // the body's locals are in scope in the condition
        const n = this.#saveLocals();
        this.#fn().loopDepth++;
        const body = this.#parseBlockNoScope();
        this.#fn().loopDepth--;
        this.#expectMatchEndAndConsume(Tok.Until, matchRepeat);
        const condition = this.#parseExpr();
        this.#restoreLocals(n);
        return [L.REPEAT, body, condition, matchRepeat.from];
    }

    // do block end: the block itself
    #parseDo(): C.Block {
        const matchDo = this.#match();
        this.#take();
        const body = this.#parseBlock();
        body[body.length - 1] = matchDo.from;
        this.#expectMatchEndAndConsume(Tok.End, matchDo);
        return body;
    }

    #parseBreak(): C.Stat {
        const from = this.#lexer.from, to = this.#lexer.to;
        this.#take();
        if (this.#fn().loopDepth === 0) return this.#statError(from, to, "break statement must be inside a loop");
        return [L.BREAK, from];
    }

    #parseContinue(from: number, to: number): C.Stat {
        if (this.#fn().loopDepth === 0) return this.#statError(from, to, "continue statement must be inside a loop");
        return [L.CONTINUE, from];
    }

    #parseFor(): C.For | C.ForIn {
        const start = this.#lexer.from;
        this.#take();
        const first = this.#parseBinding(false);

        if (this.#at(Tok.Assign)) {
            this.#take();
            const init = this.#parseExpr();
            this.#expectAndConsume(Tok.Comma, "index range");
            const limit = this.#parseExpr();
            let step: C.Expr | null = null;
            if (this.#at(Tok.Comma)) {
                this.#take();
                step = this.#parseExpr();
            }
            const matchDo = this.#match();
            this.#expectAndConsume(Tok.Do, "for loop");
            const n = this.#saveLocals();
            this.#fn().loopDepth++;
            const variable = this.#pushLocal(first);
            const body = this.#parseBlock();
            this.#fn().loopDepth--;
            this.#restoreLocals(n);
            this.#expectMatchEndAndConsume(Tok.End, matchDo);
            return [L.FOR, variable, init, limit, step, body, start];
        }

        const names: Binding[] = [first];
        if (this.#at(Tok.Comma)) {
            this.#take();
            this.#parseBindingList(names, false, false);
        }
        this.#expectAndConsume(Tok.In, "for loop");
        const values: C.Expr[] = [];
        this.#parseExprList(values);
        const matchDo = this.#match();
        this.#expectAndConsume(Tok.Do, "for loop");
        const n = this.#saveLocals();
        this.#fn().loopDepth++;
        const vars = names.map(b => this.#pushLocal(b));
        const body = this.#parseBlock();
        this.#fn().loopDepth--;
        this.#restoreLocals(n);
        this.#expectMatchEndAndConsume(Tok.End, matchDo);
        return [L.FORIN, vars, values, body, start];
    }

    // funcname ::= Name {'.' Name} [':' Name], as a chain of index expressions
    #parseFunctionName(): { expr: C.Expr, hasSelf: boolean, debugName: string | null } {
        let debugName = this.#at(Tok.Name) ? this.#cur.text : null;
        let expr = this.#parseNameExpr("function name");
        const from = this.#exprFrom;
        while (this.#at(Tok.Dot)) {
            this.#take();
            const name = this.#parseName("field name");
            debugName = name.name;
            expr = this.#expr([L.INDEX, expr, name.name, from], from, name.to);
        }
        let hasSelf = false;
        if (this.#at(Tok.Colon)) {
            this.#take();
            const name = this.#parseName("method name");
            debugName = name.name;
            expr = this.#expr([L.INDEX, expr, name.name, from], from, name.to);
            hasSelf = true;
        }
        return { expr, hasSelf, debugName };
    }

    #isLValue(e: C.Expr): boolean {
        if (typeof e === "symbol") return e !== L.NIL && !this.#consts.has(e);
        return isHead(e, L.GLOBAL) || isHead(e, L.INDEX);
    }

    // an expression that cannot be assigned, just parsed
    #lvalueError(e: C.Expr): C.ErrorForm {
        const from = this.#exprFrom, to = this.#exprTo;
        if (typeof e === "symbol" && this.#consts.has(e)) return this.#exprError(from, to, `Variable '${e.description}' is constant and may not be reassigned`);
        return this.#exprError(from, to, "Assigned expression must be a variable or a field");
    }

    #parseFunctionStat(attributes: Span | null, start: number): C.Assign {
        const matchFunction = this.#match();
        this.#take();
        let { expr, hasSelf, debugName } = this.#parseFunctionName();
        if (!this.#isLValue(expr)) expr = this.#lvalueError(expr);
        this.#stop(Tok.End, 1);
        const func = this.#parseFunctionBody(hasSelf, matchFunction, debugName, null, attributes, false).func;
        this.#stop(Tok.End, -1);
        return [L.ASSIGN, [expr], [func], start];
    }

    #validateAttribute(from: number, to: number, name: string, seen: string[], args: C.Expr[], argSpans: number[], items: ItemInfo[] | null): void {
        if (!ATTRIBUTES.has(name)) {
            this.#report(from, to, name === "" ? "Attribute name is missing" : `Invalid attribute '@${name}'`);
            return;
        }
        if (seen.includes(name)) this.#report(from, to, `Cannot duplicate attribute '@${name}'`);
        seen.push(name);
        if (name === "deprecated" && args.length > 0) {
            if (args.length > 1) this.#report(from, to, "@deprecated can be parametrized only by 1 argument");
            else if (!isHead(args[0], L.TABLE) || items === null) this.#report(argSpans[0], argSpans[1], "Unknown argument type for @deprecated");
            else for (const item of items) {
                if (item.key !== null) {
                    if (item.key !== "use" && item.key !== "reason") {
                        this.#report(item.keyFrom, item.keyTo, `Unknown argument '${item.key}' for @deprecated. Only string constants for 'use' and 'reason' are allowed`);
                    } else if (typeof item.value !== "string") {
                        this.#report(item.valueFrom, item.valueTo, `Only constant string allowed as value for '${item.key}'`);
                    }
                } else {
                    this.#report(item.valueFrom, item.valueTo, "Only constants keys 'use' and 'reason' are allowed for @deprecated attribute");
                }
            }
        }
    }

    // attributes ::= {'@' NAME | '@[' parattr {',' parattr} ']'}: checked, not kept; the span of the first, if any
    #parseAttributes(): Span | null {
        const seen: string[] = [];
        let first: Span | null = null;
        while (this.#at(Tok.Attribute) || this.#at(Tok.AttributeOpen)) {
            if (this.#at(Tok.Attribute)) {
                const from = this.#lexer.from, to = this.#lexer.to;
                this.#validateAttribute(from, to, this.#lexer.text, seen, [], [], null);
                this.#take();
                first ??= { from, to };
                continue;
            }
            const open = this.#match();
            this.#take();
            if (!this.#at(Tok.RBracket)) {
                while (true) {
                    const name = this.#parseName("attribute name");
                    const k = this.#cur.kind;
                    if (k === Tok.RawString || k === Tok.String || k === Tok.LBrace || k === Tok.LParen) {
                        const { args, argSpans, items, argsFrom, argsTo } = this.#parseCallList();
                        for (const arg of args) {
                            if (!isConstantLiteral(arg) && !isLiteralTable(arg)) this.#report(argsFrom, argsTo, "Only literals can be passed as arguments for attributes");
                        }
                        this.#validateAttribute(name.from, name.to, name.name, seen, args, argSpans, items);
                        first ??= { from: name.from, to: argsTo };
                    } else {
                        this.#validateAttribute(name.from, name.to, name.name, seen, [], [], null);
                        first ??= name;
                    }
                    if (!this.#at(Tok.Comma)) break;
                    this.#take();
                }
            } else {
                const to = this.#lexer.to;
                this.#report(open.from, to, "Attribute list cannot be empty");
                first ??= { from: open.from, to };
            }
            this.#expectMatchAndConsume(Tok.RBracket, open, false);
        }
        return first;
    }

    #parseAttributeStat(): C.Stat {
        const start = this.#lexer.from;
        const attributes = this.#parseAttributes();
        switch (this.#cur.kind) {
            case Tok.Function:
                return this.#parseFunctionStat(attributes, start);
            case Tok.Local:
                return this.#parseLocal(start, attributes, false);
            case Tok.Name:
                if (this.#cur.text === "const") {
                    this.#take();
                    return this.#parseLocal(start, attributes, true);
                }
        }
        return this.#statError(this.#lexer.from, this.#lexer.to,
            `Expected 'function', 'local function', 'const function', 'declare function' or a function type declaration after attribute, but got ${this.#describe()} instead`);
    }

    // local / const (the `const` keyword already taken)
    #parseLocal(start: number, attributes: Span | null, isConst: boolean): C.Stat {
        if (!isConst) this.#take(); // local
        if (this.#at(Tok.Function)) {
            const matchFunction = this.#match();
            this.#take();
            // for messages about a missing end, as if it began where `local` does
            if (this.#sameLine(start, matchFunction.from)) matchFunction.from = start;
            const name = this.#parseName("variable name");
            this.#stop(Tok.End, 1);
            const { func, local } = this.#parseFunctionBody(false, matchFunction, name.name, name, attributes, isConst);
            this.#stop(Tok.End, -1);
            return [L.LOCALFN, local!, func, start];
        }
        if (attributes !== null) {
            return this.#statError(this.#lexer.from, this.#lexer.to, `Expected 'function' after local declaration with attribute, but got ${this.#describe()} instead`);
        }
        this.#stop(Tok.Assign, 1);
        const names: Binding[] = [];
        this.#parseBindingList(names, false, isConst);
        this.#stop(Tok.Assign, -1);
        const values: C.Expr[] = [];
        if (this.#at(Tok.Assign)) {
            this.#take();
            this.#parseExprList(values);
        }
        const end = values.length === 0 ? this.#prevTo : this.#exprTo;
        const vars = names.map(b => this.#pushLocal(b));
        // a const that definitely gets no value (`const x`, `const a, b = 1`) can only ever be nil
        if (isConst) {
            const last = values[values.length - 1];
            const enough = (last !== undefined && (isHead(last, L.CALL) || isHead(last, L.METHOD) || isHead(last, L.VARARGS))) || values.length === vars.length;
            if (!enough) this.#report(start, end, "Missing initializer in const declaration");
        }
        return [L.LOCAL, vars, values, start];
    }

    #parseReturn(): C.Return {
        const ret: unknown[] = [L.RETURN];
        const start = this.#lexer.from;
        this.#take();
        if (!this.#blockFollow() && !this.#at(Tok.Semicolon)) this.#parseExprList(ret as C.Expr[]);
        ret.push(start);
        return ret as C.Return;
    }

    // type Name ['<' generics '>'] '=' Type, or a type function (`type` already taken)
    #parseTypeAlias(): null {
        if (this.#at(Tok.Function)) return this.#parseTypeFunction();
        this.#parseNameOpt("type name");
        this.#parseGenericTypeList(true);
        this.#expectAndConsume(Tok.Assign, "type alias");
        this.#parseType();
        return null;
    }

    #parseTypeFunction(): null {
        const matchFn = this.#match();
        this.#take();
        const name = this.#parseNameOpt("type function name");
        this.#stop(Tok.End, 1);
        const outer = this.#typeFunctionLocals;
        this.#typeFunctionLocals = new Set();
        this.#parseFunctionBody(false, matchFn, name?.name ?? ERROR_NAME, null, null, false);
        this.#typeFunctionLocals = outer;
        this.#stop(Tok.End, -1);
        return null;
    }

    // `initial` just parsed
    #parseAssignment(initial: C.Expr): C.Assign {
        const start = this.#exprFrom;
        const vars: C.Expr[] = [this.#isLValue(initial) ? initial : this.#lvalueError(initial)];
        while (this.#at(Tok.Comma)) {
            this.#take();
            const e = this.#parsePrimaryExpr(true);
            vars.push(this.#isLValue(e) ? e : this.#lvalueError(e));
        }
        this.#expectAndConsume(Tok.Assign, "assignment");
        const values: C.Expr[] = [];
        this.#parseExprList(values);
        return [L.ASSIGN, vars, values, start];
    }

    // `initial` just parsed
    #parseCompoundAssignment(initial: C.Expr, op: C.BinaryHead): C.OpSet {
        const start = this.#exprFrom;
        const target = this.#isLValue(initial) ? initial : this.#lvalueError(initial);
        this.#take();
        const value = this.#parseExpr();
        return [L.OPSET, op, target, value, start];
    }

    // funcbody ::= ['<' generics '>'] '(' [parlist] ')' [':' ReturnType] block 'end'
    #parseFunctionBody(hasSelf: boolean, matchFunction: Match, debugName: string | null, localName: Name | null, attributes: Span | null, isConst: boolean):
        { func: C.Func, local: C.Local | null } {
        const start = attributes ?? matchFunction;
        this.#parseGenericTypeList(false);
        const matchParen = this.#match();
        this.#expectAndConsume(Tok.LParen, "function");
        // so `function (t: { a: number  ) end` still finds its `)`
        this.#stop(Tok.RParen, 1);
        const args: Binding[] = [];
        const vararg = !this.#at(Tok.RParen) && this.#parseBindingList(args, true, false);
        this.#expectMatchAndConsume(Tok.RParen, matchParen, true);
        this.#stop(Tok.RParen, -1);
        this.#parseOptionalReturnType();

        const local = localName !== null ? this.#pushLocal({ name: localName.name, from: localName.from, to: localName.to, isConst }) : null;
        const n = this.#saveLocals();
        this.#functions.push({ vararg, loopDepth: 0 });
        const params: C.Local[] = hasSelf ? [this.#pushLocal({ name: "self", from: start.from, to: start.to, isConst: false })] : [];
        for (const b of args) params.push(this.#pushLocal(b));
        const body = this.#parseBlock();
        this.#functions.pop();
        this.#restoreLocals(n);
        const end = this.#lexer.to;
        this.#expectMatchEndAndConsume(Tok.End, matchFunction);
        return { func: this.#expr([L.FUNCTION, params, vararg, body, debugName, start.from], start.from, end), local };
    }

    // with `spans`, each expression's span too
    #parseExprList(result: C.Expr[], spans: number[] | null = null): void {
        result.push(this.#parseExpr());
        spans?.push(this.#exprFrom, this.#exprTo);
        while (this.#at(Tok.Comma)) {
            this.#take();
            if (this.#at(Tok.RParen)) {
                this.#reportHere("Expected expression after ',' but got ')' instead");
                break;
            }
            result.push(this.#parseExpr());
            spans?.push(this.#exprFrom, this.#exprTo);
        }
    }

    #parseBinding(isConst: boolean): Binding {
        const name = this.#parseNameOpt("variable name") ?? { name: ERROR_NAME, from: this.#lexer.from, to: this.#lexer.to };
        this.#parseOptionalType();
        return { name: name.name, from: name.from, to: name.to, isConst };
    }

    // bindinglist ::= (binding | '...' [':' type]) [',' bindinglist]
    // whether it ends with ...
    #parseBindingList(result: Binding[], allowDot3: boolean, isConst: boolean): boolean {
        while (true) {
            if (this.#at(Tok.Dots) && allowDot3) {
                this.#take();
                if (this.#at(Tok.Colon)) {
                    this.#take();
                    this.#parseVariadicArgumentTypePack();
                }
                return true;
            }
            result.push(this.#parseBinding(isConst));
            if (!this.#at(Tok.Comma)) break;
            this.#take();
        }
        return false;
    }

    // --- types ---

    #parseOptionalType(): void {
        if (!this.#at(Tok.Colon)) return;
        this.#take();
        this.#parseType();
    }

    #shouldParseTypePack(): boolean {
        return this.#at(Tok.Dots) || (this.#at(Tok.Name) && this.#lexer.lookahead().kind === Tok.Dots);
    }

    // TypeList ::= Type [',' TypeList] | '...' Type, with optional argument names (name ':' Type)
    #parseTypeList(): TypeList {
        let types = 0, named = false;
        while (true) {
            if (this.#shouldParseTypePack()) {
                this.#parseTypePack();
                return { types, named, tail: true };
            }
            if (this.#at(Tok.Name) && this.#lexer.lookahead().kind === Tok.Colon) {
                named = true;
                this.#take();
                this.#expectAndConsume(Tok.Colon, null);
            }
            this.#parseType();
            types++;
            if (!this.#at(Tok.Comma)) break;
            this.#take();
            if (this.#at(Tok.RParen)) {
                this.#reportHere("Expected type after ',' but got ')' instead");
                break;
            }
        }
        return { types, named, tail: false };
    }

    #parseOptionalReturnType(): void {
        if (!this.#at(Tok.Colon) && !this.#at(Tok.Arrow)) return;
        if (this.#at(Tok.Arrow)) this.#reportHere("Function return type annotations are written after ':' instead of '->'");
        this.#take();
        this.#parseReturnType();
        // several return types not in parentheses
        if (this.#at(Tok.Comma)) {
            this.#reportHere("Expected a statement, got ','; did you forget to wrap the list of return types in parentheses?");
            this.#take();
        }
    }

    // ReturnType ::= Type | '(' TypeList ')' | a function type
    #parseReturnType(): number {
        const begin = this.#match();
        if (!this.#at(Tok.LParen)) return this.#shouldParseTypePack() ? this.#parseTypePack() : this.#parseType();
        this.#take();
        this.#stop(Tok.Arrow, 1);
        const list = this.#at(Tok.RParen) ? NO_TYPES : this.#parseTypeList();
        const to = this.#lexer.to;
        this.#expectMatchAndConsume(Tok.RParen, begin, true);
        this.#stop(Tok.Arrow, -1);
        if (!this.#at(Tok.Arrow) && !list.named) {
            // '(A)', perhaps followed by a union or intersection
            if (list.types === 1) this.#parseTypeSuffix(true, begin.from, to);
            return to;
        }
        return this.#parseFunctionTypeTail(begin, 0, list);
    }

    #parseTableIndexer(begin: Match): number {
        this.#parseType();
        this.#expectMatchAndConsume(Tok.RBracket, begin, false);
        this.#expectAndConsume(Tok.Colon, "table field");
        return this.#parseType();
    }

    // TableType ::= '{' Type '}' | '{' [PropList] '}'
    #parseTableType(): number {
        const matchBrace = this.#match();
        this.#expectAndConsume(Tok.LBrace, "table type");
        let hasProps = false, hasIndexer = false;
        while (!this.#at(Tok.RBrace)) {
            if (this.#at(Tok.Name) && this.#lexer.lookahead().kind !== Tok.Colon && (this.#cur.text === "read" || this.#cur.text === "write")) this.#take();
            if (this.#at(Tok.LBracket)) {
                const begin = this.#match();
                this.#take();
                const k = this.#cur.kind;
                if ((k === Tok.RawString || k === Tok.String) && this.#lexer.lookahead().kind === Tok.RBracket) {
                    const chars = this.#parseCharArray();
                    this.#expectMatchAndConsume(Tok.RBracket, begin, false);
                    this.#expectAndConsume(Tok.Colon, "table field");
                    this.#parseType();
                    if (chars !== null && !chars.includes("\0")) hasProps = true;
                    else this.#report(begin.from, begin.to, "String literal contains malformed escape sequence or \\0");
                } else if (hasIndexer) {
                    const to = this.#parseTableIndexer(begin);
                    this.#report(begin.from, to, "Cannot have more than one table indexer");
                } else {
                    this.#parseTableIndexer(begin);
                    hasIndexer = true;
                }
            } else if (!hasProps && !hasIndexer && !(this.#at(Tok.Name) && this.#lexer.lookahead().kind === Tok.Colon)) {
                // {T} is {[number]: T}
                this.#parseType();
                break;
            } else {
                if (this.#parseNameOpt("table field") === null) break;
                this.#expectAndConsume(Tok.Colon, "table field");
                this.#parseType();
                hasProps = true;
            }
            if (this.#at(Tok.Comma) || this.#at(Tok.Semicolon)) this.#take();
            else if (!this.#at(Tok.RBrace)) break;
        }
        const end = this.#lexer.to;
        return this.#expectMatchAndConsume(Tok.RBrace, matchBrace, true) ? end : this.#prevTo;
    }

    // FunctionType ::= ['<' generics '>'] '(' [TypeList] ')' '->' ReturnType, or a parenthesized type, or a type pack
    #parseFunctionType(allowPack: boolean): number {
        let forceFunctionType = this.#at(Tok.Lt);
        const begin = this.#match();
        const generics = this.#parseGenericTypeList(false);
        const parameterStart = this.#match();
        this.#expectAndConsume(Tok.LParen, "function parameters");
        this.#stop(Tok.Arrow, 1);
        const list = this.#at(Tok.RParen) ? NO_TYPES : this.#parseTypeList();
        const close = this.#lexer.to;
        this.#expectMatchAndConsume(Tok.RParen, parameterStart, true);
        this.#stop(Tok.Arrow, -1);
        if (list.named) forceFunctionType = true;
        const returnTypeIntroducer = this.#at(Tok.Arrow) || this.#at(Tok.Colon);

        if (list.types === 1 && !list.tail && !forceFunctionType && !returnTypeIntroducer) {
            return allowPack ? this.#asPack(close, true) : this.#asType(parameterStart.from, close);
        }
        if (!forceFunctionType && !returnTypeIntroducer && allowPack) return this.#asPack(close, false);
        const to = this.#parseFunctionTypeTail(begin, generics, list);
        return this.#asType(begin.from, to);
    }

    #parseFunctionTypeTail(begin: Match, generics: number, list: TypeList): number {
        if (this.#at(Tok.Colon)) {
            this.#reportHere("Return types in function type annotations are written after '->' instead of ':'");
            this.#take();
        } else if (!this.#at(Tok.Arrow) && generics === 0 && list.types === 0) {
            // '()' written for the unit type
            this.#report(begin.from, this.#prevTo, "Expected '->' after '()' when parsing function type; did you mean 'nil'?");
            return begin.to;
        } else {
            this.#expectAndConsume(Tok.Arrow, "function type");
        }
        return this.#parseReturnType();
    }

    // unions and intersections after a type (none for a leading | or &) that ends at `to`
    #parseTypeSuffix(hasType: boolean, begin: number, to: number): number {
        let parts = hasType ? 1 : 0, lastFrom = begin;
        let isUnion = false, isIntersection = false, optionalCount = 0;
        while (true) {
            const k = this.#cur.kind;
            if (k === Tok.Pipe || k === Tok.Amp) {
                this.#take();
                to = this.#parseSimpleType(false);
                lastFrom = this.#typeFrom;
                parts++;
                if (k === Tok.Pipe) isUnion = true;
                else isIntersection = true;
            } else if (k === Tok.Question) {
                lastFrom = this.#lexer.from;
                to = this.#lexer.to;
                this.#take();
                parts++;
                optionalCount++;
                isUnion = true;
            } else if (k === Tok.Dots) {
                this.#reportHere("Unexpected '...' after type annotation");
                this.#take();
            } else {
                break;
            }
            if (parts > TYPE_LENGTH_LIMIT + optionalCount) {
                throw new Fatal(lastFrom, to, "Exceeded allowed type length; simplify your type annotation to make the code compile");
            }
        }
        if (parts === 1 && !isUnion && !isIntersection) return to;
        if (isUnion && isIntersection) this.#report(begin, to, "Mixing union and intersection types is not allowed; consider wrapping in parentheses.");
        this.#typeFrom = begin;
        return to;
    }

    #parseSimpleTypeOrPack(): number {
        const begin = this.#lexer.from;
        const to = this.#parseSimpleType(true);
        return this.#isPack ? to : this.#parseTypeSuffix(true, begin, to);
    }

    #parseType(): number {
        const begin = this.#lexer.from;
        if (this.#at(Tok.Pipe) || this.#at(Tok.Amp)) return this.#parseTypeSuffix(false, begin, begin);
        return this.#parseTypeSuffix(true, begin, this.#parseSimpleType(false));
    }

    #asType(from: number, to: number): number {
        this.#isPack = false;
        this.#typeFrom = from;
        return to;
    }

    #asPack(to: number, single: boolean): number {
        this.#isPack = true;
        this.#singlePack = single;
        return to;
    }

    // a type, or with allowPack a parenthesized type pack (#isPack); where it ends, and where it starts in #typeFrom
    #parseSimpleType(allowPack: boolean): number {
        const from = this.#lexer.from, to = this.#lexer.to;
        switch (this.#cur.kind) {
            case Tok.Attribute: case Tok.AttributeOpen:
                this.#report(from, to, "attributes are not allowed in declaration context");
                return this.#asType(from, to);
            case Tok.Nil: case Tok.True: case Tok.False:
                this.#take();
                return this.#asType(from, to);
            case Tok.RawString: case Tok.String:
                if (this.#parseCharArray() === null) this.#report(from, to, "String literal contains malformed escape sequence");
                return this.#asType(from, to);
            case Tok.InterpBegin: case Tok.InterpSimple:
                this.#parseInterpString();
                this.#report(from, to, "Interpolated string literals cannot be used as types");
                return this.#asType(from, to);
            case Tok.BrokenString:
                this.#take();
                this.#report(from, to, "Malformed string; did you forget to finish it?");
                return this.#asType(from, to);
            case Tok.Name: {
                const name = this.#parseName("type name");
                if (this.#at(Tok.Dot)) {
                    const dot = this.#lexer.from;
                    this.#take();
                    this.#parseIndexName("field name", dot);
                } else if (this.#at(Tok.Dots)) {
                    this.#reportHere("Unexpected '...' after type name; type pack is not allowed in this context");
                    this.#take();
                } else if (name.name === "typeof") {
                    const typeofBegin = this.#match();
                    this.#expectAndConsume(Tok.LParen, "typeof type");
                    this.#parseExpr();
                    const end = this.#lexer.to;
                    this.#expectMatchAndConsume(Tok.RParen, typeofBegin, false);
                    return this.#asType(from, end);
                }
                if (this.#at(Tok.Lt)) this.#parseTypeParams();
                return this.#asType(from, this.#prevTo);
            }
            case Tok.LBrace:
                return this.#asType(from, this.#parseTableType());
            case Tok.LParen: case Tok.Lt:
                return this.#parseFunctionType(allowPack);
            case Tok.Function:
                this.#take();
                this.#report(from, to, "Using 'function' as a type annotation is not supported, consider replacing with a function type annotation e.g. '(...any) -> ...any'");
                return this.#asType(from, to);
        }
        // a missing type: the error spans the gap before the next token
        this.#report(this.#prevTo, to, `Expected type, got ${this.#describe()}`);
        return this.#asType(this.#prevTo, from);
    }

    #parseVariadicArgumentTypePack(): void {
        if (this.#at(Tok.Name) && this.#lexer.lookahead().kind === Tok.Dots) this.#parseGenericTypePack();
        else this.#parseType();
    }

    #parseGenericTypePack(): number {
        this.#parseName("generic name");
        const end = this.#lexer.to;
        this.#expectAndConsume(Tok.Dots, "generic type pack annotation");
        return end;
    }

    #parseTypePack(): number {
        if (!this.#at(Tok.Dots)) return this.#parseGenericTypePack();
        this.#take();
        return this.#parseType();
    }

    // '<' generic {',' generic} '>', types before type packs (`name...`), with defaults where allowed; how many there are
    #parseGenericTypeList(withDefaults: boolean): number {
        if (!this.#at(Tok.Lt)) return 0;
        const begin = this.#match();
        this.#take();
        let count = 0, seenPack = false, seenDefault = false;
        while (true) {
            this.#parseName(null);
            count++;
            if (this.#at(Tok.Dots) || seenPack) {
                seenPack = true;
                if (!this.#at(Tok.Dots)) this.#reportHere("Generic types come before generic type packs");
                else this.#take();
                if (withDefaults && this.#at(Tok.Assign)) {
                    seenDefault = true;
                    this.#take();
                    if (this.#shouldParseTypePack()) {
                        this.#parseTypePack();
                    } else {
                        const to = this.#parseSimpleTypeOrPack();
                        if (!this.#isPack) this.#report(this.#typeFrom, to, "Expected type pack after '=', got type");
                    }
                } else if (seenDefault) {
                    this.#reportHere("Expected default type pack after type pack name");
                }
            } else if (withDefaults && this.#at(Tok.Assign)) {
                seenDefault = true;
                this.#take();
                this.#parseType();
            } else if (seenDefault) {
                this.#reportHere("Expected default type after type name");
            }
            if (!this.#at(Tok.Comma)) break;
            this.#take();
            if (this.#at(Tok.Gt)) {
                this.#reportHere("Expected type after ',' but got '>' instead");
                break;
            }
        }
        this.#expectMatchAndConsume(Tok.Gt, begin, false);
        return count;
    }

    // '<' TypeParams '>' after a type name
    #parseTypeParams(): void {
        if (!this.#at(Tok.Lt)) return;
        const begin = this.#match();
        this.#take();
        let count = 0;
        while (true) {
            if (this.#shouldParseTypePack()) {
                this.#parseTypePack();
            } else if (this.#at(Tok.LParen)) {
                const b = this.#lexer.from;
                const to = this.#parseSimpleType(true);
                // X<(T)> is a type pack, unless a union or intersection follows: then (T) is a parenthesized type
                if (!this.#isPack || (this.#singlePack && isTypeFollow(this.#cur.kind))) this.#parseTypeSuffix(true, b, to);
            } else if (this.#at(Tok.Gt) && count === 0) {
                break;
            } else {
                this.#parseType();
            }
            count++;
            if (!this.#at(Tok.Comma)) break;
            this.#take();
        }
        this.#expectMatchAndConsume(Tok.Gt, begin, false);
    }

    // --- expressions ---

    // a binary operator at the current token binding tighter than `limit`; a confusable (&&, ||, !=) is reported, and
    // its first token taken
    #binaryOp(limit: number): Tok | undefined {
        const kind = this.#lexer.kind;
        if (BINARY[kind] !== undefined) return kind;
        const bang = kind === Tok.Char && this.#lexer.text === "!";
        if (kind !== Tok.Amp && kind !== Tok.Pipe && !bang) return undefined;
        const from = this.#lexer.from, to = this.#lexer.to;
        const next = this.#lexer.lookahead();
        if (to !== next.from) return undefined;
        const confusable = (is: boolean, nextKind: Tok, as: Tok, message: string) => {
            if (!is || next.kind !== nextKind || LEFT[as] <= limit) return undefined;
            this.#take();
            this.#report(from, next.to, message);
            return as;
        };
        return confusable(kind === Tok.Amp, Tok.Amp, Tok.And, "Unexpected '&&'; did you mean 'and'?")
            ?? confusable(kind === Tok.Pipe, Tok.Pipe, Tok.Or, "Unexpected '||'; did you mean 'or'?")
            ?? confusable(bang, Tok.Assign, Tok.Ne, "Unexpected '!='; did you mean '~='?");
    }

    // subexpr ::= (asexp | unop subexpr) {binop subexpr}, where each binop binds tighter than `limit`
    #parseExpr(limit: number = 0): C.Expr {
        const start = this.#lexer.from;
        let expr: C.Expr;
        let uop = UNARY[this.#cur.kind];
        if (uop === undefined && this.#at(Tok.Char) && this.#cur.text === "!") {
            this.#reportHere("Unexpected '!'; did you mean 'not'?");
            uop = L.NOT;
        }
        if (uop !== undefined) {
            this.#take();
            const sub = this.#parseExpr(UNARY_PRIORITY);
            expr = this.#expr([uop, sub, start], start, this.#exprTo);
        } else {
            expr = this.#parseAssertionExpr();
        }
        let op = this.#binaryOp(limit);
        while (op !== undefined && LEFT[op] > limit) {
            this.#take();
            const right = this.#parseExpr(RIGHT[op]);
            expr = this.#expr([BINARY[op]!, expr, right, start], start, this.#exprTo);
            op = this.#binaryOp(limit);
        }
        return expr;
    }

    #parseNameExpr(context: string): C.Expr {
        const name = this.#parseNameOpt(context);
        if (name === null) return this.#expr([L.ERROR, this.#lexer.from], this.#lexer.from, this.#lexer.to);
        const local = this.#locals.get(name.name);
        if (local !== undefined) {
            if (this.#typeFunctionLocals !== null && !this.#typeFunctionLocals.has(local)) return this.#exprError(this.#lexer.from, this.#lexer.to, `Type function cannot reference outer local '${name.name}'`);
            return this.#expr(local, name.from, name.to);
        }
        return this.#expr([L.GLOBAL, name.name, name.from], name.from, name.to);
    }

    // prefixexp ::= NAME | '(' expr ')'
    #parsePrefixExpr(): C.Expr {
        if (!this.#at(Tok.LParen)) return this.#parseNameExpr("expression");
        const start = this.#lexer.from;
        const matchParen = this.#match();
        this.#take();
        const expr = this.#parseExpr();
        let end = this.#lexer.to;
        if (!this.#at(Tok.RParen)) {
            this.#expectMatchAndConsumeFail(Tok.RParen, matchParen, this.#at(Tok.Assign) ? "; did you mean to use '{' when defining a table?" : "");
            end = this.#prevTo;
        } else {
            this.#take();
        }
        return this.#expr([L.ONE, expr, start], start, end);
    }

    // primaryexp ::= prefixexp {'.' NAME | '[' exp ']' | ':' NAME funcargs | funcargs | '<<' types '>>'}
    #parsePrimaryExpr(asStatement: boolean): C.Expr {
        const start = this.#lexer.from;
        let expr = this.#parsePrefixExpr();
        // where the expression so far ends, type arguments included
        let end = this.#exprTo;
        while (true) {
            const k = this.#cur.kind;
            if (k === Tok.Dot) {
                const dot = this.#lexer.from;
                this.#take();
                const index = this.#parseIndexName(null, dot);
                expr = this.#expr([L.INDEX, expr, index.name, start], start, index.to);
            } else if (k === Tok.LBracket) {
                expr = this.#parseIndexExpr(start, expr);
            } else if (k === Tok.Colon) {
                expr = this.#parseMethodCall(start, expr);
            } else if (k === Tok.LParen) {
                // a call on a new line in an expression could as well be a new statement
                if (!asStatement && !this.#sameLine(end, this.#lexer.from)) {
                    this.#reportAmbiguousCallError();
                    break;
                }
                expr = this.#parseFunctionArgs([L.CALL, expr], start, this.#exprTo, end, false);
            } else if (k === Tok.LBrace || k === Tok.RawString || k === Tok.String) {
                expr = this.#parseFunctionArgs([L.CALL, expr], start, this.#exprTo, end, false);
            } else if (k === Tok.Lt && this.#lexer.lookahead().kind === Tok.Lt) {
                // f<<T>> is f (a typeof in the types would leave its own span)
                const from = this.#exprFrom, to = this.#exprTo;
                end = this.#parseTypeInstantiationExpr();
                this.#exprFrom = from;
                this.#exprTo = to;
                continue;
            } else {
                break;
            }
            end = this.#exprTo;
        }
        return expr;
    }

    #parseIndexExpr(start: number, expr: C.Expr): C.Index {
        const matchBracket = this.#match();
        this.#take();
        const index = this.#parseExpr();
        const end = this.#lexer.to;
        this.#expectMatchAndConsume(Tok.RBracket, matchBracket, false);
        return this.#expr([L.INDEX, expr, index, start], start, end);
    }

    #parseMethodCall(start: number, expr: C.Expr): C.Expr {
        const colon = this.#lexer.from;
        this.#take();
        const index = this.#parseIndexName("method name", colon);
        if (this.#at(Tok.Lt) && this.#lexer.lookahead().kind === Tok.Lt) this.#parseTypeInstantiationExpr();
        return this.#parseFunctionArgs([L.METHOD, expr, index.name], start, index.to, index.to, true);
    }

    // asexp ::= simpleexp ['::' Type]
    #parseAssertionExpr(): C.Expr {
        const start = this.#lexer.from;
        const expr = this.#parseSimpleExpr();
        if (!this.#at(Tok.DoubleColon)) return expr;
        this.#take();
        const to = this.#parseType();
        return this.#expr([L.ONE, expr, start], start, to);
    }

    #parseNumber(): C.Expr {
        const from = this.#lexer.from, to = this.#lexer.to, text = this.#lexer.text, lexed = this.#lexer.value;
        this.#take();
        // the common case: a short run of digits, valued by the lexer
        if (!Number.isNaN(lexed)) return this.#expr(lexed, from, to);
        const s = text.indexOf("_") === -1 ? text : text.replace(/_/g, "");
        if (s.endsWith("i")) return this.#parseInteger(s, from, to);
        let value: number;
        const integer = (digits: string, base: 2 | 16): number | null => {
            if (!(base === 2 ? /^[01]+$/ : /^[0-9a-fA-F]+$/).test(digits)) return null;
            let big = BigInt(base === 2 ? `0b${digits}` : `0x${digits}`);
            // strtoull saturates
            const max = (1n << 64n) - 1n;
            if (big > max) big = max;
            return Number(big);
        };
        if (/^0[bB]./.test(s)) {
            const v = integer(s.slice(2), 2);
            if (v === null) return this.#exprError(from, to, "Malformed number");
            value = v;
        } else if (/^0[xX]./.test(s)) {
            const v = integer(s.slice(2), 16);
            if (v === null) return this.#exprError(from, to, "Malformed number");
            value = v;
        } else {
            if (!/^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return this.#exprError(from, to, "Malformed number");
            value = Number(s);
        }
        return this.#expr(value, from, to);
    }

    // an integer literal: decimal in the signed range, hex and binary any 64 bits (wrapping to signed)
    #parseInteger(s: string, from: number, to: number): C.Expr {
        const hex = /^0[xX]/.test(s), bin = /^0[bB]/.test(s);
        const digits = s.slice(hex || bin ? 2 : 0, -1);
        if (!(hex ? /^[0-9a-fA-F]+$/ : bin ? /^[01]+$/ : /^[0-9]+$/).test(digits)) return this.#exprError(from, to, "Malformed integer");
        const n = BigInt(hex ? `0x${digits}` : bin ? `0b${digits}` : digits);
        if (n >= (hex || bin ? 1n << 64n : 1n << 63n)) return this.#exprError(from, to, "Integer overflow");
        return this.#expr(BigInt.asIntN(64, n), from, to);
    }

    #parseAttributedFunction(from: number, to: number): C.Expr {
        const attributes = this.#parseAttributes();
        if (!this.#at(Tok.Function)) {
            return this.#exprError(from, to, `Expected 'function' declaration after attribute, but got ${this.#describe()} instead`);
        }
        const matchFunction = this.#match();
        this.#take();
        return this.#parseFunctionBody(false, matchFunction, null, null, attributes, false).func;
    }

    // simpleexp ::= NUMBER | STRING | nil | true | false | '...' | tableconstructor | [attributes] function funcbody | ifelseexp | stringinterp | primaryexp
    #parseSimpleExpr(): C.Expr {
        const from = this.#lexer.from, to = this.#lexer.to;
        switch (this.#cur.kind) {
            case Tok.Attribute: case Tok.AttributeOpen:
                return this.#parseAttributedFunction(from, to);
            case Tok.Nil:
                this.#take();
                return this.#expr(L.NIL, from, to);
            case Tok.True: case Tok.False: {
                const value = this.#at(Tok.True);
                this.#take();
                return this.#expr(value, from, to);
            }
            case Tok.Function: {
                const matchFunction = this.#match();
                this.#take();
                return this.#parseFunctionBody(false, matchFunction, null, null, null, false).func;
            }
            case Tok.Number:
                return this.#parseNumber();
            case Tok.RawString: case Tok.String: case Tok.InterpSimple:
                return this.#parseString();
            case Tok.InterpBegin:
                return this.#parseInterpString();
            case Tok.BrokenString:
                this.#take();
                return this.#exprError(from, to, "Malformed string; did you forget to finish it?");
            case Tok.BrokenInterpDoubleBrace:
                this.#take();
                return this.#exprError(from, to, "Double braces are not permitted within interpolated strings; did you mean '\\{'?");
            case Tok.Dots:
                this.#take();
                if (this.#fn().vararg) return this.#expr([L.VARARGS, from], from, to);
                return this.#exprError(from, to, "Cannot use '...' outside of a vararg function");
            case Tok.LBrace:
                return this.#parseTableConstructor();
            case Tok.If:
                return this.#parseIfElseExpr();
        }
        return this.#parsePrimaryExpr(false);
    }

    // the arguments of an attribute: '(' [explist] ')' | tableconstructor | STRING, with each one's span, and what the
    // first one's items are if it is a table
    #parseCallList(): { args: C.Expr[], argSpans: number[], items: ItemInfo[] | null, argsFrom: number, argsTo: number } {
        const items: ItemInfo[] = [];
        this.#itemInfo = items;
        this.#itemInfoOf = null;
        const args: C.Expr[] = [], argSpans: number[] = [];
        let argsFrom: number, argsTo: number;
        if (this.#at(Tok.LParen)) {
            argsFrom = this.#lexer.to;
            const matchParen = this.#match();
            this.#take();
            if (!this.#at(Tok.RParen)) this.#parseExprList(args, argSpans);
            argsTo = this.#lexer.to;
            this.#expectMatchAndConsume(Tok.RParen, matchParen, false);
        } else if (this.#at(Tok.LBrace)) {
            argsFrom = this.#lexer.to;
            args.push(this.#parseTableConstructor());
            argSpans.push(this.#exprFrom, this.#exprTo);
            argsTo = this.#prevTo;
        } else {
            argsFrom = this.#lexer.from;
            argsTo = this.#lexer.to;
            args.push(this.#parseString());
            argSpans.push(this.#exprFrom, this.#exprTo);
        }
        this.#itemInfo = null;
        return { args, argSpans, items: this.#itemInfoOf === args[0] ? items : null, argsFrom, argsTo };
    }

    // args ::= '(' [explist] ')' | tableconstructor | STRING, into `call` (its head and function, or object and method
    // name); `from` to `funcTo` is what is called, and `funcEnd` where it ends, type arguments included
    #parseFunctionArgs(call: unknown[], from: number, funcTo: number, funcEnd: number, self: boolean): C.Expr {
        const k = this.#cur.kind;
        let to: number;
        if (k === Tok.LParen) {
            if (!this.#sameLine(funcEnd, this.#lexer.from)) this.#reportAmbiguousCallError();
            const matchParen = this.#match();
            this.#take();
            if (!this.#at(Tok.RParen)) this.#parseExprList(call as C.Expr[]);
            to = this.#lexer.to;
            this.#expectMatchAndConsume(Tok.RParen, matchParen, false);
        } else if (k === Tok.LBrace) {
            call.push(this.#parseTableConstructor());
            to = this.#exprTo;
        } else if (k === Tok.RawString || k === Tok.String) {
            call.push(this.#parseString());
            to = this.#exprTo;
        } else if (self && !this.#sameLine(funcEnd, this.#lexer.from)) {
            return this.#exprError(from, funcTo, "Expected function call arguments after '('");
        } else {
            return this.#exprError(from, this.#lexer.from, `Expected '(', '{' or <string> when parsing function call, got ${this.#describe()}`);
        }
        call.push(from);
        return this.#expr(call as C.Call | C.Method, from, to);
    }

    #reportAmbiguousCallError(): void {
        this.#reportHere("Ambiguous syntax: this looks like an argument list for a function call, but could also be a start of new statement; use ';' to separate statements");
    }

    // tableconstructor ::= '{' [field {fieldsep field} [fieldsep]] '}'
    #parseTableConstructor(): C.Table {
        const info = this.#itemInfo;
        this.#itemInfo = null;
        const start = this.#lexer.from;
        const matchBrace = this.#match();
        this.#expectAndConsume(Tok.LBrace, "table literal");
        const table: unknown[] = [L.TABLE];
        while (!this.#at(Tok.RBrace)) {
            if (this.#at(Tok.LBracket)) {
                const matchBracket = this.#match();
                this.#take();
                const key = this.#parseExpr();
                this.#expectMatchAndConsume(Tok.RBracket, matchBracket, false);
                this.#expectAndConsume(Tok.Assign, "table field");
                const value = this.#parseExpr();
                info?.push({ key: null, keyFrom: 0, keyTo: 0, value, valueFrom: this.#exprFrom, valueTo: this.#exprTo });
                table.push([L.PAIR, key, value, matchBracket.from]);
            } else if (this.#at(Tok.Name) && this.#lexer.lookahead().kind === Tok.Assign) {
                const name = this.#parseName("table field");
                this.#expectAndConsume(Tok.Assign, "table field");
                const value = this.#parseExpr();
                if (isHead(value, L.FUNCTION)) (value as C.Func)[4] = name.name;
                info?.push({ key: name.name, keyFrom: name.from, keyTo: name.to, value, valueFrom: this.#exprFrom, valueTo: this.#exprTo });
                table.push([L.FIELD, name.name, value, name.from]);
            } else {
                const value = this.#parseExpr();
                info?.push({ key: null, keyFrom: 0, keyTo: 0, value, valueFrom: this.#exprFrom, valueTo: this.#exprTo });
                table.push(value);
            }
            if (this.#at(Tok.Comma) || this.#at(Tok.Semicolon)) this.#take();
            else if (this.#at(Tok.LBracket) || this.#at(Tok.Name)) this.#reportHere("Expected ',' after table constructor element");
            else if (!this.#at(Tok.RBrace)) break;
        }
        let end = this.#lexer.to;
        if (!this.#expectMatchAndConsume(Tok.RBrace, matchBrace, false)) end = this.#prevTo;
        table.push(start);
        if (info !== null) this.#itemInfoOf = table;
        return this.#expr(table as C.Table, start, end);
    }

    // ifelseexp ::= 'if' exp 'then' exp {'elseif' exp 'then' exp} 'else' exp
    #parseIfElseExpr(): C.IfExpr {
        const start = this.#lexer.from;
        this.#take(); // if / elseif
        const condition = this.#parseExpr();
        this.#expectAndConsume(Tok.Then, "if then else expression");
        const trueExpr = this.#parseExpr();
        let falseExpr: C.Expr;
        if (this.#at(Tok.ElseIf)) {
            falseExpr = this.#parseIfElseExpr();
        } else {
            this.#expectAndConsume(Tok.Else, "if then else expression");
            falseExpr = this.#parseExpr();
        }
        return this.#expr([L.IFX, condition, trueExpr, falseExpr, start], start, this.#exprTo);
    }

    // a string token's value (null if an escape is malformed)
    #parseCharArray(): string | null {
        const raw = this.#at(Tok.RawString), text = this.#lexer.text;
        this.#take();
        return raw ? unescapeLong(text) : unescapeQuoted(text);
    }

    #parseString(): C.Expr {
        const from = this.#lexer.from, to = this.#lexer.to;
        const value = this.#parseCharArray();
        if (value === null) return this.#exprError(from, to, "String literal contains malformed escape sequence");
        return this.#expr(value, from, to);
    }

    // stringinterp ::= INTERP_BEGIN exp {INTERP_MID exp} INTERP_END
    #parseInterpString(): C.Expr {
        const interp: unknown[] = [L.INTERP];
        const start = this.#lexer.from;
        let endFrom = start, endTo = this.#lexer.to;
        while (true) {
            const kind = this.#lexer.kind;
            endFrom = this.#lexer.from;
            endTo = this.#lexer.to;
            const chars = unescapeQuoted(this.#lexer.text);
            this.#take();
            if (chars === null) return this.#exprError(start, endTo, "Interpolated string literal contains malformed escape sequence");
            interp.push(chars);
            if (kind === Tok.InterpEnd || kind === Tok.InterpSimple) break;

            const k = this.#cur.kind;
            if (k === Tok.InterpMid || k === Tok.InterpEnd) {
                this.#take();
                interp.push(this.#exprError(endFrom, endTo, "Malformed interpolated string, expected expression inside '{}'"));
                break;
            }
            if (k === Tok.BrokenString) {
                this.#take();
                interp.push(this.#exprError(endFrom, endTo, "Malformed interpolated string; did you forget to add a '`'?"));
                break;
            }
            interp.push(this.#parseExpr());

            switch (this.#cur.kind) {
                case Tok.InterpBegin: case Tok.InterpMid: case Tok.InterpEnd:
                    continue;
                case Tok.BrokenInterpDoubleBrace:
                    this.#take();
                    return this.#exprError(endFrom, endTo, "Double braces are not permitted within interpolated strings; did you mean '\\{'?");
                case Tok.BrokenString:
                case Tok.Eof: {
                    if (this.#at(Tok.BrokenString)) this.#take();
                    interp.push(start);
                    const top = this.#lexer.inInterpolation;
                    if (top === true) this.#report(this.#prevFrom, this.#prevTo, "Malformed interpolated string; did you forget to add a '}'?");
                    else if (top === null) this.#report(this.#prevFrom, this.#prevTo, "Malformed interpolated string; did you forget to add a '`'?");
                    return this.#expr(interp as C.Interp, start, this.#prevTo);
                }
                default:
                    return this.#exprError(endFrom, endTo, `Malformed interpolated string, got ${this.#describe()}`);
            }
        }
        interp.push(start);
        return this.#expr(interp as C.Interp, start, endTo);
    }

    // '<' '<' TypeParams '>' '>'
    #parseTypeInstantiationExpr(): number {
        const begin = this.#match();
        this.#take();
        this.#parseTypeParams();
        const end = this.#lexer.to;
        this.#expectMatchAndConsume(Tok.Gt, begin, false);
        return end;
    }
}
