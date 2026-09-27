// Lambda lifting, a pass over the core forms before analysis. A lambda bound by a %letrec whose name is never assigned
// and only ever called (so every call is known) gets its free local variables as extra parameters, passed by every call,
// so it captures nothing and compiles to a constant closure: none is made each time the %letrec runs. The variables
// passed include the lifted lambdas it calls (itself too, if it recurses), which it receives as values, and those its
// callees need. A free variable that is assigned anywhere stops the lifting (a copy would miss the assignments)
import { CORE_BLOCK, CORE_ESCAPE, CORE_LAMBDA, CORE_LET, CORE_LET_STAR, CORE_LET_VALUES, CORE_LET_VALUES_STRICT, CORE_LETREC, CORE_QUOTE, CORE_SET, OP_DEFINE_GLOBAL, SOURCE_POS } from "../common";

const keepPos = <T>(to: T, from: any): T => {
    const pos = SOURCE_POS.get(from);
    if (pos !== undefined && Array.isArray(to)) SOURCE_POS.set(to, pos);
    return to;
};

// the names a lambda binds: [%lambda, params, rest, ...]
const lambdaNames = (lambda: any[]): symbol[] => lambda[2] === null ? lambda[1] : [...lambda[1], lambda[2]];

const arityAccepts = (lambda: any[], nargs: number): boolean => lambda[2] === null ? nargs === lambda[1].length : nargs >= lambda[1].length;

// Each expression position in `e` with the names bound around it (beyond those around `e`), and how to rebuild `e`
// from new expressions for them. Block labels and the names %set! / %define-global assign are not expressions. For a
// %let* (`seq`), each position's names add to those of the positions before it (see withBounds)
type Parts = { exprs: [any, symbol[]][], rebuild: (next: any[]) => any, seq?: boolean };
const parts = (e: any[]): Parts => {
    const same = (exprs: [any, symbol[]][], rebuild: (next: any[]) => any): Parts => ({ exprs, rebuild: next => keepPos(rebuild(next), e) });
    const op = e[0];
    switch (op) {
        case CORE_QUOTE:
            return { exprs: [], rebuild: () => e };
        case CORE_LAMBDA: {
            const bound = lambdaNames(e);
            return same(e.slice(3).map(x => [x, bound]), next => [CORE_LAMBDA, e[1], e[2], ...next]);
        }
        case CORE_LET:
        case CORE_LETREC: {
            const bindings: [symbol, any][] = e[1];
            const names = bindings.map(b => b[0]);
            const inner = op === CORE_LETREC ? names : [];
            return same([...bindings.map(b => [b[1], inner] as [any, symbol[]]), ...e.slice(2).map(x => [x, names] as [any, symbol[]])], next =>
                [op, bindings.map((b, i) => keepPos([b[0], next[i]], b)), ...next.slice(bindings.length)]);
        }
        case CORE_LET_STAR: {
            const bindings: [symbol, any][] = e[1];
            const body = e.slice(2);
            const exprs: [any, symbol[]][] = [
                ...bindings.map((b, i) => [b[1], i === 0 ? [] : [bindings[i - 1][0]]] as [any, symbol[]]),
                ...body.map((x, i) => [x, i === 0 && bindings.length > 0 ? [bindings[bindings.length - 1][0]] : []] as [any, symbol[]]),
            ];
            return { exprs, seq: true, rebuild: next => keepPos([op, bindings.map((b, i) => keepPos([b[0], next[i]], b)), ...next.slice(bindings.length)], e) };
        }
        case CORE_LET_VALUES:
        case CORE_LET_VALUES_STRICT: {
            const clauses: [symbol[], symbol | null, any][] = e[1];
            const names = clauses.flatMap(c => c[1] === null ? c[0] : [...c[0], c[1]]);
            return same([...clauses.map(c => [c[2], []] as [any, symbol[]]), ...e.slice(2).map(x => [x, names] as [any, symbol[]])], next =>
                [op, clauses.map((c, i) => [c[0], c[1], next[i]]), ...next.slice(clauses.length)]);
        }
        case CORE_SET:
        case OP_DEFINE_GLOBAL:
            return same([[e[2], []]], next => [op, e[1], next[0]]);
        case CORE_BLOCK:
        case CORE_ESCAPE:
            return same(e.slice(2).map(x => [x, []]), next => [op, e[1], ...next]);
        default:
            return same(e.map(x => [x, []]), next => next);
    }
};

