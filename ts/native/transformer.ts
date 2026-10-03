// native-scheme's sugar, lowered to the core forms; everything else is core already (calls are explicit: %call and
// %intcall, or %[f x] as the reader reads it)
//  - (lambda formals body ...): formals a name (all arguments), (a b), or (a b . rest); (case-lambda (formals body ...) ...)
//  - (define-global name expr), (define-global (name . formals) body ...): a global
//  - (define-intrinsic name %intrinsic): a global procedure calling the intrinsic, its parameters from the table (a
//    fixed count, or any count of a leaf, which it applies)
//  - (let ((x init) ...) body ...), let*, letrec: the core forms of the same shape
//  - (let name ((x init) ...) body ...): a loop when name is only called in tail position with every argument, else a
//    %letrec of a procedure
//  - (let-values ((formals expr) ...) body ...), (receive formals expr body ...): %let-values/strict
//  - if, set!, begin, (cond (test body ...) ... [(else body ...)]), not, when, unless, and, or
//  - (apply f x ... seq): %apply, or %intapply of an intrinsic, with the table's spread of seq if it has one
import {
    CORE_BEGIN, CORE_BLOCK, CORE_CALL, CORE_ESCAPE, CORE_IF, CORE_INTAPPLY, CORE_INTCALL, CORE_LAMBDA, CORE_LET, CORE_LET_STAR,
    CORE_LET_VALUES, CORE_LET_VALUES_STRICT, CORE_LETREC, CORE_LOOP, CORE_QUOTE, CORE_SET, OP_DEFINE_GLOBAL, SOURCE_POS,
    formatPos, type SourcePos,
} from "../common";
import type { Intrinsics } from "../magicvm/intrinsics";
import { Lsrc, keepPos, malformed, mapExprs } from "../magicvm/passes/lang";

const CORE_APPLY = Symbol.for("%apply");

export class NativeSyntaxError extends Error {
    constructor(readonly what: string, readonly at: SourcePos | null) {
        super(`${what}${at !== null ? ` at ${formatPos(at)}` : ""}`);
        this.name = "NativeSyntaxError";
    }
}

const S = Symbol.for;
export const LAMBDA = S("lambda");
const CASE_LAMBDA = S("case-lambda"), DEFINE_GLOBAL = S("define-global"), DEFINE_INTRINSIC = S("define-intrinsic");
const LET = S("let"), LET_STAR = S("let*"), LETREC = S("letrec"), LET_VALUES = S("let-values"), RECEIVE = S("receive");
const IF = S("if"), SET = S("set!"), BEGIN = S("begin"), COND = S("cond"), ELSE = S("else"), NOT = S("not");
const WHEN = S("when"), UNLESS = S("unless"), AND = S("and"), OR = S("or"), APPLY = S("apply"), DOT = S(".");

export const SUGAR: ReadonlySet<symbol> = new Set([LAMBDA, CASE_LAMBDA, DEFINE_GLOBAL, DEFINE_INTRINSIC, LET, LET_STAR, LETREC,
    LET_VALUES, RECEIVE, IF, SET, BEGIN, COND, ELSE, NOT, WHEN, UNLESS, AND, OR, APPLY]);

const fail = (what: string, e: any): never => {
    throw new NativeSyntaxError(what, SOURCE_POS.get(e) ?? null);
};

// [params, rest] of a formals list
const formalsOf = (who: string, f: any, e: any): [symbol[], symbol | null] => {
    if (typeof f === "symbol") return [[], f];
    if (!Array.isArray(f)) fail(`${who}: formals must be a name or a list of names`, e);
    const dot = f.indexOf(DOT);
    const params = dot === -1 ? f : f.slice(0, dot);
    const rest = dot === -1 ? null : f[dot + 1];
    if (dot !== -1 && (dot !== f.length - 2 || typeof rest !== "symbol")) fail(`${who}: one name must follow .`, e);
    if (!params.every((p: any) => typeof p === "symbol")) fail(`${who}: parameters must be names`, e);
    return [params, rest];
};

const bindingsOf = (who: string, b: any, e: any): [symbol, any][] => {
    if (!Array.isArray(b) || !b.every(x => Array.isArray(x) && x.length === 2 && typeof x[0] === "symbol")) {
        fail(`${who}: bindings must be ((name init) ...)`, e);
    }
    return b;
};

const isIntrinsicName = (x: any): x is symbol => typeof x === "symbol" && x.description!.charCodeAt(0) === 37;

