// Luau's parser, after Luau's Parser.cpp (function names and error messages follow it): recursive descent, expressions by
// precedence climbing, errors collected rather than thrown (with error nodes in the tree), and names resolved to the
// locals they refer to as they are parsed
import { Lexer, unescapeLong, unescapeQuoted } from "./lexer";
import { TOK_TEXT, Tok, describe, describeKind, isReserved } from "./tokens";
import { Local } from "./ast";
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
const BINARY: (C.BinaryOp | undefined)[] = TOK_TEXT.map(() => undefined);
const COMPOUND: (C.BinaryOp | undefined)[] = TOK_TEXT.map(() => undefined);
const UNARY: (C.UnaryOp | undefined)[] = TOK_TEXT.map(() => undefined);
// a binary operator binds while its left priority is above the limit; the right one parses its right side
const LEFT = new Uint8Array(TOK_TEXT.length), RIGHT = new Uint8Array(TOK_TEXT.length);
const binary = (kind: Tok, op: C.BinaryOp, left: number, right: number, compound?: Tok) => {
    BINARY[kind] = op;
    LEFT[kind] = left;
    RIGHT[kind] = right;
    if (compound !== undefined) COMPOUND[compound] = op;
};
binary(Tok.Plus, "+", 6, 6, Tok.PlusAssign);
binary(Tok.Minus, "-", 6, 6, Tok.MinusAssign);
binary(Tok.Star, "*", 7, 7, Tok.StarAssign);
binary(Tok.Slash, "/", 7, 7, Tok.SlashAssign);
binary(Tok.FloorDiv, "//", 7, 7, Tok.FloorDivAssign);
binary(Tok.Percent, "%", 7, 7, Tok.PercentAssign);
binary(Tok.Caret, "^", 10, 9, Tok.CaretAssign);
binary(Tok.Concat, "..", 5, 4, Tok.ConcatAssign);
binary(Tok.Ne, "~=", 3, 3);
binary(Tok.Eq, "==", 3, 3);
binary(Tok.Lt, "<", 3, 3);
binary(Tok.Le, "<=", 3, 3);
binary(Tok.Gt, ">", 3, 3);
binary(Tok.Ge, ">=", 3, 3);
binary(Tok.And, "and", 2, 2);
binary(Tok.Or, "or", 1, 1);
UNARY[Tok.Not] = "not";
UNARY[Tok.Minus] = "-";
UNARY[Tok.Hash] = "#";
const UNARY_PRIORITY = 8;

type Span = { from: number, to: number };
type Name = { name: string, from: number, to: number };
type Binding = { name: string, from: number, to: number, isConst: boolean };
// the token an expected closing token matches, for messages
type Match = { kind: Tok, from: number, to: number };
// what a type list held: how many types, whether any is named, whether a pack ends it
type TypeList = { types: number, named: boolean, tail: boolean };
type FunctionState = { vararg: boolean, loopDepth: number };

const isTypeFollow = (k: Tok) => k === Tok.Pipe || k === Tok.Question || k === Tok.Amp;
const isStatLast = (s: C.Stat) => s.kind === "StatBreak" || s.kind === "StatContinue" || s.kind === "StatReturn";
const isConstantLiteral = (e: C.Expr) =>
    e.kind === "ExprConstantNil" || e.kind === "ExprConstantBool" || e.kind === "ExprConstantNumber" || e.kind === "ExprConstantString";
const isLiteralTable = (e: C.Expr): boolean =>
    e.kind === "ExprTable" && e.items.every(i => i.kind !== "general" && (isConstantLiteral(i.value) || isLiteralTable(i.value)));
const ATTRIBUTES: ReadonlySet<string> = new Set(["checked", "native", "deprecated"]);
const NO_TYPES: TypeList = { types: 0, named: false, tail: false };

export const parseLuau = (source: string, options: ParseOptions = {}): C.ParseResult => new Parser(source, options).parse();

