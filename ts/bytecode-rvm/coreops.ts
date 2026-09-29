// The VM's own operations as intrinsics (CORE_INTRINSICS, the start of every table), and the control requests the control
// operations (and host intrinsics' HostTail) return for the VM to carry out at the call
import { ErrorObject, Msg, MultipleValues, packValues, unpackValues, vmError } from "../common";
import { BARRIER, Caught, ContinuationMarkSet, EXCEPTION_HANDLERS, Handlers, markFirst, markValues } from "../marks";
import type { Marks } from "../marks";
import { CaseLambda, type Closure } from "./bytecode";
import type { VMExecutor } from "./executor";
import { Intrinsics } from "./intrinsics";
import type { InlineFn, IntrinsicFn, IntrinsicOptions } from "./intrinsics";
import { Aborted, Coroutine, DIRECT_SUSPEND_LIMIT, formatTraceback, frameInfos, InterruptError, MAX_NESTED_RESUMES, StackSnapshot, Suspend, WindPoint } from "./values";
import type { ExecutionContext, Frame } from "./values";
// (%debug-frames k args) / (%debug-traceback k args): args is ([coroutine] [msg] [level]), k the caller's continuation
// the frames %debug-frames / %debug-traceback describe: the stack snapshot they are given, or a coroutine's
export const debugTarget = (ctx: ExecutionContext, regs: readonly any[], start: number) => {
    let frames = (regs[start] as StackSnapshot).frames;
    const args = arrayArg("%debug-frames", regs[start + 1]).slice();
    if (args[0] instanceof Coroutine) {
        const co = args.shift() as Coroutine;
        if (co !== ctx.coroutine) frames = frameInfos(co.frame);
    }
    return { frames, args };
};

export const tracebackMessage = (msg: any, print: (v: any) => string): string | undefined => {
    if (msg === undefined) return undefined;
    if (typeof msg === "string") return msg;
    if (msg instanceof ErrorObject) return msg.error instanceof Error ? msg.error.message : String(msg.error);
    if (msg instanceof Error) return msg.message;
    return print(msg);
};

export const markSetArg = (who: string, set: any): Marks => {
    if (!(set instanceof ContinuationMarkSet)) throw vmError(Msg.ExpectedMarkSet, who);
    return set.marks;
};

// What an intrinsic that is not a leaf may return instead of a value: a transfer of control the VM carries out where the
// intrinsic was called (CALLHOST), as if the call site were that operation. The VM carries it out at once, reading its
// fields before running anything else, so the core operations reuse one request of each kind (`of`) rather than
// allocating one per call, which shows in tight coroutine loops. This is how the VM's control operations
// (%call/cc, %raise, the coroutine operations, applying a procedure) are intrinsics rather than opcodes, and how host
// intrinsics call back into the VM (HostTail)
export abstract class ControlRequest {
    // for a request made in tail position, what debug code records as the tail call (see recordTailMark)
    get tailProc(): any {
        return undefined;
    }

    // carried out by heap code, in `frame`, whose ip is already past the call: a non-tail request leaves its value in
    // ctx.acc (read by the MOVEACC that follows), a tail one hands it to frame's caller. Returns the frame to run next
    abstract run(ctx: ExecutionContext, executor: VMExecutor, frame: Frame, isTail: boolean): Frame | null;

    // carried out by direct code, which has no heap frame (its resume point is already recorded): the value, or a Suspend
    // thrown to carry it out on heap frames. HostTail is handled inline in direct code instead
    abstract direct(ctx: ExecutionContext, executor: VMExecutor, closure: Closure, marks: Marks, mframe: number, isTail: boolean): any;
}

// A host intrinsic that is not a leaf may return this instead of a value: the value is then (proc args ...), made as an
// ordinary call (so it can yield, capture continuations and raise)
export class HostTail extends ControlRequest {
    constructor(readonly proc: any, readonly args: any[]) {
        super();
    }

    get tailProc(): any {
        return this.proc;
    }

    run(ctx: ExecutionContext, executor: VMExecutor, frame: Frame, isTail: boolean): Frame | null {
        return executor.invoke(ctx, this.proc, frame, this.args, 0, this.args.length, isTail);
    }

