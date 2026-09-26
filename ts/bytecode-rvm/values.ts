// The VM's runtime values and state: frames, execution contexts, wind points, continuations, coroutines, catch tokens,
// stack snapshots, and Suspend (how direct code hands control to heap frames)
import { ErrorObject, IProcedure, OpaqueValue, formatPos, unpackValues } from "../common";
import type { Env, SourcePos } from "../common";
import { hostError } from "../errors";
import { Cons } from "../list";
import { Caught, EXCEPTION_HANDLERS, TAIL_TRAIL, markFirst, markOwn } from "../marks";
import type { Marks, TailTrail } from "../marks";
import type { ByteCode, Closure, VMHost } from "./bytecode";
import type { VMExecutor } from "./executor";
import { UNPACK_REST, UNPACK_STRICT } from "./opcodes";

// the values of `val` for UNPACK: checks the count when strict; missing values read as undefined (<#void>)
export const unpackForBinding = (val: any, count: number, flags: number): any[] => {
    const vals = unpackValues(val);
    if ((flags & UNPACK_STRICT) !== 0 && ((flags & UNPACK_REST) !== 0 ? vals.length < count : vals.length !== count)) {
        throw hostError(`let-values: expected ${(flags & UNPACK_REST) !== 0 ? "at least " : ""}${count} value${count === 1 ? "" : "s"} but got ${vals.length}`);
    }
    return vals;
};

export const restValues = (vals: any[], count: number): Cons | null => Cons.fromArray(vals.slice(count));

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
    public coroutine: Coroutine | null = null;
    // a throwaway resumer for nested resumes: control coming back here ends the nested driver loop
    public barrier: boolean = false;

    constructor(
        public vm: VMHost,
        public scope: Env
    ) {
        this.id = ++ExecutionContext.nextId;
    }
}

// how debug code names a tail-called procedure in the tail-call trails
export const tailName = (proc: any): string =>
    proc instanceof IProcedure ? proc.debugName ?? "?" : proc instanceof OpaqueValue ? proc.typeName : String(proc);

export type CoroutineStatus = "suspended" | "running" | "normal" | "dead";

export class Coroutine extends OpaqueValue {
    public status: CoroutineStatus = "suspended";
    public started: boolean = false;
    public closing: boolean = false;
    public frame: Frame | null = null;
    // `marks`/`mframe`: those of the code that resumed it (a tail resume's frame is gone), where its errors are raised again
    public resumer: { ctx: ExecutionContext, frame: Frame | null, marks: Marks, mframe: number } | null = null;
    public readonly ctx: ExecutionContext;

    constructor(public readonly proc: any, vm: VMHost, scope: Env) {
        super();
        this.ctx = new ExecutionContext(vm, scope);
        this.ctx.coroutine = this;
    }

    get typeName() {
        return "coroutine";
    }
}

// an error that escaped a coroutine, raised again in the resumer as-is
export class ReRaise {
    constructor(public readonly value: any, public readonly marks: Marks | undefined = undefined, public readonly mframe: number = 0) {}
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
export const countControlSuspend = (code: ByteCode): void => {
    if (++code.controlSuspends === DIRECT_SUSPEND_LIMIT) {
        code.directArity = -1;
        code.directRestArity = -1;
    }
};

// an escape-only continuation (call/ec), usable until its %call/ec returns. The %call/ec's frame is the one of `code`
// holding this in register `reg` (cleared when it returns); a direct-mode %call/ec catches escapes to it itself
export class EscapeContinuation extends IProcedure {
    constructor(public readonly ctxId: number, public readonly wind: WindPoint | null, public readonly code: ByteCode, public readonly reg: number) {
        super("escape continuation");
    }

    // the frame to return to, found among `from` and its callers; copies made by call/cc hold it too
    target(from: Frame | null): Frame | null {
        for (let f = from; f !== null; f = f.parent) {
            if (f.code === this.code && f.regs[this.reg] === this) return f;
        }
        return null;
    }
}

// the handler a %catch installs: raising to it escapes to the %catch with the error wrapped in a Caught
export class CatchToken extends EscapeContinuation {
    constructor(ctxId: number, wind: WindPoint | null, code: ByteCode, reg: number, public readonly pre: any = null) {
        super(ctxId, wind, code, reg);
    }
}


// the value of a caught error, as handlers see it
export const caughtValue = (err: any): any =>
    err instanceof ReRaise ? (err.value instanceof Error ? new ErrorObject(err.value) : err.value) : err instanceof ErrorObject ? err : new ErrorObject(err);

// what a direct-mode %catch whose token is `tok` takes from an exception passing through it, or null to let it go on:
// its own escapes, and errors whose innermost handler is `tok` (so nothing else would see them) and which leave no
// dynamic-wind to unwind
export const catchHere = (e: any, tok: CatchToken, ctx: ExecutionContext): any => {
    if (ctx.wind !== tok.wind) return null;
    if (e instanceof Suspend && e.escape === tok) return e.escapeVal;
    // a pre-unwind handler has to run first, in heap code
    if (tok.pre !== null) return null;
    if (!(e instanceof Suspend)) return e instanceof EscapedError ? null : new Caught(caughtValue(e));
    if (e.action !== null) return null;
    const marks = e.marks !== undefined ? e.marks : e.innermost !== null ? e.innermost.marks : undefined;
    if (marks === undefined) return null;
    const handlers = markFirst(marks, EXCEPTION_HANDLERS, null);
    return handlers instanceof Cons && handlers.car === tok ? new Caught(caughtValue(e.error)) : null;
};

export class Frame {
    public code: ByteCode;
    public upvars: any[];
    public epoch: number;
    // exact position of the last instruction run, when debug code knows it better than ip
    public posIp: number = -1;

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

