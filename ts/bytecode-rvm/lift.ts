// Lambda lifting, a pass over the core forms before analysis. A lambda bound by a %letrec whose name is never assigned
// and only ever called (so every call is known) gets its free local variables as extra parameters, passed by every call,
// so it captures nothing and compiles to a constant closure: none is made each time the %letrec runs. The variables
// passed include the lifted lambdas it calls (itself too, if it recurses), which it receives as values, and those its
// callees need. A free variable that is assigned anywhere stops the lifting (a copy would miss the assignments)
import { Cons, CORE_BLOCK, CORE_ESCAPE, CORE_LAMBDA, CORE_LET, CORE_LET_VALUES, CORE_LET_VALUES_STRICT, CORE_LETREC, CORE_QUOTE, CORE_SET, OP_DEFINE_GLOBAL, SOURCE_POS } from "../common";

const toArr = (x: any): any[] => x instanceof Cons ? x.toArray() : [];
const list = (items: any[]): any => Cons.fromArray(items);
const keepPos = (to: any, from: any): any => {
    const pos = SOURCE_POS.get(from);
    if (pos !== undefined && to instanceof Cons) SOURCE_POS.set(to, pos);
    return to;
};

// the names a parameter list or formals binds
const formalNames = (formals: any): symbol[] => {
    const out: symbol[] = [];
    let p = formals;
    for (; p instanceof Cons; p = p.cdr) out.push(p.car);
    if (typeof p === "symbol") out.push(p);
    return out;
};

const arityAccepts = (formals: any, nargs: number): boolean => {
    let fixed = 0, p = formals;
    for (; p instanceof Cons; p = p.cdr) fixed++;
    return p === null ? nargs === fixed : nargs >= fixed;
};

// Each expression position in `e` with the names bound around it (beyond those around `e`), and how to rebuild `e`
// from new expressions for them. Block labels and the names %set! / %define-global assign are not expressions
const parts = (e: Cons): { exprs: [any, symbol[]][], rebuild: (next: any[]) => any } => {
    const same = (exprs: [any, symbol[]][], rebuild: (next: any[]) => any) => ({ exprs, rebuild: (next: any[]) => keepPos(rebuild(next), e) });
    switch (e.car) {
        case CORE_QUOTE:
            return { exprs: [], rebuild: () => e };
        case CORE_LAMBDA: {
            const bound = formalNames(e.cdr.car);
            return same(toArr(e.cdr.cdr).map(x => [x, bound]), next => new Cons(CORE_LAMBDA, new Cons(e.cdr.car, list(next))));
        }
        case CORE_LET:
        case CORE_LETREC: {
            const bindings = toArr(e.cdr.car);
            const names = bindings.map(b => b.car);
            const inner = e.car === CORE_LETREC ? names : [];
            const body = toArr(e.cdr.cdr);
            return same([...bindings.map(b => [b.cdr.car, inner] as [any, symbol[]]), ...body.map(x => [x, names] as [any, symbol[]])], next =>
                new Cons(e.car, new Cons(list(bindings.map((b, i) => list([b.car, next[i]]))), list(next.slice(bindings.length)))));
        }
        case CORE_LET_VALUES:
        case CORE_LET_VALUES_STRICT: {
            const clauses = toArr(e.cdr.car);
            const names = clauses.flatMap(c => formalNames(c.car));
            const body = toArr(e.cdr.cdr);
            return same([...clauses.map(c => [c.cdr.car, []] as [any, symbol[]]), ...body.map(x => [x, names] as [any, symbol[]])], next =>
                new Cons(e.car, new Cons(list(clauses.map((c, i) => list([c.car, next[i]]))), list(next.slice(clauses.length)))));
        }
        case CORE_SET:
        case OP_DEFINE_GLOBAL:
            return same([[e.cdr.cdr.car, []]], next => list([e.car, e.cdr.car, next[0]]));
        case CORE_BLOCK:
            return same(toArr(e.cdr.cdr).map(x => [x, []]), next => new Cons(CORE_BLOCK, new Cons(e.cdr.car, list(next))));
        case CORE_ESCAPE:
            return e.cdr.cdr === null ? { exprs: [], rebuild: () => e } : same([[e.cdr.cdr.car, []]], next => list([CORE_ESCAPE, e.cdr.car, next[0]]));
        default:
            return same(toArr(e).map(x => [x, []]), next => list(next));
    }
};

