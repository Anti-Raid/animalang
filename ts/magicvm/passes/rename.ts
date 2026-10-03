// Gives every local variable a name of its own: each binder a fresh symbol (of the same name, as names show in
// procedure names and messages), and every reference and %set! the binder's. Later passes need not think about
// shadowing: a symbol is one variable. Globals, block labels and quoted data are left as they are.
// A binder code generation rejects (not a symbol, a special form, a front end's reserved name, an intrinsic's, or a name
// bound twice in one group) is left as it is, so the same error is reported, at the same place
import { CORE_SET, Msg, SOURCE_POS, SPECIAL_FORMS, VMError } from "../../common";
import { isCoreForm } from "../core";
import type { Intrinsics } from "../intrinsics";
import { keepPos, malformed, mapExprs } from "./lang";
import { Lconv, SET_BOX } from "./assignments";
import type { Pass } from "./pass";

// what renaming can walk: a lambda code generation accepts (any other fails to compile)
const traversable = (e: any[]): boolean => {
    switch (Lconv.forms.get(e[0])) {
        case "lambda": return malformed(Lconv, e) === null;
        default: return true;
    }
};

type Env = ReadonlyMap<symbol, symbol>;

// a function giving each binder in what it is given a fresh name (its free variables are left as they are)
export const renamer = (intrinsics: Intrinsics) => {
    const canBind = (sym: any): sym is symbol =>
        typeof sym === "symbol" && !SPECIAL_FORMS.has(sym) && intrinsics.reserved.get(sym) === undefined && !isCoreForm(sym) && intrinsics.get(sym) === undefined;

    // the env inside a group binding `names` (all at once), and the fresh name of each
    const bind = (env: Env, names: any[]): Env => {
        const counts = new Map<any, number>();
        for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
        const inner = new Map(env);
        for (const n of names) {
            if (typeof n !== "symbol") continue;
            inner.set(n, canBind(n) && counts.get(n) === 1 ? Symbol(n.description) : n);
        }
        return inner;
    };
    const name = (env: Env, sym: any) => typeof sym === "symbol" ? env.get(sym) ?? sym : sym;

    const expr = (e: any, env: Env): any => {
        if (typeof e === "symbol") return name(env, e);
        if (!Array.isArray(e) || e.length === 0) return e;
        const op = e[0];
        const fail = (err: VMError) => {
            err.at = SOURCE_POS.get(e) ?? null;
            throw err;
        };
        if (!Lconv.forms.has(op)) fail(new VMError(Msg.BareCall, [op]));
        const shape = Lconv.forms.get(op);
        if ((shape === "let" || shape === "letrec" || shape === "let*") && !(Array.isArray(e[1]) && e[1].every((b: any) => Array.isArray(b) && b.length === 2))) {
            fail(new VMError(Msg.FormArgs, [op.description, "bindings of a name and an init each", e.length - 1]));
        }
        if (shape === "let-values" && !(Array.isArray(e[1]) && e[1].every((c: any) => Array.isArray(c) && c.length === 3 && Array.isArray(c[0])))) {
            fail(new VMError(Msg.FormArgs, [op.description, "clauses of (params) rest init", e.length - 1]));
        }
        if (!traversable(e)) return e;
        switch (Lconv.forms.get(op)) {
            case "quote":
                return e;
            case "lambda":
                return keepPos([op, ...e.slice(1).map((c: any[]) => {
                    const inner = bind(env, c[2] === null ? c[1] : [...c[1], c[2]]);
                    return [c[0], c[1].map((p: any) => name(inner, p)), name(inner, c[2]), ...c.slice(3).map(x => expr(x, inner))];
                })], e);
            case "let": {
                const bindings: any[] = e[1];
                const inner = bind(env, bindings.map(b => b[0]));
                return keepPos([op, bindings.map(b => keepPos([name(inner, b[0]), expr(b[1], env)], b)), ...e.slice(2).map(x => expr(x, inner))], e);
            }
            case "letrec": {
                const bindings: any[] = e[1];
                const inner = bind(env, bindings.map(b => b[0]));
                return keepPos([op, bindings.map(b => keepPos([name(inner, b[0]), expr(b[1], inner)], b)), ...e.slice(2).map(x => expr(x, inner))], e);
            }
            case "let*": {
                let inner = env;
                const bindings = (e[1] as any[]).map(b => {
                    const init = expr(b[1], inner);
                    inner = bind(inner, [b[0]]);
                    return keepPos([name(inner, b[0]), init], b);
                });
                return keepPos([op, bindings, ...e.slice(2).map(x => expr(x, inner))], e);
            }
            case "let-values": {
                const clauses: any[] = e[1];
                const inner = bind(env, clauses.flatMap(c => c[1] === null ? c[0] : [...c[0], c[1]]));
                return keepPos([op, clauses.map(c => [c[0].map((p: any) => name(inner, p)), name(inner, c[1]), expr(c[2], env)]), ...e.slice(2).map(x => expr(x, inner))], e);
            }
            case "assign":
                return keepPos([op, op === CORE_SET || op === SET_BOX ? name(env, e[1]) : e[1], expr(e[2], env)], e);
            default:
                return mapExprs(Lconv, e, x => expr(x, env));
        }
    };
    return (ast: any) => expr(ast, new Map());
};

export const renamePass: Pass<any, any> = { name: "rename", run: (ast, ctx) => renamer(ctx.intrinsics)(ast) };
