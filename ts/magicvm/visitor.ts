// Walks of a tree that keep what is still to do on a stack of their own, not the js stack: a program nested deeper
// than the js stack allows is walked all the same. Three of them, for the three ways a walk goes:
//  - Worklist: a walk that only looks (collects, counts, records), each node visited before what it adds
//  - Visitor: a walk that gives each node a result made from those of the nodes inside it
//  - run: a walk too irregular for either, written as a generator that yields where it would call itself

const THEN = Symbol("then");

export class Worklist<C = undefined> {
    readonly #todo: any[] = [];

    // `e` is visited with `ctx`, after what was added before it (and what that adds)
    add(e: any, ctx?: C): void {
        this.#todo.push(e, ctx);
    }

    addAll(es: readonly any[], ctx?: C): void {
        for (let i = 0; i < es.length; i++) this.#todo.push(es[i], ctx);
    }

    // `f` is called when the walk gets here
    then(f: () => void): void {
        this.#todo.push(THEN, f);
    }

    // nothing more is visited
    stop(): void {
        this.#todo.length = 0;
    }

    run(visit: (e: any, ctx: C) => void): void {
        const todo = this.#todo;
        let from = 0;
        for (;;) {
            // what was just added, in the order it was added: the last of it on top
            for (let i = from, j = todo.length - 2; i < j; i += 2, j -= 2) {
                const e = todo[i], ctx = todo[i + 1];
                todo[i] = todo[j];
                todo[i + 1] = todo[j + 1];
                todo[j] = e;
                todo[j + 1] = ctx;
            }
            if (todo.length === 0) return;
            const ctx = todo.pop(), e = todo.pop();
            from = todo.length;
            if (e === THEN) ctx();
            else visit(e, ctx);
            if (todo.length < from) return;
        }
    }
}

export const DESCEND = Symbol("descend");

// a node being visited: `kids` the nodes inside it to visit, `out` the results of those done so far
export type Frame<C = any> = { readonly e: any, readonly ctx: C, kids: readonly any[], out: any[], i: number, state: any };

// The hooks are closures in fields, the class never extended: every visitor's object is laid out alike, which keeps the
// one loop below fast however many visitors there are
//  - leaf: the result of a node with nothing inside it to visit, or DESCEND
//  - open: sets the frame's `kids` (and `state`, if it needs `before`)
//  - before: the context of kids[i], called in order, for a frame with a `state` only
//  - leave: the node's result, its kids' results in `out`
export class Visitor<C, R> {
    constructor(
        readonly leaf: (e: any, ctx: C) => R | typeof DESCEND,
        readonly open: (f: Frame<C>) => void,
        readonly leave: (f: Frame<C>) => R,
        readonly before: ((f: Frame<C>, i: number) => C) | null = null,
    ) {}

    visit(root: any, ctx: C): R {
        const first = this.leaf(root, ctx);
        if (first !== DESCEND) return first as R;
        const stack: Frame<C>[] = [], before = this.before;
        let f: Frame<C> = { e: root, ctx, kids: root, out: [], i: 0, state: undefined };
        this.open(f);
        for (;;) {
            if (f.i < f.kids.length) {
                const kid = f.kids[f.i], kidCtx = before === null || f.state === undefined ? f.ctx : before(f, f.i);
                f.i++;
                const r = this.leaf(kid, kidCtx);
                if (r !== DESCEND) {
                    f.out.push(r);
                    continue;
                }
                stack.push(f);
                f = { e: kid, ctx: kidCtx, kids: kid, out: [], i: 0, state: undefined };
                this.open(f);
            } else {
                const r = this.leave(f);
                if (stack.length === 0) return r;
                f = stack.pop()!;
                f.out.push(r);
            }
        }
    }
}

// A walk as a generator: `yield` of another walk's generator gives that walk's result, and `yield` of anything else
// gives it straight back, so a walk may yield a function's result whether the function had to walk or not.
// A generator is run where it is made (`start`), the walks it yields too, each on the js stack as a call would be,
// until they are MAX_NESTED deep: what is inside is then left as a generator, and those waiting for it go on as
// generators too, for `run` to run on a stack of its own. So a program of ordinary depth is walked by plain calls,
// and only a deeper one pays for the stack
export type Task<R = any> = Generator<any, R, any>;

const GENERATOR = Object.getPrototypeOf(Object.getPrototypeOf((function* () {})()));

export const isTask = (x: any): x is Task => {
    if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
    const proto = Object.getPrototypeOf(x);
    return proto !== null && Object.getPrototypeOf(proto) === GENERATOR;
};

const MAX_NESTED = 100;
let nested = 0;
// set from where a walk was too deep to run on the js stack until `run` has it: nothing more is started meanwhile,
// so what is left goes straight to `run`'s stack
let leaving = false;

// whether there is room to go one deeper on the js stack (then `ascend` on the way out), for a walk that calls itself
// where it need not yield; without room, what it would have done there is to be left as a walk
export const descend = (): boolean => {
    if (leaving) return false;
    if (nested >= MAX_NESTED) {
        leaving = true;
        return false;
    }
    nested++;
    return true;
};
export const ascend = (): void => {
    nested--;
};

// `task`, which waits for the walk `pending`, as a walk: for a stack that is not the js stack
function* resumed<R>(task: Task<R>, pending: Task): Task<R> {
    for (;;) {
        let sent: any, failed = false;
        try {
            sent = yield pending;
        } catch (err) {
            sent = err;
            failed = true;
        }
        let r = failed ? task.throw(sent) : task.next(sent);
        while (!r.done && !isTask(r.value)) r = task.next(r.value);
        if (r.done) return r.value;
        pending = r.value;
    }
}

// `task` run here, with the walks it yields: its result, or (from MAX_NESTED deep) the walk that goes on with it
export const start = <R>(task: Task<R>): R | Task<R> => {
    if (!descend()) return task;
    try {
        let r = task.next();
        while (!r.done) {
            let v = r.value;
            if (isTask(v)) {
                try {
                    v = start(v);
                } catch (err) {
                    // (thrown on into the walk that was waiting for this one, as a call would throw into its caller)
                    r = task.throw(err);
                    continue;
                }
                if (isTask(v)) return resumed(task, v);
            }
            r = task.next(v);
        }
        return r.value;
    } finally {
        nested--;
    }
};

// the result of a walk, whatever `start` left of it run on a stack here
export const run = <R>(first: Task<R> | R): R => {
    if (!isTask(first)) return first;
    const waiting: Task[] = [], outer = nested, wasLeaving = leaving;
    let task: Task = first, send: any = undefined, failed = false;
    try {
        for (;;) {
            // (each walk here goes on from the js stack as it is now, with MAX_NESTED to go)
            nested = 0;
            leaving = false;
            let r: IteratorResult<any, any>;
            try {
                r = failed ? task.throw(send) : task.next(send);
            } catch (err) {
                if (waiting.length === 0) throw err;
                task = waiting.pop()!;
                send = err;
                failed = true;
                continue;
            }
            failed = false;
            if (r.done) {
                if (waiting.length === 0) return r.value;
                task = waiting.pop()!;
                send = r.value;
            } else if (isTask(r.value)) {
                waiting.push(task);
                task = r.value;
                send = undefined;
            } else send = r.value;
        }
    } finally {
        nested = outer;
        leaving = wasLeaving;
    }
};
