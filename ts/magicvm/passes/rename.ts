// Gives every local variable a name of its own: each binder a fresh symbol (of the same name, as names show in
// procedure names and messages), and every reference and %set! the binder's. Later passes need not think about
// shadowing: a symbol is one variable. Globals, block labels and quoted data are left as they are.
// A binder code generation rejects (not a symbol, a special form, a front end's reserved name, an intrinsic's, or a name
// bound twice in one group) is left as it is, so the same error is reported, at the same place
import { CORE_SET, Msg, SPECIAL_FORMS, VMError } from "../../common";
import { isPosSlot, posOf } from "../forms";
import { isCoreForm } from "../core";
import type { Intrinsics } from "../intrinsics";
import { DESCEND, Visitor } from "../visitor";
import { malformed, rebuilt, subExprs } from "./lang";
import { Lconv, SET_BOX } from "./assignments";
import type { Pass } from "./pass";

// what renaming can walk: a lambda code generation accepts (any other fails to compile)
const traversable = (e: any[]): boolean => {
    switch (Lconv.forms.get(e[0])) {
        case "lambda": return malformed(Lconv, e) === null;
        default: return true;
    }
};

// a function giving each binder in what it is given a fresh name (its free variables are left as they are)
export const renamer = (intrinsics: Intrinsics) => {
    const canBind = (sym: any): sym is symbol =>
        typeof sym === "symbol" && !SPECIAL_FORMS.has(sym) && intrinsics.reserved.get(sym) === undefined && !isCoreForm(sym) && intrinsics.get(sym) === undefined;

    return (ast: any): any => {
        // the name each variable in scope has now. One map for the whole walk, changed on the way into a binder and put
        // back on the way out: a copy for each binder would cost a function its locals squared
        const env = new Map<symbol, symbol>();
        type Saved = [symbol, symbol | undefined][];
        // binds `names` (all at once) to fresh names, and gives what `unbind` puts back
        const bind = (names: any[], saved: Saved = []): Saved => {
            const twice = names.length > 1 && new Set(names).size !== names.length ? new Set(names.filter((n, i) => names.indexOf(n) !== i)) : null;
            for (const n of names) {
                if (typeof n !== "symbol") continue;
                saved.push([n, env.get(n)]);
                env.set(n, canBind(n) && !(twice?.has(n) ?? false) ? Symbol(n.description) : n);
            }
            return saved;
        };
        const unbind = (saved: Saved): void => {
            for (let i = saved.length - 1; i >= 0; i--) {
                const [n, before] = saved[i];
                if (before === undefined) env.delete(n);
                else env.set(n, before);
            }
        };
        const name = (sym: any) => typeof sym === "symbol" ? env.get(sym) ?? sym : sym;

        // what a visited binding form keeps: the bindings to put back, and what its binders were renamed to
        type State = { saved: Saved, bound: boolean, names: any[], at: number, starts: number[] };
        const clauseNames = (c: any[]) => c[2] === null ? c[1] : [...c[1], c[2]];
        const valuesNames = (clauses: any[]) => clauses.flatMap(c => c[1] === null ? c[0] : [...c[0], c[1]]);
        // into the next clause of a lambda: the one before it out of scope, its own names in
        const enterClause = (e: any[], st: State) => {
            const c = e[2 + st.at++];
            unbind(st.saved);
            st.saved = bind(clauseNames(c));
            st.names.push([c[1].map(name), name(c[2])]);
        };
        const bindRest = (e: any[], st: State, shape: string | undefined) => {
            if (shape === "let*") {
                for (let i = st.names.length; i < e[2].length; i++) {
                    bind([e[2][i][0]], st.saved);
                    st.names.push(name(e[2][i][0]));
                }
            } else if (!st.bound) {
                st.bound = true;
                bind(shape === "let" ? e[2].map((b: any[]) => b[0]) : valuesNames(e[2]), st.saved);
            }
        };

        return new Visitor<undefined, any>(
            e => {
                if (typeof e === "symbol") return name(e);
                if (!Array.isArray(e) || e.length === 0) return e;
                const op = e[0], pos = e[1];
                const fail = (err: VMError) => {
                    err.at = posOf(e);
                    throw err;
                };
                if (!Lconv.forms.has(op)) fail(new VMError(Msg.BareCall, [op]));
                if (e.length < 2 || !isPosSlot(pos)) fail(new VMError(Msg.FormArgs, [op.description, "a position slot (a position, or #null) after its head", e.length - 1]));
                const shape = Lconv.forms.get(op);
                if ((shape === "let" || shape === "letrec" || shape === "let*") && !(Array.isArray(e[2]) && e[2].every((b: any) => Array.isArray(b) && b.length === 2))) {
                    fail(new VMError(Msg.FormArgs, [op.description, "bindings of a name and an init each", e.length - 2]));
                }
                if (shape === "let-values" && !(Array.isArray(e[2]) && e[2].every((c: any) => Array.isArray(c) && c.length === 3 && Array.isArray(c[0])))) {
                    fail(new VMError(Msg.FormArgs, [op.description, "clauses of (params) rest init", e.length - 2]));
                }
                return !traversable(e) || shape === "quote" ? e : DESCEND;
            },
            f => {
                const e = f.e, shape = Lconv.forms.get(e[0]);
                f.kids = subExprs(Lconv, e);
                switch (shape) {
                    case "lambda": {
                        const starts: number[] = [];
                        let at = 0;
                        for (let k = 2; k < e.length; k++) {
                            starts.push(at);
                            at += e[k].length - 3;
                        }
                        f.state = { saved: [], bound: false, names: [], at: 0, starts } satisfies State;
                        return;
                    }
                    case "letrec":
                        f.state = { saved: bind(e[2].map((b: any[]) => b[0])), bound: true, names: [], at: 0, starts: [] } satisfies State;
                        return;
                    case "let":
                    case "let*":
                    case "let-values":
                        f.state = { saved: [], bound: false, names: [], at: 0, starts: [] } satisfies State;
                }
            },
            f => {
                const e = f.e, out = f.out, op = e[0], pos = e[1], st: State | undefined = f.state;
                if (st === undefined) return Lconv.forms.get(op) === "assign" ? [op, pos, op === CORE_SET || op === SET_BOX ? name(e[2]) : e[2], out[0]] : rebuilt(Lconv, f);
                const shape = Lconv.forms.get(op);
                let next: any[];
                if (shape === "lambda") {
                    while (st.at < st.starts.length) enterClause(e, st);
                    next = [op, pos, ...e.slice(2).map((c: any[], k: number) => [c[0], st.names[k][0], st.names[k][1], ...out.slice(st.starts[k], st.starts[k] + c.length - 3)])];
                } else {
                    bindRest(e, st, shape);
                    const n = e[2].length;
                    const heads = shape === "let*" ? e[2].map((_: any, i: number) => [st.names[i], out[i]])
                        : shape === "let-values" ? e[2].map((c: any[], i: number) => [c[0].map(name), name(c[1]), out[i]])
                        : e[2].map((b: any[], i: number) => [name(b[0]), out[i]]);
                    next = [op, pos, heads, ...out.slice(n)];
                }
                unbind(st.saved);
                return next;
            },
            // (called before each expression of a binding form: what is in scope there is bound by then)
            (f, i) => {
                const e = f.e, st: State = f.state, shape = Lconv.forms.get(e[0]);
                if (shape === "lambda") {
                    while (st.at < st.starts.length && st.starts[st.at] <= i) enterClause(e, st);
                } else if (shape === "let*") {
                    if (i > 0 && i <= e[2].length && st.names.length < i) {
                        bind([e[2][i - 1][0]], st.saved);
                        st.names.push(name(e[2][i - 1][0]));
                    }
                } else if (i >= e[2].length) bindRest(e, st, shape);
                return undefined;
            },
        ).visit(ast, undefined);
    };
};

export const renamePass: Pass<any, any> = { name: "rename", run: (ast, ctx) => renamer(ctx.intrinsics)(ast) };