    direct(): any {
        throw Suspend.invoke(this.proc, this.args);
    }
}

export const hostTail = (proc: any, ...args: any[]): HostTail => new HostTail(proc, args);

// (proc regs[from] ... regs[from+count-1]): a call of `proc` with part of an intrinsic's argument window, copied with a
// loop, which on windows this small costs about half of regs.slice plus a spread
export const hostTailFrom = (proc: any, regs: readonly any[], from: number, count: number): HostTail => {
    const args = new Array(count);
    for (let i = 0; i < count; i++) args[i] = regs[from + i];
    return new HostTail(proc, args);
};

// (%call/cc proc)
export class CallCCRequest extends ControlRequest {
    proc: any = undefined;

    static readonly #reused = new CallCCRequest();
    static of(proc: any): CallCCRequest {
        const r = CallCCRequest.#reused;
        r.proc = proc;
        return r;
    }

    get tailProc(): any {
        return this.proc;
    }

    run(ctx: ExecutionContext, executor: VMExecutor, frame: Frame, isTail: boolean): Frame | null {
        return executor.callCC(ctx, this.proc, frame, isTail);
    }

    direct(): any {
        throw Suspend.callCC(this.proc);
    }
}

// (%call/ec proc)
export class EscapeRequest extends ControlRequest {
    proc: any = undefined;

    static readonly #reused = new EscapeRequest();
    static of(proc: any): EscapeRequest {
        const r = EscapeRequest.#reused;
        r.proc = proc;
        return r;
    }

    run(ctx: ExecutionContext, executor: VMExecutor, frame: Frame): Frame | null {
        return executor.callEscape(ctx, this.proc, frame);
    }

    direct(): any {
        throw Suspend.escape(this.proc);
    }
}

// (%call-catching thunk [pre [guarded]]): what %catch compiles to
export class CatchRequest extends ControlRequest {
    proc: any = undefined;
    pre: any = null;
    guarded: boolean = false;

    static readonly #reused = new CatchRequest();
    static of(proc: any, pre: any, guarded: boolean): CatchRequest {
        const r = CatchRequest.#reused;
        r.proc = proc;
        r.pre = pre;
        r.guarded = guarded;
        return r;
    }

    run(ctx: ExecutionContext, executor: VMExecutor, frame: Frame): Frame | null {
        return executor.callCatch(ctx, this.proc, frame, this.pre, this.guarded);
    }

    direct(): any {
        throw Suspend.catching(this.proc, this.pre, this.guarded);
    }
}

// (%call-with-prompt tag thunk handler)
export class PromptRequest extends ControlRequest {
    tag: any = undefined;
    thunk: any = undefined;
    handler: any = undefined;

    static readonly #reused = new PromptRequest();
    static of(tag: any, thunk: any, handler: any): PromptRequest {
        const r = PromptRequest.#reused;
        r.tag = tag;
        r.thunk = thunk;
        r.handler = handler;
        return r;
    }

    run(ctx: ExecutionContext, executor: VMExecutor, frame: Frame, isTail: boolean): Frame | null {
        return executor.callPrompt(ctx, frame, isTail, this.tag, this.thunk, this.handler);
    }

    direct(): any {
        throw Suspend.prompt(this.tag, this.thunk, this.handler);
    }
}

// (%call/comp proc tag)
export class ComposableRequest extends ControlRequest {
    proc: any = undefined;
    tag: any = undefined;

    static readonly #reused = new ComposableRequest();
    static of(proc: any, tag: any): ComposableRequest {
        const r = ComposableRequest.#reused;
        r.proc = proc;
        r.tag = tag;
        return r;
    }

    get tailProc(): any {
        return this.proc;
    }

    run(ctx: ExecutionContext, executor: VMExecutor, frame: Frame, isTail: boolean): Frame | null {
        return executor.callComposable(ctx, this.proc, this.tag, frame, isTail);
    }

    direct(): any {
        throw Suspend.callComposable(this.proc, this.tag);
    }
}

// (%abort tag values)
export class AbortRequest extends ControlRequest {
    tag: any = undefined;
    values: any[] = [];

    static readonly #reused = new AbortRequest();
    static of(tag: any, values: any[]): AbortRequest {
        const r = AbortRequest.#reused;
        r.tag = tag;
        r.values = values;
        return r;
    }

