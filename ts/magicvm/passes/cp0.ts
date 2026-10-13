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
import { BOXED, isLetrecLambda, isPadded, isUnnamed, unwrapBoxed } from "../lambda";
import { BOX, BOX_IN_PLACE, Lconv, SET_BOX, UNBOX, boxesIn, convertAssignments } from "./assignments";
import { AstAnalysis } from "../analysis";
import { malformed, parts, rebuild, subExprs, type Shape } from "./lang";
import { renamer } from "./rename";
import { Worklist, isTask, run, start, type Task } from "../visitor";
import { posOf } from "../forms";
import { Scope } from "../scope";

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
class Env extends Scope<Info> {}
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
    const todo = new Worklist();
    todo.add(e);
    todo.run(x => {
        n += 1 + headWeight(x);
        if (n > limit) todo.stop();
        else todo.addAll(children(x));
    });
    return n;
};

const lambdaName = (lambda: any): string => {
    const pos = posOf(lambda);
    return pos !== null ? `lambda@${pos.file}:${pos.line}` : "lambda";
};
// the name of a lambda bound to `bound`: the variable's, unless the lambda takes no name (see UNNAMED)
const boundName = (lambda: any, bound: symbol): string => isUnnamed(unwrapBoxed(lambda)) ? lambdaName(unwrapBoxed(lambda)) : String(bound.description);

// how often `sym` is used in the expressions `es`
const escapesTo = (e: any, label: symbol): boolean => {
    let found = false;
    const todo = new Worklist();
    todo.add(e);
    todo.run(x => {
        if (!Array.isArray(x) || x[0] === CORE_QUOTE) return;
        if (x[0] === CORE_ESCAPE && x[2] === label) {
            found = true;
            todo.stop();
        } else todo.addAll(x);
    });
    return found;
};

// What an optimized expression gives as multiple values, when it comes to a (%values e ...) under the markers of
// inlined procedures, blocks nothing escapes from, and %lets (what a call of a procedure that returns several values
// is, once inlined): the expressions; `mark`, which puts one back under the markers (so an error in it is still shown
// in the procedure's frame); and `around`, which binds the %lets' variables around a form
type Values = { exprs: any[], mark: (x: any) => any, around: (form: any) => any };
const valuesOf = (e: any): Values | null => {
    // the markers and the %lets it is under, outermost first (a %let with how many markers are around it)
    const markers: any[][] = [], lets: [any[], number][] = [];
    const markAs = (x: any, count: number): any => {
        for (let i = count - 1; i >= 0 && !isConst(x) && typeof x !== "symbol"; i--) x = [INLINED, markers[i][1], markers[i][2], x];
        return x;
    };
    for (;;) {
        if (!Array.isArray(e)) return null;
        if (e[0] === CORE_INTCALL && e[2] === VALUES) break;
        if (e[0] === INLINED && e.length === 4) {
            markers.push(e);
            e = e[3];
        } else if (e[0] === CORE_BLOCK && e.length === 4 && !escapesTo(e[3], e[2])) e = e[3];
        else if (e[0] === CORE_BEGIN && e.length === 3) e = e[2];
        else if (e[0] === CORE_LET && e.length === 4) {
            lets.push([e, markers.length]);
            e = e[3];
        } else return null;
    }
    const around = (form: any): any => {
        for (let i = lets.length - 1; i >= 0; i--) {
            const [bound, count] = lets[i];
            const marked = (init: any) => Array.isArray(init) && init[0] === BOX && init.length === 3 ? [BOX, init[1], markAs(init[2], count)] : markAs(init, count);
            form = [CORE_LET, bound[1], bound[2].map((b: any[]) => [b[0], marked(b[1])]), form];
        }
        return form;
    };
    return { exprs: e.slice(3), mark: x => markAs(x, markers.length), around };
};

