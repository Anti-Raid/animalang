// Luau's tree (syntax/ast.ts) lowered to the VM's core forms. So far: locals, assignment (to locals and globals),
// compound assignment, do, if, while, repeat, numeric for, break, continue, return, functions, calls, literals, and the
// operators; the rest is "not supported yet"
import { CORE_BEGIN, CORE_BLOCK, CORE_CALL, CORE_ESCAPE, CORE_IF, CORE_INTCALL, CORE_LAMBDA, CORE_LET, CORE_LETREC, CORE_LOOP, CORE_SET, type SourcePos } from "../common";
import { PAD, clause } from "../magicvm/lambda";
import { L, isForm, offsetOf, type ParseResult } from "./syntax/ast";
import { Lexer } from "./syntax/lexer";
import { Tok } from "./syntax/tokens";
import type * as C from "./syntax/ast";

export class LuauSyntaxError extends Error {
    constructor(readonly pos: SourcePos, readonly reason: string) {
        super(`${pos.file}:${pos.line}: ${reason}`);
    }
}

const ARITH: ReadonlyMap<symbol, string> = new Map([
    [L.ADD, "add"], [L.SUB, "sub"], [L.MUL, "mul"], [L.DIV, "div"], [L.IDIV, "idiv"], [L.MOD, "mod"], [L.POW, "pow"],
]);
const COMPARE: ReadonlyMap<symbol, string> = new Map([
    [L.EQ, "eq"], [L.NE, "ne"], [L.LT, "lt"], [L.LE, "le"], [L.GT, "gt"], [L.GE, "ge"],
]);

const intcall = (pos: SourcePos | null, name: string, ...args: any[]) => [CORE_INTCALL, pos, Symbol.for(name), ...args];

const values = (pos: SourcePos | null, exprs: any[]) => exprs.length === 1 ? exprs[0] : intcall(pos, "%values", ...exprs);

// the loop a break or continue leaves; a repeat's continue tests its condition first, which may only use the body's
// locals declared before the statement holding the continue (`index`)
type Loop = { brk: symbol, cont: symbol, repeat?: { stat: C.Repeat, locals: Map<symbol, number>, index: number } };

class Lowering {
    // the function being lowered: the block its return escapes from, the loops a break or continue may leave, and whether
    // it is the chunk (which may return several values)
    #loops: Loop[] = [];
    #ret: symbol = Symbol("return");
    #chunk = true;

    constructor(readonly parsed: ParseResult, readonly file: string, readonly source: string) {}

    pos(form: C.Form): SourcePos {
        const { line, column } = this.parsed.lines.pos(offsetOf(form));
        return { file: this.file, line: line + 1, col: column + 1 };
    }

    error(form: C.Form, reason: string): never {
        throw new LuauSyntaxError(this.pos(form), reason);
    }

    unsupported(form: C.Form, what: string): never {
        return this.error(form, `${what} is not supported yet`);
    }

