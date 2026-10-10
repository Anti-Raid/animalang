// The VM's runtime values and state: frames, execution contexts, wind points, continuations, coroutines, catch tokens,
// stack snapshots, and Suspend (how direct code hands control to heap frames)
import { ErrorObject, IProcedure, Msg, MultipleValues, OpaqueValue, VMError, unpackValues, vmError } from "../common";
import type { Env, Formatter, SourcePos } from "../common";
import { Caught, EXCEPTION_HANDLERS, Handlers, TAIL_TRAIL, markFirst, markOwn } from "../marks";
import type { Marks, TailTrail } from "../marks";
import type { Code, Closure, VMHost } from "./code";
import type { VMExecutor } from "./executor";
import { UNPACK_REST, UNPACK_STRICT } from "./ops";

// the values of `val` for Unpack: checks the count when strict; missing values read as undefined (<#void>)
export const unpackForBinding = (val: any, count: number, flags: number): any[] => {
    const vals = unpackValues(val);
    if ((flags & UNPACK_STRICT) !== 0 && ((flags & UNPACK_REST) !== 0 ? vals.length < count : vals.length !== count)) {
        throw vmError(Msg.ValuesCount, count, (flags & UNPACK_REST) !== 0, vals.length);
    }
    return vals;
};

export const restValues = (vals: any[], count: number): any[] => vals.slice(count);

// what a call that wants one value takes of what the procedure returned: its first value, <#void> of none
export const oneValue = (val: any): any => val instanceof MultipleValues ? (val.values.length > 0 ? val.values[0] : undefined) : val;

// what an entry for several values returns (see Code.entry) when it has left them in VB, from where its caller takes
// them at once, leaving the slots empty
export const MULTI = Object.freeze({ multi: true });
export const VALUES_MAX = 255;
export const VB: any[] = Array.from({ length: VALUES_MAX }, () => undefined);

// what an entry for `want` values returns of `val`, which it did not make itself: one value as it is, more in VB
export const manyValues = (val: any, want: number): any => {
    if (!(val instanceof MultipleValues)) return val;
    const values = val.values;
    if (values.length < 2) return values.length === 1 ? values[0] : undefined;
    for (let i = Math.min(values.length, want) - 1; i >= 0; i--) VB[i] = values[i];
    return MULTI;
};

export class Box {
    constructor(public val: any) {}
}

export class WindPoint {
    public readonly depth: number;

    constructor(
        public parent: WindPoint | null,
        public before: any | null = null,
        public after: any | null = null
    ) {
        this.depth = parent === null ? 0 : parent.depth + 1;
    }
}

export type WindAction = { type: "after" | "before"; thunk: any; nextWind: WindPoint | null };

export function depthOf(w: WindPoint | null): number {
    return w === null ? -1 : w.depth;
}

export function computeWindTransition(fromWind: WindPoint | null, toWind: WindPoint | null): WindAction[] {
    if (fromWind === toWind) {
        return [];
    }

    // Equalize depth, then walk together, finds the LCA with no arrays.
    let a = fromWind;
    let b = toWind;
    while (depthOf(a) > depthOf(b)) a = a!.parent;
    while (depthOf(b) > depthOf(a)) b = b!.parent;
    while (a !== b) {
        a = a!.parent;
        b = b!.parent;
    }
    const lca = a;

    const actions: WindAction[] = [];

    // Unwind: natural leaf-to-root walk order is already correct. Only nodes with after thunks generate actions.
    for (let node = fromWind; node !== lca; node = node!.parent) {
        if (node!.after !== null) {
            actions.push({ type: "after", thunk: node!.after, nextWind: node!.parent });
        }
    }

    // Rewind: collect nodes with before thunks on the path from toWind up to lca,
    // then insert in root-to-leaf order.
    const beforeNodes: WindPoint[] = [];
    for (let node = toWind; node !== lca; node = node!.parent) {
        if (node!.before !== null) {
            beforeNodes.push(node!);
        }
    }
    for (let k = beforeNodes.length - 1; k >= 0; k--) {
        const node = beforeNodes[k];
        actions.push({ type: "before", thunk: node.before, nextWind: node });
    }

    return actions;
}

export interface PendingWindTransition {
    actions: WindAction[];
    actionIdx: number;
    targetFrame: Frame | null;
    targetVal: any;
    targetWind: WindPoint | null;
}