    run(ctx: ExecutionContext, executor: VMExecutor, frame: Frame): Frame | null {
        return executor.abort(ctx, frame, this.tag, this.values);
    }

    direct(): any {
        throw Suspend.abort(this.tag, this.values);
    }
}

// (%coroutine-yield v ...), or hostYield: the values it is resumed with are the value of the call. The core operation is
// never in tail position; a host intrinsic's can be, and then they are its caller's
export class YieldRequest extends ControlRequest {
    val: any = undefined;

    static readonly #reused = new YieldRequest();
    static of(val: any): YieldRequest {
        const r = YieldRequest.#reused;
        r.val = val;
        return r;
    }

    run(ctx: ExecutionContext, executor: VMExecutor, frame: Frame, isTail: boolean): Frame | null {
        return isTail ? executor.coYield(ctx, frame.parent, this.val, frame.marks, frame.mframe) : executor.coYield(ctx, frame, this.val);
    }

    direct(): any {
        throw Suspend.yield(this.val);
    }
}

// A host intrinsic that is not a leaf may return this instead of a value: the coroutine running the call yields `values`,
// and the values it is resumed with are the value of the call
export const hostYield = (...values: any[]): YieldRequest => {
    const r = new YieldRequest();
    r.val = values.length === 1 ? values[0] : packValues(values);
    return r;
};

// An interrupt handler may return this to stop (see Intrinsics.setInterruptHandler): the evaluation ends with an InterruptError
// carrying `value`, which no exception handler or dynamic-wind after-thunk sees
export class InterruptRequest extends ControlRequest {
    constructor(readonly value: any) {
        super();
    }

    run(): Frame | null {
        throw new InterruptError(this.value);
    }

    direct(): any {
        throw new InterruptError(this.value);
    }
}

export const hostInterruptError = (value: any): InterruptRequest => new InterruptRequest(value);

// (%coroutine-resume co v ...), or with `raising`, (%coroutine-raise co obj): args is [obj], raised by the pending yield
export class ResumeRequest extends ControlRequest {
    co: any = undefined;
    args: any[] = [];
    raising: boolean = false;

    static readonly #reused = new ResumeRequest();
    static of(co: any, args: any[], raising: boolean = false): ResumeRequest {
        const r = ResumeRequest.#reused;
        r.co = co;
        r.args = args;
        r.raising = raising;
        return r;
    }

    get tailProc(): any {
        return this.co;
    }

    run(ctx: ExecutionContext, executor: VMExecutor, frame: Frame, isTail: boolean): Frame | null {
        return executor.coResume(ctx, isTail ? frame.parent : frame, this.co, this.args, frame.marks, frame.mframe, this.raising);
    }

    direct(ctx: ExecutionContext, executor: VMExecutor, closure: Closure, marks: Marks, mframe: number, isTail: boolean): any {
        // inside a coroutine, its frames must stay on the heap, where it can be traced while it waits
        if (isTail || ctx.coroutine !== null || executor.nestedResumes >= MAX_NESTED_RESUMES || ++closure.tmpl.code.nestedResumes > DIRECT_SUSPEND_LIMIT) {
            throw Suspend.resume(this.co, this.args, marks, mframe, this.raising);
        }
        return executor.coResumeNested(ctx, this.co, this.args, this.raising);
    }
}

// (%raise obj [continuable]): never in tail position (a continuable raise returns where it was raised)
export class RaiseRequest extends ControlRequest {
    obj: any = undefined;
    continuable: boolean = false;

    static readonly #reused = new RaiseRequest();
    static of(obj: any, continuable: boolean): RaiseRequest {
        const r = RaiseRequest.#reused;
        r.obj = obj; r.continuable = continuable;
        return r;
    }

    run(ctx: ExecutionContext, executor: VMExecutor, frame: Frame): Frame | null {
        return executor.raise(ctx, frame, this.obj, this.continuable);
    }

    direct(ctx: ExecutionContext, executor: VMExecutor, closure: Closure, marks: Marks): any {
        throw Suspend.raise(this.obj, this.continuable, marks);
    }
}

