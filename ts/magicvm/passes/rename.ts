// Gives every local variable a name of its own: each binder a fresh symbol (of the same name, as names show in
// procedure names and messages), and every reference and %set! the binder's. Later passes need not think about
// shadowing: a symbol is one variable. Globals, block labels and quoted data are left as they are.
// A binder code generation rejects (not a symbol, a special form, a front end's reserved name, an intrinsic's, or a name
// bound twice in one group) is left as it is, so the same error is reported, at the same place
import { CORE_SET, Msg, SPECIAL_FORMS, VMError } from "../../common";
import { isPosSlot, posOf } from "../forms";
import { isCoreForm } from "../core";
import type { Intrinsics } from "../intrinsics";
import { malformed, mapExprs } from "./lang";
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

        const expr = (e: any): any => {
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
            if (!traversable(e)) return e;
            switch (shape) {
                case "quote":
                    return e;
                case "lambda":
                    return [op, pos, ...e.slice(2).map((c: any[]) => {
                        const saved = bind(c[2] === null ? c[1] : [...c[1], c[2]]);
                        const clause = [c[0], c[1].map(name), name(c[2]), ...c.slice(3).map(expr)];
                        unbind(saved);
                        return clause;
                    })];
                case "let": {
                    const bindings: any[] = e[2];
                    const inits = bindings.map(b => expr(b[1]));
                    const saved = bind(bindings.map(b => b[0]));
                    const out = [op, pos, bindings.map((b, i) => [name(b[0]), inits[i]]), ...e.slice(3).map(expr)];
                    unbind(saved);
                    return out;
                }
                case "letrec": {
                    const bindings: any[] = e[2];
                    const saved = bind(bindings.map(b => b[0]));
                    const out = [op, pos, bindings.map(b => [name(b[0]), expr(b[1])]), ...e.slice(3).map(expr)];
                    unbind(saved);
                    return out;
                }
                case "let*": {
                    const saved: Saved = [];
                    const bindings = (e[2] as any[]).map(b => {
                        const init = expr(b[1]);
                        bind([b[0]], saved);
                        return [name(b[0]), init];
                    });
                    const out = [op, pos, bindings, ...e.slice(3).map(expr)];
                    unbind(saved);
                    return out;
                }
                case "let-values": {
                    const clauses: any[] = e[2];
                    const inits = clauses.map(c => expr(c[2]));
                    const saved = bind(clauses.flatMap(c => c[1] === null ? c[0] : [...c[0], c[1]]));
                    const out = [op, pos, clauses.map((c, i) => [c[0].map(name), name(c[1]), inits[i]]), ...e.slice(3).map(expr)];
                    unbind(saved);
                    return out;
                }
                case "assign":
                    return [op, pos, op === CORE_SET || op === SET_BOX ? name(e[2]) : e[2], expr(e[3])];
                default:
                    return mapExprs(Lconv, e, expr);
            }
        };
        return expr(ast);
    };
};

export const renamePass: Pass<any, any> = { name: "rename", run: (ast, ctx) => renamer(ctx.intrinsics)(ast) };
