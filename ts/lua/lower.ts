// Luau's tree (syntax/ast.ts) lowered to the VM's core forms. So far: locals, assignment, compound assignment, do, if,
// while, repeat, numeric for, for ... in, break, continue, return, functions, calls and method calls, several values
// and `...`, tables, indexing, literals, and the operators; the rest is "not supported yet"
import { CORE_BEGIN, CORE_BLOCK, CORE_CALL, CORE_ESCAPE, CORE_IF, CORE_INTAPPLY, CORE_INTCALL, CORE_LAMBDA, CORE_LET, CORE_LETREC, CORE_LET_STAR, CORE_LET_VALUES, CORE_LOOP, CORE_QUOTE, CORE_SET, MultipleValues, type SourcePos } from "../common";
import { PAD, clause } from "../magicvm/lambda";
import { predictShapes, type Shape } from "./shapes";
import { RecordShape } from "./table";
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

const CORE_APPLY = Symbol.for("%apply");

const intcall = (pos: SourcePos | null, name: string, ...args: any[]) => [CORE_INTCALL, pos, Symbol.for(name), ...args];

// what a function that returns nothing returns
const NO_VALUES = new MultipleValues([]);

// an expression whose evaluation runs no code that could assign a local: a constant, a local or a global
const isSimple = (e: C.Expr): boolean => !isForm(e) || e[0] === L.GLOBAL || (e[0] === L.ONE && isSimple(e[1]));

const isConstant = (e: C.Expr): boolean => e === L.NIL || (!isForm(e) && typeof e !== "symbol");

const isIndex = (e: C.Expr): e is C.Index => isForm(e) && e[0] === L.INDEX;

// the one string object the engine keeps for a string that is a property name: equal constants are then the same
// object, as Luau's strings are, and a table finds such a key by comparing references
const intern = (s: string): string => Object.keys({ [s]: 0 })[0];

// reading and storing an entry: by name where the key is a string constant (LOP_GETTABLEKS, LOP_SETTABLEKS)
const getter = (key: C.Expr): string => typeof key === "string" ? "%luau-field" : "%luau-index";
const setter = (key: C.Expr): string => typeof key === "string" && key !== "__mode" && key !== "__call" ? "%luau-setfield" : "%luau-setindex";

// the number a table constructor's key is when Luau's compiler knows it: a literal, or arithmetic on literals (Luau
// also follows locals that are never assigned; this does not)
const constNumber = (e: C.Expr): number | null => {
    if (typeof e === "number") return e;
    if (!isForm(e)) return null;
    if (e[0] === L.ONE || e[0] === L.NEG) {
        const v = constNumber(e[1]);
        return v === null ? null : e[0] === L.NEG ? -v : v;
    }
    const a = e.length === 4 ? constNumber(e[1] as C.Expr) : null, b = a === null ? null : constNumber(e[2] as C.Expr);
    if (a === null || b === null) return null;
    switch (e[0]) {
        case L.ADD: return a + b;
        case L.SUB: return a - b;
        case L.MUL: return a * b;
        case L.DIV: return a / b;
    }
    return null;
};

// the most fields a table made from a template has (BytecodeBuilder::TableShape::kMaxLength)
const MAX_TEMPLATE = 32;

const refers = (e: unknown, sym: symbol): boolean => e === sym || (Array.isArray(e) && e.some(x => refers(x, sym)));

// a step of a statement lowered in Luau's order: a name bound for the steps after it, or a form to run
type Step = { bind: symbol[], init: any } | { run: any };

// a call or `...`: several values where it is last in a list, its first value (or nil) anywhere else
const isCall = (e: C.Expr): e is C.Call | C.Method => isForm(e) && (e[0] === L.CALL || e[0] === L.METHOD);
const isMulti = (e: C.Expr): e is C.Call | C.Method | C.Varargs => isCall(e) || (isForm(e) && e[0] === L.VARARGS);

// the loop a break or continue leaves; a repeat's continue tests its condition first, which may only use the body's
// locals declared before the statement holding the continue (`index`)
type Loop = { brk: symbol, cont: symbol, repeat?: { stat: C.Repeat, locals: Map<symbol, number>, index: number } };

