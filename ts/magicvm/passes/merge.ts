// Merging mutually recursive procedures, a pass over the core forms before lambda lifting. Procedures a %letrec binds
// that call one another in tail position (a state machine, a pair like even? and odd?) are made one procedure: its
// first parameters say which of them it is running as, the rest are theirs, and its body is theirs, each under a test
// of the selectors. A call of one of them, from anywhere it is in scope, calls the merged procedure with that one's
// selectors, so a tail call between them is a tail call of the procedure to itself: a loop in generated code, where
// it was a call (js has no tail calls, so the stack grew until the code went on in heap frames). Each name stays
// bound, to a procedure that calls the merged one, for the uses of it that are not such calls
import { CORE_BEGIN, CORE_CALL, CORE_IF, CORE_LAMBDA, CORE_LET, CORE_LET_STAR, CORE_LET_VALUES, CORE_LET_VALUES_STRICT, CORE_LETREC, CORE_SET } from "../../common";
import { bodyOf, clause, isSingleLambda, optionsOf, paramsOf, restOf, type Clause } from "../lambda";
import { Lsrc, parts as partsOf, type Parts } from "./lang";

const parts = (e: any[]): Parts => partsOf(Lsrc, e);

const only = (lambda: any[]): Clause => lambda[2];

// most procedures made one: more would be a long chain of tests before each body
const MAX_MERGED = 8;

const assignedNames = (e: any, out: Set<symbol> = new Set()): Set<symbol> => {
    if (!Array.isArray(e)) return out;
    if (e[0] === CORE_SET) out.add(e[2]);
    for (const [x] of parts(e).exprs) assignedNames(x, out);
    return out;
};

// the calls in tail position of `e`, itself in tail position (those under a %block, a %loop, a mark or a catch are
// left out: they only decide what is worth merging)
const tailCalls = (e: any, out: any[][]): any[][] => {
    if (!Array.isArray(e)) return out;
    switch (e[0]) {
        case CORE_CALL: out.push(e); break;
        case CORE_IF: for (const branch of e.slice(3)) tailCalls(branch, out); break;
        case CORE_BEGIN: if (e.length > 2) tailCalls(e[e.length - 1], out); break;
        case CORE_LET: case CORE_LET_STAR: case CORE_LETREC: case CORE_LET_VALUES: case CORE_LET_VALUES_STRICT:
            if (e.length > 3) tailCalls(e[e.length - 1], out);
            break;
    }
    return out;
};

// the groups of `count` nodes that reach one another along `edges`, of two nodes or more (Tarjan's algorithm)
const cycles = (count: number, edges: number[][]): number[][] => {
    const index: number[] = Array(count).fill(-1), low: number[] = Array(count).fill(0);
    const onStack: boolean[] = Array(count).fill(false), stack: number[] = [], out: number[][] = [];
    let next = 0;
    const visit = (v: number): void => {
        index[v] = low[v] = next++;
        stack.push(v);
        onStack[v] = true;
        for (const w of edges[v]) {
            if (index[w] === -1) {
                visit(w);
                low[v] = Math.min(low[v], low[w]);
            } else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
        }
        if (low[v] !== index[v]) return;
        const group: number[] = [];
        for (;;) {
            const w = stack.pop()!;
            onStack[w] = false;
            group.push(w);
            if (w === v) break;
        }
        if (group.length > 1) out.push(group.sort((a, b) => a - b));
    };
    for (let v = 0; v < count; v++) if (index[v] === -1) visit(v);
    return out;
};

