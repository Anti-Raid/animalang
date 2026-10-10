// The optimizer, after Chez's cp0 (Waddell and Dybvig, "Fast and Effective Procedure Inlining"): one walk that
// simplifies as it goes, over a program whose locals are never assigned (the assignments pass made every assigned local a
// box), so a variable's value is the one it was bound to:
//  - constants and copies of variables take the place of the variables bound to them
//  - a call of a foldable intrinsic on constants is its value (if it does not throw), and an %if on a constant test its
//    branch (only #f is false)
//  - what is computed only for its effects, and has none, is dropped: an unused binding of such a value too
//  - (%call (%lambda (x ...) body) arg ...) is (%let ((x arg) ...) body), and a call of a local lambda is its body so bound,
//    when the lambda is called once and used no other way (its binding then goes), or is small, within a total budget.
//    A %letrec's lambdas are not inlined in their own group, so a self tail call stays a loop
// Nothing is moved past anything else, and a call that could fail or have an effect is never dropped or run early. Forms
// whose binders code generation rejects, and lambdas that escape to a %block outside them, are left as they are, so their
// errors stay. Globals are never inlined or
// propagated: they can be changed
import { CORE_BEGIN, CORE_BLOCK, CORE_CALL, CORE_ESCAPE, CORE_IF, CORE_INTAPPLY, CORE_INTCALL, CORE_LAMBDA, CORE_LET, CORE_LET_VALUES_STRICT, CORE_LOOP, CORE_QUOTE, SPECIAL_FORMS } from "../../common";
import { isCoreForm } from "../core";
import type { Intrinsics } from "../intrinsics";
import { BOXED, isLetrecLambda, isPadded, unwrapBoxed } from "../lambda";
import { BOX, BOX_IN_PLACE, Lconv, SET_BOX, UNBOX, boxesIn, convertAssignments } from "./assignments";
import { AstAnalysis } from "../analysis";
import { malformed, mapExprs, parts, subExprs, withBounds } from "./lang";
import { renamer } from "./rename";
import { posOf } from "../forms";

// a lambda of at most this many forms may be inlined at every call, within the budget; one called once always may. A
// known global's procedure (Intrinsics.defineKnown) of at most KNOWN_SIZE is inlined where an argument is a lambda
// or a known procedure, so the call of it inside can be inlined too
const INLINE_SIZE = 16;
const KNOWN_SIZE = 160;
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
const VALUES = Symbol.for("%values");
const ARRAY = Symbol.for("%array");
// what the walk knows of the variables bound where it is: a scope's own over those of the scopes around it (each
// scope a copy of the one around it would cost a function its locals times its binders)
class Env {
    readonly #own = new Map<symbol, Info>();

    constructor(readonly around: Env | null = null) {}

    get(sym: symbol): Info | undefined {
        for (let scope: Env | null = this; scope !== null; scope = scope.around) {
            const info = scope.#own.get(sym);
            if (info !== undefined) return info;
        }
        return undefined;
    }

    set(sym: symbol, info: Info): void {
        this.#own.set(sym, info);
    }
}
// what the walk knows where it is: the variables bound to what it can use, the lambdas not to inline there (their own
// %letrec group, and those being inlined), whether it is in the tail position of the procedure it is in (a lambda's,
// or one inlined), and the same of each %block around it
type K = { readonly env: Env, readonly own: ReadonlySet<symbol>, readonly tail: boolean, readonly blocks: ReadonlyMap<symbol, boolean> };
const notTail = (k: K): K => k.tail ? { ...k, tail: false } : k;
type Ctx = "value" | "effect";

const VOID = undefined;

const isConst = (e: any): boolean => (!Array.isArray(e) && typeof e !== "symbol") || (Array.isArray(e) && e[0] === CORE_QUOTE && e.length === 3);
const constValue = (e: any): any => Array.isArray(e) ? e[2] : e;
const asConst = (v: any): any => typeof v === "symbol" || (typeof v === "object" && v !== null) ? [CORE_QUOTE, null, v] : v;

