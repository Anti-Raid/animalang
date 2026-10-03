// The optimizer, after Chez's cp0 (Waddell and Dybvig, "Fast and Effective Procedure Inlining"): one walk that
// simplifies as it goes, over a program whose locals are never assigned (the assignments pass made every assigned local a
// box), so a variable's value is the one it was bound to:
//  - constants and copies of variables take the place of the variables bound to them
//  - a call of a foldable intrinsic on constants is its value (if it does not throw), and an %if on a constant test its
//    branch (only #f is false)
//  - what is computed only for its effects, and has none, is dropped: an unused binding of such a value too
//  - ((%lambda (x ...) body) arg ...) is (%let ((x arg) ...) body), and a call of a local lambda is its body so bound,
//    when the lambda is called once and used no other way (its binding then goes), or is small, within a total budget.
//    A %letrec's lambdas are not inlined in their own group, so a self tail call stays a loop
// Nothing is moved past anything else, and a call that could fail or have an effect is never dropped or run early. Forms
// whose binders code generation rejects, and lambdas that escape to a %block outside them, are left as they are, so their
// errors stay. Globals are never inlined or
// propagated: they can be changed
import { CORE_BEGIN, CORE_BLOCK, CORE_ESCAPE, CORE_IF, CORE_LAMBDA, CORE_LET, CORE_LOOP, CORE_QUOTE, SOURCE_POS, SPECIAL_FORMS } from "../../common";
import { isCoreForm } from "../core";
import type { Intrinsics } from "../intrinsics";
import { BOXED, isLetrecLambda, isPadded, unwrapBoxed } from "../lambda";
import { BOX, BOX_IN_PLACE, Lconv, SET_BOX, UNBOX } from "./assignments";
import { keepPos, malformed, mapExprs, subExprs } from "./lang";
import { renamer } from "./rename";

// a lambda of at most this many forms may be inlined at every call, within the budget; one called once always may
const INLINE_SIZE = 16;
const INLINE_BUDGET = 2000;

type Info = { k: "const", e: any } | { k: "alias", sym: symbol } | { k: "lambda", lambda: any[], once: boolean, name: string }
    // a sequence made of locals and constants, used once outside any lambda or loop, so made where it is used
    | { k: "seq", e: any[] };

// (%inlined name body): `body` is the procedure `name`'s, inlined where this form is (tracebacks show its frame, see
// Code.inlines); the name is a label, not a variable. %tail-inlined: the same, called in the tail position of the
// procedure the form is in, so its frame replaces that procedure's
export const INLINED = Symbol.for("%inlined");
export const TAIL_INLINED = Symbol.for("%tail-inlined");
const WITH_MARK = Symbol.for("%with-mark");
const APPLY = Symbol.for("%apply");
const ARRAY = Symbol.for("%array");
type Env = ReadonlyMap<symbol, Info>;
// what the walk knows where it is: the variables bound to what it can use, the lambdas not to inline there (their own
// %letrec group, and those being inlined), whether it is in the tail position of the procedure it is in (a lambda's,
// or one inlined), and the same of each %block around it
type K = { readonly env: Env, readonly own: ReadonlySet<symbol>, readonly tail: boolean, readonly blocks: ReadonlyMap<symbol, boolean> };
const notTail = (k: K): K => k.tail ? { ...k, tail: false } : k;
type Ctx = "value" | "effect";

const VOID = undefined;

const isConst = (e: any): boolean => (!Array.isArray(e) && typeof e !== "symbol") || (Array.isArray(e) && e[0] === CORE_QUOTE && e.length === 2);
const constValue = (e: any): any => Array.isArray(e) ? e[1] : e;
const asConst = (v: any): any => typeof v === "symbol" || (typeof v === "object" && v !== null) ? [CORE_QUOTE, v] : v;

const children = (e: any): any[] => Array.isArray(e) && e[0] !== CORE_QUOTE ? subExprs(Lconv, e) : [];

