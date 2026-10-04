// Luau's tree (syntax/ast.ts) lowered to the VM's core forms. So far: locals, assignment (to locals and globals),
// compound assignment, do blocks, return, literals, arithmetic and concatenation; the rest is "not supported yet"
import { CORE_BEGIN, CORE_BLOCK, CORE_ESCAPE, CORE_INTCALL, CORE_LET, CORE_SET, type SourcePos } from "../common";
import { L, isForm, offsetOf, type ParseResult } from "./syntax/ast";
import type * as C from "./syntax/ast";

export class LuauSyntaxError extends Error {
    constructor(readonly pos: SourcePos, readonly reason: string) {
        super(`${pos.file}:${pos.line}: ${reason}`);
    }
}

const RETURN = Symbol("return");

const ARITH: ReadonlyMap<symbol, string> = new Map([
    [L.ADD, "add"], [L.SUB, "sub"], [L.MUL, "mul"], [L.DIV, "div"], [L.IDIV, "idiv"], [L.MOD, "mod"], [L.POW, "pow"],
]);

const intcall = (pos: SourcePos | null, name: string, ...args: any[]) => [CORE_INTCALL, pos, Symbol.for(name), ...args];

const values = (pos: SourcePos | null, exprs: any[]) => exprs.length === 1 ? exprs[0] : intcall(pos, "%values", ...exprs);

class Lowering {
    constructor(readonly parsed: ParseResult, readonly file: string) {}

    pos(form: C.Form): SourcePos {
        const { line, column } = this.parsed.lines.pos(offsetOf(form));
        return { file: this.file, line: line + 1, col: column + 1 };
    }

    unsupported(form: C.Form, what: string): never {
        throw new LuauSyntaxError(this.pos(form), `${what} is not supported yet`);
    }

    chunk(): any[] {
        const root = this.parsed.root;
        const pos = this.pos(root);
        return [CORE_BLOCK, pos, RETURN, ...this.statements(root), intcall(pos, "%values")];
    }

    // a block's statements as a list of forms, each local statement binding the rest of the block
    statements(block: C.Block): any[] {
        let rest: any[] = [];
        for (let i = block.length - 2; i >= 1; i--) {
            const stat = block[i] as C.Stat;
            if (stat[0] === L.LOCAL) rest = [this.local(stat as C.LocalStat, rest)];
            else rest.unshift(this.statement(stat));
        }
        return rest;
    }

    local(stat: C.LocalStat, body: any[]): any[] {
        const [, names, exprs] = stat;
        const inits = exprs.map(e => this.expr(e));
        const bindings = names.map((name, i) => [name, i < inits.length ? inits[i] : undefined]);
        for (let i = names.length; i < inits.length; i++) bindings.push([Symbol("_"), inits[i]]);
        return [CORE_LET, this.pos(stat), bindings, ...body];
    }

    statement(stat: C.Stat): any {
        const pos = this.pos(stat);
        switch (stat[0]) {
            case L.BLOCK: return [CORE_BEGIN, pos, ...this.statements(stat as C.Block)];
            case L.ASSIGN: {
                const [, targets, exprs] = stat as C.Assign;
                const inits = exprs.map(e => this.expr(e));
                const names = targets.map(t => this.target(t));
                if (names.length === 1 && inits.length === 1) return [CORE_SET, pos, names[0], inits[0]];
                const temps = inits.map(() => Symbol("v"));
                return [CORE_LET, pos, temps.map((t, i) => [t, inits[i]]),
                    ...names.map((name, i) => [CORE_SET, pos, name, i < temps.length ? temps[i] : undefined])];
            }
            case L.OPSET: {
                const [, op, target, value] = stat as C.OpSet;
                const name = this.target(target);
                return [CORE_SET, pos, name, this.binary(pos, op, name, this.expr(value), stat)];
            }
            case L.RETURN: {
                const exprs = (stat as C.Return).slice(1, -1) as C.Expr[];
                return [CORE_ESCAPE, pos, RETURN, values(pos, exprs.map(e => this.expr(e)))];
            }
            case L.LOCALFN: return this.unsupported(stat, "local function");
            case L.IF: return this.unsupported(stat, "if");
            case L.WHILE: return this.unsupported(stat, "while");
            case L.REPEAT: return this.unsupported(stat, "repeat");
            case L.FOR: case L.FORIN: return this.unsupported(stat, "for");
            case L.BREAK: return this.unsupported(stat, "break");
            case L.CONTINUE: return this.unsupported(stat, "continue");
            case L.CALL: case L.METHOD: return this.unsupported(stat, "a call");
        }
        return this.unsupported(stat, "this statement");
    }

    target(e: C.Expr): symbol {
        if (typeof e === "symbol") return e;
        if (isForm(e) && e[0] === L.GLOBAL) return Symbol.for(e[1]);
        return this.unsupported(e as C.Form, "assigning to an index");
    }

    binary(pos: SourcePos, op: C.BinaryHead, a: any, b: any, form: C.Form): any {
        const arith = ARITH.get(op);
        if (arith !== undefined) return intcall(pos, `%luau-${arith}`, a, b);
        if (op === L.CONCAT) return intcall(pos, "%luau-concat", a, b);
        return this.unsupported(form, `'${op.description}'`);
    }

    expr(e: C.Expr): any {
        if (e === L.NIL) return undefined;
        if (!isForm(e)) return e;
        const pos = this.pos(e);
        switch (e[0]) {
            case L.GLOBAL: return Symbol.for(e[1]);
            case L.ONE: return this.expr(e[1]);
            case L.NEG: return intcall(pos, "%luau-unm", this.expr(e[1]));
            case L.ADD: case L.SUB: case L.MUL: case L.DIV: case L.IDIV: case L.MOD: case L.POW: case L.CONCAT:
            case L.EQ: case L.NE: case L.LT: case L.LE: case L.GT: case L.GE: case L.AND: case L.OR: {
                const [op, a, b] = e as C.Binary;
                return this.binary(pos, op, this.expr(a), this.expr(b), e);
            }
            case L.NOT: return this.unsupported(e, "'not'");
            case L.LEN: return this.unsupported(e, "'#'");
            case L.VARARGS: return this.unsupported(e, "'...'");
            case L.CALL: case L.METHOD: return this.unsupported(e, "a call");
            case L.INDEX: return this.unsupported(e, "indexing");
            case L.FUNCTION: return this.unsupported(e, "a function");
            case L.TABLE: return this.unsupported(e, "a table");
            case L.IFX: return this.unsupported(e, "an if expression");
            case L.INTERP: return this.unsupported(e, "an interpolated string");
        }
        return this.unsupported(e, "this expression");
    }
}

// a parsed chunk (with no errors) as core forms: a block whose value is what the chunk returns
export const lowerLuau = (parsed: ParseResult, file: string): any[] => new Lowering(parsed, file).chunk();