// `intrinsics`: the table of the instance the code is for, which apply and define-intrinsic consult
export const transformNative = (ast: any, intrinsics?: Intrinsics): any => {
    const walk = (e: any): any => {
        if (!Array.isArray(e) || e.length === 0) return e;
        const op = e[0];
        if (typeof op === "symbol" && SUGAR.has(op)) return keepPos(lower(e), e);
        if (!Lsrc.forms.has(op) || malformed(Lsrc, e) !== null) return e;
        return mapExprs(Lsrc, e, walk);
    };
    const body = (items: any[]): any[] => items.map(walk);
    const seq = (items: any[], e: any): any => items.length === 1 ? walk(items[0]) : keepPos([CORE_BEGIN, ...body(items)], e);
    const spread = (x: any) => intrinsics?.spread !== undefined ? [CORE_INTCALL, S(intrinsics.spread.name), x] : x;
    const clause = (who: string, formals: any, items: any[], e: any) => {
        if (items.length === 0) fail(`${who}: needs a body`, e);
        const [params, rest] = formalsOf(who, formals, e);
        return [[], params, rest, ...body(items)];
    };

    const lower = (e: any[]): any => {
        const op = e[0];
        switch (op) {
            case LAMBDA:
                if (e.length < 3) fail("lambda: needs formals and a body", e);
                return [CORE_LAMBDA, clause("lambda", e[1], e.slice(2), e)];
            case CASE_LAMBDA:
                if (e.length < 2 || !e.slice(1).every(Array.isArray)) fail("case-lambda: (case-lambda (formals body ...) ...)", e);
                return [CORE_LAMBDA, ...e.slice(1).map((c: any[]) => clause("case-lambda", c[0], c.slice(1), c))];
            case DEFINE_GLOBAL: {
                if (Array.isArray(e[1])) {
                    if (e.length < 3 || typeof e[1][0] !== "symbol") fail("define-global: (define-global (name . formals) body ...)", e);
                    const formals = e[1].length === 3 && e[1][1] === DOT ? e[1][2] : e[1].slice(1);
                    return [OP_DEFINE_GLOBAL, e[1][0], keepPos([CORE_LAMBDA, clause("define-global", formals, e.slice(2), e)], e)];
                }
                if (e.length !== 3 || typeof e[1] !== "symbol") fail("define-global: (define-global name expr)", e);
                return [OP_DEFINE_GLOBAL, e[1], walk(e[2])];
            }
            case DEFINE_INTRINSIC: {
                if (e.length !== 3 || typeof e[1] !== "symbol" || !isIntrinsicName(e[2])) fail("define-intrinsic: (define-intrinsic name %intrinsic)", e);
                if (intrinsics === undefined) fail("define-intrinsic: needs the instance's table (compile with compileNative)", e);
                const entry = intrinsics!.get(e[2]);
                if (entry === undefined) fail(`define-intrinsic: ${e[2].description} is not an intrinsic`, e);
                if (entry!.min === entry!.max) {
                    const params = Array.from({ length: entry!.min }, (_, i) => S(`a${i}`));
                    return [OP_DEFINE_GLOBAL, e[1], keepPos([CORE_LAMBDA, [[], params, null, [CORE_INTCALL, e[2], ...params]]], e)];
                }
                if (!entry!.leaf) fail(`define-intrinsic: ${e[2].description} takes ${entry!.min} or more args and is not a leaf, so it cannot be applied (write a case-lambda)`, e);
                const args = S("args");
                return [OP_DEFINE_GLOBAL, e[1], keepPos([CORE_LAMBDA, [[], [], args, [CORE_INTAPPLY, e[2], spread(args)]]], e)];
            }
            case LET: case LET_STAR: case LETREC: {
                if (op === LET && typeof e[1] === "symbol") {
                    if (e.length < 4) fail("let: (let name ((name init) ...) body ...)", e);
                    const bindings = bindingsOf("let", e[2], e);
                    return namedLet(e[1], bindings.map(b => b[0]), bindings.map(b => walk(b[1])), body(e.slice(3)), e);
                }
                if (e.length < 3) fail(`${op.description}: needs bindings and a body`, e);
                const core = op === LET ? CORE_LET : op === LET_STAR ? CORE_LET_STAR : CORE_LETREC;
                const bindings = bindingsOf(op.description!, e[1], e).map(b => keepPos([b[0], walk(b[1])], b));
                return [core, bindings, ...body(e.slice(2))];
            }
            case LET_VALUES: case RECEIVE: {
                const clauses = op === RECEIVE ? [[e[1], e[2]]] : e[1];
                const items = e.slice(op === RECEIVE ? 3 : 2);
                if ((op === RECEIVE && e.length < 3) || !Array.isArray(clauses) || !clauses.every((c: any) => Array.isArray(c) && c.length === 2) || items.length === 0) {
                    fail(op === RECEIVE ? "receive: (receive formals expr body ...)" : "let-values: (let-values ((formals expr) ...) body ...)", e);
                }
                return [CORE_LET_VALUES_STRICT, clauses.map((c: any[]) => [...formalsOf(op.description!, c[0], e), walk(c[1])]), ...body(items)];
            }
            case IF:
                if (e.length !== 3 && e.length !== 4) fail("if: (if test then [else])", e);
                return [CORE_IF, ...body(e.slice(1))];
            case SET:
                if (e.length !== 3 || typeof e[1] !== "symbol") fail("set!: (set! name expr)", e);
                return [CORE_SET, e[1], walk(e[2])];
            case BEGIN:
                return [CORE_BEGIN, ...body(e.slice(1))];
            case COND: {
                const clauses = e.slice(1);
                if (!clauses.every((c: any) => Array.isArray(c) && c.length >= 1)) fail("cond: (cond (test body ...) ... [(else body ...)])", e);
                const out: any[] = [CORE_IF];
                for (const [i, c] of clauses.entries()) {
                    if (c[0] === ELSE) {
                        if (i !== clauses.length - 1 || c.length < 2) fail("cond: else must be last, with a body", e);
                        out.push(seq(c.slice(1), c));
                    } else {
                        if (c.length < 2) fail("cond: each clause needs a body (use or for a test's own value)", c);
                        out.push(walk(c[0]), seq(c.slice(1), c));
                    }
                }
                return out.length === 1 ? undefined : out.length === 2 ? out[1] : out;
            }
            case ELSE:
                return fail("else: only in cond", e);
            case NOT:
                if (e.length !== 2) fail("not: (not x)", e);
                return [CORE_IF, walk(e[1]), false, true];
            case WHEN: case UNLESS: {
                if (e.length < 3) fail(`${op.description}: needs a condition and a body`, e);
                const then = keepPos([CORE_BEGIN, ...body(e.slice(2))], e);
                return op === WHEN ? [CORE_IF, walk(e[1]), then] : [CORE_IF, walk(e[1]), undefined, then];
            }
            case AND: {
                const xs = body(e.slice(1));
                if (xs.length === 0) return true;
                return xs.reduceRight((rest, x) => [CORE_IF, x, rest, false]);
            }
            case OR: {
                const xs = body(e.slice(1));
                if (xs.length === 0) return false;
                return xs.reduceRight((rest, x) => {
                    const t = Symbol("or");
                    return [CORE_LET, [[t, x]], [CORE_IF, t, t, rest]];
                });
            }
            case APPLY: {
                if (e.length < 3) fail("apply: (apply f x ... seq)", e);
                const args = [...body(e.slice(2, -1)), spread(walk(e[e.length - 1]))];
                return isIntrinsicName(e[1]) ? [CORE_INTAPPLY, e[1], ...args] : [CORE_APPLY, walk(e[1]), ...args];
            }
        }
    };
    return walk(ast);
};