const children = (e: any): any[] => Array.isArray(e) && e[0] !== CORE_QUOTE ? subExprs(Lconv, e) : [];

// what a form's head and intrinsic name add to its size, as when a call was (f arg ...) and an intrinsic's (%name arg ...)
const headWeight = (x: any): number => {
    if (!Array.isArray(x) || x[0] === CORE_CALL) return 0;
    if (x[0] === CORE_INTAPPLY) return 2;
    return x[0] === CORE_INTCALL || Lconv.forms.get(x[0]) === "exprs" ? 1 : 0;
};

// how many forms `e` has, counting up to just past `limit`
const sizeOf = (e: any, limit: number): number => {
    let n = 0;
    const walk = (x: any) => {
        if (n > limit) return;
        n += 1 + headWeight(x);
        for (const y of children(x)) walk(y);
    };
    walk(e);
    return n;
};

const lambdaName = (lambda: any): string => {
    const pos = posOf(lambda);
    return pos !== null ? `lambda@${pos.file}:${pos.line}` : "lambda";
};

// how often `sym` is used in the expressions `es`
const escapesTo = (e: any, label: symbol): boolean =>
    Array.isArray(e) && e[0] !== CORE_QUOTE && ((e[0] === CORE_ESCAPE && e[2] === label) || e.some(x => escapesTo(x, label)));

// What an optimized expression gives as multiple values, when it comes to a (%values e ...) under the markers of
// inlined procedures, blocks nothing escapes from, and %lets (what a call of a procedure that returns several values
// is, once inlined): the expressions; `mark`, which puts one back under the markers (so an error in it is still shown
// in the procedure's frame); and `around`, which binds the %lets' variables around a form
type Values = { exprs: any[], mark: (x: any) => any, around: (form: any) => any };
const valuesOf = (e: any, mark: (x: any) => any = x => x, around: (form: any) => any = x => x): Values | null => {
    if (!Array.isArray(e)) return null;
    if (e[0] === CORE_INTCALL && e[2] === VALUES) return { exprs: e.slice(3), mark, around };
    if (e[0] === INLINED && e.length === 4) return valuesOf(e[3], x => mark(isConst(x) || typeof x === "symbol" ? x : [INLINED, e[1], e[2], x]), around);
    if (e[0] === CORE_BLOCK && e.length === 4 && !escapesTo(e[3], e[2])) return valuesOf(e[3], mark, around);
    if (e[0] === CORE_BEGIN && e.length === 3) return valuesOf(e[2], mark, around);
    if (e[0] === CORE_LET && e.length === 4) {
        const marked = (init: any) => Array.isArray(init) && init[0] === BOX && init.length === 3 ? [BOX, init[1], mark(init[2])] : mark(init);
        return valuesOf(e[3], mark, form => around([CORE_LET, e[1], e[2].map((b: any[]) => [b[0], marked(b[1])]), form]));
    }
    return null;
};

// (a variable a (%set-box! x v) stores into is used there: its binding is the box)
const usesIn = (es: readonly any[], sym: symbol): number => {
    let n = 0;
    const walk = (x: any) => {
        if (x === sym) n++;
        else {
            if (Array.isArray(x) && x[2] === sym && Lconv.forms.get(x[0]) === "assign") n++;
            for (const y of children(x)) walk(y);
        }
    };
    es.forEach(walk);
    return n;
};

// the variables usesIn finds a use of in `es`
const usedIn = (es: readonly any[]): Set<symbol> => {
    const used = new Set<symbol>();
    const walk = (x: any) => {
        if (typeof x === "symbol") used.add(x);
        else {
            if (Array.isArray(x) && typeof x[2] === "symbol" && Lconv.forms.get(x[0]) === "assign") used.add(x[2]);
            for (const y of children(x)) walk(y);
        }
    };
    es.forEach(walk);
    return used;
};