// every name %set! assigns anywhere in `e`
const assignedNames = (e: any, out: Set<symbol> = new Set()): Set<symbol> => {
    if (!(e instanceof Cons)) return out;
    if (e.car === CORE_SET) out.add(e.cdr.car);
    for (const [x] of parts(e).exprs) assignedNames(x, out);
    return out;
};

// The unshadowed uses of `name` in `e`: calls (with the names bound between `e` and each call, unless the call is inside
// one of `skip`, the lifted lambdas, which rename what they need), and whether it is used any other way
type Uses = { calls: { node: Cons, bound: ReadonlySet<symbol> }[], other: boolean };
const usesOf = (e: any, name: symbol, skip: ReadonlySet<any>, bound: ReadonlySet<symbol> = new Set(), out: Uses = { calls: [], other: false }, inSkip = false): Uses => {
    if (e === name) {
        out.other = true;
        return out;
    }
    if (!(e instanceof Cons)) return out;
    if (e.car === CORE_SET && e.cdr.car === name) out.other = true;
    const inner = inSkip || skip.has(e);
    const exprs = parts(e).exprs;
    for (let i = 0; i < exprs.length; i++) {
        const [x, names] = exprs[i];
        if (names.includes(name)) continue;
        // the operator of a call
        if (i === 0 && x === name && e.car === name && !isForm(e)) {
            out.calls.push({ node: e, bound: inner ? new Set() : bound });
            continue;
        }
        usesOf(x, name, skip, names.length === 0 ? bound : new Set([...bound, ...names]), out, inner);
    }
    return out;
};

const FORMS = new Set([CORE_QUOTE, CORE_LAMBDA, CORE_LET, CORE_LETREC, CORE_LET_VALUES, CORE_LET_VALUES_STRICT, CORE_SET, OP_DEFINE_GLOBAL, CORE_BLOCK, CORE_ESCAPE]);
const isForm = (e: Cons) => FORMS.has(e.car);

// the names of `scope` used (unshadowed) in `e`
const freeIn = (e: any, scope: ReadonlySet<symbol>, bound: ReadonlySet<symbol>, out: Set<symbol>): Set<symbol> => {
    if (typeof e === "symbol") {
        if (scope.has(e) && !bound.has(e)) out.add(e);
        return out;
    }
    if (!(e instanceof Cons)) return out;
    for (const [x, names] of parts(e).exprs) freeIn(x, scope, names.length === 0 ? bound : new Set([...bound, ...names]), out);
    return out;
};

// `e` with the unshadowed free uses of the names in `map` replaced, and the calls in `calls` given their extra arguments
const rewrite = (e: any, map: ReadonlyMap<symbol, symbol>, extra: ReadonlyMap<Cons, symbol[]>, bound: ReadonlySet<symbol> = new Set()): any => {
    if (typeof e === "symbol") return !bound.has(e) && map.get(e) || e;
    if (!(e instanceof Cons)) return e;
    const { exprs, rebuild } = parts(e);
    const added = extra.get(e);
    const next = exprs.map(([x, names]) => rewrite(x, map, extra, names.length === 0 ? bound : new Set([...bound, ...names])));
    if (added === undefined) return rebuild(next);
    // inside a lifted lambda these are its fresh parameters, which nothing shadows
    const args = added.map(a => map.get(a) ?? a);
    return keepPos(list([next[0], ...args, ...next.slice(1)]), e);
};