export class ExecutionContext {
    private static nextId: number = 0;
    public id: number;
    public acc: any = null;
    public epoch: number = 0;
    public wind: WindPoint | null = null;
    public pendingWind: PendingWindTransition | null = null;
    // the catches of code that is not re-entrant its frames are under, outermost first, two entries each: the handler
    // list (the EXCEPTION_HANDLERS mark) and the wind it was entered with. Such a catch has no token and sets no mark:
    // an error is its to take when it is the last here and the handler list where the error was raised is the one it
    // was entered with (a handler installed inside it would be on that list before). `ncatch` entries are in use (the
    // array only grows: setting an array's length is slow)
    public catches: any[] = [];
    public ncatch: number = 0;
    public coroutine: Coroutine | null = null;
    // a throwaway resumer for nested resumes: control coming back here ends the nested driver loop
    public barrier: boolean = false;

    constructor(
        public vm: VMHost,
        public scope: Env
    ) {
        this.id = ++ExecutionContext.nextId;
    }

    // whether %coroutine-yield would work here: inside a coroutine that is not being closed
    get coroutineYieldable(): boolean {
        return this.coroutine !== null && !this.coroutine.closing;
    }
}

// how debug code names a tail-called procedure in the tail-call trails
export const tailName = (proc: any): string =>
    proc instanceof IProcedure ? proc.debugName ?? "?" : proc instanceof OpaqueValue ? proc.typeName : String(proc);

export type CoroutineStatus = "suspended" | "running" | "normal" | "dead";

// `marks`/`mframe`: those of the code that resumed it (a tail resume's frame is gone), where its errors are raised again
export type Resumer = { ctx: ExecutionContext, frame: Frame | null, marks: Marks, mframe: number };

// Its state changes only through the transitions below, which the executor makes
export class Coroutine extends OpaqueValue {
    #status: CoroutineStatus = "suspended";
    #started: boolean = false;
    #closing: boolean = false;
    #frame: Frame | null = null;
    // the marks where it yielded, where a raise into it is raised (a tail yield's frame is gone)
    #marks: Marks = null;
    #mframe: number = 0;
    #resumer: Resumer | null = null;
    readonly #ctx: ExecutionContext;
    readonly #proc: any;
    readonly #fin: any;

    // `fin`: a thunk run when the coroutine is left for good (it returns, dies with an error or is closed), once started
    constructor(proc: any, vm: VMHost, scope: Env, fin: any = null) {
        super();
        this.#proc = proc;
        this.#fin = fin;
        this.#ctx = new ExecutionContext(vm, scope);
        this.#ctx.coroutine = this;
    }

    get typeName() {
        return "coroutine";
    }

    get status(): CoroutineStatus {
        return this.#status;
    }

    // running its dynamic-wind after-thunks as it is left for good, when it cannot yield
    get closing(): boolean {
        return this.#closing;
    }

    // where it waits: where it yielded when suspended, where it resumed another when normal
    get frame(): Frame | null {
        return this.#frame;
    }

    get ctx(): ExecutionContext {
        return this.#ctx;
    }

    get proc(): any {
        return this.#proc;
    }

    get fin(): any {
        return this.#fin;
    }