const NOT_A_LOOP = Symbol("not a loop");

// whether `name` is used anywhere in `e` (outside quoted data)
const mentions = (e: any, name: symbol): boolean => e === name || (Array.isArray(e) && e[0] !== CORE_QUOTE && e.some(x => mentions(x, name)));

// A loop when `name` is only ever called in tail position of the body with every argument: carriers hold the next
// round's arguments, assigned right before the jump to it (every value computed first, so none is assigned before a call
// and read after it), and the parameters are bound fresh from them every round, as calls would bind them; a
// continuation captured in a round keeps that round's values. Else a %letrec of the procedure, called with the inits
const namedLet = (name: symbol, params: symbol[], inits: any[], items: any[], e: any): any => {
    try {
        return asLoop(name, params, inits, items);
    } catch (err) {
        if (err !== NOT_A_LOOP) throw err;
    }
    const temps = inits.map(() => Symbol("init"));
    const proc = keepPos([CORE_LAMBDA, [[], params, null, ...items]], e);
    return [CORE_LET, temps.map((t, i) => [t, inits[i]]), [CORE_LETREC, [[name, proc]], [CORE_CALL, name, ...temps]]];
};

const asLoop = (name: symbol, params: symbol[], inits: any[], items: any[]): any => {
    const carriers = params.map(p => Symbol(p.description));
    const done = Symbol("done"), next = Symbol("next");
    const binds = (names: any[]) => names.includes(name);
    const seq = (xs: any[], tail: boolean, blocks: ReadonlySet<symbol>) => xs.map((x, i) => rw(x, tail && i === xs.length - 1, blocks));
    const values = (xs: any[], blocks: ReadonlySet<symbol>) => xs.map(x => rw(x, false, blocks));
    const rw = (e: any, tail: boolean, blocks: ReadonlySet<symbol>): any => {
        if (e === name) throw NOT_A_LOOP;
        if (!Array.isArray(e) || e.length === 0) return e;
        const op = e[0];
        const keep = (to: any[]) => keepPos(to, e);
        switch (op) {
            case CORE_QUOTE:
                return e;
            case CORE_LAMBDA:
                if (e.slice(1).every((c: any[]) => binds([...c[1], c[2]]) || !mentions(c.slice(3), name))) return e;
                throw NOT_A_LOOP;
            case CORE_IF: {
                const args = e.slice(1);
                const branch = (i: number) => i % 2 === 1 || i === args.length - 1;
                return keep([op, ...args.map((a: any, i: number) => rw(a, tail && branch(i), blocks))]);
            }
            case CORE_BEGIN:
                return keep([op, ...seq(e.slice(1), tail, blocks)]);
            case CORE_SET:
                if (e[1] === name) throw NOT_A_LOOP;
                return keep([op, e[1], rw(e[2], false, blocks)]);
            case OP_DEFINE_GLOBAL:
                return keep([op, e[1], rw(e[2], false, blocks)]);
            case CORE_LET_STAR: {
                const at = e[1].findIndex((b: any[]) => b[0] === name);
                const bindings = e[1].map((b: any[], i: number) => at !== -1 && i > at ? b : keepPos([b[0], rw(b[1], false, blocks)], b));
                return keep([op, bindings, ...(at !== -1 ? e.slice(2) : seq(e.slice(2), tail, blocks))]);
            }
            case CORE_LETREC:
                if (binds(e[1].map((b: any[]) => b[0]))) return e;
                return keep([op, e[1].map((b: any[]) => keepPos([b[0], rw(b[1], false, blocks)], b)), ...seq(e.slice(2), tail, blocks)]);
            case CORE_LET: {
                const shadowed = binds(e[1].map((b: any[]) => b[0]));
                const bindings = e[1].map((b: any[]) => keepPos([b[0], rw(b[1], false, blocks)], b));
                return keep([op, bindings, ...(shadowed ? e.slice(2) : seq(e.slice(2), tail, blocks))]);
            }
            case CORE_LET_VALUES:
            case CORE_LET_VALUES_STRICT: {
                const shadowed = binds(e[1].flatMap((c: any[]) => [...c[0], c[1]]));
                const clauses = e[1].map((c: any[]) => [c[0], c[1], rw(c[2], false, blocks)]);
                return keep([op, clauses, ...(shadowed ? e.slice(2) : seq(e.slice(2), tail, blocks))]);
            }
            case CORE_BLOCK: {
                // a block in tail position gives the body's value; one that is not hides any outer block of its name
                const inner = new Set(blocks);
                if (tail) inner.add(e[1]);
                else inner.delete(e[1]);
                return keep([op, e[1], ...seq(e.slice(2), tail, inner)]);
            }
            case CORE_ESCAPE:
                return e.length < 3 ? e : keep([op, e[1], rw(e[2], blocks.has(e[1]), blocks)]);
            case CORE_LOOP:
                return keep([op, ...seq(e.slice(1), false, blocks)]);
            case CORE_INTCALL:
            case CORE_INTAPPLY:
                return keep([op, e[1], ...values(e.slice(2), blocks)]);
            case CORE_CALL: {
                if (e[1] !== name) return keep([op, ...values(e.slice(1), blocks)]);
                const args = e.slice(2);
                if (!tail || args.length !== params.length) throw NOT_A_LOOP;
                const vals = values(args, blocks);
                const temps = vals.slice(0, -1).map(() => Symbol("arg"));
                const sets = [
                    ...(vals.length > 0 ? [[CORE_SET, carriers[vals.length - 1], vals[vals.length - 1]]] : []),
                    ...temps.map((t, i) => [CORE_SET, carriers[i], t]),
                ];
                const jump = [CORE_BEGIN, ...sets, [CORE_ESCAPE, next]];
                return keep(temps.length === 0 ? jump : [CORE_LET, temps.map((t, i) => [t, vals[i]]), jump]);
            }
        }
        return keep([op, ...values(e.slice(1), blocks)]);
    };
    const loopBody = seq(items, true, new Set());
    return [CORE_LET, carriers.map((c, i) => [c, inits[i]]),
        [CORE_BLOCK, done,
            [CORE_LOOP,
                [CORE_BLOCK, next,
                    [CORE_LET, params.map((p, i) => [p, carriers[i]]),
                        [CORE_ESCAPE, done, [CORE_BEGIN, ...loopBody]]]]]]];
};