// how many forms `e` has, counting up to just past `limit`
const sizeOf = (e: any, limit: number): number => {
    let n = 0;
    const walk = (x: any) => {
        if (n > limit) return;
        n++;
        for (const y of children(x)) walk(y);
    };
    walk(e);
    return n;
};

// how often `sym` is used in the expressions `es`
const usesIn = (es: readonly any[], sym: symbol): number => {
    let n = 0;
    const walk = (x: any) => {
        if (x === sym) n++;
        else for (const y of children(x)) walk(y);
    };
    es.forEach(walk);
    return n;
};

// whether every use of `sym` in `es` is as the operator of a call
const onlyCalledIn = (es: readonly any[], sym: symbol): boolean => {
    const walk = (x: any): boolean => x !== sym && children(x).every((y, i) => i === 0 && y === sym && x[0] === sym ? true : walk(y));
    return es.every(walk);
};

// whether `sym` is boxed in place in `es` ((%box! sym), see the assignments pass)
const boxedInPlace = (es: readonly any[], sym: symbol): boolean => {
    const walk = (x: any): boolean => Array.isArray(x) && x[0] !== CORE_QUOTE && ((x[0] === BOX_IN_PLACE && x[1] === sym) || children(x).some(walk));
    return es.some(walk);
};

// whether `sym` is used once in `es`, and not inside a lambda or a loop there (which could run it more than once)
const usedOnceStraight = (es: readonly any[], sym: symbol): boolean => {
    let n = 0, nested = false;
    const walk = (x: any, inside: boolean) => {
        if (x === sym) {
            n++;
            nested ||= inside;
        } else if (Array.isArray(x)) {
            const deeper = inside || x[0] === CORE_LAMBDA || x[0] === CORE_LOOP;
            for (const y of children(x)) walk(y, deeper);
        }
    };
    es.forEach(x => walk(x, false));
    return n === 1 && !nested;
};

// whether `e` escapes to a %block outside it (which is an error inside a lambda, and must stay one)
const escapesOut = (e: any, inside: ReadonlySet<symbol> = new Set()): boolean => {
    if (!Array.isArray(e) || e[0] === CORE_QUOTE) return false;
    if (e[0] === CORE_ESCAPE) return !inside.has(e[1]) || children(e).some(x => escapesOut(x, inside));
    const within = e[0] === CORE_BLOCK ? new Set([...inside, e[1]]) : inside;
    return children(e).some(x => escapesOut(x, within));
};

export type Optimized = { ast: any, assumed: ReadonlySet<number> };