// whether every use of `sym` in `es` is as the operator of a call
const onlyCalledIn = (es: readonly any[], sym: symbol): boolean => {
    const walk = (x: any): boolean => x !== sym && children(x).every((y, i) => i === 0 && y === sym && x[0] === CORE_CALL ? true : walk(y));
    return es.every(walk);
};

// whether `sym` is boxed in place in `es` ((%box! sym), see the assignments pass)
const boxedInPlace = (es: readonly any[], sym: symbol): boolean => {
    const walk = (x: any): boolean => Array.isArray(x) && x[0] !== CORE_QUOTE && ((x[0] === BOX_IN_PLACE && x[2] === sym) || children(x).some(walk));
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
    if (e[0] === CORE_ESCAPE) return !inside.has(e[2]) || children(e).some(x => escapesOut(x, inside));
    const within = e[0] === CORE_BLOCK ? new Set([...inside, e[2]]) : inside;
    return children(e).some(x => escapesOut(x, within));
};

// the free variables of `e` (in expression positions), given the names bound around it
const freeIn = (e: any, bound: ReadonlySet<symbol>, out: Set<symbol>): Set<symbol> => {
    if (typeof e === "symbol") {
        if (!bound.has(e)) out.add(e);
    } else if (Array.isArray(e) && e[0] !== CORE_QUOTE) {
        for (const [x, around] of withBounds(parts(Lconv, e), bound)) freeIn(x, around, out);
    }
    return out;
};

// What a program does with each of its variables (a name is one variable, so its uses are those of its scope): what
// usesIn, onlyCalledIn, boxedInPlace and usedOnceStraight find in a binding's scope, found for every variable in one walk.
// Asking those of each binding in turn costs a function with many locals its length squared. Null for a program with
// a form that is not laid out as it should be (which those walk as far as they can)
type Uses = { uses: number, straight: number, nested: boolean, other: boolean, boxed: boolean };
const usesOfAll = (ast: any): Map<symbol, Uses> | null => {
    const all = new Map<symbol, Uses>();
    // how many lambdas and loops a variable's binder is inside
    const bound = new Map<symbol, number>();
    const of = (sym: symbol): Uses => {
        let u = all.get(sym);
        if (u === undefined) all.set(sym, u = { uses: 0, straight: 0, nested: false, other: false, boxed: false });
        return u;
    };
    let wellFormed = true;
    const visit = (x: any[], depth: number): void => {
        const shape = Lconv.forms.get(x[0]);
        if (x.length === 0 || shape === "quote") return;
        if (shape === undefined || malformed(Lconv, x) !== null) {
            wellFormed = false;
            return;
        }
        if (x[0] === BOX_IN_PLACE && typeof x[2] === "symbol") of(x[2]).boxed = true;
        if (shape === "assign" && typeof x[2] === "symbol") of(x[2]).uses++;
        const inner = x[0] === CORE_LAMBDA || x[0] === CORE_LOOP ? depth + 1 : depth;
        const exprs = parts(Lconv, x).exprs;
        // (a variable nothing uses is known too: as one with no uses)
        for (const [, names] of exprs) {
            for (const name of names) {
                if (bound.has(name)) continue;
                bound.set(name, inner);
                of(name);
            }
        }
        exprs.forEach(([y], i) => {
            if (typeof y === "symbol") {
                const u = of(y);
                u.uses++;
                u.straight++;
                if (inner > (bound.get(y) ?? inner)) u.nested = true;
                if (!(i === 0 && x[0] === CORE_CALL)) u.other = true;
            } else if (Array.isArray(y)) visit(y, inner);
        });
    };
    if (Array.isArray(ast)) visit(ast, 0);
    return wellFormed ? all : null;
};

// `boxes`: the variables boxes were made of in what was inlined (for the unbox pass)
export type Optimized = { ast: any, assumed: ReadonlySet<number>, boxes: ReadonlySet<symbol> };