export const mergeLoops = (ast: any): any => {
    const assigned = assignedNames(ast);
    // a procedure of one clause and a fixed count of parameters, bound to a name never assigned
    const isCandidate = (b: [symbol, any]) => isSingleLambda(b[1]) && restOf(only(b[1])) === null && !assigned.has(b[0]);

    // `e`, a %letrec whose inits and body are already done, with one group of its procedures merged (and then the next)
    const mergeIn = (e: any[]): any[] => {
        const bindings: [symbol, any][] = e[2];
        const candidates = bindings.map((b, i) => isCandidate(b) ? i : -1).filter(i => i !== -1);
        if (candidates.length < 2) return e;
        const at = new Map(candidates.map((i, c) => [bindings[i][0], c]));
        const arity = (c: number) => paramsOf(only(bindings[candidates[c]][1])).length;
        // a call of candidate `c` that gives it each of its parameters
        const callee = (call: any[]): number => {
            const c = typeof call[2] === "symbol" ? at.get(call[2]) : undefined;
            return c !== undefined && call.length - 3 === arity(c) ? c : -1;
        };
        const edges = candidates.map(i => {
            const body = bodyOf(only(bindings[i][1]));
            const calls = body.length === 0 ? [] : tailCalls(body[body.length - 1], []);
            return [...new Set(calls.map(callee).filter(c => c !== -1))];
        });
        const group = cycles(candidates.length, edges).find(g => g.length <= MAX_MERGED);
        if (group === undefined) return e;

        const members = group.map(c => candidates[c]);
        const clauses = members.map(i => only(bindings[i][1]));
        const names = members.map(i => bindings[i][0]);
        const which = new Map(names.map((n, m) => [n, m]));
        const merged = Symbol(names.map(n => n.description).join("+"));
        // which member is running: one selector for each bit of its number
        const selectors = Array.from({ length: Math.ceil(Math.log2(members.length)) }, (_, i) => Symbol(`which${i}`));
        const shared = Array.from({ length: Math.max(...clauses.map(c => paramsOf(c).length)) }, (_, i) => Symbol(`p${i}`));
        const callOf = (pos: any, m: number, args: any[]): any[] =>
            [CORE_CALL, pos, merged, ...selectors.map((_, bit) => ((m >> bit) & 1) === 1), ...args, ...Array(shared.length - args.length).fill(undefined)];
        const redirect = (x: any): any => {
            if (!Array.isArray(x)) return x;
            const p = parts(x);
            const done = p.rebuild(p.exprs.map(([y]) => redirect(y)));
            const m = done[0] === CORE_CALL && typeof done[2] === "symbol" ? which.get(done[2]) : undefined;
            return m !== undefined && done.length - 3 === paramsOf(clauses[m]).length ? callOf(done[1], m, done.slice(3)) : done;
        };
        // member `m`'s body, its parameters bound to the shared ones
        const bodyAs = (m: number): any[] => [CORE_LET, null, paramsOf(clauses[m]).map((p, i) => [p, shared[i]]), ...bodyOf(clauses[m]).map(redirect)];
        // the members from `from` whose numbers agree on the bits below `bit`, told apart by the bits from it on
        const dispatch = (bit: number, from: number): any => {
            if (bit === selectors.length) return bodyAs(from);
            const other = from | (1 << bit);
            return other < members.length ? [CORE_IF, null, selectors[bit], dispatch(bit + 1, other), dispatch(bit + 1, from)] : dispatch(bit + 1, from);
        };
        const whole: [symbol, any] = [merged, [CORE_LAMBDA, bindings[members[0]][1][1], clause([], [...selectors, ...shared], null, [dispatch(0, 0)])]];
        const entry = (m: number): [symbol, any] => {
            const params = paramsOf(clauses[m]).map(p => Symbol(p.description));
            return [names[m], [CORE_LAMBDA, bindings[members[m]][1][1], clause(optionsOf(clauses[m]), params, null, [callOf(null, m, params)])]];
        };
        const next = bindings.flatMap((b, i): [symbol, any][] => {
            const m = members.indexOf(i);
            if (m === -1) return [[b[0], redirect(b[1])]];
            return m === 0 ? [whole, entry(0)] : [entry(m)];
        });
        return mergeIn([CORE_LETREC, e[1], next, ...e.slice(3).map(redirect)]);
    };

    const walk = (e: any): any => {
        if (!Array.isArray(e)) return e;
        const p = parts(e);
        const done = p.rebuild(p.exprs.map(([x]) => walk(x)));
        return done[0] === CORE_LETREC ? mergeIn(done) : done;
    };
    return walk(ast);
};
