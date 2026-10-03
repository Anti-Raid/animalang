// Closure conversion: the variables each %lambda clause captures, in the order code generation first uses them (their
// upvar indexes). A clause captures a variable bound in a function around it that it, or a lambda inside it, uses; a
// lambda whose value is never used is not made, so its uses capture nothing. Locals have names of their own (the rename
// pass), so a variable is its symbol.
// The walk follows code generation's order: a %letrec's lambdas before its other inits, a %catch's thunk and pre-handler
// before its handler, an %apply's forwarded rest list before the rest
import { isSpreadOf } from "../analysis";
import { isCoreForm } from "../core";
import type { Intrinsics } from "../intrinsics";
import { isLetrecLambda, unwrapBoxed } from "../lambda";
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
    const isIntrinsic = (op: any) => typeof op === "symbol" && (isCoreForm(op) || intrinsics.get(op) !== undefined);

    // `used`: whether the value is used (a lambda whose value is not is not made); `blocks`: the same of each %block
    const body = (items: any[], fn: Fn, used: boolean, blocks: ReadonlyMap<symbol, boolean>) =>
        items.forEach((x, i) => walk(x, fn, used && i === items.length - 1, blocks));

    const walk = (e: any, fn: Fn, used: boolean, blocks: ReadonlyMap<symbol, boolean>): void => {
        if (typeof e === "symbol") return use(e, fn);
        if (!Array.isArray(e) || e.length === 0) return;
        const op = e[0];
        const shape = Lconv.forms.get(op);
        if (shape !== undefined && shape !== "exprs" && malformed(Lconv, e) !== null) return;
        const all = (xs: any[]) => xs.forEach(x => walk(x, fn, true, blocks));
        switch (shape) {
            case "quote":
                return;
            case "lambda":
                for (const c of e.slice(1)) {
                    if (!used) continue;
                    const inner: Fn = { parent: fn, captures: [] };
                    bind(inner, c[2] === null ? c[1] : [...c[1], c[2]]);
                    body(c.slice(3), inner, true, new Map());
                    out.set(c, inner.captures);
                }
                return;
            case "let":
                all(e[1].map((b: any[]) => b[1]));
                bind(fn, e[1].map((b: any[]) => b[0]));
                return body(e.slice(2), fn, used, blocks);
            case "let*":
                for (const b of e[1]) {
                    walk(b[1], fn, true, blocks);
                    bind(fn, [b[0]]);
                }
                return body(e.slice(2), fn, used, blocks);
            case "letrec": {
                const bindings: any[][] = e[1];
                bind(fn, bindings.map(b => b[0]));
                all(bindings.filter(b => isLetrecLambda(b[1])).map(b => unwrapBoxed(b[1])));
                all(bindings.filter(b => !isLetrecLambda(b[1])).map(b => unwrapBoxed(b[1])));
                return body(e.slice(2), fn, used, blocks);
            }
            case "let-values":
                all(e[1].map((c: any[]) => c[2]));
                bind(fn, e[1].flatMap((c: any[]) => c[1] === null ? c[0] : [...c[0], c[1]]));
                return body(e.slice(2), fn, used, blocks);
            case "assign":
                walk(e[2], fn, true, blocks);
                if ((op === Symbol.for("%set!") || op === Symbol.for("%set-box!")) && typeof e[1] === "symbol") use(e[1], fn);
                return;
            case "label":
                if (op === Symbol.for("%block")) return body(e.slice(2), fn, used, new Map(blocks).set(e[1], used));
                if (e.length > 2) walk(e[2], fn, blocks.get(e[1]) ?? false, blocks);
                return;
        }
        switch (op) {
            case Symbol.for("%begin"):
                return body(e.slice(1), fn, used, blocks);
            case Symbol.for("%if"): {
                const args = e.slice(1);
                for (let i = 0; i + 1 < args.length; i += 2) {
                    walk(args[i], fn, true, blocks);
                    walk(args[i + 1], fn, used, blocks);
                }
                if (args.length % 2 === 1) walk(args[args.length - 1], fn, used, blocks);
                return;
            }
            case Symbol.for("%loop"):
                return e.slice(1).forEach((x: any) => walk(x, fn, false, blocks));
            case Symbol.for("%with-mark"):
                walk(e[1], fn, true, blocks);
                walk(e[2], fn, true, blocks);
                return walk(e[3], fn, used, blocks);
            case Symbol.for("%catch"):
                return all(e.length >= 4 ? [e[1], e[3], e[2]] : [e[1], e[2]]);
            case Symbol.for("%apply"): {
                const last = e[e.length - 1];
                if (e.length > 2 && isSpreadOf(last, intrinsics)) use(last[1], fn);
                return all(isIntrinsic(e[1]) ? e.slice(2) : e.slice(1));
            }
        }
        // a call: of an intrinsic, its arguments; else the procedure, then the arguments
        all(isIntrinsic(op) ? e.slice(1) : e);
    };
    walk(ast, { parent: null, captures: [] }, true, new Map());
    return out;
};