    chunk(): any[] {
        const root = this.parsed.root;
        const pos = this.pos(root);
        return [CORE_BLOCK, pos, this.#ret, ...this.statements(root), intcall(pos, "%values")];
    }

    // a block's statements as a list of forms, then `tail`; each local statement binds the rest of the block. `onEach` is
    // told the index of each statement before it is lowered
    statements(block: C.Block, tail: any[] = [], onEach?: (i: number) => void): any[] {
        let rest: any[] = tail;
        for (let i = block.length - 2; i >= 1; i--) {
            const stat = block[i] as C.Stat;
            onEach?.(i);
            if (stat[0] === L.LOCAL) rest = [this.local(stat as C.LocalStat, rest)];
            else if (stat[0] === L.LOCALFN) {
                const [, name, func] = stat as C.LocalFunction;
                rest = [[CORE_LETREC, this.pos(stat), [[name, this.function(func)]], ...rest]];
            }
            else rest = [this.statement(stat), ...rest];
        }
        return rest;
    }

    body(pos: SourcePos, block: C.Block): any[] {
        return [CORE_BEGIN, pos, ...this.statements(block)];
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
            case L.BLOCK: return this.body(pos, stat as C.Block);
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
                if (exprs.length > 1 && !this.#chunk) return this.unsupported(stat, "returning several values from a function");
                const value = this.#chunk ? values(pos, exprs.map(e => this.expr(e))) : exprs.length === 0 ? undefined : this.expr(exprs[0]);
                return [CORE_ESCAPE, pos, this.#ret, value];
            }
            case L.IF: {
                const out: any[] = [CORE_IF, pos];
                let clause: C.If | C.Block | null = stat as C.If;
                while (clause !== null && clause[0] === L.IF) {
                    const [, cond, then, rest] = clause as C.If;
                    out.push(this.test(cond), this.body(this.pos(then), then));
                    clause = rest;
                }
                if (clause !== null) out.push(this.body(this.pos(clause), clause as C.Block));
                return out;
            }
            case L.WHILE: {
                const [, cond, block] = stat as C.While;
                return this.loop(pos, loop => [CORE_LOOP, pos,
                    [CORE_IF, pos, this.test(cond), [CORE_BLOCK, pos, loop.cont, ...this.statements(block)], [CORE_ESCAPE, pos, loop.brk]]]);
            }
            case L.REPEAT: {
                const [, block, cond] = stat as C.Repeat;
                const locals = new Map<symbol, number>();
                for (let i = 1; i < block.length - 1; i++) {
                    const s = block[i] as C.Stat;
                    if (s[0] === L.LOCAL) for (const name of (s as C.LocalStat)[1]) locals.set(name, i);
                    else if (s[0] === L.LOCALFN) locals.set((s as C.LocalFunction)[1], i);
                }
                return this.loop(pos, loop => {
                    loop.repeat = { stat: stat as C.Repeat, locals, index: 0 };
                    const check = [CORE_IF, pos, this.test(cond), [CORE_ESCAPE, pos, loop.brk]];
                    return [CORE_LOOP, pos, [CORE_BLOCK, pos, loop.cont, ...this.statements(block, [check], i => loop.repeat!.index = i)]];
                });
            }
            case L.FOR: return this.numericFor(stat as C.For, pos);
            case L.BREAK: return [CORE_ESCAPE, pos, this.#innermost(stat).brk];
            case L.CONTINUE: {
                const loop = this.#innermost(stat);
                if (loop.repeat === undefined) return [CORE_ESCAPE, pos, loop.cont];
                // the condition is tested here, where the body's locals it may use are bound
                const { stat: repeat, locals, index } = loop.repeat;
                this.#checkUntil(repeat, locals, index, stat);
                return [CORE_IF, pos, this.test(repeat[2]), [CORE_ESCAPE, pos, loop.brk], [CORE_ESCAPE, pos, loop.cont]];
            }
            case L.FORIN: return this.unsupported(stat, "for ... in");
            case L.CALL: return this.call(stat as C.Call);
            case L.METHOD: return this.unsupported(stat, "a method call");
        }
        return this.unsupported(stat, "this statement");
    }

    // (%block brk body): a loop's body is `make`'s, with the loop to break out of and continue
    loop(pos: SourcePos, make: (loop: Loop) => any[]): any[] {
        const loop: Loop = { brk: Symbol("break"), cont: Symbol("continue") };
        this.#loops.push(loop);
        try {
            return [CORE_BLOCK, pos, loop.brk, make(loop)];
        } finally {
            this.#loops.pop();
        }
    }

    #innermost(stat: C.Stat): Loop {
        const loop = this.#loops[this.#loops.length - 1];
        return loop ?? this.error(stat, "break or continue outside a loop");
    }

    // a continue in a repeat may not jump over a local its condition uses, as Luau's compiler checks
    #checkUntil(repeat: C.Repeat, locals: Map<symbol, number>, index: number, cont: C.Stat): void {
        const cond = repeat[2];
        const visit = (e: unknown, at: C.Form | null): void => {
            if (typeof e === "symbol") {
                const declared = locals.get(e);
                if (declared !== undefined && declared > index) {
                    const reason = `Local ${e.description} used in the repeat..until condition is undefined because continue statement on line ${this.pos(cont).line} jumps over it`;
                    if (at !== null) this.error(at, reason);
                    throw new LuauSyntaxError({ file: this.file, line: this.#untilLine(repeat), col: 1 }, reason);
                }
            } else if (isForm(e)) {
                for (let i = 1; i < e.length - 1; i++) visit(e[i], e);
            } else if (Array.isArray(e)) {
                for (const x of e) visit(x, at);
            }
        };
        visit(cond, isForm(cond) ? cond : null);
    }

    // the line where a repeat's condition starts (a local has no position of its own): after its matching until
    #untilLine(repeat: C.Repeat): number {
        const lexer = new Lexer(this.source);
        let depth = 0;
        for (lexer.next(); lexer.kind !== Tok.Eof; lexer.next()) {
            if (lexer.from < offsetOf(repeat)) continue;
            if (lexer.kind === Tok.Repeat) depth++;
            else if (lexer.kind === Tok.Until && --depth === 0) {
                lexer.next();
                break;
            }
        }
        return this.parsed.lines.pos(lexer.from).line + 1;
    }

    // for i = a, b, c: Luau's FORNPREP and FORNLOOP, with a fresh local per iteration
    numericFor([, name, from, to, step, block]: C.For, pos: SourcePos): any[] {
        const [a, b, c, i, limit, by] = [Symbol("from"), Symbol("to"), Symbol("step"), Symbol("i"), Symbol("limit"), Symbol("by")];
        return [CORE_LET, pos, [[a, this.expr(from)], [b, this.expr(to)], [c, step === null ? 1 : this.expr(step)]],
            [CORE_LET, pos, [[i, intcall(pos, "%luau-for-number", a, "initial value")], [limit, intcall(pos, "%luau-for-number", b, "limit")], [by, intcall(pos, "%luau-for-number", c, "step")]],
                this.loop(pos, loop => [CORE_LOOP, pos,
                    [CORE_IF, pos, this.#forTest(pos, step, i, limit, by),
                        [CORE_BEGIN, pos,
                            [CORE_LET, pos, [[name, i]], [CORE_BLOCK, pos, loop.cont, ...this.statements(block)]],
                            [CORE_SET, pos, i, intcall(pos, "%luau-add", i, by)]],
                        [CORE_ESCAPE, pos, loop.brk]]])]];
    }

    // a padded closure, as Luau's functions take any number of arguments: missing ones are nil, extra ones dropped
    function(func: C.Func): any[] {
        const [, params, , block] = func;
        const pos = this.pos(func);
        const outer = { loops: this.#loops, ret: this.#ret, chunk: this.#chunk };
        this.#loops = [];
        this.#ret = Symbol("return");
        this.#chunk = false;
        try {
            return [CORE_LAMBDA, pos, clause([PAD], params, null, [[CORE_BLOCK, pos, this.#ret, ...this.statements(block), undefined]])];
        } finally {
            this.#loops = outer.loops;
            this.#ret = outer.ret;
            this.#chunk = outer.chunk;
        }
    }

    call(e: C.Call): any[] {
        const [, f, ...rest] = e;
        const args = rest.slice(0, -1) as C.Expr[];
        return [CORE_CALL, this.pos(e), this.expr(f), ...args.map(a => this.expr(a))];
    }

    // with a literal step, its sign picks the test when compiling
    #forTest(pos: SourcePos, step: C.Expr | null, i: symbol, limit: symbol, by: symbol): any {
        const literal = step === null ? 1 : typeof step === "number" ? step : isForm(step) && step[0] === L.NEG && typeof step[1] === "number" ? -step[1] : null;
        if (literal === null || Number.isNaN(literal)) return intcall(pos, "%luau-for-test", i, limit, by);
        return literal > 0 ? intcall(pos, "%luau-le", i, limit) : intcall(pos, "%luau-le", limit, i);
    }

    target(e: C.Expr): symbol {
        if (typeof e === "symbol") return e;
        if (isForm(e) && e[0] === L.GLOBAL) return Symbol.for(e[1]);
        return this.unsupported(e as C.Form, "assigning to an index");
    }

    binary(pos: SourcePos, op: C.BinaryHead, a: any, b: any, form: C.Form): any {
        const arith = ARITH.get(op);
        if (arith !== undefined) return intcall(pos, `%luau-${arith}`, a, b);
        const compare = COMPARE.get(op);
        if (compare !== undefined) return intcall(pos, `%luau-${compare}`, a, b);
        if (op === L.CONCAT) return intcall(pos, "%luau-concat", a, b);
        return this.unsupported(form, `'${op.description}'`);
    }

    // `e` as a condition: a boolean, as Luau's truthiness has it (nil and false are false)
    test(e: C.Expr): any {
        if (!isForm(e)) return typeof e === "boolean" ? e : e === L.NIL ? false : intcall(null, "%luau-truthy", this.expr(e));
        const pos = this.pos(e);
        switch (e[0]) {
            case L.ONE: return this.test(e[1]);
            case L.AND: return [CORE_IF, pos, this.test(e[1]), this.test(e[2]), false];
            case L.OR: return [CORE_IF, pos, this.test(e[1]), true, this.test(e[2])];
            case L.NOT: return [CORE_IF, pos, this.test(e[1]), false, true];
            case L.EQ: case L.NE: case L.LT: case L.LE: case L.GT: case L.GE: return this.expr(e);
        }
        return intcall(pos, "%luau-truthy", this.expr(e));
    }

    expr(e: C.Expr): any {
        if (e === L.NIL) return undefined;
        if (!isForm(e)) return e;
        const pos = this.pos(e);
        switch (e[0]) {
            case L.GLOBAL: return Symbol.for(e[1]);
            case L.ONE: return this.expr(e[1]);
            case L.NEG: return intcall(pos, "%luau-unm", this.expr(e[1]));
            case L.NOT: return intcall(pos, "%luau-not", this.expr(e[1]));
            case L.AND: case L.OR: {
                const t = Symbol("t");
                const [then, otherwise] = e[0] === L.AND ? [this.expr(e[2]), t] : [t, this.expr(e[2])];
                return [CORE_LET, pos, [[t, this.expr(e[1])]], [CORE_IF, pos, intcall(pos, "%luau-truthy", t), then, otherwise]];
            }
            case L.ADD: case L.SUB: case L.MUL: case L.DIV: case L.IDIV: case L.MOD: case L.POW: case L.CONCAT:
            case L.EQ: case L.NE: case L.LT: case L.LE: case L.GT: case L.GE: {
                const [op, a, b] = e as C.Binary;
                return this.binary(pos, op, this.expr(a), this.expr(b), e);
            }
            case L.IFX: {
                const [, cond, then, otherwise] = e as C.IfExpr;
                return [CORE_IF, pos, this.test(cond), this.expr(then), this.expr(otherwise)];
            }
            case L.LEN: return this.unsupported(e, "'#'");
            case L.VARARGS: return this.unsupported(e, "'...'");
            case L.CALL: return this.call(e as C.Call);
            case L.METHOD: return this.unsupported(e, "a method call");
            case L.INDEX: return this.unsupported(e, "indexing");
            case L.FUNCTION: return this.function(e as C.Func);
            case L.TABLE: return this.unsupported(e, "a table");
            case L.INTERP: return this.unsupported(e, "an interpolated string");
        }
        return this.unsupported(e, "this expression");
    }
}

// a parsed chunk (with no errors) as core forms: a block whose value is what the chunk returns
export const lowerLuau = (parsed: ParseResult, file: string, source: string): any[] => new Lowering(parsed, file, source).chunk();
