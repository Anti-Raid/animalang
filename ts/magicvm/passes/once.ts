// Binding once, a pass over the core forms of code that is not re-entrant, after renaming (a symbol is one variable).
// A %let variable bound to a constant and assigned in one place, where nothing can have read it before, is bound to
// what it is assigned instead, so it is never assigned: no box when a closure captures it, and a procedure the
// optimizer knows (a local declared, then given its function: Lua's way to name a function before it is written).
//  - nothing mentions it between its binding and its assignment: a %let of the value around what follows (a lambda:
//    a %letrec, as it may call itself)
//  - closures made in between mention it (a function that calls it, written first): those and the assignment, with
//    nothing but the making of closures among them (so none of them has run), become one %letrec around what follows
// The forms looked at are those of one run of statements: a %let or %letrec's body, and on into the %let or %letrec
// its last form is (a front end binds each local around the rest of its block); not a %let*, so not a block of more
// locals than flatten-lets leaves nested. A frame of re-entrant code can run a second time from before the
// assignment, with the closures of the first still holding the variable
import { CORE_BEGIN, CORE_LAMBDA, CORE_LET, CORE_LETREC, CORE_QUOTE, CORE_SET } from "../../common";
import { DESCEND, Worklist } from "../visitor";
import { Lsrc, mapTree, subExprs } from "./lang";
import type { Pass } from "./pass";

const isLambda = (e: any): boolean => Array.isArray(e) && e[0] === CORE_LAMBDA;
const isConst = (e: any): boolean => Array.isArray(e) ? e[0] === CORE_QUOTE : typeof e !== "symbol";
const isBinder = (e: any): boolean => Array.isArray(e) && (e[0] === CORE_LET || e[0] === CORE_LETREC) && Array.isArray(e[2]);
const formOrAtom = (e: any) => Array.isArray(e) ? DESCEND : e;

// a %let or %letrec with its bindings (`open`), or one of the forms of its body but the binder that goes on from it
type Item = { readonly form: any[], readonly open: boolean };

// the bindings as %letrecs, one inside another, each of the lambdas that reach one another: one that calls none of
// the others is outside them, where the optimizer may inline it into them
const letrecs = (bindings: [symbol, any][], pos: any, body: any[]): any[] => {
    const names = new Map(bindings.map((b, i) => [b[0], i]));
    const calls = bindings.map(([, lambda]) => {
        const out = new Set<number>();
        const todo = new Worklist();
        todo.add(lambda);
        todo.run(e => {
            if (typeof e === "symbol") {
                const i = names.get(e);
                if (i !== undefined) out.add(i);
            } else if (Array.isArray(e)) {
                if (Lsrc.forms.get(e[0]) === "assign") todo.add(e[2]);
                todo.addAll(subExprs(Lsrc, e));
            }
        });
        return [...out];
    });
    // (Tarjan's: a group is complete once nothing it reaches is still open, so those it needs come before it)
    const index = new Array<number>(bindings.length).fill(-1), low = new Array<number>(bindings.length).fill(0);
    const open: number[] = [], isOpen = new Array<boolean>(bindings.length).fill(false), groups: number[][] = [];
    let next = 0;
    for (let root = 0; root < bindings.length; root++) {
        if (index[root] !== -1) continue;
        const path: [number, number][] = [[root, 0]];
        index[root] = low[root] = next++;
        open.push(root);
        isOpen[root] = true;
        while (path.length > 0) {
            const at = path[path.length - 1], v = at[0];
            if (at[1] < calls[v].length) {
                const w = calls[v][at[1]++];
                if (index[w] === -1) {
                    index[w] = low[w] = next++;
                    open.push(w);
                    isOpen[w] = true;
                    path.push([w, 0]);
                } else if (isOpen[w]) low[v] = Math.min(low[v], index[w]);
                continue;
            }
            path.pop();
            if (path.length > 0) low[path[path.length - 1][0]] = Math.min(low[path[path.length - 1][0]], low[v]);
            if (low[v] !== index[v]) continue;
            const group: number[] = [];
            for (let w = -1; w !== v;) {
                w = open.pop()!;
                isOpen[w] = false;
                group.push(w);
            }
            groups.push(group.sort((a, b) => a - b));
        }
    }
    let form = body;
    for (let g = groups.length - 1; g >= 0; g--) form = [[CORE_LETREC, pos, groups[g].map(i => bindings[i]), ...form]];
    return form[0];
};