    // resumed by `resumer`: whether this is its first run, and the frame and marks it yielded with
    resume(resumer: Resumer): { first: boolean, frame: Frame | null, marks: Marks, mframe: number } {
        const first = !this.#started;
        const frame = this.#frame;
        this.#started = true;
        this.#resumer = resumer;
        this.#status = "running";
        this.#frame = null;
        return { first, frame, marks: this.#marks, mframe: this.#mframe };
    }

    // it resumed another coroutine, from `frame` (null for a nested resume)
    waitOn(frame: Frame | null): void {
        this.#status = "normal";
        this.#frame = frame;
    }

    // the coroutine it resumed is done for now
    wake(): void {
        this.#status = "running";
        this.#frame = null;
    }

    // `frame` is null when it yielded in tail position with no caller left: resuming it then returns from it
    suspend(frame: Frame | null, marks: Marks, mframe: number): void {
        this.#status = "suspended";
        this.#frame = frame;
        this.#marks = marks;
        this.#mframe = mframe;
    }

    finish(): void {
        this.#status = "dead";
        this.#frame = null;
    }

    // closed while suspended: it runs again only for its after-thunks
    startClose(): void {
        this.#status = "running";
        this.#frame = null;
    }

    markClosing(closing: boolean): void {
        this.#closing = closing;
    }

    detachResumer(): Resumer {
        const resumer = this.#resumer!;
        this.#resumer = null;
        return resumer;
    }
}

// an error that escaped a coroutine, raised again in the resumer as-is
export class ReRaise {
    constructor(public readonly value: any, public readonly marks: Marks | undefined = undefined, public readonly mframe: number = 0) {}
}

// the wind an escape to `frame` unwinds to, for a token that recorded `wind`
export const mapWind = (frame: Frame, wind: WindPoint | null): WindPoint | null =>
    frame.winds !== null && frame.winds.has(wind) ? frame.winds.get(wind)! : wind;

// what (%call/comp proc tag) captures: the frames up to the nearest prompt with the tag (innermost first), the wind
// points entered since the prompt (innermost first), the prompt's wind, and the logical frame the frames start at
export class ComposableContinuation extends IProcedure {
    constructor(readonly frames: Frame[], readonly winds: WindPoint[], readonly promptWind: WindPoint | null, readonly base: number) {
        super("composable continuation");
    }
}

// what an abort hands its prompt (see PROMPT)
export class Aborted {
    constructor(readonly values: any[]) {}
}

export class VMContinuation extends IProcedure {
    constructor(
        public frame: Frame | null,
        public ctxId: number,
        public wind: WindPoint | null = null
    ) {
        super("continuation");
    }
}

// a function whose direct calls keep ending in a control transfer (call/cc, a continuation, a yield, an escape) or an
// error pays for it every time: after DIRECT_SUSPEND_LIMIT of them, calls to it use heap frames, where those are cheap
export const countControlSuspend = (code: Code): void => {
    // (the VM's own code stays direct: an error in it is placed by the frames it leaves through)
    if (code.internal) return;
    if (++code.controlSuspends === DIRECT_SUSPEND_LIMIT) {
        code.direct = false;
    }
};

// an escape-only continuation (call/ec), usable while the frame whose pending call it was made for still holds it
// (Frame.escape) among the current frames; a direct-mode %call/ec catches escapes to it itself
export class EscapeContinuation extends IProcedure {
    constructor(public readonly ctxId: number, public readonly wind: WindPoint | null) {
        super("escape continuation");
    }

    // what its frame holds
    get owner(): EscapeContinuation {
        return this;
    }
}

// the handler a %catch installs: raising to it escapes to the %catch with the error wrapped in a Caught
// `guarded`: an error raised while `pre` runs comes to this %catch too, as Msg.ErrorInHandler; while it runs, the handler
// in effect is a copy of the token for that (`of` the token itself, `inPre`)
export class CatchToken extends EscapeContinuation {
    // a pre of #f or <#void> is none (e.g. xpcall with no handler)
    public readonly pre: any;

    constructor(ctxId: number, wind: WindPoint | null, pre: any = null, public readonly guarded: boolean = false, readonly of: CatchToken | null = null) {
        super(ctxId, wind);
        this.pre = pre === false || pre === undefined ? null : pre;
    }

    get inPre(): boolean {
        return this.of !== null;
    }

    get owner(): EscapeContinuation {
        return this.of ?? this;
    }