// (a variable a (%set-box! x v) stores into is used there: its binding is the box)
const usesIn = (es: readonly any[], sym: symbol): number => {
    let n = 0;
    const todo = new Worklist();
    todo.addAll(es);
    todo.run(x => {
        if (x === sym) n++;
        else {
            if (Array.isArray(x) && x[2] === sym && Lconv.forms.get(x[0]) === "assign") n++;
            todo.addAll(children(x));
        }
    });
    return n;
};

// the variables usesIn finds a use of in `es`
const usedIn = (es: readonly any[]): Set<symbol> => {
    const used = new Set<symbol>();
    const todo = new Worklist();
    todo.addAll(es);
    todo.run(x => {
        if (typeof x === "symbol") used.add(x);
        else {
            if (Array.isArray(x) && typeof x[2] === "symbol" && Lconv.forms.get(x[0]) === "assign") used.add(x[2]);
            todo.addAll(children(x));
        }
    });
    return used;
};

// whether every use of `sym` in `es` is as the operator of a call
const onlyCalledIn = (es: readonly any[], sym: symbol): boolean => {
    let only = true;
    const todo = new Worklist();
    todo.addAll(es);
    todo.run(x => {
        if (x === sym) {
            only = false;
            return todo.stop();
        }
        const kids = children(x);
        if (kids.length > 0 && kids[0] === sym && x[0] === CORE_CALL) for (let i = 1; i < kids.length; i++) todo.add(kids[i]);
        else todo.addAll(kids);
    });
    return only;
};

// whether `sym` is boxed in place in `es` ((%box! sym), see the assignments pass)
const boxedInPlace = (es: readonly any[], sym: symbol): boolean => {
    let found = false;
    const todo = new Worklist();
    todo.addAll(es);
    todo.run(x => {
        if (!Array.isArray(x) || x[0] === CORE_QUOTE) return;
        if (x[0] === BOX_IN_PLACE && x[2] === sym) {
            found = true;
            todo.stop();
        } else todo.addAll(children(x));
    });
    return found;
};

// whether `sym` is used once in `es`, and not inside a lambda or a loop there (which could run it more than once)
const usedOnceStraight = (es: readonly any[], sym: symbol): boolean => {
    let n = 0, nested = false;
    const todo = new Worklist<boolean>();
    todo.addAll(es, false);
    todo.run((x, inside) => {
        if (x === sym) {
            n++;
            nested ||= inside;
        } else if (Array.isArray(x)) todo.addAll(children(x), inside || x[0] === CORE_LAMBDA || x[0] === CORE_LOOP);
    });
    return n === 1 && !nested;
};

// whether `e` escapes to a %block outside it (which is an error inside a lambda, and must stay one)
const escapesOut = (e: any): boolean => {
    let found = false;
    const todo = new Worklist<ReadonlySet<symbol>>();
    todo.add(e, new Set());
    todo.run((x, inside) => {
        if (!Array.isArray(x) || x[0] === CORE_QUOTE) return;
        if (x[0] === CORE_ESCAPE && !inside.has(x[2])) {
            found = true;
            return todo.stop();
        }
        todo.addAll(children(x), x[0] === CORE_BLOCK ? new Set([...inside, x[2]]) : inside);
    });
    return found;
};