class Lowering {
    // the function being lowered: the block its return escapes from, the loops a break or continue may leave, and its
    // `...` (an array; the chunk's is empty)
    #loops: Loop[] = [];
    #ret: symbol = Symbol("return");
    #varargs: any = [CORE_QUOTE, null, []];
    // the function (its return block) each local was declared in. Luau keeps a function's own locals in registers and
    // uses a register itself as an operand, so such a local is read when the operation runs, not where it is written
    readonly #owner = new Map<symbol, symbol>();
    readonly #shapes: Map<C.Table, Shape>;

    constructor(readonly parsed: ParseResult, readonly file: string, readonly source: string) {
        this.#shapes = predictShapes(parsed.root);
    }

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
        return this.functionBody(pos, root);
    }

    // a function's body (or the chunk's): a block its returns escape from. A return that ends it is its value; without
    // one it returns nothing
    functionBody(pos: SourcePos, block: C.Block): any[] {
        const last = block.length > 2 ? block[block.length - 2] as C.Stat : null;
        if (last === null || last[0] !== L.RETURN) return [CORE_BLOCK, pos, this.#ret, ...this.statements(block), [CORE_QUOTE, pos, NO_VALUES]];
        const before = [...block.slice(0, -2), block[block.length - 1]] as C.Block;
        return [CORE_BLOCK, pos, this.#ret, ...this.statements(before, () => [this.values(this.pos(last), last.slice(1, -1) as C.Expr[])])];
    }

    // a block's statements as a list of forms, then `tail`'s (lowered with the block's locals declared); each local
    // statement binds the rest of the block. `onEach` is told the index of each statement before it is lowered
    statements(block: C.Block, tail: () => any[] = () => [], onEach?: (i: number) => void): any[] {
        for (let i = 1; i < block.length - 1; i++) {
            const stat = block[i] as C.Stat;
            if (stat[0] === L.LOCAL) this.#declare(...(stat as C.LocalStat)[1]);
            else if (stat[0] === L.LOCALFN) this.#declare((stat as C.LocalFunction)[1]);
        }
        let rest: any[] = tail();
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

    #declare(...names: symbol[]): void {
        for (const name of names) this.#owner.set(name, this.#ret);
    }

    // the local `e` is, if it is one of the function being lowered (parentheses do not change that)
    #own(e: C.Expr): symbol | null {
        while (isForm(e) && e[0] === L.ONE) e = e[1];
        return typeof e === "symbol" && this.#owner.get(e) === this.#ret ? e : null;
    }

    body(pos: SourcePos, block: C.Block): any[] {
        return [CORE_BEGIN, pos, ...this.statements(block)];
    }

    local(stat: C.LocalStat, body: any[]): any[] {
        return this.bind(this.pos(stat), stat[1], stat[2], body);
    }

    // `names` bound to the values of `exprs` around `body`, as Luau adjusts a list of values: every expression is
    // evaluated, in order; a call or `...` that is last gives all its values; missing values are nil, extra ones dropped
    bind(pos: SourcePos, names: symbol[], exprs: C.Expr[], body: any[]): any[] {
        const end = exprs[exprs.length - 1];
        const last = end !== undefined && isMulti(end) ? end : null;
        const fixed = last === null ? exprs : exprs.slice(0, -1);
        const bindings: any[][] = fixed.map((e, i) => [i < names.length ? names[i] : Symbol("_"), this.expr(e)]);
        const rest = names.slice(fixed.length);
        if (last === null) return [CORE_LET, pos, [...bindings, ...rest.map(name => [name, undefined])], ...body];
        if (last[0] === L.VARARGS) return [CORE_LET, pos, [...bindings, ...rest.map((name, i) => [name, intcall(pos, "%luau-arg", this.#varargs, i)])], ...body];
        if (rest.length === 0) return [CORE_LET, pos, [...bindings, [Symbol("_"), this.call(last)]], ...body];
        if (rest.length === 1) return [CORE_LET, pos, [...bindings, [rest[0], this.expr(last)]], ...body];
        const unpack = [CORE_LET_VALUES, pos, [[rest, null, this.call(last)]], ...body];
        return bindings.length === 0 ? unpack : [CORE_LET, pos, bindings, unpack];
    }

    statement(stat: C.Stat): any {
        const pos = this.pos(stat);
        switch (stat[0]) {
            case L.BLOCK: return this.body(pos, stat as C.Block);
            case L.ASSIGN: {
                const [, targets, exprs] = stat as C.Assign;
                if (targets.length !== 1 || exprs.length !== 1) return this.assign(pos, targets, exprs);
                const target = targets[0];
                if (!isIndex(target)) return [CORE_SET, pos, this.variable(target), this.expr(exprs[0])];
                return this.#inOrder(pos, [target[1], target[2], exprs[0]], ([o, k, v]) => intcall(pos, setter(target[2]), o, k, v));
            }
            case L.OPSET: {
                const [, op, target, value] = stat as C.OpSet;
                if (isIndex(target)) {
                    // the object and the key, the entry's value, the operand, and then the store, which reads a local
                    // of the function that is its object or key again
                    const bindings: any[][] = [];
                    const temp = (init: any): symbol => {
                        const t = Symbol("v");
                        bindings.push([t, init]);
                        return t;
                    };
                    const part = (e: C.Expr) => this.#own(e) ?? (isConstant(e) ? this.expr(e) : temp(this.expr(e)));
                    const o = part(target[1]), k = part(target[2]);
                    const old = temp(intcall(pos, getter(target[2]), o, k));
                    const result = temp(this.binary(pos, op, old, this.expr(value), stat));
                    return [CORE_LET_STAR, pos, bindings, intcall(pos, setter(target[2]), o, k, result)];
                }
                const name = this.variable(target);
                // a local of the function is read when the operation runs, after the value
                if (this.#own(target) !== null && op !== L.CONCAT && !isSimple(value)) {
                    const v = Symbol("v");
                    return [CORE_LET, pos, [[v, this.expr(value)]], [CORE_SET, pos, name, this.binary(pos, op, name, v, stat)]];
                }
                return [CORE_SET, pos, name, this.binary(pos, op, name, this.expr(value), stat)];
            }
            case L.RETURN: {
                return [CORE_ESCAPE, pos, this.#ret, this.values(pos, (stat as C.Return).slice(1, -1) as C.Expr[])];
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
                    const check = () => [[CORE_IF, pos, this.test(cond), [CORE_ESCAPE, pos, loop.brk]]];
                    return [CORE_LOOP, pos, [CORE_BLOCK, pos, loop.cont, ...this.statements(block, check, i => loop.repeat!.index = i)]];
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
            case L.FORIN: return this.forIn(stat as C.ForIn, pos);
            case L.CALL: case L.METHOD: return this.call(stat as C.Call | C.Method);
        }
        return this.unsupported(stat, "this statement");
    }

    // several targets, in the order Luau's compiler assigns them (compileStatAssign): the objects and keys of indexed
    // targets are evaluated first (a local of the function being its register, read when it is stored into); a local of
    // the function takes its value as soon as it is computed, unless a value computed after it refers to it or an
    // indexed target uses it; other targets, and those locals, are assigned once every value is computed, a local given
    // as a value being read then
    assign(pos: SourcePos, targets: C.Expr[], exprs: C.Expr[]): any {
        const n = targets.length, k = exprs.length;
        const steps: Step[] = [];
        const temp = (init: any): symbol => {
            const t = Symbol("v");
            steps.push({ bind: [t], init });
            return t;
        };
        const used = new Set<symbol>();
        const part = (e: C.Expr): any => {
            const own = this.#own(e);
            if (own !== null) used.add(own);
            return own ?? (isConstant(e) ? this.expr(e) : temp(this.expr(e)));
        };
        const places = targets.map(t => isIndex(t) ? { obj: part(t[1]), key: part(t[2]), set: setter(t[2]) } : { name: this.variable(t) });
        const names = places.map((p): symbol | null => "name" in p ? p.name! : null);
        const local = names.map(name => name !== null && this.#owner.get(name) === this.#ret);
        const assigned = new Set<symbol>(), conflict = new Set<symbol>();
        const visit = (e: C.Expr) => { for (const s of assigned) if (refers(e, s)) conflict.add(s); };
        for (let i = 0; i < n; i++) {
            if (!local[i]) continue;
            if (i < k) visit(exprs[i]);
            assigned.add(names[i]!);
        }
        for (let i = 0; i < k; i++) if (i >= n || !local[i]) visit(exprs[i]);
        for (const s of assigned) if (used.has(s)) conflict.add(s);

        // what each target is assigned at the end (null: it has been already)
        const value: (symbol | null)[] = [];
        const store = (i: number, v: any): any => {
            const place = places[i];
            return "name" in place ? [CORE_SET, pos, place.name, v] : intcall(pos, place.set, place.obj, place.key, v);
        };
        for (let i = 0; i < Math.min(n, k); i++) {
            const e = exprs[i];
            if (i === k - 1 && n > k) {
                // the last value gives the targets that are left theirs
                const count = n - i;
                if (!isMulti(e)) value.push(temp(this.expr(e)), ...Array.from({ length: count - 1 }, () => temp(undefined)));
                else if (e[0] === L.VARARGS) for (let j = 0; j < count; j++) value.push(temp(intcall(pos, "%luau-arg", this.#varargs, j)));
                else {
                    const temps = Array.from({ length: count }, () => Symbol("v"));
                    steps.push({ bind: temps, init: this.call(e) });
                    value.push(...temps);
                }
            } else if (local[i] && !conflict.has(names[i]!)) {
                steps.push({ run: store(i, this.expr(e)) });
                value.push(null);
            } else {
                value.push((local[i] ? null : this.#own(e)) ?? temp(this.expr(e)));
            }
        }
        for (let i = n; i < k; i++) {
            const e = exprs[i];
            steps.push({ run: isCall(e) ? this.call(e) : this.expr(e) });
        }
        for (const want of [false, true]) {
            for (let i = 0; i < n; i++) if (local[i] === want && value[i] !== null) steps.push({ run: store(i, value[i]) });
        }
        const forms = steps.reduceRight((rest: any[], step) => "run" in step ? [step.run, ...rest]
            : step.bind.length === 1 ? [[CORE_LET, pos, [[step.bind[0], step.init]], ...rest]]
            : [[CORE_LET_VALUES, pos, [[step.bind, null, step.init]], ...rest]], []);
        return [CORE_BEGIN, pos, ...forms];
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
        this.#declare(name);
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

    // for v1, ..., vn in f, s, c: LOP_FORGPREP and LOP_FORGLOOP. What the loop does each time round is decided once
    // (%luau-for-prep): over a table by ipairs it reads the array part at the next index; over a table by pairs or next,
    // or a table itself, it moves to the next position that has an entry; otherwise it calls f(s, c), stops when the
    // first value is nil, and that value is the next c. Each iteration binds fresh locals
    forIn([, names, exprs, block]: C.ForIn, pos: SourcePos): any[] {
        this.#declare(...names);
        const [f, s, c, kind, table, at, v] = ["f", "s", "c", "kind", "table", "at", "v"].map(n => Symbol(n));
        const temps = names.map(() => Symbol("v"));
        const stop = (loop: Loop, value: any) => [CORE_IF, pos, intcall(pos, "%luau-nil?", value), [CORE_ESCAPE, pos, loop.brk]];
        const set = (name: symbol, value: any) => [CORE_SET, pos, name, value];
        const second = temps.length > 1 ? (value: any) => [set(temps[1], value)] : () => [];
        const called = (loop: Loop): any => {
            const got = names.map(() => Symbol("v"));
            const each = [stop(loop, got[0]), set(c, got[0]), ...got.map((g, i) => set(temps[i], g))];
            const call = [CORE_CALL, pos, f, s, c];
            return got.length === 1 ? [CORE_LET, pos, [[got[0], intcall(pos, "%first-value", call, undefined)]], ...each]
                : [CORE_LET_VALUES, pos, [[got, null, call]], ...each];
        };
        return this.bind(pos, [f, s, c], exprs, [
            [CORE_LET, pos, [[kind, intcall(pos, "%luau-for-prep", f, s, c)]],
                [CORE_LET, pos, [[table, intcall(pos, "%luau-for-table", f, s)], [at, 0], ...temps.map(t => [t, undefined])],
                    this.loop(pos, loop => [CORE_LOOP, pos,
                        [CORE_BEGIN, pos,
                            [CORE_IF, pos,
                                intcall(pos, "%luau-eq", kind, 1),
                                [CORE_BEGIN, pos,
                                    set(at, intcall(pos, "%luau-add", at, 1)),
                                    [CORE_LET, pos, [[v, intcall(pos, "%luau-array-at", table, at)]], stop(loop, v), set(temps[0], at), ...second(v)]],
                                intcall(pos, "%luau-eq", kind, 2),
                                [CORE_BEGIN, pos,
                                    set(at, intcall(pos, "%luau-next-pos", table, at)),
                                    [CORE_IF, pos, intcall(pos, "%luau-eq", at, 0), [CORE_ESCAPE, pos, loop.brk]],
                                    set(temps[0], intcall(pos, "%luau-key-at", table, at)),
                                    ...second(intcall(pos, "%luau-value-at", table, at))],
                                called(loop)],
                            [CORE_LET, pos, names.map((name, i) => [name, temps[i]]), [CORE_BLOCK, pos, loop.cont, ...this.statements(block)]]]])]]]);
    }

    // a padded closure, as Luau's functions take any number of arguments: missing ones are nil, extra ones dropped, or
    // are its `...`
    function(func: C.Func): any[] {
        const [, params, varargs, block] = func;
        const pos = this.pos(func);
        const outer = { loops: this.#loops, ret: this.#ret, varargs: this.#varargs };
        const rest = varargs ? Symbol("...") : null;
        this.#loops = [];
        this.#ret = Symbol("return");
        this.#varargs = rest;
        this.#declare(...params);
        try {
            return [CORE_LAMBDA, pos, clause([PAD], params, rest, [this.functionBody(pos, block)])];
        } finally {
            this.#loops = outer.loops;
            this.#ret = outer.ret;
            this.#varargs = outer.varargs;
        }
    }

    // all the values of a list of expressions (what a function returns): the values of a call or `...` that is last
    // after the others
    values(pos: SourcePos, exprs: C.Expr[]): any {
        if (exprs.length === 0) return [CORE_QUOTE, pos, NO_VALUES];
        const last = exprs[exprs.length - 1];
        const fixed = exprs.slice(0, -1).map(e => this.expr(e));
        if (!isMulti(last)) return exprs.length === 1 ? this.expr(last) : intcall(pos, "%values", ...fixed, this.expr(last));
        if (last[0] === L.VARARGS) return fixed.length === 0 ? intcall(pos, "%luau-varargs", this.#varargs) : [CORE_INTAPPLY, pos, Symbol.for("%values"), ...fixed, this.#varargs];
        return fixed.reduceRight((tail, e) => intcall(pos, "%values-cons", e, tail), this.call(last));
    }

    // a call, whose value is all the values the function returns, or with `one`, the first of them (nil of none). An
    // argument list ending in `...` or a call passes all of its values; a call that gives one value (as most do) is
    // then an ordinary call
    call(e: C.Call | C.Method, one: boolean = false): any[] {
        if (e[0] === L.METHOD) return this.method(e as C.Method, one);
        const pos = this.pos(e);
        // (the VM makes a %call whose first value is taken a call that asks for one)
        const made = (call: any[]) => one ? intcall(pos, "%first-value", call, undefined) : call;
        const args = e.slice(2, -1) as C.Expr[];
        const last = args[args.length - 1];
        if (last === undefined || !isMulti(last)) return made([CORE_CALL, pos, this.expr(e[1]), ...args.map(a => this.expr(a))]);
        const fixed = args.slice(0, -1).map(a => this.expr(a));
        if (last[0] === L.VARARGS) return made([CORE_APPLY, pos, this.expr(e[1]), ...fixed, this.#varargs]);
        const [f, v, ...temps] = [Symbol("f"), Symbol("v"), ...fixed.map(() => Symbol("a"))];
        return [CORE_LET, pos, [[f, this.expr(e[1])], ...temps.map((t, i) => [t, fixed[i]]), [v, this.call(last)]],
            [CORE_IF, pos, intcall(pos, "%luau-several?", v),
                made([CORE_APPLY, pos, f, ...temps, intcall(pos, "%values->array", v)]),
                made([CORE_CALL, pos, f, ...temps, v])]];
    }

    // obj:name(args), as LOP_NAMECALL goes: the object (a local of the function being its register, read when the
    // method is looked up), then the arguments, and only then the method, which is called with the object first
    method(e: C.Method, one: boolean): any[] {
        const pos = this.pos(e);
        const made = (call: any[]) => one ? intcall(pos, "%first-value", call, undefined) : call;
        const args = e.slice(3, -1) as C.Expr[];
        const last = args[args.length - 1];
        const multi = last !== undefined && isMulti(last) ? last : null;
        const bindings: any[][] = [];
        const temp = (init: any): symbol => {
            const t = Symbol("a");
            bindings.push([t, init]);
            return t;
        };
        const o = this.#own(e[1]) ?? temp(this.expr(e[1]));
        const given = (multi === null ? args : args.slice(0, -1)).map(a => isConstant(a) ? this.expr(a) : temp(this.expr(a)));
        const found = () => intcall(pos, "%luau-method", o, intern(e[2]));
        if (multi === null) return [CORE_LET_STAR, pos, bindings, made([CORE_CALL, pos, found(), o, ...given])];
        if (multi[0] === L.VARARGS) return [CORE_LET_STAR, pos, bindings, made([CORE_APPLY, pos, found(), o, ...given, this.#varargs])];
        const v = temp(this.call(multi)), f = temp(found());
        return [CORE_LET_STAR, pos, bindings,
            [CORE_IF, pos, intcall(pos, "%luau-several?", v),
                made([CORE_APPLY, pos, f, o, ...given, intcall(pos, "%values->array", v)]),
                made([CORE_CALL, pos, f, o, ...given, v])]];
    }

    // `a{x}b` is ("a%*b"):format(x), as Luau compiles it: the pieces with their % doubled, %* for each expression (one
    // value of it), and a string constant among the expressions written into the format
    interp(e: C.Interp): any {
        const pos = this.pos(e);
        const escaped = (s: string) => s.replace(/%/g, "%%");
        let format = "";
        const bindings: any[][] = [];
        (e.slice(1, -1) as (string | C.Expr)[]).forEach((part, i) => {
            if (i % 2 === 0 || typeof part === "string") format += escaped(part as string);
            else {
                format += "%*";
                bindings.push([Symbol("a"), this.expr(part as C.Expr)]);
            }
        });
        const fmt = intern(format);
        const call = [CORE_CALL, pos, intcall(pos, "%luau-method", fmt, "format"), fmt, ...bindings.map(b => b[0])];
        return [CORE_LET, pos, bindings, intcall(pos, "%first-value", call, undefined)];
    }

    // an operation on `operands`, which are evaluated in order, but a local of the function is its register, read when
    // the operation runs: after the operands that follow it
    #inOrder(pos: SourcePos, operands: C.Expr[], make: (forms: any[]) => any): any {
        let last = -1;
        operands.forEach((e, i) => { if (!isSimple(e)) last = i; });
        if (!operands.some((e, i) => i < last && this.#own(e) !== null)) return make(operands.map(e => this.expr(e)));
        const bindings: any[][] = [];
        const forms = operands.map((e, i) => {
            if (i > last || isConstant(e) || this.#own(e) !== null) return this.expr(e);
            const t = Symbol("v");
            bindings.push([t, this.expr(e)]);
            return t;
        });
        return [CORE_LET, pos, bindings, make(forms)];
    }

    // a table constructor, as compileExprTable makes it: a table of the sizes Luau's compiler works out, then the items
    // in order, a keyed one stored as an assignment is, the others into the array part, the last all of its values
    table(e: C.Table): any {
        const pos = this.pos(e);
        const items = e.slice(1, -1) as (C.Expr | C.Field | C.Pair)[];
        if (items.length === 0) {
            const shape = this.#shapes.get(e);
            return intcall(pos, "%luau-table", shape?.array ?? 0, shape?.hash ?? 0);
        }
        const keyed = (item: C.Expr | C.Field | C.Pair): item is C.Field | C.Pair => isForm(item) && (item[0] === L.FIELD || item[0] === L.PAIR);
        const arraySize = items.filter(item => !keyed(item)).length;
        const fields = items.filter((item): item is C.Field => isForm(item) && item[0] === L.FIELD);
        let hashSize = items.length - arraySize, indexSize = 0;
        if (arraySize === 0) {
            // keys [1], [2], ... in order go to the array part, when there are no other [] keys
            for (const item of items) if (isForm(item) && item[0] === L.PAIR && constNumber(item[1]) === indexSize + 1) indexSize++;
            if (hashSize === fields.length + indexSize) hashSize = fields.length;
            else indexSize = 0;
            // a table of fields only is a copy of a template with each name once (LOP_DUPTABLE)
            if (indexSize === 0 && hashSize === fields.length && fields.length <= MAX_TEMPLATE) {
                hashSize = new Set(fields.map(f => f[1])).size;
                if (hashSize === fields.length) return intcall(pos, "%luau-record", [CORE_QUOTE, pos, new RecordShape(fields.map(f => intern(f[1])))], ...fields.map(f => this.expr(f[2])));
            }
        }
        const end = items[items.length - 1];
        const multi = !keyed(end) && isMulti(end) ? end : null;
        const narray = arraySize - (multi !== null && multi[0] === L.VARARGS ? 1 : 0) + indexSize;
        let lead = 0;
        while (lead < items.length - (multi === null ? 0 : 1) && !keyed(items[lead])) lead++;
        const made = intcall(pos, "%luau-table", narray, hashSize, ...items.slice(0, lead).map(item => this.expr(item as C.Expr)));
        if (lead === items.length) return made;
        const t = Symbol("t");
        const steps: any[] = [];
        let index = lead + 1;
        for (let i = lead; i < items.length; i++) {
            const item = items[i];
            if (keyed(item)) {
                const at = this.pos(item);
                if (item[0] === L.FIELD) steps.push(intcall(at, setter(item[1]), t, intern(item[1]), this.expr(item[2])));
                else steps.push(this.#inOrder(at, [item[1], item[2]], ([key, v]) => intcall(at, "%luau-setindex", t, key, v)));
            } else if (i === items.length - 1 && multi !== null) {
                steps.push(intcall(pos, "%luau-setlist", t, index, multi[0] === L.VARARGS ? this.#varargs : intcall(pos, "%values->array", this.call(multi))));
            } else {
                steps.push(intcall(pos, "%luau-seti", t, index++, this.expr(item)));
            }
        }
        return [CORE_LET, pos, [[t, made]], ...steps, t];
    }

    // with a literal step, its sign picks the test when compiling
    #forTest(pos: SourcePos, step: C.Expr | null, i: symbol, limit: symbol, by: symbol): any {
        const literal = step === null ? 1 : typeof step === "number" ? step : isForm(step) && step[0] === L.NEG && typeof step[1] === "number" ? -step[1] : null;
        if (literal === null || Number.isNaN(literal)) return intcall(pos, "%luau-for-test", i, limit, by);
        return literal > 0 ? intcall(pos, "%luau-le", i, limit) : intcall(pos, "%luau-le", limit, i);
    }

    // the variable an assignment's target is, which is not an indexed one
    variable(e: C.Expr): symbol {
        if (typeof e === "symbol") return e;
        if (isForm(e) && e[0] === L.GLOBAL) return Symbol.for(e[1]);
        return this.unsupported(e as C.Form, "assigning to this");
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
        if (!isForm(e)) return typeof e === "string" ? intern(e) : e;
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
                // a local of the function on the left is read when the operation runs, after the right operand
                const left = op === L.CONCAT || isSimple(b) ? null : this.#own(a);
                if (left === null) return this.binary(pos, op, this.expr(a), this.expr(b), e);
                const right = Symbol("r");
                return [CORE_LET, pos, [[right, this.expr(b)]], this.binary(pos, op, left, right, e)];
            }
            case L.IFX: {
                const [, cond, then, otherwise] = e as C.IfExpr;
                return [CORE_IF, pos, this.test(cond), this.expr(then), this.expr(otherwise)];
            }
            case L.LEN: return intcall(pos, "%luau-len", this.expr(e[1]));
            case L.VARARGS: return intcall(pos, "%luau-arg", this.#varargs, 0);
            case L.CALL: case L.METHOD: return this.call(e as C.Call | C.Method, true);
            case L.INDEX: return this.#inOrder(pos, [e[1], e[2]], ([o, k]) => intcall(pos, getter(e[2] as C.Expr), o, k));
            case L.FUNCTION: return this.function(e as C.Func);
            case L.TABLE: return this.table(e as C.Table);
            case L.INTERP: return this.interp(e as C.Interp);
        }
        return this.unsupported(e, "this expression");
    }
}

// a parsed chunk (with no errors) as core forms: a block whose value is what the chunk returns
export const lowerLuau = (parsed: ParseResult, file: string, source: string): any[] => new Lowering(parsed, file, source).chunk();