    forPre(): CatchToken {
        return new CatchToken(this.ctxId, this.wind, null, false, this);
    }
}

// the value of a caught error, as handlers see it
export const caughtValue = (err: any, vm: VMHost): any => {
    const val = err instanceof ReRaise ? (err.value instanceof Error ? new ErrorObject(err.value) : err.value) : err instanceof ErrorObject ? err : new ErrorObject(err);
    if (val instanceof ErrorObject) vm.message(val.error);
    return val;
};

// what a direct-mode %catch whose token is `tok` takes from an exception passing through it, or null to let it go on:
// its own escapes, and errors whose innermost handler is `tok` (so nothing else would see them) and which leave no
// dynamic-wind to unwind
export const catchHere = (e: any, tok: CatchToken, ctx: ExecutionContext): any => {
    if (ctx.wind !== tok.wind) return null;
    if (e instanceof Suspend && e.escape === tok) return e.escapeVal;
    // a pre-unwind handler has to run first, in heap code
    if (tok.pre !== null) return null;
    if (!(e instanceof Suspend)) return e instanceof EscapedError || e instanceof InterruptError ? null : new Caught(caughtValue(e, ctx.vm));
    if (e.action !== null) return null;
    const marks = e.marks !== undefined ? e.marks : e.innermost !== null ? e.innermost.marks : undefined;
    if (marks === undefined) return null;
    const handlers = markFirst(marks, EXCEPTION_HANDLERS, null);
    return handlers instanceof Handlers && handlers.handler === tok ? new Caught(caughtValue(e.error, ctx.vm)) : null;
};

// what the frame of a catch on its context's stack holds for `escape` (see Frame.catchAt)
export const STACK_CATCH = new EscapeContinuation(0, null);

// what a direct-mode catch on the context's stack at `at` takes from an exception passing through it (taking itself off
// the stack), or null to let it go on: an error or a raise whose innermost handler it is, with no dynamic-wind to leave.
// It is not the last there when a catch inside it let the exception go on, its frame rebuilt
export const caughtAt = (e: any, at: number, ctx: ExecutionContext): any => {
    const catches = ctx.catches;
    if (ctx.ncatch !== at + 2 || ctx.wind !== catches[at + 1]) return null;
    let caught;
    if (!(e instanceof Suspend)) {
        if (e instanceof EscapedError || e instanceof InterruptError) return null;
        caught = new Caught(caughtValue(e, ctx.vm));
    } else if (e.catchAt === at) caught = e.escapeVal;
    else {
        if (e.action !== null) return null;
        const marks = e.marks !== undefined ? e.marks : e.innermost !== null ? e.innermost.marks : undefined;
        if (marks === undefined || markFirst(marks, EXCEPTION_HANDLERS, null) !== catches[at]) return null;
        caught = new Caught(caughtValue(e.error, ctx.vm));
    }
    ctx.ncatch = at;
    return caught;
};

export class Frame {
    public code: Code;
    public upvars: any[];
    public epoch: number;
    // in a frame a composable continuation reinstated: the wind points it copied, by the originals the frame's escape
    // continuations and catch tokens still hold (see mapWind)
    public winds: Map<WindPoint | null, WindPoint | null> | null = null;
    // exact position of the last instruction run, when debug code knows it better than ip
    public posIp: number = -1;
    // the inlined procedure the frame is running (an index into Code.inlines, -1: none), for tracebacks
    public isite: number = -1;
    // the escape continuation or catch token of the %call/ec or %catch this frame's pending call is, cleared when it resumes
    public escape: EscapeContinuation | null = null;
    // where in its context's `catches` the catch this frame's pending call is under is (-1: none; `escape` is
    // STACK_CATCH then), taken off when it resumes
    public catchAt: number = -1;

    // `marks`: the continuation marks visible in this frame; `mframe`: its logical frame (a tail call keeps its caller's)
    constructor(
        public closure: Closure,
        public regs: any[],
        public ip: number,
        public parent: Frame | null,
        public ctx: ExecutionContext,
        public marks: Marks = null,
        public mframe: number = 0
    ) {
        this.code = closure.tmpl.code;
        this.upvars = closure.upvars;
        this.epoch = ctx.epoch;
    }

    get debugName(): string {
        return this.closure.debugName ?? "lambda";
    }

    // a captured frame is about to run, as a copy (only ever a frame of re-entrant code: code that is not makes no
    // continuation, and an instance runs code of its own kind alone, see Anima.evaluateRaw)
    thaw(ctx: ExecutionContext): Frame {
        const copy = new Frame(this.closure, this.regs.slice(), this.ip, this.parent, ctx, this.marks, this.mframe);
        copy.isite = this.isite;
        copy.winds = this.winds;
        copy.escape = this.escape;
        return copy;
    }

    share(ctx: ExecutionContext): this {
        ctx.epoch++;
        return this;
    }

    isShared(ctx: ExecutionContext): boolean {
        return this.epoch < ctx.epoch;
    }
}

export const MAX_JS_DEPTH = 1000;

export const MAX_NESTED_RESUMES = 16;

export const DIRECT_SUSPEND_LIMIT = 8;

export const MISSING = Symbol("missing");

export class EscapedError {
    constructor(public readonly error: any) {}
}

// About how many interrupt checks pass between calls of the handler (see Intrinsics.setInterruptHandler): the VM's own
// choice, which it may change. AOT code counts only some checks (see %interrupt in aot/control.ts)
export const INTERRUPT_INTERVAL = 65536;

// An interrupt handler's stop (hostInterruptError): it leaves every evaluation it is in for the host, past exception
// handlers and dynamic-wind after-thunks, which never see it; the coroutines it leaves die. `value` is what the handler
// gave
export class InterruptError extends Error {
    constructor(readonly value: any) {
        super(value instanceof Error ? value.message : typeof value === "string" ? value : "interrupted");
        this.name = "InterruptError";
    }
}

export type SuspendAction = (ctx: ExecutionContext, executor: VMExecutor, caller: Frame, sig: Suspend) => Frame | null;

// thrown out of direct-entry code when heap frames are needed; each direct frame on the way out rebuilds itself
export class Suspend {
    innermost: Frame | null = null;
    outermost: Frame | null = null;
    // the outermost direct function this passed through, i.e. the one heap code called directly
    entered: Closure | null = null;
    // set when invoking an escape continuation, so a direct-mode %call/ec on the way out can take the value itself
    escape: EscapeContinuation | null = null;
    escapeVal: any = undefined;
    // for the next frame pushed: the token of the direct-mode %call/ec or %catch it was left through
    pendingEscape: EscapeContinuation | null = null;
    // the same of a catch on the context's stack (where in `catches`, -1: none); and for a raise, the catch there it
    // goes to, which a direct-mode catch on the way out takes it at (with `escapeVal`)
    pendingCatch: number = -1;
    catchAt: number = -1;
    // the marks where it was thrown, when that was a tail call (which rebuilds no frame): errors are raised with them
    marks: Marks | undefined = undefined;
    mframe: number = 0;

