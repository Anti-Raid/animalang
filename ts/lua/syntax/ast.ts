// The tree the parser makes, after Luau's Ast.h (node and field names follow it), less types: the parser checks them but
// keeps none, as nothing at run time depends on them. Every span is a pair of source offsets [from, to); `lines` of the
// parse result turns an offset into a line and column
import type { Lines } from "./tokens";

type Base<K extends string> = { kind: K, from: number, to: number };

// a variable a declaration binds; name expressions refer to it (ExprLocal)
export class Local {
    constructor(
        readonly name: string,
        readonly from: number,
        readonly to: number,
        readonly isConst: boolean,
    ) {}
}

export type UnaryOp = "not" | "-" | "#";
export type BinaryOp = "+" | "-" | "*" | "/" | "//" | "%" | "^" | ".." | "~=" | "==" | "<" | "<=" | ">" | ">=" | "and" | "or";

export type TableItem = { kind: "list", key: null, value: Expr } | { kind: "record", key: ExprConstantString, value: Expr } | { kind: "general", key: Expr, value: Expr };

// `(e)`, and `e :: T`: both keep one value of a call
export type ExprGroup = Base<"ExprGroup"> & { expr: Expr };
export type ExprConstantNil = Base<"ExprConstantNil">;
export type ExprConstantBool = Base<"ExprConstantBool"> & { value: boolean };
export type ExprConstantNumber = Base<"ExprConstantNumber"> & { value: number };
// its value is a byte string (see unescapeQuoted)
export type ExprConstantString = Base<"ExprConstantString"> & { value: string };
export type ExprLocal = Base<"ExprLocal"> & { local: Local };
export type ExprGlobal = Base<"ExprGlobal"> & { name: string };
export type ExprVarargs = Base<"ExprVarargs">;
export type ExprCall = Base<"ExprCall"> & { func: Expr, args: Expr[], self: boolean };
export type ExprIndexName = Base<"ExprIndexName"> & { expr: Expr, index: string };
export type ExprIndexExpr = Base<"ExprIndexExpr"> & { expr: Expr, index: Expr };
export type ExprFunction = Base<"ExprFunction"> & {
    self: Local | null,
    args: Local[],
    vararg: boolean,
    body: StatBlock,
    debugName: string | null,
};
export type ExprTable = Base<"ExprTable"> & { items: TableItem[] };
export type ExprUnary = Base<"ExprUnary"> & { op: UnaryOp, expr: Expr };
export type ExprBinary = Base<"ExprBinary"> & { op: BinaryOp, left: Expr, right: Expr };
export type ExprIfElse = Base<"ExprIfElse"> & { condition: Expr, trueExpr: Expr, falseExpr: Expr };
export type ExprInterpString = Base<"ExprInterpString"> & { strings: string[], expressions: Expr[] };
// where parsing failed (the error is in the result's errors)
export type ExprError = Base<"ExprError">;

export type Expr =
    | ExprGroup | ExprConstantNil | ExprConstantBool | ExprConstantNumber | ExprConstantString | ExprLocal | ExprGlobal | ExprVarargs
    | ExprCall | ExprIndexName | ExprIndexExpr | ExprFunction | ExprTable | ExprUnary | ExprBinary | ExprIfElse | ExprInterpString
    | ExprError;

export type StatBlock = Base<"StatBlock"> & { body: Stat[] };
export type StatIf = Base<"StatIf"> & { condition: Expr, thenBody: StatBlock, elseBody: StatBlock | StatIf | null };
export type StatWhile = Base<"StatWhile"> & { condition: Expr, body: StatBlock };
export type StatRepeat = Base<"StatRepeat"> & { condition: Expr, body: StatBlock };
export type StatBreak = Base<"StatBreak">;
export type StatContinue = Base<"StatContinue">;
export type StatReturn = Base<"StatReturn"> & { list: Expr[] };
export type StatExpr = Base<"StatExpr"> & { expr: Expr };
export type StatLocal = Base<"StatLocal"> & { vars: Local[], values: Expr[], isConst: boolean };
export type StatFor = Base<"StatFor"> & { var: Local, init: Expr, limit: Expr, step: Expr | null, body: StatBlock };
export type StatForIn = Base<"StatForIn"> & { vars: Local[], values: Expr[], body: StatBlock };
export type StatAssign = Base<"StatAssign"> & { vars: Expr[], values: Expr[] };
export type StatCompoundAssign = Base<"StatCompoundAssign"> & { op: BinaryOp, var: Expr, value: Expr };
export type StatFunction = Base<"StatFunction"> & { name: Expr, func: ExprFunction };
export type StatLocalFunction = Base<"StatLocalFunction"> & { name: Local, func: ExprFunction, isConst: boolean };
// where parsing failed (the error is in the result's errors)
export type StatError = Base<"StatError">;

export type Stat =
    | StatBlock | StatIf | StatWhile | StatRepeat | StatBreak | StatContinue | StatReturn | StatExpr | StatLocal | StatFor | StatForIn
    | StatAssign | StatCompoundAssign | StatFunction | StatLocalFunction | StatError;

export type Node = Expr | Stat;

export type ParseError = { from: number, to: number, message: string };
export type Comment = { kind: "comment" | "blockComment" | "brokenComment", from: number, to: number };
// a comment starting with ! (e.g. --!strict); `header` when it comes before any code
export type HotComment = { header: boolean, from: number, to: number, content: string };

export type ParseResult = {
    root: StatBlock,
    errors: ParseError[],
    lines: Lines,
    lineCount: number,
    hotComments: HotComment[],
    comments: Comment[],
};

type Fields = string[];
const FIELDS = new Map<string, Fields>();
const fieldsOf = (node: Node): Fields => {
    let fields = FIELDS.get(node.kind);
    if (fields === undefined) FIELDS.set(node.kind, fields = Object.keys(node).filter(k => k !== "kind" && typeof (node as any)[k] === "object"));
    return fields;
};

const visit = (v: any, out: Node[]): void => {
    if (v === null || typeof v !== "object" || v instanceof Local) return;
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) visit(v[i], out); return; }
    const c = typeof v.kind === "string" ? v.kind.charCodeAt(0) : 0;
    if (c >= 65 && c <= 90 && typeof v.from === "number") { out.push(v); return; }
    for (const k in v) visit(v[k], out);
};

// the nodes directly inside `node`, in no particular order
export const childNodes = (node: Node, out: Node[] = []): Node[] => {
    const fields = fieldsOf(node);
    for (let i = 0; i < fields.length; i++) visit((node as any)[fields[i]], out);
    return out;
};