    thaw(ctx: ExecutionContext): Frame {
        return new Frame(this.closure, this.regs.slice(), this.ip, this.parent, ctx, this.marks, this.mframe);
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
    // the marks where it was thrown, when that was a tail call (which rebuilds no frame): errors are raised with them
    marks: Marks | undefined = undefined;
    mframe: number = 0;

    // `control`: suspended for call/cc, invoking a continuation, a yield or a coroutine resume, rather than for depth or an error
    constructor(public readonly action: SuspendAction | null, public readonly error?: any, public readonly control: boolean = false) {}

    push(frame: Frame) {
        if (this.outermost === null) {
            this.innermost = frame;
        } else {
            this.outermost.parent = frame;
        }
        this.outermost = frame;
    }

    static invoke(proc: any, args: any[]) {
        const escape = proc instanceof EscapeContinuation;
        const sig = new Suspend((ctx, executor, caller, sig) => executor.invoke(ctx, proc, caller, args, 0, args.length, false, sig.marks, sig.mframe), undefined, escape || proc instanceof VMContinuation);
        if (escape && args.length === 1) {
            sig.escape = proc;
            sig.escapeVal = args[0];
        }
        return sig;
    }

    // raising from direct code: an escape when the innermost handler is a plain catch token (which a direct %catch
    // further out can take), else delivered from heap frames
    static raise(obj: any, continuable: boolean, marks: Marks) {
        const sig = new Suspend((ctx, executor, caller) => executor.raise(ctx, caller, obj, continuable), undefined, true);
        const handlers = markFirst(marks, EXCEPTION_HANDLERS, null);
        if (handlers instanceof Cons && handlers.car instanceof CatchToken && handlers.car.pre === null) {
            sig.escape = handlers.car;
            sig.escapeVal = new Caught(obj);
        }
        return sig;
    }

    // direct code taking a snapshot of the stack: its frames are rebuilt, and the snapshot is the value. Code that keeps
    // doing it is better off on heap frames, where a snapshot needs no rebuilding, so it counts like a control transfer
    static stack(skip: number) {
        return new Suspend((ctx, executor, caller) => executor.setRetVal(ctx, caller, new StackSnapshot(frameInfos(caller, skip))), undefined, true);
    }

    static callCC(proc: any) {
        return new Suspend((ctx, executor, caller, sig) => executor.callCC(ctx, proc, caller, false, sig.marks, sig.mframe), undefined, true);
    }

    static error(err: any) {
        return new Suspend(null, err);
    }

    static resume(co: any, args: any[], marks: Marks, mframe: number) {
        return new Suspend((ctx, executor, caller) => executor.coResume(ctx, caller, co, args, marks, mframe), undefined, true);
    }

    static yield(val: any) {
        return new Suspend((ctx, executor, caller) => executor.coYield(ctx, caller, val), undefined, true);
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

export const frameInfos = (frame: Frame | null, level: number = 0): FrameInfo[] => {
    const out: FrameInfo[] = [];
    for (let f = frame, i = 0; f !== null; f = f.parent, i++) {
        if (i >= level) out.push({
            name: f.debugName,
            pos: f.code.positionAt(Math.max((f.posIp !== -1 ? f.posIp : f.ip) - 1, 0)),
            tails: markOwn(f.marks, f.mframe, TAIL_TRAIL, null),
        });
    }
    return out;
};

export const formatTraceback = (frames: FrameInfo[], msg?: string): string => {
    const tails = (t: TailTrail | null) => t === null || t.length === 0 ? "" :
        ` (tail calls: ${t.map(c => c.count > 1 ? `${c.name} x${c.count}` : c.name).reverse().join(" <- ")})`;
    const lines = frames.map(f => `\n  ${formatPos(f.pos)} in ${f.name}${tails(f.tails)}`).join("");
    return `${msg !== undefined ? msg + "\n" : ""}stack traceback:${lines}`;
};