export const bindOnce = (ast: any): any => {
    // the variables a %let binds to a constant, those a form of a binder's body assigns (where one to rebind is
    // assigned), every assignment's variable, and the binders that go on from another's body
    // (every form of every program not re-entrant is looked at here, and few have anything to rebind: the forms inside
    // one go straight on the stack, in no order that matters, and nothing is counted until something may be rebound)
    const constants = new Set<symbol>(), inBody = new Set<symbol>(), inner = new Set<any>();
    const assigned: symbol[] = [];
    const todo: any[] = [ast];
    while (todo.length > 0) {
        const e = todo.pop();
        if (!Array.isArray(e)) continue;
        const shape = Lsrc.forms.get(e[0]);
        if (shape === "exprs") {
            for (let i = 2; i < e.length; i++) if (typeof e[i] === "object") todo.push(e[i]);
        } else if (shape === "intrinsic" || shape === "label") {
            for (let i = 3; i < e.length; i++) if (typeof e[i] === "object") todo.push(e[i]);
        } else if (shape === "assign") {
            if (e[0] === CORE_SET && typeof e[2] === "symbol") assigned.push(e[2]);
            todo.push(e[3]);
        } else if (shape === "let" || shape === "letrec") {
            if (!Array.isArray(e[2])) continue;
            for (const b of e[2]) {
                if (!Array.isArray(b)) continue;
                if (shape === "let" && typeof b[0] === "symbol" && isConst(b[1])) constants.add(b[0]);
                else todo.push(b[1]);
            }
            for (let i = 3; i < e.length; i++) {
                const form = e[i];
                if (!Array.isArray(form)) continue;
                if (form[0] === CORE_SET && typeof form[2] === "symbol") inBody.add(form[2]);
                todo.push(form);
            }
            if (e.length > 3 && isBinder(e[e.length - 1])) inner.add(e[e.length - 1]);
        } else if (shape !== undefined && shape !== "quote") {
            const inside = subExprs(Lsrc, e);
            for (let i = 0; i < inside.length; i++) todo.push(inside[i]);
        }
    }
    // (renaming gives every binder a symbol of its own but one code generation refuses, which is left as it was: one
    // of those may be bound more than once, and is left alone here too. They are a front end's names, or the same
    // name twice in a list of bindings)
    const candidates = new Map<symbol, number>();
    for (const name of inBody) if (constants.has(name) && Symbol.keyFor(name) === undefined) candidates.set(name, 0);
    if (candidates.size === 0) return ast;
    for (const name of assigned) {
        const n = candidates.get(name);
        if (n !== undefined) candidates.set(name, n + 1);
    }
    const once = (name: any, init: any, bindings: readonly any[]): name is symbol =>
        candidates.get(name) === 1 && isConst(init) && (bindings.length === 1 || bindings.filter(b => Array.isArray(b) && b[0] === name).length === 1);
    if (![...candidates.values()].includes(1)) return ast;

    const rebind = (top: any[]): any => {
        const items: Item[] = [];
        let any = false;
        for (let form = top;;) {
            items.push({ form, open: true });
            if (form[0] === CORE_LET) any ||= form[2].some((b: any) => Array.isArray(b) && once(b[0], b[1], form[2]));
            const last = form[form.length - 1], on = form.length > 3 && isBinder(last);
            for (let k = 3; k < form.length - (on ? 1 : 0); k++) items.push({ form: form[k], open: false });
            if (!on) break;
            form = last;
        }
        if (!any) return top;

        // the variables bound so far that are still as they were bound, with nothing able to have read them
        const waiting = new Set<symbol>();
        // those of them `exprs` mentions: where it would be read as they run (`now`), and in the closures they make
        const mentions = (exprs: readonly any[]): { now: Set<symbol>, later: Set<symbol> } => {
            const now = new Set<symbol>(), later = new Set<symbol>();
            if (waiting.size === 0) return { now, later };
            const todo = new Worklist<boolean>();
            todo.addAll(exprs, false);
            todo.run((e, inLambda) => {
                if (typeof e === "symbol") {
                    if (waiting.has(e)) (inLambda ? later : now).add(e);
                } else if (Array.isArray(e)) {
                    // (assigned anywhere but where it is looked for: not one to rebind)
                    if (Lsrc.forms.get(e[0]) === "assign" && waiting.has(e[2])) now.add(e[2]);
                    todo.addAll(subExprs(Lsrc, e), inLambda || e[0] === CORE_LAMBDA);
                }
            });
            return { now, later };
        };
        // the run of closure-making items under way, from the first whose closures mention a waiting variable: the
        // variables those mention, and the items in it that assign one its lambda
        let from = -1;
        const mentioned = new Set<symbol>(), assigned: number[] = [];
        const groups = new Map<number, number>(), values = new Set<number>(), rebound = new Set<symbol>();
        // something that is not the making of a closure runs here: the run ends
        const end = () => {
            if (assigned.length > 0) {
                groups.set(assigned[assigned.length - 1], from);
                for (const i of assigned) rebound.add(items[i].form[2]);
            }
            for (const name of mentioned) waiting.delete(name);
            from = -1;
            mentioned.clear();
            assigned.length = 0;
        };
        const makes = (i: number, inert: boolean, { now, later }: { now: Set<symbol>, later: Set<symbol> }) => {
            for (const name of now) waiting.delete(name);
            if (!inert) {
                end();
                for (const name of later) waiting.delete(name);
            } else if (later.size > 0) {
                if (from === -1) from = i;
                for (const name of later) if (waiting.has(name)) mentioned.add(name);
            }
        };
        for (let i = 0; i < items.length; i++) {
            const { form, open } = items[i];
            if (open) {
                const bindings: any[] = form[2];
                const inert = bindings.every(b => Array.isArray(b) && typeof b[0] === "symbol" && (isLambda(b[1]) || (form[0] === CORE_LET && isConst(b[1]))));
                makes(i, inert, mentions(bindings.map(b => Array.isArray(b) ? b[1] : b)));
                if (form[0] === CORE_LET) for (const b of bindings) if (Array.isArray(b) && once(b[0], b[1], bindings)) waiting.add(b[0]);
                continue;
            }
            if (!Array.isArray(form) || form[0] !== CORE_SET || typeof form[2] !== "symbol" || form.length !== 4) {
                makes(i, false, mentions([form]));
                continue;
            }
            const name: symbol = form[2], value = form[3];
            if (!waiting.has(name)) {
                makes(i, isLambda(value) || isConst(value) || typeof value === "symbol", mentions([value]));
                continue;
            }
            const { now, later } = mentions([value]);
            if (isLambda(value)) {
                if (from === -1) from = i;
                waiting.delete(name);
                mentioned.delete(name);
                assigned.push(i);
                for (const other of later) if (other !== name) mentioned.add(other);
            } else if (now.has(name) || later.has(name) || mentioned.has(name)) {
                now.add(name);
                makes(i, false, { now, later });
            } else {
                makes(i, false, { now, later });
                waiting.delete(name);
                values.add(i);
                rebound.add(name);
            }
        }
        end();
        if (rebound.size === 0) return top;

        // the forms again, from the last: `rest` is what follows where the walk is, last first. With nothing after an
        // assignment, its binding is around what the assignment's own value was
        const following = (rest: any[]): any[] => rest.length === 0 ? [undefined] : rest.reverse();
        let rest: any[] = [];
        for (let i = items.length - 1; i >= 0; i--) {
            const start = groups.get(i);
            if (start !== undefined) {
                const bindings: [symbol, any][] = [], after: any[] = [], constants: any[] = [];
                for (let k = start; k <= i; k++) {
                    const { form, open } = items[k];
                    if (open) {
                        for (const b of form[2]) {
                            if (isLambda(b[1])) bindings.push(b);
                            else if (!rebound.has(b[0])) constants.push(b);
                        }
                    } else if (!isLambda(form[3])) after.push(form);
                    else if (rebound.has(form[2])) bindings.push([form[2], form[3]]);
                    else {
                        // (a lambda assigned to something else: made with the others, as what it is assigned to names it)
                        const made = Symbol(form[2].description);
                        bindings.push([made, form[3]]);
                        after.push([CORE_SET, form[1], form[2], made]);
                    }
                }
                const group = letrecs(bindings, items[i].form[1], after.length > 0 ? [...after, ...rest.reverse()] : following(rest));
                rest = [constants.length === 0 ? group : [CORE_LET, null, constants, group]];
                i = start;
                continue;
            }
            const { form, open } = items[i];
            if (values.has(i)) rest = [[CORE_LET, form[1], [[form[2], form[3]]], ...following(rest)]];
            else if (!open) rest.push(form);
            else {
                const bindings = form[0] === CORE_LET ? form[2].filter((b: any) => !Array.isArray(b) || !rebound.has(b[0])) : form[2];
                const body = rest.reverse();
                rest = [bindings.length > 0 ? [form[0], form[1], bindings, ...body] : body.length === 1 ? body[0] : [CORE_BEGIN, form[1], ...body]];
            }
        }
        return rest[0];
    };
    return mapTree(Lsrc, ast, formOrAtom, (next, e) => isBinder(next) && !inner.has(e) ? rebind(next) : next);
};

export const bindOncePass: Pass<any, any> = { name: "bind-once", run: (ast, ctx) => ctx.reentrant ? ast : bindOnce(ast) };