// (%current-stack [skip]): never in tail position (the frames it describes are those of the call)
export class StackRequest extends ControlRequest {
    skip: number = 0;

    static readonly #reused = new StackRequest();
    static of(skip: number): StackRequest {
        const r = StackRequest.#reused;
        r.skip = skip;
        return r;
    }

    run(ctx: ExecutionContext, executor: VMExecutor, frame: Frame): Frame | null {
        ctx.acc = new StackSnapshot(frameInfos(frame, this.skip));
        return frame;
    }

    direct(): any {
        throw Suspend.stack(this.skip);
    }
}

// argument checks of the control operations, shared by their intrinsics and their AOT code (CONTROL_AOT)
export const raiseContinuable = (flag: any): boolean => {
    if (typeof flag !== "boolean") throw vmError(Msg.BadContinuable);
    return flag;
};
export const catchGuard = (flag: any): boolean => {
    if (typeof flag !== "boolean") throw vmError(Msg.CatchGuard);
    return flag;
};
export const stackSkip = (skip: any): number => {
    if (!Number.isInteger(skip) || skip < 0) throw vmError(Msg.BadStackSkip);
    return skip;
};
export const arrayArg = (who: string, val: any): any[] => {
    if (!Array.isArray(val)) throw vmError(Msg.ExpectedArray, who, val);
    return val;
};
// the arguments of an %apply: the window's leading values, then the elements of its last, an array. Always a new array,
// as the last may be a forwarded rest array that is applied again
export const applyArgs = (regs: readonly any[], start: number, nargs: number): any[] => {
    const last = arrayArg("%apply", regs[start + nargs - 1]);
    const args = regs.slice(start, start + nargs - 1);
    for (let i = 0; i < last.length; i++) args.push(last[i]);
    return args;
};

// a one-argument template; the argument is always a register name, so it may be repeated freely
export const unaryInline = (inline: (a: string, d: Readonly<Record<string, string>>) => string): InlineFn =>
    (args, slow, tmp, d) => args.length === 1 ? inline(args[0], d) : null;