// the free variables of `e` (in expression positions)
const freeIn = (e: any): Set<symbol> => {
    const out = new Set<symbol>();
    const todo = new Worklist<ReadonlySet<symbol>>();
    todo.add(e, new Set());
    todo.run((x, bound) => {
        if (typeof x === "symbol") {
            if (!bound.has(x)) out.add(x);
            return;
        }
        if (!Array.isArray(x) || x[0] === CORE_QUOTE) return;
        const p = parts(Lconv, x);
        if (!p.seq) {
            // (the positions of one binder are given the same names: one set for them)
            let last: symbol[] | null = null, around = bound;
            for (const [y, names] of p.exprs) {
                if (names !== last) {
                    last = names;
                    around = names.length === 0 ? bound : new Set([...bound, ...names]);
                }
                todo.add(y, around);
            }
            return;
        }
        // (a %let*: each expression sees the names before it, added to one set when the walk gets there)
        const running = new Set(bound);
        for (const [y, names] of p.exprs) {
            todo.then(() => { for (const name of names) running.add(name); });
            todo.add(y, running);
        }
    });
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
    // (what is visited: an expression, with how deep its form is, twice that plus one for a call's operator)
    const todo = new Worklist<number>();
    if (Array.isArray(ast)) todo.add(ast, 0);
    todo.run((x, at) => {
        const depth = at >> 1;
        if (typeof x === "symbol") {
            const u = of(x);
            u.uses++;
            u.straight++;
            if (depth > (bound.get(x) ?? depth)) u.nested = true;
            if ((at & 1) === 0) u.other = true;
            return;
        }
        if (!Array.isArray(x)) return;
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
        let last: symbol[] | null = null;
        for (const [, names] of exprs) {
            if (names === last) continue;
            for (const name of last = names) {
                if (bound.has(name)) continue;
                bound.set(name, inner);
                of(name);
            }
        }
        exprs.forEach(([y], i) => todo.add(y, inner * 2 + (i === 0 && x[0] === CORE_CALL ? 1 : 0)));
    });
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
            closed = freeIn(lambda).size === 0;
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
    // (true or false where `e` itself says, null where it is if its expressions from `from` on are)
    const effectFreeAt = (e: any): boolean | null => {
        if (isConst(e)) return true;
        if (typeof e === "symbol") return locals.has(e);
        if (!Array.isArray(e)) return true;
        const op = e[0];
        if (op === CORE_LAMBDA) return malformed(Lconv, e) === null && e.slice(2).every((c: any[]) => validBinders(clauseNames(c)));
        if (op === UNBOX) return e.length === 3 && locals.has(e[2]);
        if (op === BOX) return e.length === 3 ? null : false;
        if (op === CORE_BEGIN) return null;
        const entry = op === CORE_INTCALL ? intrinsicOf(e[2]) : undefined;
        return entry?.effectFree && e.length - 3 >= entry.min && e.length - 3 <= entry.max ? null : false;
    };
    const effectFree = (root: any): boolean => {
        const first = effectFreeAt(root);
        if (first !== null) return first;
        const forms: any[][] = [], ats: number[] = [];
        let e: any[] = root, i = e[0] === CORE_INTCALL ? 3 : 2;
        for (;;) {
            if (i < e.length) {
                const x = e[i++], r = effectFreeAt(x);
                if (r === false) return false;
                if (r === null) {
                    forms.push(e);
                    ats.push(i);
                    e = x;
                    i = e[0] === CORE_INTCALL ? 3 : 2;
                }
            } else {
                // (a call of an intrinsic dropped or kept for what the intrinsic is taken to be)
                if (e[0] === CORE_INTCALL) assumed.add(intrinsicOf(e[2])!.pos);
                if (forms.length === 0) return true;
                e = forms.pop()!;
                i = ats.pop()!;
            }
        }
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
                env.set(name, { k: "lambda", lambda: init, once, name: boundName(init, name) });
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

    // The walk (see visitor.ts): `walk` gives what stands for `e`, or for a form with something inside it to walk the
    // generator that will, which the generators here yield for its result. An atom's result is used as it is
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
        if (shape !== undefined && malformed(Lconv, e) !== null) return e;
        if (shape === "quote") return ctx === "effect" ? VOID : e;
        if (op === CORE_CALL && e.length >= 3) return start(walkCall(e, ctx, k));
        if (op === CORE_INTCALL && intrinsicOf(e[2]) !== undefined) return start(walkIntrinsic(e, ctx, k));
        if (op === CORE_IF) return start(walkIf(e, ctx, k));
        return start(walkForm(e, ctx, k, shape));
    };
    const value = (x: any, k: K, env: Env = k.env) => walk(x, "value", { ...notTail(k), env });

    // the expressions of a body, the last in `ctx` (and in the body's tail position), the others for their effects only
    const body = function* (items: any[], ctx: Ctx, k: K): Task<any[]> {
        const out: any[] = [];
        for (let i = 0; i < items.length; i++) {
            const last = i === items.length - 1;
            let y = last ? walk(items[i], ctx, k) : walk(items[i], "effect", notTail(k));
            if (isTask(y)) y = yield y;
            const parts = Array.isArray(y) && y[0] === CORE_BEGIN ? y.slice(2) : [y];
            out.push(...(last ? parts : parts.filter(z => !isConst(z))));
        }
        return out;
    };

    const walkForm = function* (e: any[], ctx: Ctx, k: K, shape: Shape | undefined): Task<any> {
        const op = e[0], pos = e[1];
        switch (shape) {
            case "lambda": {
                if (!e.slice(2).every((c: any[]) => validBinders(clauseNames(c)))) return e;
                if (ctx === "effect") return VOID;
                const clauses: any[] = [];
                for (const c of e.slice(2)) {
                    for (const n of clauseNames(c)) locals.add(n);
                    clauses.push([c[0], c[1], c[2], ...(yield body(c.slice(3), "value", { env: k.env, own: k.own, tail: true, blocks: new Map() }))]);
                }
                return [op, pos, ...clauses];
            }
            case "let": {
                const bindings: any[][] = e[2];
                if (!validBinders(bindings.map(b => b[0]))) return e;
                const items = e.slice(3);
                const inner = new Env(k.env);
                const kept: any[][] = [];
                for (const [name, init] of bindings) {
                    const v = yield value(init, k);
                    locals.add(name);
                    if (!learn(inner, name, v, () => items)) kept.push([name, v]);
                }
                const done = yield body(items, ctx, { ...k, env: inner });
                const rest = needed(kept, done);
                return rest.length === 0 ? asExpr(done, e) : [op, pos, rest, ...done];
            }
            case "let*": {
                const bindings: any[][] = e[2];
                if (!bindings.every(b => canBind(b[0]))) return e;
                const inner = new Env(k.env);
                const kept: any[][] = [];
                for (let i = 0; i < bindings.length; i++) {
                    const [name, init] = bindings[i];
                    const v = yield value(init, k, inner);
                    locals.add(name);
                    if (!learn(inner, name, v, () => [...bindings.slice(i + 1).map(b => b[1]), ...e.slice(3)])) kept.push([name, v]);
                }
                const done = yield body(e.slice(3), ctx, { ...k, env: inner });
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
                    inner.set(name, { k: "lambda", lambda: init, once, name: boundName(init, name) });
                }
                const inits: any[] = [];
                for (const [name, init] of bindings) {
                    const inside = unwrapBoxed(init);
                    const v = yield walk(inside, "value", { ...notTail(k), env: inner, own: isLetrecLambda(init) ? group : k.own });
                    if (lambda(init)) inner.set(name, { ...(inner.get(name) as any), lambda: v });
                    inits.push(inside === init ? v : [BOXED, null, v]);
                }
                const done = yield body(items, ctx, { ...k, env: inner });
                const rest = needed(bindings.map((b, i) => [b[0], inits[i]]), done);
                return rest.length === 0 ? asExpr(done, e) : [op, pos, rest, ...done];
            }
            case "let-values": {
                const clauses: any[][] = [];
                for (const c of e[2]) clauses.push([c[0], c[1], yield value(c[2], k)]);
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
                    const done = yield body(items, ctx, { ...k, env: inner });
                    const bound = needed(kept, done);
                    return found.around(bound.length === 0 ? asExpr(done, e) : [CORE_LET, pos, bound, ...done]);
                }
                return [op, pos, clauses, ...(yield body(e.slice(3), ctx, k))];
            }
        }
        switch (op) {
            case CORE_BEGIN:
                return asExpr(yield body(e.slice(2), ctx, k), e);
            case SET_BOX:
                return [op, pos, aliasOf(e[2], k.env), yield value(e[3], k)];
            // a block's body is in its tail position, and so is the value of an escape to it
            case CORE_BLOCK:
                return [op, pos, e[2], ...(yield body(e.slice(3), ctx, { ...k, blocks: new Map(k.blocks).set(e[2], k.tail) }))];
            case CORE_ESCAPE:
                return e.length > 3 ? [op, pos, e[2], yield walk(e[3], "value", { ...k, tail: k.blocks.get(e[2]) ?? false })] : e;
            case WITH_MARK:
                return e.length === 5 ? [op, pos, yield value(e[2], k), yield value(e[3], k), yield walk(e[4], ctx, k)] : e;
            case APPLY: {
                if (e.length < 4) break;
                const next = [op, pos];
                for (let i = 2; i < e.length; i++) next.push(yield value(e[i], k));
                const elems = elementsOf(next[next.length - 1]);
                if (elems === null) return next;
                // (%apply f x ... ys) of a sequence made right there: a call of f with x ... and the elements
                return yield walkCall([CORE_CALL, pos, next[2], ...next.slice(3, -1), ...elems], ctx, k);
            }
            case CORE_INTAPPLY: {
                if (e.length < 4 || typeof e[2] !== "symbol") break;
                const next = [op, pos, e[2]];
                for (let i = 3; i < e.length; i++) next.push(yield value(e[i], k));
                const elems = elementsOf(next[next.length - 1]);
                const entry = intrinsicOf(e[2]);
                if (elems === null || entry === undefined) return next;
                // an applied intrinsic whose count does not fit is left to fail when it runs
                const call = [CORE_INTCALL, pos, e[2], ...next.slice(3, -1), ...elems];
                if (call.length - 3 < entry.min || call.length - 3 > entry.max) return next;
                return yield walkIntrinsic(call, ctx, k);
            }
            // an inlined body's tail position is its procedure's
            case INLINED:
            case TAIL_INLINED: {
                const items = yield body(e.slice(3), ctx, { ...k, tail: true });
                // nothing of it left to run, nothing to show in a traceback
                return items.length === 0 || (items.length === 1 && isConst(items[0])) ? asExpr(items, e) : [op, pos, e[2], ...items];
            }
        }
        // (as mapExprs: the form itself if none of its expressions changed)
        const exprs = subExprs(Lconv, e);
        let next: any[] | null = null;
        for (let i = 0; i < exprs.length; i++) {
            let y = value(exprs[i], k);
            if (isTask(y)) y = yield y;
            if (next !== null) next.push(y);
            else if (y !== exprs[i]) (next = exprs.slice(0, i)).push(y);
        }
        const done = next === null ? e : rebuild(Lconv, e, next);
        return ctx === "effect" && (op === BOX || op === UNBOX) && effectFree(done) ? VOID : done;
    };

    // the variable `sym` is a copy of, if it is one
    const aliasOf = (sym: any, env: Env): any => {
        for (let info = typeof sym === "symbol" ? env.get(sym) : undefined; info?.k === "alias"; info = env.get(sym)) sym = info.sym;
        return sym;
    };

    const walkIf = function* (e: any[], ctx: Ctx, k: K): Task<any> {
        const args = e.slice(2);
        if (args.length < 2) return e;
        const clauses: any[] = [];
        for (let i = 0; i + 1 < args.length; i += 2) {
            let test = walk(args[i], "value", notTail(k));
            if (isTask(test)) test = yield test;
            if (isConst(test)) {
                if (constValue(test) === false) continue;
                // a true test: its branch is the rest of the chain
                const branch = yield walk(args[i + 1], ctx, k);
                return clauses.length === 0 ? branch : [CORE_IF, e[1], ...clauses, branch];
            }
            let branch = walk(args[i + 1], ctx, k);
            if (isTask(branch)) branch = yield branch;
            clauses.push(test, branch);
        }
        const hasElse = args.length % 2 === 1;
        const otherwise = hasElse ? yield walk(args[args.length - 1], ctx, k) : VOID;
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
        // what the names made here are used for is known as that of the program's own: each once where it is put (an
        // argument past the parameters in the rest parameter's elements, if there is one), never called or boxed
        if (known !== null) {
            for (const [arg] of extra) known.set(arg, { uses: rest === null ? 0 : 1, straight: rest === null ? 0 : 1, nested: false, other: rest !== null, boxed: false });
            for (const [lambda] of lambdas) known.set(lambda as symbol, { uses: 1, straight: 1, nested: false, other: true, boxed: false });
        }
        return walk(lambdas.length === 0 ? bound : [CORE_LET, at, lambdas, bound], ctx, k);
    };

    const walkIntrinsic = function* (e: any[], ctx: Ctx, k: K): Task<any> {
        const entry = intrinsicOf(e[2])!;
        const args: any[] = [], nk = notTail(k);
        for (let i = 3; i < e.length; i++) {
            let v = walk(e[i], "value", nk);
            if (isTask(v)) v = yield v;
            args.push(v);
        }
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

    const walkCall = function* (e: any[], ctx: Ctx, k: K): Task<any> {
        const op = e[2];
        const nargs = e.length - 3;
        // a lambda applied, or a local bound to one: its body, its parameters bound to the arguments
        const head = aliasOf(op, k.env);
        if (inlinable(head) && fits(head[2], nargs)) {
            return yield inlined(lambdaName(head), head, e, ctx, k);
        }
        const info = typeof head === "symbol" ? k.env.get(head) : undefined;
        if (info?.k === "lambda" && !k.own.has(head) && fits(info.lambda[2], nargs)) {
            const size = sizeOf(info.lambda, INLINE_SIZE);
            if (info.once || (size <= INLINE_SIZE && budget >= size)) {
                if (!info.once) budget -= size;
                const body = copy(info.lambda);
                boxesIn(body, boxes);
                return yield inlined(info.name, body, e, ctx, { ...k, own: new Set([...k.own, head]) });
            }
        }
        // a known global's procedure, where it would pay: an argument it may call is a lambda or a known procedure
        const known = typeof head === "symbol" && !locals.has(head) && !k.own.has(head) ? intrinsics.known.get(head) : undefined;
        if (known !== undefined && e.slice(3).some(x => knownProcedure(x, k.env))) {
            const size = sizeOf(known.lambda, KNOWN_SIZE);
            const lambda = size <= KNOWN_SIZE && budget >= size && fits(known.lambda[2], nargs) ? prepare(known.lambda) : null;
            if (lambda !== null && inlinable(lambda)) {
                budget -= size;
                return yield inlined(known.name, lambda, e, ctx, { ...k, own: new Set([...k.own, head]) });
            }
        }
        const call = [CORE_CALL, e[1]], nk = notTail(k);
        for (let i = 2; i < e.length; i++) {
            let v = walk(e[i], "value", nk);
            if (isTask(v)) v = yield v;
            call.push(v);
        }
        return call;
    };

    // whether `x` is a procedure the optimizer knows the body of
    const knownProcedure = (x: any, env: Env): boolean => {
        if (Array.isArray(x)) return x[0] === CORE_LAMBDA;
        if (typeof x !== "symbol") return false;
        const info = env.get(aliasOf(x, env));
        return info?.k === "lambda" || (!locals.has(x) && intrinsics.known.has(x));
    };

    return { ast: run(walk(ast, "value", { env: new Env(), own: new Set(), tail: true, blocks: new Map() })), assumed, boxes };
};
