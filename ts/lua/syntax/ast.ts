// The tree the parser makes, as prefix forms: [HEAD, ...operands, offset], HEAD one of L's symbols and offset where the
// form starts in the source (`lines` of the parse result turns it into a line and column). Constants are themselves
// (numbers, byte strings, booleans, L.NIL); a local is the symbol its declaration made, one per declaration, so two
// locals of one name are two symbols; lists (of locals, of values) are plain arrays. Types are checked but not kept
import type { Lines } from "./tokens";

const NIL: unique symbol = Symbol("nil");
const GLOBAL: unique symbol = Symbol("global");
const VARARGS: unique symbol = Symbol("...");
const ONE: unique symbol = Symbol("one");
const CALL: unique symbol = Symbol("call");
const METHOD: unique symbol = Symbol("method");
const INDEX: unique symbol = Symbol("index");
const FUNCTION: unique symbol = Symbol("function");
const TABLE: unique symbol = Symbol("table");
const FIELD: unique symbol = Symbol("field");
const PAIR: unique symbol = Symbol("pair");
const IFX: unique symbol = Symbol("ifx");
const INTERP: unique symbol = Symbol("interp");
const ADD: unique symbol = Symbol("+");
const SUB: unique symbol = Symbol("-");
const MUL: unique symbol = Symbol("*");
const DIV: unique symbol = Symbol("/");
const IDIV: unique symbol = Symbol("//");
const MOD: unique symbol = Symbol("%");
const POW: unique symbol = Symbol("^");
const CONCAT: unique symbol = Symbol("..");
const EQ: unique symbol = Symbol("==");
const NE: unique symbol = Symbol("~=");
const LT: unique symbol = Symbol("<");
const LE: unique symbol = Symbol("<=");
const GT: unique symbol = Symbol(">");
const GE: unique symbol = Symbol(">=");
const AND: unique symbol = Symbol("and");
const OR: unique symbol = Symbol("or");
const NEG: unique symbol = Symbol("neg");
const NOT: unique symbol = Symbol("not");
const LEN: unique symbol = Symbol("#");
const BLOCK: unique symbol = Symbol("block");
const LOCAL: unique symbol = Symbol("local");
const LOCALFN: unique symbol = Symbol("localfn");
const ASSIGN: unique symbol = Symbol("assign");
const OPSET: unique symbol = Symbol("opset");
const IF: unique symbol = Symbol("if");
const WHILE: unique symbol = Symbol("while");
const REPEAT: unique symbol = Symbol("repeat");
const FOR: unique symbol = Symbol("for");
const FORIN: unique symbol = Symbol("forin");
const RETURN: unique symbol = Symbol("return");
const BREAK: unique symbol = Symbol("break");
const CONTINUE: unique symbol = Symbol("continue");
const ERROR: unique symbol = Symbol("error");

export const L = {
    // the nil constant, not a head
    NIL,
    GLOBAL, VARARGS, ONE, CALL, METHOD, INDEX, FUNCTION, TABLE, FIELD, PAIR, IFX, INTERP,
    ADD, SUB, MUL, DIV, IDIV, MOD, POW, CONCAT, EQ, NE, LT, LE, GT, GE, AND, OR, NEG, NOT, LEN,
    BLOCK, LOCAL, LOCALFN, ASSIGN, OPSET, IF, WHILE, REPEAT, FOR, FORIN, RETURN, BREAK, CONTINUE, ERROR,
} as const;

// where a form starts in the source
export type Offset = number;
export type Local = symbol;
export type Constant = number | string | boolean | typeof NIL;

export type BinaryHead =
    | typeof ADD | typeof SUB | typeof MUL | typeof DIV | typeof IDIV | typeof MOD | typeof POW | typeof CONCAT
    | typeof EQ | typeof NE | typeof LT | typeof LE | typeof GT | typeof GE | typeof AND | typeof OR;
export type UnaryHead = typeof NEG | typeof NOT | typeof LEN;

export type Global = [typeof GLOBAL, string, Offset];
export type Varargs = [typeof VARARGS, Offset];
// (e) and e :: T: one value of a call
export type One = [typeof ONE, Expr, Offset];
export type Call = [typeof CALL, Expr, ...Expr[], Offset];
// obj:name(args)
export type Method = [typeof METHOD, Expr, string, ...Expr[], Offset];
export type Index = [typeof INDEX, Expr, Expr, Offset];
// a method's `self` is its first parameter
export type Func = [typeof FUNCTION, Local[], boolean, Block, string | null, Offset];
// name = value, and [key] = value; other items are values
export type Field = [typeof FIELD, string, Expr, Offset];
export type Pair = [typeof PAIR, Expr, Expr, Offset];
export type Table = [typeof TABLE, ...(Expr | Field | Pair)[], Offset];
export type IfExpr = [typeof IFX, Expr, Expr, Expr, Offset];
// the strings between the expressions: `a{x}b` is [INTERP, "a", x, "b"]
export type Interp = [typeof INTERP, ...(string | Expr)[], Offset];
export type Binary = [BinaryHead, Expr, Expr, Offset];
export type Unary = [UnaryHead, Expr, Offset];
// where parsing failed (the error is in the result's errors)
export type ErrorForm = [typeof ERROR, Offset];

export type ExprForm = Global | Varargs | One | Call | Method | Index | Func | Table | IfExpr | Interp | Binary | Unary | ErrorForm;
export type Expr = Constant | Local | ExprForm;

export type Block = [typeof BLOCK, ...Stat[], Offset];
export type LocalStat = [typeof LOCAL, Local[], Expr[], Offset];
// local function: its local is in scope in its body
export type LocalFunction = [typeof LOCALFN, Local, Func, Offset];
// also `function name() end`
export type Assign = [typeof ASSIGN, Expr[], Expr[], Offset];
export type OpSet = [typeof OPSET, BinaryHead, Expr, Expr, Offset];
export type If = [typeof IF, Expr, Block, Block | If | null, Offset];
export type While = [typeof WHILE, Expr, Block, Offset];
// its body's locals are in scope in its condition
export type Repeat = [typeof REPEAT, Block, Expr, Offset];
export type For = [typeof FOR, Local, Expr, Expr, Expr | null, Block, Offset];
export type ForIn = [typeof FORIN, Local[], Expr[], Block, Offset];
export type Return = [typeof RETURN, ...Expr[], Offset];
export type Break = [typeof BREAK, Offset];
export type Continue = [typeof CONTINUE, Offset];

export type Stat = Block | LocalStat | LocalFunction | Assign | OpSet | If | While | Repeat | For | ForIn | Return | Break | Continue | Call | Method | ErrorForm;
export type Form = ExprForm | Stat | Field | Pair;

const HEADS: ReadonlySet<symbol> = new Set(Object.values(L).filter(h => h !== NIL));
// whether v is a form (a list of locals starts with a symbol too, but not with a head)
export const isForm = (v: unknown): v is Form => Array.isArray(v) && HEADS.has(v[0]);
export const offsetOf = (form: Form): Offset => form[form.length - 1] as Offset;

export type ParseError = { from: number, to: number, message: string };
export type Comment = { kind: "comment" | "blockComment" | "brokenComment", from: number, to: number };
// a comment starting with ! (e.g. --!strict); `header` when it comes before any code
export type HotComment = { header: boolean, from: number, to: number, content: string };

export type ParseResult = {
    root: Block,
    errors: ParseError[],
    lines: Lines,
    lineCount: number,
    hotComments: HotComment[],
    comments: Comment[],
};
