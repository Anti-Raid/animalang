// The languages the compiler's passes read and write: the core forms (arrays, see compiler.ts), declared once by the
// shape of each form, and a language as the forms it allows. A later language is an earlier one with forms removed or
// added (`extend`). The shapes drive every traversal (`parts`, `mapExprs`) and the check of a pass's output (`check`)
import { isPosSlot } from "../forms";
import { CORE_FORMS } from "../core";
import { bodyOf, clausesOf, namesOf } from "../lambda";

// how a form's operands are laid out after its head:
//  - quote: one datum, not an expression
//  - lambda: clauses [options, params, rest, body ...], each binding its names in its body
//  - let / letrec: [[name, init] ...], body ...; a letrec's names are bound in its inits too
//  - let*: the same, each init seeing the names before it
//  - let-values: [[params, rest, init] ...], body ...
//  - assign: name, expr (%set!, %define-global)
//  - label: name, expr ... (%block, %escape: the name is a label, not a variable)
//  - intrinsic: an intrinsic's name, expr ... (%intcall, %intapply)
//  - exprs: every operand is an expression
export type Shape = "quote" | "lambda" | "let" | "letrec" | "let*" | "let-values" | "assign" | "label" | "intrinsic" | "exprs";

export type Language = { readonly name: string, readonly forms: ReadonlyMap<symbol, Shape> };

const language = (name: string, forms: Record<string, Shape>): Language =>
    ({ name, forms: new Map(Object.entries(forms).map(([head, shape]) => [Symbol.for(head), shape])) });

export const extend = (base: Language, name: string, change: { remove?: string[], add?: Record<string, Shape> }): Language => {
    const forms = new Map(base.forms);
    for (const head of change.remove ?? []) forms.delete(Symbol.for(head));
    for (const [head, shape] of Object.entries(change.add ?? {})) forms.set(Symbol.for(head), shape);
    return { name, forms };
};

// what a front end may give the compiler
export const Lsrc = language("Lsrc", {
    "%quote": "quote",
    "%lambda": "lambda",
    "%let": "let",
    "%letrec": "letrec",
    "%let*": "let*",
    "%let-values": "let-values",
    "%let-values/strict": "let-values",
    "%set!": "assign",
    "%define-global": "assign",
    "%call": "exprs",
    "%intcall": "intrinsic",
    "%intapply": "intrinsic",
    "%block": "label",
    "%escape": "label",
    "%if": "exprs",
    "%begin": "exprs",
    "%loop": "exprs",
    "%with-mark": "exprs",
    "%catch": "exprs",
    "%current-marks": "exprs",
    "%apply": "exprs",
});

// Each expression position in `e` with the names bound around it (beyond those around `e`), and how to rebuild `e`
// (with its position slot) from new expressions for them. For a %let* (`seq`), each position's names add to those of the
// positions before it (see withBounds)
export type Parts = { exprs: [any, symbol[]][], rebuild: (next: any[]) => any, seq?: boolean };

export const parts = (lang: Language, e: any[]): Parts => {
    const op = e[0], pos = e[1];
    switch (lang.forms.get(op)) {
        case undefined:
        case "quote":
            return { exprs: [], rebuild: () => e };
        case "lambda": {
            const clauses = clausesOf(e);
            const exprs = clauses.flatMap(c => bodyOf(c).map(x => [x, namesOf(c)] as [any, symbol[]]));
            return { exprs, rebuild: next => {
                let at = 0;
                return [op, pos, ...clauses.map(c => {
                    const n = c.length - 3;
                    at += n;
                    return [c[0], c[1], c[2], ...next.slice(at - n, at)];
                })];
            } };
        }
        case "let":
        case "letrec": {
            const bindings: [symbol, any][] = e[2];
            const names = bindings.map(b => b[0]);
            const inner = lang.forms.get(op) === "letrec" ? names : [];
            return { exprs: [...bindings.map(b => [b[1], inner] as [any, symbol[]]), ...e.slice(3).map(x => [x, names] as [any, symbol[]])], rebuild: next =>
                [op, pos, bindings.map((b, i) => [b[0], next[i]]), ...next.slice(bindings.length)] };
        }
        case "let*": {
            const bindings: [symbol, any][] = e[2];
            const body = e.slice(3);
            const exprs: [any, symbol[]][] = [
                ...bindings.map((b, i) => [b[1], i === 0 ? [] : [bindings[i - 1][0]]] as [any, symbol[]]),
                ...body.map((x, i) => [x, i === 0 && bindings.length > 0 ? [bindings[bindings.length - 1][0]] : []] as [any, symbol[]]),
            ];
            return { exprs, seq: true, rebuild: next => [op, pos, bindings.map((b, i) => [b[0], next[i]]), ...next.slice(bindings.length)] };
        }
        case "let-values": {
            const clauses: [symbol[], symbol | null, any][] = e[2];
            const names = clauses.flatMap(c => c[1] === null ? c[0] : [...c[0], c[1]]);
            return { exprs: [...clauses.map(c => [c[2], []] as [any, symbol[]]), ...e.slice(3).map(x => [x, names] as [any, symbol[]])], rebuild: next =>
                [op, pos, clauses.map((c, i) => [c[0], c[1], next[i]]), ...next.slice(clauses.length)] };
        }
        case "assign":
            return { exprs: [[e[3], []]], rebuild: next => [op, pos, e[2], next[0]] };
        case "label":
        case "intrinsic":
            return { exprs: e.slice(3).map(x => [x, []]), rebuild: next => [op, pos, e[2], ...next] };
        case "exprs":
            return { exprs: e.slice(2).map(x => [x, []]), rebuild: next => [op, pos, ...next] };
    }
};