export const optimize = (ast: any, intrinsics: Intrinsics): Optimized => {
    // the intrinsics whose calls were folded or dropped: the code still depends on what they are (see Code.bind)
    const assumed = new Set<number>();
    const locals = new Set<symbol>();
    const copy = renamer(intrinsics);
    // (a variable made by inlining is not among them: its scope is looked through)
    const known = usesOfAll(ast);
    let budget = INLINE_BUDGET;
    const boxes = new Set<symbol>();

    // a known global's procedure as this pass takes its input: names of its own, its assigned locals boxes (null if it
    // refers to anything but intrinsics and its own variables, which may mean something else where it is inlined)
    const prepared = new Map<any, boolean>();
    const prepare = (lambda: any): any[] | null => {
        let closed = prepared.get(lambda);
        if (closed === undefined) {
            closed = freeIn(lambda, new Set(), new Set()).size === 0;
            prepared.set(lambda, closed);
        }
        if (!closed) return null;
        const own = copy(lambda);
        const converted = convertAssignments(own, new AstAnalysis(intrinsics).analyze(own).variables);
        for (const sym of converted.boxes) boxes.add(sym);
        return converted.ast;
    };

    const intrinsicOf = (name: any) => typeof name === "symbol" ? intrinsics.get(name) : undefined;
    const PACK = intrinsics.pack !== undefined ? Symbol.for(intrinsics.pack.name) : ARRAY;
    const isIntCall = (e: any, name: symbol) => Array.isArray(e) && e[0] === CORE_INTCALL && e[2] === name;
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
        if (op === CORE_LAMBDA) return malformed(Lconv, e) === null && e.slice(2).every((c: any[]) => validBinders(clauseNames(c)));
        if (op === UNBOX) return e.length === 3 && locals.has(e[2]);
        if (op === BOX) return e.length === 3 && effectFree(e[2]);
        if (op === CORE_BEGIN) return e.slice(2).every(effectFree);
        const entry = op === CORE_INTCALL ? intrinsicOf(e[2]) : undefined;
        if (entry?.effectFree && e.length - 3 >= entry.min && e.length - 3 <= entry.max && e.slice(3).every(effectFree)) {
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
            const parts = Array.isArray(y) && y[0] === CORE_BEGIN ? y.slice(2) : [y];
            out.push(...(last ? parts : parts.filter(z => !isConst(z))));
        });
        return out;
    };
    const asExpr = (items: any[], from: any): any => items.length === 0 ? VOID : items.length === 1 ? items[0] : [CORE_BEGIN, posOf(from), ...items];

    // what binding `name` to `init` (simplified) tells the walk of `scope`: a constant or a copy takes its place (the
    // binding goes), a lambda may be inlined
    const learn = (env: Env, name: symbol, init: any, scope: () => readonly any[]): boolean => {
        const u = known?.get(name);
        // boxed in place, it holds its box from then on: not the value it was bound to
        if (u !== undefined ? u.boxed : boxedInPlace(scope(), name)) return false;
        if (isConst(init)) env.set(name, { k: "const", e: init });
        else if (typeof init === "symbol" && locals.has(init)) env.set(name, { k: "alias", sym: init });
        else if (sequenceOf(init) !== null && (u !== undefined ? u.straight === 1 && !u.nested : usedOnceStraight(scope(), name))) env.set(name, { k: "seq", e: init });
        else {
            if (inlinable(init)) {
                const once = u !== undefined ? u.uses === 1 && !u.other : usesIn(scope(), name) === 1 && onlyCalledIn(scope(), name);
                env.set(name, { k: "lambda", lambda: init, once, name: String(name.description) });
            }
            return false;
        }
        return true;
    };
    const inlinable = (e: any): boolean => Array.isArray(e) && e[0] === CORE_LAMBDA && e.length === 3 && malformed(Lconv, e) === null
        && validBinders(clauseNames(e[2])) && !escapesOut([CORE_BEGIN, null, ...e[2].slice(3)]);
    // whether a call with `nargs` arguments binds the clause's parameters (else it is left to fail as a call)
    const fits = (c: any[], nargs: number) => isPadded(c) || (c[2] === null ? nargs === c[1].length : nargs >= c[1].length);

    // the elements of a sequence made of locals and constants (by the table's pack, or %array where it has none), or null
    const sequenceOf = (e: any): any[] | null => {
        if (!isIntCall(e, PACK)) return null;
        return e.slice(3).every((x: any) => isConst(x) || (typeof x === "symbol" && locals.has(x))) ? e.slice(3) : null;
    };
    // what %apply takes last: an array, or of the table's own sequences, what its spread makes of one
    const elementsOf = (last: any): any[] | null => {
        if (intrinsics.pack === undefined) return isIntCall(last, ARRAY) ? last.slice(3) : null;
        if (intrinsics.spread === undefined || !isIntCall(last, Symbol.for(intrinsics.spread.name)) || last.length !== 4) return null;
        const packed = last[3];
        return isIntCall(packed, PACK) ? packed.slice(3) : null;
    };

    // the bindings still needed: those with an init that may do something, and those the body or a needed binding's init
    // uses (so procedures that only call each other go when nothing else uses them)
    const needed = (bindings: any[][], items: readonly any[]): any[][] => {
        const kept = new Set(bindings.filter(([, init]) => !effectFree(unwrapBoxed(init))).map(b => b[0]));
        if (kept.size === bindings.length) return bindings;
        for (let reach = [...items, ...bindings.filter(b => kept.has(b[0])).map(b => b[1])]; reach.length > 0;) {
            // (what `reach` uses, found in one walk of it: asking usesIn of each binding walks it once for each)
            const used = usedIn(reach);
            const found = bindings.filter(b => !kept.has(b[0]) && used.has(b[0]));
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
        const op = e[0], pos = e[1];
        const shape = Lconv.forms.get(op);
        if (shape !== undefined && malformed(Lconv, e) !== null) return e;
        const value = (x: any, env: Env = k.env) => walk(x, "value", { ...notTail(k), env });
        switch (shape) {
            case "quote":
                return ctx === "effect" ? VOID : e;
            case "lambda":
                if (!e.slice(2).every((c: any[]) => validBinders(clauseNames(c)))) return e;
                if (ctx === "effect") return VOID;
                return [op, pos, ...e.slice(2).map((c: any[]) => {
                    for (const n of clauseNames(c)) locals.add(n);
                    return [c[0], c[1], c[2], ...body(c.slice(3), "value", { env: k.env, own: k.own, tail: true, blocks: new Map() })];
                })];
            case "let": {
                const bindings: any[][] = e[2];
                if (!validBinders(bindings.map(b => b[0]))) return e;
                const items = e.slice(3);
                const inner = new Env(k.env);
                const kept: any[][] = [];
                for (const [name, init] of bindings) {
                    const v = value(init);
                    locals.add(name);
                    if (!learn(inner, name, v, () => items)) kept.push([name, v]);
                }
                const done = body(items, ctx, { ...k, env: inner });
                const rest = needed(kept, done);
                return rest.length === 0 ? asExpr(done, e) : [op, pos, rest, ...done];
            }
            case "let*": {
                const bindings: any[][] = e[2];
                if (!bindings.every(b => canBind(b[0]))) return e;
                const inner = new Env(k.env);
                const kept: any[][] = [];
                bindings.forEach(([name, init], i) => {
                    const v = value(init, inner);
                    locals.add(name);
                    if (!learn(inner, name, v, () => [...bindings.slice(i + 1).map(b => b[1]), ...e.slice(3)])) kept.push([name, v]);
                });
                const done = body(e.slice(3), ctx, { ...k, env: inner });
                const rest = needed(kept, done);
                return rest.length === 0 ? asExpr(done, e) : [op, pos, rest, ...done];
            }
            case "letrec": {
                const bindings: any[][] = e[2];
                const names = bindings.map(b => b[0]);
                if (!validBinders(names)) return e;
                for (const n of names) locals.add(n);
                const items = e.slice(3);
                const inner = new Env(k.env);
                // a %letrec's lambdas are not inlined into each other, so recursion stays recursion
                const group = new Set([...k.own, ...names]);
                const lambda = (init: any) => isLetrecLambda(init) && init === unwrapBoxed(init) && inlinable(init);
                const scopeOf = (name: symbol) => [...bindings.filter(b => b[0] !== name).map(b => b[1]), ...items];
                for (const [name, init] of bindings) {
                    if (!lambda(init)) continue;
                    // (its uses are those of its own init and of its scope: none in the first, so all of them in the second)
                    const u = known?.get(name);
                    const once = usesIn([init], name) === 0 && (u !== undefined ? u.uses === 1 && !u.other : usesIn(scopeOf(name), name) === 1 && onlyCalledIn(scopeOf(name), name));
                    inner.set(name, { k: "lambda", lambda: init, once, name: String(name.description) });
                }
                const inits = bindings.map(([name, init]) => {
                    const inside = unwrapBoxed(init);
                    const v = walk(inside, "value", { ...notTail(k), env: inner, own: isLetrecLambda(init) ? group : k.own });
                    if (lambda(init)) inner.set(name, { ...(inner.get(name) as any), lambda: v });
                    return inside === init ? v : [BOXED, null, v];
                });
                const done = body(items, ctx, { ...k, env: inner });
                const rest = needed(bindings.map((b, i) => [b[0], inits[i]]), done);
                return rest.length === 0 ? asExpr(done, e) : [op, pos, rest, ...done];
            }
            case "let-values": {
                const clauses = e[2].map((c: any[]) => [c[0], c[1], value(c[2])]);
                for (const n of clauses.flatMap((c: any[]) => c[1] === null ? c[0] : [...c[0], c[1]])) if (typeof n === "symbol") locals.add(n);
                // the values of a (%values e ...): each name is bound to its expression, with no multiple values made
                // (missing ones <#void>, extra ones still evaluated); a strict form with another count is left to fail
                const [names, rest, init] = clauses.length === 1 ? clauses[0] : [[], true, null];
                const found = rest === null && validBinders(names) ? valuesOf(init) : null;
                if (found !== null && (op !== CORE_LET_VALUES_STRICT || found.exprs.length === names.length)) {
                    const items = e.slice(3);
                    const inner = new Env(k.env);
                    const kept: any[][] = [];
                    names.forEach((name: symbol, i: number) => {
                        const v = i < found.exprs.length ? found.mark(found.exprs[i]) : VOID;
                        if (!learn(inner, name, v, () => items)) kept.push([name, v]);
                    });
                    for (const x of found.exprs.slice(names.length)) kept.push([Symbol("_"), found.mark(x)]);
                    const done = body(items, ctx, { ...k, env: inner });
                    const bound = needed(kept, done);
                    return found.around(bound.length === 0 ? asExpr(done, e) : [CORE_LET, pos, bound, ...done]);
                }
                return [op, pos, clauses, ...body(e.slice(3), ctx, k)];
            }
        }
        switch (op) {
            case CORE_BEGIN:
                return asExpr(body(e.slice(2), ctx, k), e);
            case CORE_IF:
                return walkIf(e, ctx, k);
            case SET_BOX:
                return [op, pos, aliasOf(e[2], k.env), value(e[3])];
            // a block's body is in its tail position, and so is the value of an escape to it
            case CORE_BLOCK:
                return [op, pos, e[2], ...body(e.slice(3), ctx, { ...k, blocks: new Map(k.blocks).set(e[2], k.tail) })];
            case CORE_ESCAPE:
                return e.length > 3 ? [op, pos, e[2], walk(e[3], "value", { ...k, tail: k.blocks.get(e[2]) ?? false })] : e;
            case WITH_MARK:
                return e.length === 5 ? [op, pos, value(e[2]), value(e[3]), walk(e[4], ctx, k)] : e;
            case APPLY: {
                if (e.length < 4) break;
                const next = [op, pos, ...e.slice(2).map((x: any) => value(x))];
                const elems = elementsOf(next[next.length - 1]);
                if (elems === null) return next;
                // (%apply f x ... ys) of a sequence made right there: a call of f with x ... and the elements
                return walkCall([CORE_CALL, pos, next[2], ...next.slice(3, -1), ...elems], ctx, k);
            }
            case CORE_INTAPPLY: {
                if (e.length < 4 || typeof e[2] !== "symbol") break;
                const next = [op, pos, e[2], ...e.slice(3).map((x: any) => value(x))];
                const elems = elementsOf(next[next.length - 1]);
                const entry = intrinsicOf(e[2]);
                if (elems === null || entry === undefined) return next;
                // an applied intrinsic whose count does not fit is left to fail when it runs
                const call = [CORE_INTCALL, pos, e[2], ...next.slice(3, -1), ...elems];
                if (call.length - 3 < entry.min || call.length - 3 > entry.max) return next;
                return walkIntrinsic(call, ctx, k);
            }
            case CORE_CALL:
                if (e.length < 3) break;
                return walkCall(e, ctx, k);
            case CORE_INTCALL:
                if (intrinsicOf(e[2]) === undefined) break;
                return walkIntrinsic(e, ctx, k);
            // an inlined body's tail position is its procedure's
            case INLINED:
            case TAIL_INLINED: {
                const items = body(e.slice(3), ctx, { ...k, tail: true });
                // nothing of it left to run, nothing to show in a traceback
                return items.length === 0 || (items.length === 1 && isConst(items[0])) ? asExpr(items, e) : [op, pos, e[2], ...items];
            }
        }
        const next = mapExprs(Lconv, e, x => value(x));
        return ctx === "effect" && (op === BOX || op === UNBOX) && effectFree(next) ? VOID : next;
    };

    // the variable `sym` is a copy of, if it is one
    const aliasOf = (sym: any, env: Env): any => {
        for (let info = typeof sym === "symbol" ? env.get(sym) : undefined; info?.k === "alias"; info = env.get(sym)) sym = info.sym;
        return sym;
    };

    const walkIf = (e: any[], ctx: Ctx, k: K): any => {
        const args = e.slice(2);
        if (args.length < 2) return e;
        const clauses: any[] = [];
        for (let i = 0; i + 1 < args.length; i += 2) {
            const test = walk(args[i], "value", notTail(k));
            if (isConst(test)) {
                if (constValue(test) === false) continue;
                // a true test: its branch is the rest of the chain
                const branch = walk(args[i + 1], ctx, k);
                return clauses.length === 0 ? branch : [CORE_IF, e[1], ...clauses, branch];
            }
            clauses.push(test, walk(args[i + 1], ctx, k));
        }
        const hasElse = args.length % 2 === 1;
        const otherwise = hasElse ? walk(args[args.length - 1], ctx, k) : VOID;
        if (clauses.length === 0) return otherwise;
        return [CORE_IF, e[1], ...clauses, ...(hasElse ? [otherwise] : [])];
    };

    // (lambda arg ...) as a %let of its parameters around its body, marked as the procedure `name`'s, inlined at the
    // call (the arguments are evaluated outside it, as they are by the caller)
    // A missing parameter of a padded clause is <#void>; arguments past the parameters are evaluated, in order, into
    // names of their own, and are the rest parameter's elements (a padded clause without one drops them)
    const inlined = (name: string, lambda: any[], call: any[], ctx: Ctx, k: K): any => {
        const [, params, rest] = lambda[2];
        const at = call[1];
        // a lambda passed keeps its own name (the compiler names a lambda after the variable it is bound to)
        const own = call.slice(3).map((x: any) => Array.isArray(x) && x[0] === CORE_LAMBDA ? [Symbol(lambdaName(x)), x] : null);
        const args = call.slice(3).map((x: any, i: number) => own[i]?.[0] ?? x);
        const extra = args.slice(params.length).map((x: any) => [Symbol("arg"), x]);
        const bindings = [...params.map((p: symbol, i: number) => [p, i < args.length ? args[i] : VOID]), ...extra];
        const marked = [k.tail ? TAIL_INLINED : INLINED, at, Symbol(name), ...lambda[2].slice(3)];
        const packed = rest === null ? marked : [CORE_LET, at, [[rest, [CORE_INTCALL, null, PACK, ...extra.map((b: any[]) => b[0])]]], marked];
        const bound = [CORE_LET, at, bindings, packed];
        const lambdas = own.filter(b => b !== null);
        return walk(lambdas.length === 0 ? bound : [CORE_LET, at, lambdas, bound], ctx, k);
    };

    const walkIntrinsic = (e: any[], ctx: Ctx, k: K): any => {
        const entry = intrinsicOf(e[2])!;
        const args = e.slice(3).map(x => walk(x, "value", notTail(k)));
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
        const call = [CORE_INTCALL, e[1], e[2], ...args];
        return ctx === "effect" && effectFree(call) ? VOID : call;
    };

    const walkCall = (e: any[], ctx: Ctx, k: K): any => {
        const op = e[2];
        const nargs = e.length - 3;
        // a lambda applied, or a local bound to one: its body, its parameters bound to the arguments
        const head = aliasOf(op, k.env);
        if (inlinable(head) && fits(head[2], nargs)) {
            return inlined(lambdaName(head), head, e, ctx, k);
        }
        const info = typeof head === "symbol" ? k.env.get(head) : undefined;
        if (info?.k === "lambda" && !k.own.has(head) && fits(info.lambda[2], nargs)) {
            const size = sizeOf(info.lambda, INLINE_SIZE);
            if (info.once || (size <= INLINE_SIZE && budget >= size)) {
                if (!info.once) budget -= size;
                const body = copy(info.lambda);
                boxesIn(body, boxes);
                return inlined(info.name, body, e, ctx, { ...k, own: new Set([...k.own, head]) });
            }
        }
        // a known global's procedure, where it would pay: an argument it may call is a lambda or a known procedure
        const known = typeof head === "symbol" && !locals.has(head) && !k.own.has(head) ? intrinsics.known.get(head) : undefined;
        if (known !== undefined && e.slice(3).some(x => knownProcedure(x, k.env))) {
            const size = sizeOf(known.lambda, KNOWN_SIZE);
            const lambda = size <= KNOWN_SIZE && budget >= size && fits(known.lambda[2], nargs) ? prepare(known.lambda) : null;
            if (lambda !== null && inlinable(lambda)) {
                budget -= size;
                return inlined(known.name, lambda, e, ctx, { ...k, own: new Set([...k.own, head]) });
            }
        }
        return [CORE_CALL, e[1], walk(op, "value", notTail(k)), ...e.slice(3).map(x => walk(x, "value", notTail(k)))];
    };

    // whether `x` is a procedure the optimizer knows the body of
    const knownProcedure = (x: any, env: Env): boolean => {
        if (Array.isArray(x)) return x[0] === CORE_LAMBDA;
        if (typeof x !== "symbol") return false;
        const info = env.get(aliasOf(x, env));
        return info?.k === "lambda" || (!locals.has(x) && intrinsics.known.has(x));
    };

    return { ast: walk(ast, "value", { env: new Env(), own: new Set(), tail: true, blocks: new Map() }), assumed, boxes };
};
