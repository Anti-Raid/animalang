// Closure conversion: the variables each %lambda clause captures, in the order code generation first uses them (their
// upvar indexes). A clause captures a variable bound in a function around it that it, or a lambda inside it, uses; a
// lambda whose value is never used is not made, so its uses capture nothing. Locals have names of their own (the rename
// pass), so a variable is its symbol.
// The walk follows code generation's order: a %letrec's lambdas before its other inits, a %catch's thunk and pre-handler
// before its handler, an %apply's forwarded rest list before the rest
import { isSpreadOf } from "../analysis";
import type { Intrinsics } from "../intrinsics";
import { isLetrecLambda, unwrapBoxed } from "../lambda";
import { Worklist } from "../visitor";
import { malformed } from "./lang";
import { Lconv } from "./assignments";

// each clause's captured variables, by clause
export type Captures = WeakMap<object, readonly symbol[]>;

type Fn = { readonly parent: Fn | null, readonly captures: symbol[] };

export const closureCaptures = (ast: any, intrinsics: Intrinsics): Captures => {
    const out: Captures = new WeakMap();
    const owner = new Map<symbol, Fn>();
    const bind = (fn: Fn, names: any[]) => { for (const n of names) if (typeof n === "symbol") owner.set(n, fn); };
    const use = (sym: symbol, fn: Fn) => {
        const home = owner.get(sym);
        if (home === undefined) return;
        for (let f: Fn | null = fn; f !== null && f !== home; f = f.parent) {
            if (!f.captures.includes(sym)) f.captures.push(sym);
        }
    };

    // `used`: whether the value is used (a lambda whose value is not is not made); `blocks`: the same of each %block
    type Ctx = { readonly fn: Fn, readonly used: boolean, readonly blocks: ReadonlyMap<symbol, boolean> };
    const as = (c: Ctx, used: boolean): Ctx => c.used === used ? c : { fn: c.fn, used, blocks: c.blocks };
    const todo = new Worklist<Ctx>();
    const body = (items: any[], c: Ctx) => items.forEach((x, i) => todo.add(x, as(c, c.used && i === items.length - 1)));

    todo.add(ast, { fn: { parent: null, captures: [] }, used: true, blocks: new Map() });
    todo.run((e, c) => {
        const { fn, used, blocks } = c;
        if (typeof e === "symbol") return use(e, fn);
        if (!Array.isArray(e) || e.length === 0) return;
        const op = e[0];
        const shape = Lconv.forms.get(op);
        if (shape !== undefined && malformed(Lconv, e) !== null) return;
        const all = (xs: any[]) => todo.addAll(xs, as(c, true));
        switch (shape) {
            case "quote":
                return;
            case "lambda":
                for (const clause of e.slice(2)) {
                    if (!used) continue;
                    const inner: Fn = { parent: fn, captures: [] };
                    todo.then(() => bind(inner, clause[2] === null ? clause[1] : [...clause[1], clause[2]]));
                    body(clause.slice(3), { fn: inner, used: true, blocks: new Map() });
                    out.set(clause, inner.captures);
                }
                return;
            case "let":
                all(e[2].map((b: any[]) => b[1]));
                todo.then(() => bind(fn, e[2].map((b: any[]) => b[0])));
                return body(e.slice(3), c);
            case "let*":
                for (const b of e[2]) {
                    todo.add(b[1], as(c, true));
                    todo.then(() => bind(fn, [b[0]]));
                }
                return body(e.slice(3), c);
            case "letrec": {
                const bindings: any[][] = e[2];
                bind(fn, bindings.map(b => b[0]));
                all(bindings.filter(b => isLetrecLambda(b[1])).map(b => unwrapBoxed(b[1])));
                all(bindings.filter(b => !isLetrecLambda(b[1])).map(b => unwrapBoxed(b[1])));
                return body(e.slice(3), c);
            }
            case "let-values":
                all(e[2].map((clause: any[]) => clause[2]));
                todo.then(() => bind(fn, e[2].flatMap((clause: any[]) => clause[1] === null ? clause[0] : [...clause[0], clause[1]])));
                return body(e.slice(3), c);
            case "assign":
                todo.add(e[3], as(c, true));
                if ((op === Symbol.for("%set!") || op === Symbol.for("%set-box!")) && typeof e[2] === "symbol") todo.then(() => use(e[2], fn));
                return;
            case "label":
                if (op === Symbol.for("%block")) return body(e.slice(3), { fn, used, blocks: new Map(blocks).set(e[2], used) });
                if (op === Symbol.for("%inlined") || op === Symbol.for("%tail-inlined")) return body(e.slice(3), c);
                if (e.length > 3) todo.add(e[3], as(c, blocks.get(e[2]) ?? false));
                return;
        }
        switch (op) {
            case Symbol.for("%begin"):
                return body(e.slice(2), c);
            case Symbol.for("%if"): {
                const args = e.slice(2);
                for (let i = 0; i + 1 < args.length; i += 2) {
                    todo.add(args[i], as(c, true));
                    todo.add(args[i + 1], c);
                }
                if (args.length % 2 === 1) todo.add(args[args.length - 1], c);
                return;
            }
            case Symbol.for("%loop"):
                return todo.addAll(e.slice(2), as(c, false));
            case Symbol.for("%with-mark"):
                todo.add(e[2], as(c, true));
                todo.add(e[3], as(c, true));
                return todo.add(e[4], c);
            case Symbol.for("%catch"):
                return all(e.length >= 5 ? [e[2], e[4], e[3]] : [e[2], e[3]]);
            case Symbol.for("%apply"):
            case Symbol.for("%intapply"): {
                const from = op === Symbol.for("%apply") ? 2 : 3;
                const last = e[e.length - 1];
                if (e.length > 3 && isSpreadOf(last, intrinsics)) use(last[3], fn);
                return all(e.slice(from));
            }
        }
        // a call: the procedure, then the arguments; an intrinsic's, its arguments
        all(e.slice(op === Symbol.for("%intcall") ? 3 : 2));
    });
    return out;
};