class Parser {
    readonly #lexer: Lexer;
    // the span of the previous token
    #prevFrom = 0;
    #prevTo = 0;
    readonly #errors: C.ParseError[] = [];
    readonly #comments: C.Comment[] = [];
    readonly #hotComments: C.HotComment[] = [];
    readonly #locals = new Map<string, Local>();
    readonly #localStack: Local[] = [];
    // what each local on the stack shadows, to restore when it goes out of scope
    readonly #shadowed: (Local | undefined)[] = [];
    readonly #functions: FunctionState[] = [{ vararg: true, loopDepth: 0 }];
    // the locals of the type function being parsed, which may not refer to any other
    #typeFunctionLocals: Set<Local> | null = null;
    // of the last simple type parsed: whether it was a type pack (and one of one type), and where it starts
    #isPack = false;
    #singlePack = false;
    #typeFrom = 0;
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
        let root: C.StatBlock;
        try {
            root = this.#parseChunk();
        } catch (e) {
            const l = this.#lexer;
            if (e instanceof Fatal) this.#errors.push({ from: e.from, to: e.to, message: e.message });
            else if (e instanceof RangeError) this.#errors.push({ from: l.from, to: l.to, message: "Exceeded allowed recursion depth; the program is nested too deeply to parse" });
            else throw e;
            root = { kind: "StatBlock", from: l.from, to: l.to, body: [] };
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

    #exprError(from: number, to: number, message: string): C.ExprError {
        this.#report(from, to, message);
        return { kind: "ExprError", from, to };
    }

    #statError(from: number, to: number, message: string): C.StatError {
        this.#report(from, to, message);
        return { kind: "StatError", from, to };
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
        if (!this.#sameLine(open, at) && this.#column(at) !== this.#column(open) && !this.#sameLine(this.#endMismatchSuspect.from, open)) {
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

    // whether offsets a <= b are on one line: the text between them is usually short
    #column(offset: number): number {
        return offset === 0 ? 0 : offset - this.source.lastIndexOf("\n", offset - 1) - 1;
    }