export const optimize = (ast: any, intrinsics: Intrinsics): Optimized => {
    // the intrinsics whose calls were folded or dropped: the code still depends on what they are (see Code.bind)
    const assumed = new Set<number>();
    const locals = new Set<symbol>();
    const copy = renamer(intrinsics);
    let budget = INLINE_BUDGET;

    const intrinsicOf = (op: any) => typeof op === "symbol" && !isCoreForm(op) ? intrinsics.get(op) : undefined;
    const canBind = (n: any) => typeof n === "symbol" && !SPECIAL_FORMS.has(n) && intrinsics.reserved.get(n) === undefined && !isCoreForm(n) && intrinsics.get(n) === undefined;
    // binders code generation accepts (any other form fails to compile, so is left as it is)
    const validBinders = (names: any[]) => names.every(canBind) && new Set(names).size === names.length;
    const clauseNames = (c: any[]) => c[2] === null ? c[1] : [...c[1], c[2]];

    // whether `e` has no effect and cannot fail, so it may be dropped when its value is not used
    const effectFree = (e: any): boolean => {
        if (isConst(e)) return true;
        if (typeof e === "symbol") return locals.has(e);
        if (!Array.isArray(e)) return true;
        const op = e[0];
        if (op === CORE_LAMBDA) return malformed(Lconv, e) === null && e.slice(1).every((c: any[]) => validBinders(clauseNames(c)));
        if (op === UNBOX) return e.length === 2 && locals.has(e[1]);
        if (op === BOX) return e.length === 2 && effectFree(e[1]);
        if (op === CORE_BEGIN) return e.slice(1).every(effectFree);
        const entry = intrinsicOf(op);
        if (entry?.effectFree && e.length - 1 >= entry.min && e.length - 1 <= entry.max && e.slice(1).every(effectFree)) {
            assumed.add(entry.pos);
            return true;
        }
        return false;
    };

    // the expressions of a body, the last in `ctx` (and in the body's tail position), the others for their effects only
    const body = (items: any[], ctx: Ctx, k: K): any[] => {
        const out: any[] = [];
        items.forEach((x, i) => {
            const last = i === items.length - 1;
            const y = last ? walk(x, ctx, k) : walk(x, "effect", notTail(k));
            const parts = Array.isArray(y) && y[0] === CORE_BEGIN ? y.slice(1) : [y];
            out.push(...(last ? parts : parts.filter(z => !isConst(z))));
        });
        return out;
    };
    const asExpr = (items: any[], from: any): any => items.length === 0 ? VOID : items.length === 1 ? items[0] : keepPos([CORE_BEGIN, ...items], from);

    // what binding `name` to `init` (simplified) tells the walk of `scope`: a constant or a copy takes its place (the
    // binding goes), a lambda may be inlined
    const learn = (env: Map<symbol, Info>, name: symbol, init: any, scope: readonly any[]): boolean => {
        // boxed in place, it holds its box from then on: not the value it was bound to
        if (boxedInPlace(scope, name)) return false;
        if (isConst(init)) env.set(name, { k: "const", e: init });
        else if (typeof init === "symbol" && locals.has(init)) env.set(name, { k: "alias", sym: init });
        else if (sequenceOf(init) !== null && usedOnceStraight(scope, name)) env.set(name, { k: "seq", e: init });
        else {
            if (inlinable(init)) env.set(name, { k: "lambda", lambda: init, once: usesIn(scope, name) === 1 && onlyCalledIn(scope, name), name: String(name.description) });
            return false;
        }
        return true;
    };
    const inlinable = (e: any): boolean => Array.isArray(e) && e[0] === CORE_LAMBDA && e.length === 2 && malformed(Lconv, e) === null
        && validBinders(clauseNames(e[1])) && !escapesOut([CORE_BEGIN, ...e[1].slice(3)]);
    // whether a call with `nargs` arguments binds the clause's parameters (else it is left to fail as a call)
    const fits = (c: any[], nargs: number) => isPadded(c) || (c[2] === null ? nargs === c[1].length : nargs >= c[1].length);

    // the elements of a sequence made of locals and constants (by the table's pack, or %array where it has none), or null
    const sequenceOf = (e: any): any[] | null => {
        if (!Array.isArray(e) || e[0] !== (intrinsics.pack !== undefined ? Symbol.for(intrinsics.pack.name) : ARRAY)) return null;
        return e.slice(1).every(x => isConst(x) || (typeof x === "symbol" && locals.has(x))) ? e.slice(1) : null;
    };
    // what %apply takes last: an array, or of the table's own sequences, what its spread makes of one
    const elementsOf = (last: any): any[] | null => {
        if (intrinsics.pack === undefined) return Array.isArray(last) && last[0] === ARRAY ? last.slice(1) : null;
        if (intrinsics.spread === undefined || !Array.isArray(last) || last[0] !== Symbol.for(intrinsics.spread.name) || last.length !== 2) return null;
        const packed = last[1];
        return Array.isArray(packed) && packed[0] === Symbol.for(intrinsics.pack.name) ? packed.slice(1) : null;
    };

    // the bindings still needed: those with an init that may do something, and those the body or a needed binding's init
    // uses (so procedures that only call each other go when nothing else uses them)
    const needed = (bindings: any[][], items: readonly any[]): any[][] => {
        const kept = new Set(bindings.filter(([, init]) => !effectFree(unwrapBoxed(init))).map(b => b[0]));
        for (let reach = [...items, ...bindings.filter(b => kept.has(b[0])).map(b => b[1])]; reach.length > 0;) {
            const found = bindings.filter(b => !kept.has(b[0]) && usesIn(reach, b[0]) > 0);
            for (const b of found) kept.add(b[0]);
            reach = found.map(b => b[1]);
        }
        return bindings.filter(b => kept.has(b[0]));
    };

    const walk = (e: any, ctx: Ctx, k: K): any => {
        if (typeof e === "symbol") {
            const info = k.env.get(e);
            if (info?.k === "const") return ctx === "effect" ? VOID : info.e;
            if (info?.k === "alias") return walk(info.sym, ctx, k);
            if (info?.k === "seq") return ctx === "effect" ? VOID : info.e;
            return ctx === "effect" && locals.has(e) ? VOID : e;
        }
        if (!Array.isArray(e)) return ctx === "effect" ? VOID : e;
        if (e.length === 0) return e;
        const op = e[0];
        const shape = Lconv.forms.get(op);
        if (shape !== undefined && shape !== "exprs" && malformed(Lconv, e) !== null) return e;
        const value = (x: any, env: Env = k.env) => walk(x, "value", { ...notTail(k), env });
        switch (shape) {
            case "quote":
                return ctx === "effect" ? VOID : e;
            case "lambda":
                if (!e.slice(1).every((c: any[]) => validBinders(clauseNames(c)))) return e;
                if (ctx === "effect") return VOID;
                return keepPos([op, ...e.slice(1).map((c: any[]) => {
                    for (const n of clauseNames(c)) locals.add(n);
                    return [c[0], c[1], c[2], ...body(c.slice(3), "value", { env: k.env, own: k.own, tail: true, blocks: new Map() })];
                })], e);
            case "let": {
                const bindings: any[][] = e[1];
                if (!validBinders(bindings.map(b => b[0]))) return e;
                const items = e.slice(2);
                const inner = new Map(k.env);
                const kept: any[][] = [];
                for (const [name, init] of bindings) {
                    const v = value(init);
                    locals.add(name);
                    if (!learn(inner, name, v, items)) kept.push([name, v]);
                }
                const done = body(items, ctx, { ...k, env: inner });
                const rest = needed(kept, done);
                return rest.length === 0 ? asExpr(done, e) : keepPos([op, rest, ...done], e);
            }
            case "let*": {
                const bindings: any[][] = e[1];
                if (!bindings.every(b => canBind(b[0]))) return e;
                const inner = new Map(k.env);
                const kept: any[][] = [];
                bindings.forEach(([name, init], i) => {
                    const v = value(init, inner);
                    locals.add(name);
                    if (!learn(inner, name, v, [...bindings.slice(i + 1).map(b => b[1]), ...e.slice(2)])) kept.push([name, v]);
                });
                const done = body(e.slice(2), ctx, { ...k, env: inner });
                const rest = needed(kept, done);
                return rest.length === 0 ? asExpr(done, e) : keepPos([op, rest, ...done], e);
            }
            case "letrec": {
                const bindings: any[][] = e[1];
                const names = bindings.map(b => b[0]);
                if (!validBinders(names)) return e;
                for (const n of names) locals.add(n);
                const items = e.slice(2);
                const inner = new Map(k.env);
                // a %letrec's lambdas are not inlined into each other, so recursion stays recursion
                const group = new Set([...k.own, ...names]);
                const lambda = (init: any) => isLetrecLambda(init) && init === unwrapBoxed(init) && inlinable(init);
                const scopeOf = (name: symbol) => [...bindings.filter(b => b[0] !== name).map(b => b[1]), ...items];
                for (const [name, init] of bindings) {
                    if (lambda(init)) inner.set(name, { k: "lambda", lambda: init, once: usesIn([init], name) === 0 && usesIn(scopeOf(name), name) === 1 && onlyCalledIn(scopeOf(name), name), name: String(name.description) });
                }
                const inits = bindings.map(([name, init]) => {
                    const inside = unwrapBoxed(init);
                    const v = walk(inside, "value", { ...notTail(k), env: inner, own: isLetrecLambda(init) ? group : k.own });
                    if (lambda(init)) inner.set(name, { ...(inner.get(name) as any), lambda: v });
                    return inside === init ? v : [BOXED, v];
                });
                const done = body(items, ctx, { ...k, env: inner });
                const rest = needed(bindings.map((b, i) => keepPos([b[0], inits[i]], b)), done);
                return rest.length === 0 ? asExpr(done, e) : keepPos([op, rest, ...done], e);
            }
            case "let-values": {
                const clauses = e[1].map((c: any[]) => [c[0], c[1], value(c[2])]);
                for (const n of clauses.flatMap((c: any[]) => c[1] === null ? c[0] : [...c[0], c[1]])) if (typeof n === "symbol") locals.add(n);
                return keepPos([op, clauses, ...body(e.slice(2), ctx, k)], e);
            }
        }
        switch (op) {
            case CORE_BEGIN:
                return asExpr(body(e.slice(1), ctx, k), e);
            case CORE_IF:
                return walkIf(e, ctx, k);
            case SET_BOX:
                return keepPos([op, aliasOf(e[1], k.env), value(e[2])], e);
            // a block's body is in its tail position, and so is the value of an escape to it
            case CORE_BLOCK:
                return keepPos([op, e[1], ...body(e.slice(2), ctx, { ...k, blocks: new Map(k.blocks).set(e[1], k.tail) })], e);
            case CORE_ESCAPE:
                return e.length > 2 ? keepPos([op, e[1], walk(e[2], "value", { ...k, tail: k.blocks.get(e[1]) ?? false })], e) : e;
            case WITH_MARK:
                return e.length === 4 ? keepPos([op, value(e[1]), value(e[2]), walk(e[3], ctx, k)], e) : e;
            case APPLY: {
                if (e.length < 3) break;
                const next = keepPos([op, ...e.slice(1).map((x: any) => value(x))], e);
                const elems = elementsOf(next[next.length - 1]);
                if (elems === null) return next;
                // (%apply f x ... ys) of a sequence made right there: a call of f with x ... and the elements
                const call = keepPos([next[1], ...next.slice(2, -1), ...elems], e);
                const entry = intrinsicOf(next[1]);
                if (entry !== undefined && (!entry.leaf || call.length - 1 < entry.min || call.length - 1 > entry.max)) return next;
                if (entry === undefined && typeof next[1] === "symbol" && isCoreForm(next[1])) return next;
                return walkCall(call, ctx, k);
            }
            // an inlined body's tail position is its procedure's
            case INLINED:
            case TAIL_INLINED: {
                const items = body(e.slice(2), ctx, { ...k, tail: true });
                // nothing of it left to run, nothing to show in a traceback
                return items.length === 0 || (items.length === 1 && isConst(items[0])) ? asExpr(items, e) : keepPos([op, e[1], ...items], e);
            }
        }
        if (shape !== undefined || isCoreForm(op)) {
            const next = mapExprs(Lconv, e, x => x === op ? x : value(x));
            return ctx === "effect" && (op === BOX || op === UNBOX) && effectFree(next) ? VOID : next;
        }
        return walkCall(e, ctx, k);
    };

    // the variable `sym` is a copy of, if it is one
    const aliasOf = (sym: any, env: Env): any => {
        for (let info = typeof sym === "symbol" ? env.get(sym) : undefined; info?.k === "alias"; info = env.get(sym)) sym = info.sym;
        return sym;
    };

    const walkIf = (e: any[], ctx: Ctx, k: K): any => {
        const args = e.slice(1);
        if (args.length < 2) return e;
        const clauses: any[] = [];
        for (let i = 0; i + 1 < args.length; i += 2) {
            const test = walk(args[i], "value", notTail(k));
            if (isConst(test)) {
                if (constValue(test) === false) continue;
                // a true test: its branch is the rest of the chain
                const branch = walk(args[i + 1], ctx, k);
                return clauses.length === 0 ? branch : keepPos([CORE_IF, ...clauses, branch], e);
            }
            clauses.push(test, walk(args[i + 1], ctx, k));
        }
        const hasElse = args.length % 2 === 1;
        const otherwise = hasElse ? walk(args[args.length - 1], ctx, k) : VOID;
        if (clauses.length === 0) return otherwise;
        return keepPos([CORE_IF, ...clauses, ...(hasElse ? [otherwise] : [])], e);
    };

    // (lambda arg ...) as a %let of its parameters around its body, marked as the procedure `name`'s, inlined at the
    // call (the arguments are evaluated outside it, as they are by the caller)
    // A missing parameter of a padded clause is <#void>; arguments past the parameters are evaluated, in order, into
    // names of their own, and are the rest parameter's elements (a padded clause without one drops them)
    const inlined = (name: string, lambda: any[], call: any[], ctx: Ctx, k: K): any => {
        const [, params, rest] = lambda[1];
        const args = call.slice(1);
        const extra = args.slice(params.length).map((x: any) => [Symbol("arg"), x]);
        const bindings = [...params.map((p: symbol, i: number) => [p, i < args.length ? args[i] : VOID]), ...extra];
        const marked = keepPos([k.tail ? TAIL_INLINED : INLINED, Symbol(name), ...lambda[1].slice(3)], call);
        const packed = rest === null ? marked : keepPos([CORE_LET, [[rest, [intrinsics.pack !== undefined ? Symbol.for(intrinsics.pack.name) : ARRAY, ...extra.map((b: any[]) => b[0])]]], marked], call);
        return walk(keepPos([CORE_LET, bindings, packed], call), ctx, k);
    };

    const walkCall = (e: any[], ctx: Ctx, k: K): any => {
        const op = e[0];
        const entry = intrinsicOf(op);
        if (entry !== undefined) {
            const args = e.slice(1).map(x => walk(x, "value", notTail(k)));
            if (entry.foldable && args.length >= entry.min && args.length <= entry.max && args.every(isConst)) {
                try {
                    const folded = entry.fn(args.map(constValue), 0, args.length);
                    assumed.add(entry.pos);
                    return ctx === "effect" ? VOID : asConst(folded);
                } catch {
                    // left to throw when it runs
                }
            }
            // the empty sequence, when it is no new object (as an empty list is not)
            if (entry === intrinsics.pack && args.length === 0) {
                const empty = entry.fn([], 0, 0);
                if (typeof empty !== "object" || empty === null) return ctx === "effect" ? VOID : empty;
            }
            const call = keepPos([op, ...args], e);
            return ctx === "effect" && effectFree(call) ? VOID : call;
        }
        // a lambda applied, or a local bound to one: its body, its parameters bound to the arguments
        const head = aliasOf(op, k.env);
        if (inlinable(head) && fits(head[1], e.length - 1)) {
            const pos = SOURCE_POS.get(head);
            return inlined(pos !== undefined ? `lambda@${pos.file}:${pos.line}` : "lambda", head, e, ctx, k);
        }
        const info = typeof head === "symbol" ? k.env.get(head) : undefined;
        if (info?.k === "lambda" && !k.own.has(head) && fits(info.lambda[1], e.length - 1)) {
            const size = sizeOf(info.lambda, INLINE_SIZE);
            if (info.once || (size <= INLINE_SIZE && budget >= size)) {
                if (!info.once) budget -= size;
                return inlined(info.name, copy(info.lambda), e, ctx, { ...k, own: new Set([...k.own, head]) });
            }
        }
        return keepPos([walk(op, "value", notTail(k)), ...e.slice(1).map(x => walk(x, "value", notTail(k)))], e);
    };

    return { ast: walk(ast, "value", { env: new Map(), own: new Set(), tail: true, blocks: new Map() }), assumed };
};