// each expression position of `p` with the names bound around it, given those around the form (`bound`, not changed).
// A %let*'s positions share one growing set, so a long one costs no more than its length
export function* withBounds(p: Parts, bound: ReadonlySet<symbol>): Generator<[any, ReadonlySet<symbol>]> {
    if (p.seq) {
        const running = new Set(bound);
        for (const [x, added] of p.exprs) {
            for (const name of added) running.add(name);
            yield [x, running];
        }
        return;
    }
    for (const [x, names] of p.exprs) yield [x, names.length === 0 ? bound : new Set([...bound, ...names])];
}

// the expressions directly inside a form (not its binders, labels or quoted data)
export const subExprs = (lang: Language, e: any[]): any[] => parts(lang, e).exprs.map(([x]) => x);

// `e` with `f` applied to each expression directly inside it, rebuilt (with its position) only if one changed
export const mapExprs = (lang: Language, e: any[], f: (x: any) => any): any[] => {
    const p = parts(lang, e);
    let changed = false;
    const next = p.exprs.map(([x]) => {
        const y = f(x);
        if (y !== x) changed = true;
        return y;
    });
    return changed ? p.rebuild(next) : e;
};

// why the form `e` is not laid out as its shape in `lang` says, or null if it is (its operands only, not their insides)
export const malformed = (lang: Language, e: any[]): string | null => {
    const isSyms = (x: any) => Array.isArray(x) && x.every(s => typeof s === "symbol");
    if (e.length < 2 || !isPosSlot(e[1])) return "no position slot (a position, or #null)";
    switch (lang.forms.get(e[0])) {
        case "quote":
            return e.length === 3 ? null : "a quote of other than one datum";
        case "lambda":
            return e.slice(2).every(c => Array.isArray(c) && isSyms(c[0]) && isSyms(c[1]) && (c[2] === null || typeof c[2] === "symbol")) ? null : "a malformed clause";
        case "let": case "letrec": case "let*":
            return Array.isArray(e[2]) && e[2].every((b: any) => Array.isArray(b) && b.length === 2 && typeof b[0] === "symbol") ? null : "malformed bindings";
        case "let-values":
            return Array.isArray(e[2]) && e[2].every((c: any) => Array.isArray(c) && c.length === 3 && isSyms(c[0]) && (c[1] === null || typeof c[1] === "symbol")) ? null : "malformed bindings";
        case "assign": case "label": case "intrinsic":
            return typeof e[2] === "symbol" ? null : "a name that is not a symbol";
        default:
            return null;
    }
};

// Checks that `e` is in `lang`: no core form it does not allow, and each form laid out as its shape says. For tests and
// debugging: a pass whose output fails it left a form its output language removed, or built one wrongly
export const check = (lang: Language, e: any): void => {
    if (!Array.isArray(e)) return;
    const fail = (why: string) => { throw new Error(`internal error: not ${lang.name}: ${why} in (${String(e[0]?.description ?? e[0])} ...)`); };
    const op = e[0];
    if (!lang.forms.has(op)) fail(typeof op === "symbol" && CORE_FORMS.has(op) ? "a form the language does not have" : "a call without %call");
    const why = malformed(lang, e);
    if (why !== null) fail(why);
    if (lang.forms.get(op) === "quote") return;
    for (const x of subExprs(lang, e)) check(lang, x);
};