// each expression position of `p` with the names bound around it, given those around the form (`bound`, not changed).
// A %let*'s positions share one growing set, so a long one costs no more than its length
function* withBounds(p: Parts, bound: ReadonlySet<symbol>): Generator<[any, ReadonlySet<symbol>]> {
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

// every name %set! assigns anywhere in `e`
const assignedNames = (e: any, out: Set<symbol> = new Set()): Set<symbol> => {
    if (!Array.isArray(e)) return out;
    if (e[0] === CORE_SET) out.add(e[1]);
    for (const [x] of parts(e).exprs) assignedNames(x, out);
    return out;
};

const FORMS = new Set([CORE_QUOTE, CORE_LAMBDA, CORE_LET, CORE_LET_STAR, CORE_LETREC, CORE_LET_VALUES, CORE_LET_VALUES_STRICT, CORE_SET, OP_DEFINE_GLOBAL, CORE_BLOCK, CORE_ESCAPE]);

// The unshadowed uses of `name` in `e`: calls (with the names bound between `e` and each call, unless the call is inside
// one of `skip`, the lifted lambdas, which rename what they need), and whether it is used any other way
type Uses = { calls: { node: any[], bound: ReadonlySet<symbol> }[], other: boolean };
const usesOf = (e: any, name: symbol, skip: ReadonlySet<any>, bound: ReadonlySet<symbol> = new Set(), out: Uses = { calls: [], other: false }, inSkip = false): Uses => {
    if (e === name) {
        out.other = true;
        return out;
    }
    if (!Array.isArray(e)) return out;
    if (e[0] === CORE_SET && e[1] === name) out.other = true;
    const inner = inSkip || skip.has(e);
    let i = 0;
    for (const [x, around] of withBounds(parts(e), bound)) {
        if (!around.has(name)) {
            // the operator of a call
            if (i === 0 && x === name && e[0] === name && !FORMS.has(e[0])) out.calls.push({ node: e, bound: inner ? new Set() : new Set(bound) });
            else usesOf(x, name, skip, around, out, inner);
        }
        i++;
    }
    return out;
};

// the names of `scope` used (unshadowed) in `e`
const freeIn = (e: any, scope: ReadonlySet<symbol>, bound: ReadonlySet<symbol>, out: Set<symbol>): Set<symbol> => {
    if (typeof e === "symbol") {
        if (scope.has(e) && !bound.has(e)) out.add(e);
        return out;
    }
    if (!Array.isArray(e)) return out;
    for (const [x, around] of withBounds(parts(e), bound)) freeIn(x, scope, around, out);
    return out;
};

// `e` with the unshadowed free uses of the names in `map` replaced, and the calls in `extra` given their extra arguments
const rewrite = (e: any, map: ReadonlyMap<symbol, symbol>, extra: ReadonlyMap<any[], symbol[]>, bound: ReadonlySet<symbol> = new Set()): any => {
    if (typeof e === "symbol") return !bound.has(e) && map.get(e) || e;
    if (!Array.isArray(e)) return e;
    const p = parts(e);
    const next: any[] = [];
    for (const [x, around] of withBounds(p, bound)) next.push(rewrite(x, map, extra, around));
    const added = extra.get(e);
    if (added === undefined) return p.rebuild(next);
    // inside a lifted lambda these are its fresh parameters, which nothing shadows
    return keepPos([next[0], ...added.map(a => map.get(a) ?? a), ...next.slice(1)], e);
};

const isLambdaExpr = (e: any): boolean => Array.isArray(e) && e[0] === CORE_LAMBDA;

export const liftLambdas = (ast: any): any => {
    const assigned = assignedNames(ast);

    // `scope`: the local names bound around `e`. `unsafe`: those that may not have their value yet when code there runs
    // (%letrec values), which a copy would miss, so they cannot be passed
    const walk = (e: any, scope: ReadonlySet<symbol>, unsafe: ReadonlySet<symbol>): any => {
        if (!Array.isArray(e)) return e;
        if (e[0] === CORE_LETREC) {
            const bindings: [symbol, any][] = e[1];
            const names = bindings.map(b => b[0]);
            const lambdas = new Set(names.filter((_, i) => isLambdaExpr(bindings[i][1])));
            const values = names.filter(n => !lambdas.has(n));
            // the values' inits run before some values have theirs; if they may run the lambdas, so may everything else
            const runsEarly = bindings.some(b => !isLambdaExpr(b[1]) && freeIn(b[1], lambdas, new Set(), new Set()).size > 0);
            const inner = new Set([...scope, ...names]);
            const inInits = new Set([...unsafe, ...values]);
            const afterInits = runsEarly ? inInits : unsafe;
            const next = bindings.map(b => keepPos([b[0], walk(b[1], inner, isLambdaExpr(b[1]) ? afterInits : inInits)], b));
            const body = e.slice(2).map((x: any) => walk(x, inner, afterInits));
            return liftIn(keepPos([CORE_LETREC, next, ...body], e), scope, afterInits);
        }
        const p = parts(e);
        const next: any[] = [];
        for (const [x, around] of withBounds(p, scope)) next.push(walk(x, around, unsafe));
        return p.rebuild(next);
    };

    const liftIn = (letrec: any[], outer: ReadonlySet<symbol>, unsafe: ReadonlySet<symbol>): any[] => {
        const bindings: [symbol, any][] = letrec[1];
        const body = letrec.slice(2);
        const names = bindings.map(b => b[0]);
        const scope = new Set([...outer, ...names]);
        const inits = new Map<symbol, any>(bindings);
        const within = [...bindings.map(b => b[1]), ...body];

        let lifted = new Set(names.filter(n => isLambdaExpr(inits.get(n)) && !assigned.has(n)));
        let fv = new Map<symbol, symbol[]>();
        let calls = new Map<symbol, Uses["calls"]>();
        for (;;) {
            const skip = new Set([...lifted].map(n => inits.get(n)));
            calls = new Map();
            const next = new Set<symbol>();
            for (const name of lifted) {
                const uses = within.reduce((u, x) => usesOf(x, name, skip, new Set(), u), { calls: [], other: false } as Uses);
                if (uses.other || uses.calls.some((c: Uses["calls"][number]) => !arityAccepts(inits.get(name), c.node.length - 1))) continue;
                next.add(name);
                calls.set(name, uses.calls);
            }
            // what each passes: its free locals (lifted ones it calls included), then what those need, to a fixpoint
            fv = new Map([...next].map(name => {
                const lambda = inits.get(name);
                const free = new Set<symbol>();
                for (const x of lambda.slice(3)) freeIn(x, scope, new Set(lambdaNames(lambda)), free);
                return [name, [...free]];
            }));
            for (let changed = true; changed;) {
                changed = false;
                for (const vars of fv.values()) {
                    for (const v of [...vars]) {
                        for (const w of fv.get(v) ?? []) {
                            if (!vars.includes(w)) {
                                vars.push(w);
                                changed = true;
                            }
                        }
                    }
                }
            }
            // an assigned or not yet known variable cannot be passed, and a call must see the variables it passes as they are here
            for (const name of [...next]) {
                const vars = fv.get(name)!;
                if (vars.some(v => assigned.has(v) || unsafe.has(v)) || calls.get(name)!.some(c => vars.some(v => c.bound.has(v)))) next.delete(name);
            }
            if (next.size === lifted.size) break;
            lifted = next;
        }
        if (lifted.size === 0) return letrec;

        const extra = new Map<any[], symbol[]>();
        for (const name of lifted) for (const c of calls.get(name)!) extra.set(c.node, fv.get(name)!);
        const liftedInit = (name: symbol): any[] => {
            const lambda = inits.get(name);
            const vars = fv.get(name)!;
            const renamed = new Map(vars.map(v => [v, Symbol(v.description)]));
            const newBody = lambda.slice(3).map((x: any) => rewrite(x, renamed, extra, new Set(lambdaNames(lambda))));
            return keepPos([CORE_LAMBDA, [...vars.map(v => renamed.get(v)!), ...lambda[1]], lambda[2], ...newBody], lambda);
        };
        const newBindings = bindings.map(b => keepPos([b[0], lifted.has(b[0]) ? liftedInit(b[0]) : rewrite(b[1], new Map(), extra)], b));
        const newBody = body.map(x => rewrite(x, new Map(), extra));
        return keepPos([CORE_LETREC, newBindings, ...newBody], letrec);
    };

    return walk(ast, new Set(), new Set());
};