    #sameLine(a: number, b: number): boolean {
        const i = this.source.indexOf("\n", a);
        return i === -1 || i >= b;
    }

    #pushLocal(b: Binding): Local {
        const local = new Local(b.name, b.from, b.to, b.isConst);
        this.#shadowed.push(this.#locals.get(b.name));
        this.#locals.set(b.name, local);
        this.#localStack.push(local);
        this.#typeFunctionLocals?.add(local);
        return local;
    }

    #saveLocals(): number {
        return this.#localStack.length;
    }

    #restoreLocals(n: number): void {
        for (let i = this.#localStack.length - 1; i >= n; i--) {
            const name = this.#localStack[i].name, shadowed = this.#shadowed[i];
            if (shadowed !== undefined) this.#locals.set(name, shadowed);
            else this.#locals.delete(name);
        }
        this.#localStack.length = n;
        this.#shadowed.length = n;
    }

    // --- blocks and statements ---

    #blockFollow(): boolean {
        const k = this.#cur.kind;
        return k === Tok.Eof || k === Tok.Else || k === Tok.ElseIf || k === Tok.End || k === Tok.Until;
    }

    #parseChunk(): C.StatBlock {
        const block = this.#parseBlock();
        if (!this.#at(Tok.Eof)) this.#expectAndConsumeFail(Tok.Eof, null);
        return block;
    }

    #parseBlock(): C.StatBlock {
        const n = this.#saveLocals();
        const block = this.#parseBlockNoScope();
        this.#restoreLocals(n);
        return block;
    }

    #parseBlockNoScope(): C.StatBlock {
        const body: C.Stat[] = [];
        const from = this.#prevTo;
        while (!this.#blockFollow()) {
            const stat = this.#parseStat();
            if (stat === null) {
                if (this.#at(Tok.Semicolon)) this.#take();
                continue;
            }
            if (this.#at(Tok.Semicolon)) {
                this.#take();
                stat.to = this.#prevTo;
            }
            body.push(stat);
            if (isStatLast(stat)) break;
        }
        return { kind: "StatBlock", from, to: this.#lexer.from, body };
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
        if (expr.kind === "ExprCall") return { kind: "StatExpr", from: expr.from, to: expr.to, expr };
        if (this.#at(Tok.Comma) || this.#at(Tok.Assign)) return this.#parseAssignment(expr);
        const op = COMPOUND[this.#cur.kind];
        if (op !== undefined) return this.#parseCompoundAssignment(expr, op);

        // neither: a context-sensitive keyword
        const ident = expr.kind === "ExprGlobal" ? expr.name : expr.kind === "ExprLocal" ? expr.local.name : null;
        if (ident === "type") return this.#parseTypeAlias();
        if (ident === "export" && this.#isName("type")) {
            this.#take();
            return this.#parseTypeAlias();
        }
        if (ident === "continue") return this.#parseContinue(expr.from, expr.to);
        if (ident === "const") return this.#parseLocal(expr.from, null, true);

        // the lexer could not move at all: skip the token, as statements are parsed in a loop
        if (start === this.#lexer.from) this.#take();
        return this.#statError(expr.from, expr.to, "Incomplete statement: expected assignment or a function call");
    }

    #parseIf(): C.StatIf {
        const start = this.#lexer.from;
        this.#take(); // if / elseif
        const condition = this.#parseExpr();
        const matchThen = this.#match();
        this.#expectAndConsume(Tok.Then, "if statement");
        const thenBody = this.#parseBlock();

        let elseBody: C.StatBlock | C.StatIf | null = null;
        let end: number;
        if (this.#at(Tok.ElseIf)) {
            elseBody = this.#parseIf();
            end = elseBody.to;
        } else {
            let matchThenElse = matchThen;
            if (this.#at(Tok.Else)) {
                matchThenElse = this.#match();
                this.#take();
                const block = this.#parseBlock();
                block.from = matchThenElse.to;
                elseBody = block;
            }
            end = this.#lexer.to;
            this.#expectMatchEndAndConsume(Tok.End, matchThenElse);
        }
        return { kind: "StatIf", from: start, to: end, condition, thenBody, elseBody };
    }

    #parseWhile(): C.StatWhile {
        const start = this.#lexer.from;
        this.#take();
        const condition = this.#parseExpr();
        const matchDo = this.#match();
        this.#expectAndConsume(Tok.Do, "while loop");
        this.#fn().loopDepth++;
        const body = this.#parseBlock();
        this.#fn().loopDepth--;
        const end = this.#lexer.to;
        this.#expectMatchEndAndConsume(Tok.End, matchDo);
        return { kind: "StatWhile", from: start, to: end, condition, body };
    }

    #parseRepeat(): C.StatRepeat {
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
        return { kind: "StatRepeat", from: matchRepeat.from, to: condition.to, condition, body };
    }

    // do block end: the block itself, with the keywords
    #parseDo(): C.StatBlock {
        const matchDo = this.#match();
        this.#take();
        const body = this.#parseBlock();
        body.from = matchDo.from;
        const end = this.#lexer.to;
        if (this.#expectMatchEndAndConsume(Tok.End, matchDo)) body.to = end;
        return body;
    }

    #parseBreak(): C.Stat {
        const from = this.#lexer.from, to = this.#lexer.to;
        this.#take();
        if (this.#fn().loopDepth === 0) return this.#statError(from, to, "break statement must be inside a loop");
        return { kind: "StatBreak", from, to };
    }

    #parseContinue(from: number, to: number): C.Stat {
        if (this.#fn().loopDepth === 0) return this.#statError(from, to, "continue statement must be inside a loop");
        return { kind: "StatContinue", from, to };
    }

    #parseFor(): C.StatFor | C.StatForIn {
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
            const end = this.#lexer.to;
            this.#expectMatchEndAndConsume(Tok.End, matchDo);
            return { kind: "StatFor", from: start, to: end, var: variable, init, limit, step, body };
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
        const end = this.#lexer.to;
        this.#expectMatchEndAndConsume(Tok.End, matchDo);
        return { kind: "StatForIn", from: start, to: end, vars, values, body };
    }

    // funcname ::= Name {'.' Name} [':' Name], as a chain of index expressions
    #parseFunctionName(): { expr: C.Expr, hasSelf: boolean, debugName: string | null } {
        let debugName = this.#at(Tok.Name) ? this.#cur.text : null;
        let expr = this.#parseNameExpr("function name");
        while (this.#at(Tok.Dot)) {
            this.#take();
            const name = this.#parseName("field name");
            debugName = name.name;
            expr = { kind: "ExprIndexName", from: expr.from, to: name.to, expr, index: name.name };
        }
        let hasSelf = false;
        if (this.#at(Tok.Colon)) {
            this.#take();
            const name = this.#parseName("method name");
            debugName = name.name;
            expr = { kind: "ExprIndexName", from: expr.from, to: name.to, expr, index: name.name };
            hasSelf = true;
        }
        return { expr, hasSelf, debugName };
    }

    #isLValue(e: C.Expr): boolean {
        return (e.kind === "ExprLocal" && !e.local.isConst) || e.kind === "ExprGlobal" || e.kind === "ExprIndexExpr" || e.kind === "ExprIndexName";
    }

    #lvalueError(e: C.Expr): C.ExprError {
        if (e.kind === "ExprLocal" && e.local.isConst) return this.#exprError(e.from, e.to, `Variable '${e.local.name}' is constant and may not be reassigned`);
        return this.#exprError(e.from, e.to, "Assigned expression must be a variable or a field");
    }

    #parseFunctionStat(attributes: Span | null, start: number): C.StatFunction {
        const matchFunction = this.#match();
        this.#take();
        let { expr, hasSelf, debugName } = this.#parseFunctionName();
        if (!this.#isLValue(expr)) expr = this.#lvalueError(expr);
        this.#stop(Tok.End, 1);
        const func = this.#parseFunctionBody(hasSelf, matchFunction, debugName, null, attributes, false).func;
        this.#stop(Tok.End, -1);
        return { kind: "StatFunction", from: start, to: func.to, name: expr, func };
    }

    #validateAttribute(from: number, to: number, name: string, seen: string[], args: C.Expr[]): void {
        if (!ATTRIBUTES.has(name)) {
            this.#report(from, to, name === "" ? "Attribute name is missing" : `Invalid attribute '@${name}'`);
            return;
        }
        if (seen.includes(name)) this.#report(from, to, `Cannot duplicate attribute '@${name}'`);
        seen.push(name);
        if (name === "deprecated" && args.length > 0) {
            if (args.length > 1) this.#report(from, to, "@deprecated can be parametrized only by 1 argument");
            else if (args[0].kind !== "ExprTable") this.#report(args[0].from, args[0].to, "Unknown argument type for @deprecated");
            else for (const item of args[0].items) {
                if (item.kind === "record") {
                    const key = item.key.value;
                    if (key !== "use" && key !== "reason") {
                        this.#report(item.key.from, item.key.to, `Unknown argument '${key}' for @deprecated. Only string constants for 'use' and 'reason' are allowed`);
                    } else if (item.value.kind !== "ExprConstantString") {
                        this.#report(item.value.from, item.value.to, `Only constant string allowed as value for '${key}'`);
                    }
                } else {
                    this.#report(item.value.from, item.value.to, "Only constants keys 'use' and 'reason' are allowed for @deprecated attribute");
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
                this.#validateAttribute(from, to, this.#lexer.text, seen, []);
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
                        const { args, argsFrom, argsTo } = this.#parseCallList();
                        for (const arg of args) {
                            if (!isConstantLiteral(arg) && !isLiteralTable(arg)) this.#report(argsFrom, argsTo, "Only literals can be passed as arguments for attributes");
                        }
                        this.#validateAttribute(name.from, name.to, name.name, seen, args);
                        first ??= { from: name.from, to: argsTo };
                    } else {
                        this.#validateAttribute(name.from, name.to, name.name, seen, []);
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
            return { kind: "StatLocalFunction", from: start, to: func.to, name: local!, func, isConst };
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
        const vars = names.map(b => this.#pushLocal(b));
        const end = values.length === 0 ? this.#prevTo : values[values.length - 1].to;
        const node: C.StatLocal = { kind: "StatLocal", from: start, to: end, vars, values, isConst };
        // a const that definitely gets no value (`const x`, `const a, b = 1`) can only ever be nil
        if (isConst) {
            const last = values[values.length - 1];
            const enough = (last !== undefined && (last.kind === "ExprCall" || last.kind === "ExprVarargs")) || values.length === vars.length;
            if (!enough) this.#report(start, end, "Missing initializer in const declaration");
        }
        return node;
    }

    #parseReturn(): C.StatReturn {
        const start = this.#lexer.from;
        let end = this.#lexer.to;
        this.#take();
        const list: C.Expr[] = [];
        if (!this.#blockFollow() && !this.#at(Tok.Semicolon)) this.#parseExprList(list);
        if (list.length > 0) end = list[list.length - 1].to;
        return { kind: "StatReturn", from: start, to: end, list };
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

    #parseAssignment(initial: C.Expr): C.StatAssign {
        const first = this.#isLValue(initial) ? initial : this.#lvalueError(initial);
        const vars: C.Expr[] = [first];
        while (this.#at(Tok.Comma)) {
            this.#take();
            const e = this.#parsePrimaryExpr(true);
            vars.push(this.#isLValue(e) ? e : this.#lvalueError(e));
        }
        this.#expectAndConsume(Tok.Assign, "assignment");
        const values: C.Expr[] = [];
        this.#parseExprList(values);
        return { kind: "StatAssign", from: first.from, to: values[values.length - 1].to, vars, values };
    }

    #parseCompoundAssignment(initial: C.Expr, op: C.BinaryOp): C.StatCompoundAssign {
        const target = this.#isLValue(initial) ? initial : this.#lvalueError(initial);
        this.#take();
        const value = this.#parseExpr();
        return { kind: "StatCompoundAssign", from: target.from, to: value.to, op, var: target, value };
    }

    // funcbody ::= ['<' generics '>'] '(' [parlist] ')' [':' ReturnType] block 'end'
    #parseFunctionBody(hasSelf: boolean, matchFunction: Match, debugName: string | null, localName: Name | null, attributes: Span | null, isConst: boolean):
        { func: C.ExprFunction, local: Local | null } {
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
        const self = hasSelf ? this.#pushLocal({ name: "self", from: start.from, to: start.to, isConst: false }) : null;
        const vars = args.map(b => this.#pushLocal(b));
        const body = this.#parseBlock();
        this.#functions.pop();
        this.#restoreLocals(n);
        const end = this.#lexer.to;
        this.#expectMatchEndAndConsume(Tok.End, matchFunction);
        const func: C.ExprFunction = ({
            kind: "ExprFunction", from: start.from, to: end, self, args: vars, vararg, body, debugName,
        });
        return { func, local };
    }

    #parseExprList(result: C.Expr[]): void {
        result.push(this.#parseExpr());
        while (this.#at(Tok.Comma)) {
            this.#take();
            if (this.#at(Tok.RParen)) {
                this.#reportHere("Expected expression after ',' but got ')' instead");
                break;
            }
            result.push(this.#parseExpr());
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
            uop = "not";
        }
        if (uop !== undefined) {
            this.#take();
            const sub = this.#parseExpr(UNARY_PRIORITY);
            expr = { kind: "ExprUnary", from: start, to: sub.to, op: uop, expr: sub };
        } else {
            expr = this.#parseAssertionExpr();
        }
        let op = this.#binaryOp(limit);
        while (op !== undefined && LEFT[op] > limit) {
            this.#take();
            const right = this.#parseExpr(RIGHT[op]);
            expr = { kind: "ExprBinary", from: start, to: right.to, op: BINARY[op]!, left: expr, right };
            op = this.#binaryOp(limit);
        }
        return expr;
    }

    #parseNameExpr(context: string): C.Expr {
        const name = this.#parseNameOpt(context);
        if (name === null) return { kind: "ExprError", from: this.#lexer.from, to: this.#lexer.to };
        const local = this.#locals.get(name.name);
        if (local !== undefined) {
            if (this.#typeFunctionLocals !== null && !this.#typeFunctionLocals.has(local)) return this.#exprError(this.#lexer.from, this.#lexer.to, `Type function cannot reference outer local '${local.name}'`);
            return { kind: "ExprLocal", from: name.from, to: name.to, local };
        }
        return { kind: "ExprGlobal", from: name.from, to: name.to, name: name.name };
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
        return { kind: "ExprGroup", from: start, to: end, expr };
    }

    // primaryexp ::= prefixexp {'.' NAME | '[' exp ']' | ':' NAME funcargs | funcargs | '<<' types '>>'}
    #parsePrimaryExpr(asStatement: boolean): C.Expr {
        const start = this.#lexer.from;
        let expr = this.#parsePrefixExpr();
        // where the expression so far ends, type arguments included
        let end = expr.to;
        while (true) {
            const k = this.#cur.kind;
            if (k === Tok.Dot) {
                const dot = this.#lexer.from;
                this.#take();
                const index = this.#parseIndexName(null, dot);
                expr = { kind: "ExprIndexName", from: start, to: index.to, expr, index: index.name };
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
                expr = this.#parseFunctionArgs(expr, false, end);
            } else if (k === Tok.LBrace || k === Tok.RawString || k === Tok.String) {
                expr = this.#parseFunctionArgs(expr, false, end);
            } else if (k === Tok.Lt && this.#lexer.lookahead().kind === Tok.Lt) {
                end = this.#parseTypeInstantiationExpr();
                continue;
            } else {
                break;
            }
            end = expr.to;
        }
        return expr;
    }

    #parseIndexExpr(start: number, expr: C.Expr): C.ExprIndexExpr {
        const matchBracket = this.#match();
        this.#take();
        const index = this.#parseExpr();
        const end = this.#lexer.to;
        this.#expectMatchAndConsume(Tok.RBracket, matchBracket, false);
        return { kind: "ExprIndexExpr", from: start, to: end, expr, index };
    }

    #parseMethodCall(start: number, expr: C.Expr): C.Expr {
        const colon = this.#lexer.from;
        this.#take();
        const index = this.#parseIndexName("method name", colon);
        const func: C.ExprIndexName = { kind: "ExprIndexName", from: start, to: index.to, expr, index: index.name };
        if (this.#at(Tok.Lt) && this.#lexer.lookahead().kind === Tok.Lt) this.#parseTypeInstantiationExpr();
        return this.#parseFunctionArgs(func, true, func.to);
    }

    // asexp ::= simpleexp ['::' Type]
    #parseAssertionExpr(): C.Expr {
        const start = this.#lexer.from;
        const expr = this.#parseSimpleExpr();
        if (!this.#at(Tok.DoubleColon)) return expr;
        this.#take();
        const to = this.#parseType();
        return { kind: "ExprGroup", from: start, to, expr };
    }

    #parseNumber(): C.Expr {
        const from = this.#lexer.from, to = this.#lexer.to, text = this.#lexer.text, lexed = this.#lexer.value;
        this.#take();
        // the common case: a short run of digits, valued by the lexer
        if (!Number.isNaN(lexed)) return { kind: "ExprConstantNumber", from, to, value: lexed };
        const s = text.indexOf("_") === -1 ? text : text.replace(/_/g, "");
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
        return { kind: "ExprConstantNumber", from, to, value };
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
            case Tok.Nil: {
                this.#take();
                return { kind: "ExprConstantNil", from, to };
            }
            case Tok.True: case Tok.False: {
                const value = this.#at(Tok.True);
                this.#take();
                return { kind: "ExprConstantBool", from, to, value };
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
            case Tok.BrokenString: {
                this.#take();
                return this.#exprError(from, to, "Malformed string; did you forget to finish it?");
            }
            case Tok.BrokenInterpDoubleBrace: {
                this.#take();
                return this.#exprError(from, to, "Double braces are not permitted within interpolated strings; did you mean '\\{'?");
            }
            case Tok.Dots: {
                this.#take();
                if (this.#fn().vararg) return { kind: "ExprVarargs", from, to };
                return this.#exprError(from, to, "Cannot use '...' outside of a vararg function");
            }
            case Tok.LBrace:
                return this.#parseTableConstructor();
            case Tok.If:
                return this.#parseIfElseExpr();
        }
        return this.#parsePrimaryExpr(false);
    }

    // the arguments of an attribute: '(' [explist] ')' | tableconstructor | STRING
    #parseCallList(): { args: C.Expr[], argsFrom: number, argsTo: number } {
        if (this.#at(Tok.LParen)) {
            const argsFrom = this.#lexer.to;
            const matchParen = this.#match();
            this.#take();
            const args: C.Expr[] = [];
            if (!this.#at(Tok.RParen)) this.#parseExprList(args);
            const argsTo = this.#lexer.to;
            this.#expectMatchAndConsume(Tok.RParen, matchParen, false);
            return { args, argsFrom, argsTo };
        }
        if (this.#at(Tok.LBrace)) {
            const argsFrom = this.#lexer.to;
            const e = this.#parseTableConstructor();
            return { args: [e], argsFrom, argsTo: this.#prevTo };
        }
        const argsFrom = this.#lexer.from, argsTo = this.#lexer.to;
        return { args: [this.#parseString()], argsFrom, argsTo };
    }

    // args ::= '(' [explist] ')' | tableconstructor | STRING
    // the call of `func`, which ends at `funcEnd` (after any type arguments)
    #parseFunctionArgs(func: C.Expr, self: boolean, funcEnd: number): C.Expr {
        const k = this.#cur.kind;
        if (k === Tok.LParen) {
            if (!this.#sameLine(funcEnd, this.#lexer.from)) this.#reportAmbiguousCallError();
            const matchParen = this.#match();
            this.#take();
            const args: C.Expr[] = [];
            if (!this.#at(Tok.RParen)) this.#parseExprList(args);
            const end = this.#lexer.to;
            this.#expectMatchAndConsume(Tok.RParen, matchParen, false);
            return { kind: "ExprCall", from: func.from, to: end, func, args, self };
        }
        if (k === Tok.LBrace) {
            const arg = this.#parseTableConstructor();
            return { kind: "ExprCall", from: func.from, to: arg.to, func, args: [arg], self };
        }
        if (k === Tok.RawString || k === Tok.String) {
            const arg = this.#parseString();
            return { kind: "ExprCall", from: func.from, to: arg.to, func, args: [arg], self };
        }
        if (self && !this.#sameLine(funcEnd, this.#lexer.from)) return this.#exprError(func.from, func.to, "Expected function call arguments after '('");
        return this.#exprError(func.from, this.#lexer.from, `Expected '(', '{' or <string> when parsing function call, got ${this.#describe()}`);
    }

    #reportAmbiguousCallError(): void {
        this.#reportHere("Ambiguous syntax: this looks like an argument list for a function call, but could also be a start of new statement; use ';' to separate statements");
    }

    // tableconstructor ::= '{' [field {fieldsep field} [fieldsep]] '}'
    #parseTableConstructor(): C.ExprTable {
        const start = this.#lexer.from;
        const matchBrace = this.#match();
        this.#expectAndConsume(Tok.LBrace, "table literal");
        const items: C.TableItem[] = [];
        while (!this.#at(Tok.RBrace)) {
            if (this.#at(Tok.LBracket)) {
                const matchBracket = this.#match();
                this.#take();
                const key = this.#parseExpr();
                this.#expectMatchAndConsume(Tok.RBracket, matchBracket, false);
                this.#expectAndConsume(Tok.Assign, "table field");
                items.push({ kind: "general", key, value: this.#parseExpr() });
            } else if (this.#at(Tok.Name) && this.#lexer.lookahead().kind === Tok.Assign) {
                const name = this.#parseName("table field");
                this.#expectAndConsume(Tok.Assign, "table field");
                const key: C.ExprConstantString = { kind: "ExprConstantString", from: name.from, to: name.to, value: name.name };
                const value = this.#parseExpr();
                if (value.kind === "ExprFunction") value.debugName = name.name;
                items.push({ kind: "record", key, value });
            } else {
                items.push({ kind: "list", key: null, value: this.#parseExpr() });
            }
            if (this.#at(Tok.Comma) || this.#at(Tok.Semicolon)) this.#take();
            else if (this.#at(Tok.LBracket) || this.#at(Tok.Name)) this.#reportHere("Expected ',' after table constructor element");
            else if (!this.#at(Tok.RBrace)) break;
        }
        let end = this.#lexer.to;
        if (!this.#expectMatchAndConsume(Tok.RBrace, matchBrace, false)) end = this.#prevTo;
        return { kind: "ExprTable", from: start, to: end, items };
    }

    // ifelseexp ::= 'if' exp 'then' exp {'elseif' exp 'then' exp} 'else' exp
    #parseIfElseExpr(): C.ExprIfElse {
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
        return { kind: "ExprIfElse", from: start, to: falseExpr.to, condition, trueExpr, falseExpr };
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
        return { kind: "ExprConstantString", from, to, value };
    }

    // stringinterp ::= INTERP_BEGIN exp {INTERP_MID exp} INTERP_END
    #parseInterpString(): C.Expr {
        const strings: string[] = [];
        const expressions: C.Expr[] = [];
        const start = this.#lexer.from;
        let endFrom = start, endTo = this.#lexer.to;
        while (true) {
            const kind = this.#lexer.kind;
            endFrom = this.#lexer.from;
            endTo = this.#lexer.to;
            const chars = unescapeQuoted(this.#lexer.text);
            this.#take();
            if (chars === null) return this.#exprError(start, endTo, "Interpolated string literal contains malformed escape sequence");
            strings.push(chars);
            if (kind === Tok.InterpEnd || kind === Tok.InterpSimple) break;

            const k = this.#cur.kind;
            if (k === Tok.InterpMid || k === Tok.InterpEnd) {
                this.#take();
                expressions.push(this.#exprError(endFrom, endTo, "Malformed interpolated string, expected expression inside '{}'"));
                break;
            }
            if (k === Tok.BrokenString) {
                this.#take();
                expressions.push(this.#exprError(endFrom, endTo, "Malformed interpolated string; did you forget to add a '`'?"));
                break;
            }
            expressions.push(this.#parseExpr());

            switch (this.#cur.kind) {
                case Tok.InterpBegin: case Tok.InterpMid: case Tok.InterpEnd:
                    continue;
                case Tok.BrokenInterpDoubleBrace:
                    this.#take();
                    return this.#exprError(endFrom, endTo, "Double braces are not permitted within interpolated strings; did you mean '\\{'?");
                case Tok.BrokenString:
                case Tok.Eof: {
                    if (this.#at(Tok.BrokenString)) this.#take();
                    const node: C.ExprInterpString = { kind: "ExprInterpString", from: start, to: this.#prevTo, strings, expressions };
                    const top = this.#lexer.inInterpolation;
                    if (top === true) this.#report(this.#prevFrom, this.#prevTo, "Malformed interpolated string; did you forget to add a '}'?");
                    else if (top === null) this.#report(this.#prevFrom, this.#prevTo, "Malformed interpolated string; did you forget to add a '`'?");
                    return node;
                }
                default:
                    return this.#exprError(endFrom, endTo, `Malformed interpolated string, got ${this.#describe()}`);
            }
        }
        return { kind: "ExprInterpString", from: start, to: endTo, strings, expressions };
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