// The VM's own operations, as intrinsics: the first entries of every table (see newIntrinsics in core.ts), so each is at
// the same position in all of them, and the compiler and the VM refer to them by that position (corePos). They are
// %-named compiler intrinsics like the core forms, and code may call them directly. `context`: called with the running
// ExecutionContext and VMExecutor
export const CORE_INTRINSICS: Intrinsics = (() => {
    const table = new Intrinsics();
    const deps = { MultipleValues, WindPoint, Caught, EXCEPTION_HANDLERS, Handlers, BARRIER };
    const core = (name: string, args: [number, number], fn: IntrinsicFn, options: Omit<IntrinsicOptions, "args" | "deps"> = {}) =>
        table.register(name, fn, { args, leaf: true, ...options, deps: options.inline === undefined ? undefined : deps });
    // (%coroutine-create proc [finally]): finally is a thunk run when the coroutine, once started, is left for good
    core("%coroutine-create", [1, 2], (regs, start, nargs, ctx, executor) => executor.coCreate(ctx, regs[start], nargs === 2 ? regs[start + 1] : null), { context: true });
    core("%current-coroutine", [1, 1], (regs, start, nargs, ctx) => ctx!.coroutine ?? regs[start], {
        context: true, inline: ([missing]) => `(ctx.coroutine !== null ? ctx.coroutine : ${missing})`,
    });
    core("%coroutine-yieldable?", [0, 0], (regs, start, nargs, ctx) => ctx!.coroutineYieldable, {
        context: true, returns: "boolean", inline: () => `ctx.coroutineYieldable`,
    });
    core("%coroutine-status", [1, 1], (regs, start, nargs, ctx, executor) => executor.coStatus(regs[start]), { context: true });
    // closing a coroutine runs its dynamic-wind after-thunks
    core("%coroutine-close", [1, 1], (regs, start, nargs, ctx, executor) => { executor.coClose(ctx, regs[start]); }, { context: true, leaf: false });
    core("%wind", [2, 2], (regs, start, nargs, ctx) => { ctx.wind = new WindPoint(ctx.wind, regs[start], regs[start + 1]); }, {
        context: true, inline: ([before, after], slow, tmp, d) => `(ctx.wind = new ${d.WindPoint}(ctx.wind, ${before}, ${after}), undefined)`,
    });
    core("%end-wind", [0, 0], (regs, start, nargs, ctx) => { if (ctx.wind !== null) ctx.wind = ctx.wind.parent; }, {
        context: true, inline: () => `(ctx.wind !== null && (ctx.wind = ctx.wind.parent), undefined)`,
    });
    core("%caught?", [1, 1], (regs, start) => regs[start] instanceof Caught, { inline: unaryInline((v, d) => `${v} instanceof ${d.Caught}`) });
    core("%caught-value", [1, 1], (regs, start) => regs[start].error, { inline: unaryInline(v => `${v}.error`) });
    core("%make-caught", [1, 1], (regs, start) => new Caught(regs[start]), { inline: unaryInline((v, d) => `new ${d.Caught}(${v})`) });
    core("%handler-key", [0, 0], () => EXCEPTION_HANDLERS, { inline: (args, slow, tmp, d) => d.EXCEPTION_HANDLERS });
    core("%barrier-key", [0, 0], () => BARRIER, { inline: (args, slow, tmp, d) => d.BARRIER });
    // (%push-handler handler handlers): the handlers mark with handler innermost
    core("%push-handler", [2, 2], (regs, start) => new Handlers(regs[start], regs[start + 1]), {
        inline: ([h, outer], slow, tmp, d) => `(${outer} === null || ${outer} instanceof ${d.Handlers} ? new ${d.Handlers}(${h}, ${outer}) : ${slow})`,
    });
    core("%values-cons", [2, 2], (regs, start) => {
        const vals = regs[start + 1];
        return new MultipleValues([regs[start], ...(vals instanceof MultipleValues ? vals.values : [vals])]);
    }, { inline: ([x, v], slow, tmp, d) => `(${v} instanceof ${d.MultipleValues} ? new ${d.MultipleValues}([${x}, ...${v}.values]) : new ${d.MultipleValues}([${x}, ${v}]))` });
    core("%make-case-lambda", [1, Infinity], (regs, start, nargs) => new CaseLambda(regs.slice(start, start + nargs)));
    core("%values", [0, Infinity], (regs, start, nargs) => packValues(regs.slice(start, start + nargs)));
    core("%values->array", [1, 1], (regs, start) => unpackValues(regs[start]).slice());
    core("%debug-frames", [3, 3], (regs, start, nargs, ctx) => {
        const { frames, args } = debugTarget(ctx, regs, start);
        const level = typeof args[0] === "number" ? args[0] : 0;
        const missing = regs[start + 2];
        return frames.slice(level).map(f => [f.name, f.pos?.file ?? missing, f.pos?.line ?? missing, f.pos?.col ?? missing]);
    }, { context: true });
    core("%debug-traceback", [2, 2], (regs, start, nargs, ctx) => {
        const { frames, args } = debugTarget(ctx, regs, start);
        const msg = typeof args[0] === "number" ? undefined : args.shift();
        const level = typeof args[0] === "number" ? args[0] : 0;
        return formatTraceback(frames.slice(level), tracebackMessage(msg, v => ctx!.vm.print(v)), ctx!.vm.intrinsics.format);
    }, { context: true });
    // Lua's truncation of multiple values to one: the first value, or `missing` for none
    core("%first-value", [2, 2], (regs, start) => {
        const val = regs[start];
        return val instanceof MultipleValues ? (val.values.length > 0 ? val.values[0] : regs[start + 1]) : val;
    }, { inline: ([v, missing], slow, tmp, d) => `(${v} instanceof ${d.MultipleValues} ? (${v}.values.length > 0 ? ${v}.values[0] : ${missing}) : ${v})` });
    // (%marks-first set key missing) / (%marks->array set key): continuation-mark-set-first / its values, innermost first
    core("%marks-first", [3, 3], (regs, start) => markFirst(markSetArg("continuation-mark-set-first", regs[start]), regs[start + 1], regs[start + 2]));
    core("%marks->array", [2, 2], (regs, start) => markValues(markSetArg("continuation-mark-set->list", regs[start]), regs[start + 1]));

    // Control operations: not leaves, they return a ControlRequest the VM carries out at the call. Those whose value is
    // that of the call itself (`tail: false`) are never compiled as tail calls
    const control = (name: string, args: [number, number], fn: IntrinsicFn, tail: boolean = true) => core(name, args, fn, { leaf: false, tail });
    // regs[from .. to) as a new array: a loop, as slicing a frame's registers is several times slower on these windows
    const copyWindow = (regs: any[], from: number, to: number): any[] => {
        const out: any[] = [];
        for (let i = from; i < to; i++) out.push(regs[i]);
        return out;
    };
    control("%call/cc", [1, 1], (regs, start) => CallCCRequest.of(regs[start]));
    control("%call/ec", [1, 1], (regs, start) => EscapeRequest.of(regs[start]), false);
    control("%call-catching", [1, 3], (regs, start, nargs) => CatchRequest.of(regs[start], nargs >= 2 ? regs[start + 1] : null, nargs === 3 ? catchGuard(regs[start + 2]) : false), false);
    control("%coroutine-yield", [0, Infinity], (regs, start, nargs) => YieldRequest.of(nargs === 1 ? regs[start] : packValues(copyWindow(regs, start, start + nargs))), false);
    control("%coroutine-resume", [1, Infinity], (regs, start, nargs) => ResumeRequest.of(regs[start], copyWindow(regs, start + 1, start + nargs)));
    control("%coroutine-resume-array", [2, 2], (regs, start) => ResumeRequest.of(regs[start], arrayArg("%coroutine-resume-array", regs[start + 1]).slice()));
    control("%coroutine-raise", [2, 2], (regs, start) => ResumeRequest.of(regs[start], [regs[start + 1]], true));
    control("%raise", [1, 2], (regs, start, nargs) => RaiseRequest.of(regs[start], nargs === 2 ? raiseContinuable(regs[start + 1]) : false), false);
    control("%current-stack", [0, 1], (regs, start, nargs) => StackRequest.of(nargs === 1 ? stackSkip(regs[start]) : 0), false);
    // delimited continuations: a prompt's body gives its value to %prompt-finish, or an abort to it an Aborted, whose
    // values its handler is then called with
    control("%call-with-prompt", [3, 3], (regs, start) => PromptRequest.of(regs[start], regs[start + 1], regs[start + 2]));
    control("%call/comp", [2, 2], (regs, start) => ComposableRequest.of(regs[start], regs[start + 1]));
    control("%abort", [2, 2], (regs, start) => AbortRequest.of(regs[start], arrayArg("%abort", regs[start + 1]).slice()));
    core("%prompt-finish", [2, 2], (regs, start) => {
        const res = regs[start + 1];
        return res instanceof Aborted ? new HostTail(regs[start], res.values) : res;
    }, { leaf: false });
    // an interrupt check (see Intrinsics.setInterruptHandler), which the compiler puts in code itself; AOT code inlines the count
    core("%interrupt", [0, 0], (regs, start, nargs, ctx, executor) => executor.interrupt(ctx), { context: true, leaf: false, tail: false });
    // (%apply proc arg ... array) compiles to these: %apply-fresh when the array is a new one nothing else holds
    control("%apply-array", [2, Infinity], (regs, start, nargs) => new HostTail(regs[start], applyArgs(regs, start + 1, nargs - 1)));
    control("%apply-fresh", [2, 2], (regs, start) => new HostTail(regs[start], arrayArg("%apply", regs[start + 1])));
    return table.freeze();
})();

// how many core operations there are: positions below this are theirs in every table
export const CORE_COUNT = CORE_INTRINSICS.entries.length;

// the position of a core operation the compiler or the VM emits itself
export const corePos = (name: string): number => {
    const entry = CORE_INTRINSICS.byName(name);
    if (entry === undefined) throw new Error(`internal error: no core operation '${name}'`);
    return entry.pos;
};


// an intrinsic's argument count checked at run time (for APPLYINT, whose count the compiler cannot know)
export const applyIntrinsic = (fn: IntrinsicFn, name: string, min: number, max: number, args: any[], ctx: ExecutionContext, executor: VMExecutor): any => {
    if (args.length < min || args.length > max) throw vmError(Msg.Arity, name, min, max, args.length);
    return fn(args, 0, args.length, ctx, executor);
};