    // `control`: suspended for call/cc, invoking a continuation, a yield or a coroutine resume, rather than for depth or an error
    constructor(public readonly action: SuspendAction | null, public readonly error?: any, public readonly control: boolean = false) {}

    // the error it carries happened at `pos`, if nothing has said where yet (a tail call into the VM's own code leaves
    // no frame to say)
    locate(pos: SourcePos | null): void {
        if (this.error instanceof VMError && this.error.at === null) this.error.at = pos;
    }

    push(frame: Frame) {
        if (this.pendingEscape !== null) {
            frame.escape = this.pendingEscape;
            this.pendingEscape = null;
        }
        if (this.pendingCatch !== -1) {
            frame.escape = STACK_CATCH;
            frame.catchAt = this.pendingCatch;
            this.pendingCatch = -1;
        }
        if (this.outermost === null) {
            this.innermost = frame;
        } else {
            this.outermost.parent = frame;
        }
        this.outermost = frame;
    }

    static invoke(proc: any, args: any[]) {
        const escape = proc instanceof EscapeContinuation;
        const sig = new Suspend((ctx, executor, caller, sig) => executor.invoke(ctx, proc, caller, args, 0, args.length, false, sig.marks, sig.mframe), undefined, escape || proc instanceof VMContinuation || proc instanceof ComposableContinuation);
        if (escape && args.length === 1) {
            sig.escape = proc;
            sig.escapeVal = args[0];
        }
        return sig;
    }

    // raising from direct code: an escape when the innermost handler is a plain catch token (which a direct %catch
    // further out can take), else delivered from heap frames
    static raise(obj: any, continuable: boolean, marks: Marks, ctx?: ExecutionContext) {
        const sig = new Suspend((ctx, executor, caller) => executor.raise(ctx, caller, obj, continuable), undefined, true);
        const handlers = markFirst(marks, EXCEPTION_HANDLERS, null);
        if (ctx !== undefined && ctx.ncatch !== 0 && ctx.catches[ctx.ncatch - 2] === handlers) {
            sig.catchAt = ctx.ncatch - 2;
            sig.escapeVal = new Caught(obj);
        } else if (handlers instanceof Handlers && handlers.handler instanceof CatchToken && handlers.handler.pre === null) {
            sig.escape = handlers.handler;
            sig.escapeVal = new Caught(obj);
        }
        return sig;
    }

    // direct code taking a snapshot of the stack: its frames are rebuilt, and the snapshot is the value. Code that keeps
    // doing it is better off on heap frames, where a snapshot needs no rebuilding, so it counts like a control transfer
    static stack(skip: number) {
        return new Suspend((ctx, executor, caller) => executor.setRetVal(ctx, caller, new StackSnapshot(frameInfos(caller, skip))), undefined, true);
    }

    static prompt(tag: any, thunk: any, handler: any) {
        return new Suspend((ctx, executor, caller, sig) => executor.callPrompt(ctx, caller, false, tag, thunk, handler, sig.marks, sig.mframe), undefined, true);
    }

    static callComposable(proc: any, tag: any) {
        return new Suspend((ctx, executor, caller, sig) => executor.callComposable(ctx, proc, tag, caller, false, sig.marks, sig.mframe), undefined, true);
    }

    static abort(tag: any, values: any[]) {
        return new Suspend((ctx, executor, caller) => executor.abort(ctx, caller, tag, values), undefined, true);
    }