export const liftLambdas = (ast: any): any => {
    const assigned = assignedNames(ast);

    // `scope`: the local names bound around `e`. `unsafe`: those that may not have their value yet when code there runs
    // (%letrec values), which a copy would miss, so they cannot be passed
    const walk = (e: any, scope: ReadonlySet<symbol>, unsafe: ReadonlySet<symbol>): any => {
        if (!(e instanceof Cons)) return e;
        if (e.car === CORE_LETREC) {
            const bindings: Cons[] = toArr(e.cdr.car);
            const names = bindings.map(b => b.car as symbol);
            const lambdas = new Set(names.filter((_, i) => isLambdaExpr(bindings[i].cdr.car)));
            const values = names.filter(n => !lambdas.has(n));
            // the values' inits run before some values have theirs; if they may run the lambdas, so may everything else
            const runsEarly = bindings.some(b => !isLambdaExpr(b.cdr.car) && freeIn(b.cdr.car, lambdas, new Set(), new Set()).size > 0);
            const inner = new Set([...scope, ...names]);
            const inInits = new Set([...unsafe, ...values]);
            const afterInits = runsEarly ? inInits : unsafe;
            const next = bindings.map(b => list([b.car, walk(b.cdr.car, inner, isLambdaExpr(b.cdr.car) ? afterInits : inInits)]));
            const body = toArr(e.cdr.cdr).map(x => walk(x, inner, afterInits));
            return liftIn(keepPos(new Cons(CORE_LETREC, new Cons(list(next), list(body))), e), scope, afterInits);
        }
        const { exprs, rebuild } = parts(e);
        return rebuild(exprs.map(([x, names]) => walk(x, names.length === 0 ? scope : new Set([...scope, ...names]), unsafe)));
    };

    const liftIn = (letrec: Cons, outer: ReadonlySet<symbol>, unsafe: ReadonlySet<symbol>): Cons => {
        const bindings: Cons[] = toArr(letrec.cdr.car);
        const body = toArr(letrec.cdr.cdr);
        const names = bindings.map(b => b.car as symbol);
        const scope = new Set([...outer, ...names]);
        const inits = new Map<symbol, any>(bindings.map(b => [b.car, b.cdr.car]));
        const isLambda = (name: symbol) => { const init = inits.get(name); return init instanceof Cons && init.car === CORE_LAMBDA; };
        const within = [...bindings.map(b => b.cdr.car), ...body];

        let lifted = new Set(names.filter(n => isLambda(n) && !assigned.has(n)));
        let fv = new Map<symbol, symbol[]>();
        let calls = new Map<symbol, Uses["calls"]>();
        for (;;) {
            const skip = new Set([...lifted].map(n => inits.get(n)));
            calls = new Map();
            const next = new Set<symbol>();
            for (const name of lifted) {
                const uses = within.reduce((u, x) => usesOf(x, name, skip, new Set(), u), { calls: [], other: false } as Uses);
                if (uses.other || uses.calls.some((c: { node: Cons }) => !arityAccepts(inits.get(name).cdr.car, c.node.length - 1))) continue;
                next.add(name);
                calls.set(name, uses.calls);
            }
            // what each passes: its free locals (lifted ones it calls included), then what those need, to a fixpoint
            fv = new Map([...next].map(name => {
                const lambda = inits.get(name);
                return [name, [...freeIn(new Cons(CORE_BEGIN_MARK, lambda.cdr.cdr), scope, new Set(formalNames(lambda.cdr.car)), new Set())]];
            }));
            for (let changed = true; changed;) {
                changed = false;
                for (const [name, vars] of fv) {
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

        const extra = new Map<Cons, symbol[]>();
        for (const name of lifted) for (const c of calls.get(name)!) extra.set(c.node, fv.get(name)!);
        const liftedInit = (name: symbol): any => {
            const lambda = inits.get(name);
            const vars = fv.get(name)!;
            const renamed = new Map(vars.map(v => [v, Symbol(v.description)]));
            const params = vars.map(v => renamed.get(v)!).reduceRight((rest: any, p) => new Cons(p, rest), lambda.cdr.car);
            const newBody = toArr(lambda.cdr.cdr).map(x => rewrite(x, renamed, extra, new Set(formalNames(lambda.cdr.car))));
            return keepPos(new Cons(CORE_LAMBDA, new Cons(params, list(newBody))), lambda);
        };
        const newBindings = bindings.map(b => list([b.car, lifted.has(b.car) ? liftedInit(b.car) : rewrite(b.cdr.car, new Map(), extra)]));
        const newBody = body.map(x => rewrite(x, new Map(), extra));
        return keepPos(new Cons(CORE_LETREC, new Cons(list(newBindings), list(newBody))), letrec) as Cons;
    };

    return walk(ast, new Set(), new Set());
};

const isLambdaExpr = (e: any): boolean => e instanceof Cons && e.car === CORE_LAMBDA;

// freeIn walks a lambda's body as the expressions of a form with no binders of its own
const CORE_BEGIN_MARK = Symbol("lambda body");