    static callCC(proc: any) {
        return new Suspend((ctx, executor, caller, sig) => executor.callCC(ctx, proc, caller, false, sig.marks, sig.mframe), undefined, true);
    }

    static error(err: any) {
        return new Suspend(null, err);
    }

    static resume(co: any, args: any[], marks: Marks, mframe: number, raising: boolean = false) {
        return new Suspend((ctx, executor, caller) => executor.coResume(ctx, caller, co, args, marks, mframe, raising), undefined, true);
    }

    static yield(val: any) {
        return new Suspend((ctx, executor, caller, sig) => executor.coYield(ctx, caller, val, sig.marks, sig.mframe), undefined, true);
    }
}

// `tails`: the tail calls that led to the frame's current procedure (recorded by debug code), oldest first
export type FrameInfo = { name: string, pos: SourcePos | null, tails: TailTrail | null };

// what (%current-stack) returns: the frames as they were when it ran
export class StackSnapshot extends OpaqueValue {
    constructor(readonly frames: FrameInfo[]) {
        super();
    }

    get typeName() {
        return "stack";
    }
}

// The frames from `frame` out, as the program has them: a frame running code the optimizer inlined procedures into is
// also the frames of those procedures, innermost first, the way it would be without inlining (a procedure inlined in
// tail position replaced the frame it was called from)
export const frameInfos = (frame: Frame | null, level: number = 0): FrameInfo[] => {
    const out: FrameInfo[] = [];
    let i = 0;
    const push = (info: FrameInfo) => { if (i++ >= level) out.push(info); };
    for (let f = frame; f !== null; f = f.parent) {
        if (f.code.internal) continue;
        const ip = Math.max((f.posIp !== -1 ? f.posIp : f.ip) - 1, 0);
        let { site: inner, pos } = f.code.frameAt(f.isite, ip);
        let present = true;
        for (let at = inner; at !== -1; at = f.code.inlines[at].parent) {
            const site = f.code.inlines[at];
            if (present) push({ name: site.name, pos, tails: null });
            pos = site.at;
            present = !site.tail;
        }
        if (present) push({ name: f.debugName, pos, tails: markOwn(f.marks, f.mframe, TAIL_TRAIL, null) });
    }
    return out;
};

export const formatTraceback = (frames: FrameInfo[], msg: string | undefined, fmt: Formatter): string =>
    [fmt(Msg.TracebackHeader, [msg], fmt, null), ...frames.map(f => fmt(Msg.TracebackFrame, [f.name, f.pos, f.tails], fmt, f.pos))].join("\n");

// What a direct entry's catch does with `e`, thrown out of `closure`'s code: the Suspend to throw on (a stop leaves as
// it is: no frame needs rebuilding, and no handler may see it). `regs` are the registers a heap frame resuming at `rip`
// reads, or null when it was leaving by a tail call (`rip` -1; `tip`: that call's ip, or -1), which rebuilds no frame.
// `dip`, `derr`: the ip an error was noted at, and that error (debug code notes the ip of everything it runs)
export const unwind = (e: any, closure: Closure, regs: any[] | null, rip: number, tip: number, dip: number, derr: any, isite: number, ctx: ExecutionContext, marks: Marks, mframe: number): Suspend => {
    if (e instanceof InterruptError) throw e;
    const sig = e instanceof Suspend ? e : Suspend.error(e);
    sig.entered = closure;
    const code = closure.tmpl.code;
    // the error it carries, which may have come through the VM's own code without getting a position
    const err = e instanceof Suspend ? e.error : e;
    if (regs === null) {
        // a tail call that failed, or whose callee did: no frame is left to say where it was
        if (tip !== -1 && err instanceof VMError && err.at === null) err.at = code.positionAt(tip);
        if (sig.innermost === null && sig.marks === undefined) {
            sig.marks = marks;
            sig.mframe = mframe;
        }
        return sig;
    }
    const f = new Frame(closure, regs, rip, null, ctx, marks, mframe);
    if (code.debug ? !(e instanceof Suspend) : e === derr) f.posIp = dip;
    f.isite = isite;
    if (err instanceof VMError && err.at === null) err.at = errorPos(f);
    sig.push(f);
    return sig;
};

// where an error in `frame` happened
export const errorPos = (frame: Frame | null): SourcePos | null => {
    for (let f = frame; f !== null; f = f.parent) {
        if (!f.code.internal) return f.code.frameAt(f.isite, Math.max((f.posIp !== -1 ? f.posIp : f.ip) - 1, 0)).pos;
    }
    return null;
};
