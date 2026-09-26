// The VM's own operations as intrinsics (CORE_INTRINSICS, the start of every table), and the control requests the control
// operations (and host intrinsics' HostTail) return for the VM to carry out at the call
import { ASTStringifier, ErrorObject, MultipleValues, packValues } from "../common";
import { hostError } from "../errors";
import { Cons } from "../list";
import { Caught, ContinuationMarkSet, EXCEPTION_HANDLERS, markFirst, markValues } from "../marks";
import type { Marks } from "../marks";
import { arityMessage } from "./arity";
import type { Closure } from "./bytecode";
import type { VMExecutor } from "./executor";
import { Intrinsics } from "./intrinsics";
import type { InlineFn, IntrinsicFn, IntrinsicOptions } from "./intrinsics";
import { applyArgsList, listToArray, listToValues, makeList, valuesToList, windowApplyArgs, windowRestArgs } from "./lists";
import { Coroutine, DIRECT_SUSPEND_LIMIT, MAX_NESTED_RESUMES, StackSnapshot, Suspend, WindPoint, formatTraceback, frameInfos } from "./values";
import type { ExecutionContext, Frame } from "./values";
// (%debug-frames k args) / (%debug-traceback k args): args is ([coroutine] [msg] [level]), k the caller's continuation
// the frames %debug-frames / %debug-traceback describe: the stack snapshot they are given, or a coroutine's
export const debugTarget = (ctx: ExecutionContext, regs: readonly any[], start: number) => {
    let frames = (regs[start] as StackSnapshot).frames;
    const args = listToArray(regs[start + 1]);
    if (args[0] instanceof Coroutine) {
        const co = args.shift() as Coroutine;
        if (co !== ctx.coroutine) frames = frameInfos(co.frame);
    }
    return { frames, args };
};

export const tracebackMessage = (msg: any): string | undefined => {
    if (msg === undefined) return undefined;
    if (typeof msg === "string") return msg;
    if (msg instanceof ErrorObject) return msg.error instanceof Error ? msg.error.message : String(msg.error);
    if (msg instanceof Error) return msg.message;
    return new ASTStringifier().stringify(msg);
};

export const markSetArg = (who: string, set: any): Marks => {
    if (!(set instanceof ContinuationMarkSet)) throw hostError(`${who}: expected a continuation mark set`);
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

// (%coroutine-yield v ...): never in tail position (the value it is resumed with is the value of the call)
export class YieldRequest extends ControlRequest {
    val: any = undefined;

    static readonly #reused = new YieldRequest();
    static of(val: any): YieldRequest {
        const r = YieldRequest.#reused;
        r.val = val;
        return r;
    }

    run(ctx: ExecutionContext, executor: VMExecutor, frame: Frame): Frame | null {
        return executor.coYield(ctx, frame, this.val);
    }

    direct(): any {
        throw Suspend.yield(this.val);
    }
}

// (%coroutine-resume co v ...)
export class ResumeRequest extends ControlRequest {
    co: any = undefined;
    args: any[] = [];

    static readonly #reused = new ResumeRequest();
    static of(co: any, args: any[]): ResumeRequest {
        const r = ResumeRequest.#reused;
        r.co = co;
        r.args = args;
        return r;
    }

    get tailProc(): any {
        return this.co;
    }

    run(ctx: ExecutionContext, executor: VMExecutor, frame: Frame, isTail: boolean): Frame | null {
        return executor.coResume(ctx, isTail ? frame.parent : frame, this.co, this.args, frame.marks, frame.mframe);
    }

    direct(ctx: ExecutionContext, executor: VMExecutor, closure: Closure, marks: Marks, mframe: number, isTail: boolean): any {
        // inside a coroutine, its frames must stay on the heap, where it can be traced while it waits
        if (isTail || ctx.coroutine !== null || executor.nestedResumes >= MAX_NESTED_RESUMES || ++closure.tmpl.code.nestedResumes > DIRECT_SUSPEND_LIMIT) {
            throw Suspend.resume(this.co, this.args, marks, mframe);
        }
        return executor.coResumeNested(ctx, this.co, this.args);
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
    if (typeof flag !== "boolean") throw hostError("%raise: continuable must be #t or #f");
    return flag;
};
export const stackSkip = (skip: any): number => {
    if (!Number.isInteger(skip) || skip < 0) throw hostError("%current-stack: expected a count of frames to skip");
    return skip;
};
export const restArrayArgs = (regs: readonly any[], start: number, nargs: number, multi: boolean): any[] => {
    if (!Array.isArray(regs[start + nargs - 1])) throw hostError("%apply-array: the last argument must be a rest array");
    return windowRestArgs(regs, start, nargs, multi);
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
    const deps = { Cons, MultipleValues, WindPoint, Caught, EXCEPTION_HANDLERS };
    const core = (name: string, args: [number, number], fn: IntrinsicFn, options: Omit<IntrinsicOptions, "args" | "deps"> = {}) =>
        table.register(name, fn, { args, leaf: true, ...options, deps: options.inline === undefined ? undefined : deps });
    core("%coroutine-create", [1, 1], (regs, start, nargs, ctx, executor) => executor.coCreate(ctx, regs[start]), { context: true });
    core("%coroutine-status", [1, 1], (regs, start, nargs, ctx, executor) => executor.coStatus(regs[start]), { context: true });
    // closing a coroutine runs its dynamic-wind after-thunks
    core("%coroutine-close", [1, 1], (regs, start, nargs, ctx, executor) => { executor.coClose(ctx, regs[start]); }, { context: true, leaf: false });
    core("%wind", [2, 2], (regs, start, nargs, ctx) => { ctx.wind = new WindPoint(ctx.wind, regs[start], regs[start + 1]); }, {
        context: true, inline: ([before, after], slow, tmp, d) => `(ctx.wind = new ${d.WindPoint}(ctx.wind, ${before}, ${after}), undefined)`,
    });
    core("%end-wind", [0, 0], (regs, start, nargs, ctx) => { if (ctx.wind !== null) ctx.wind = ctx.wind.parent; }, {
        context: true, inline: () => `(ctx.wind !== null && (ctx.wind = ctx.wind.parent), undefined)`,
    });
    core("%end-escape", [1, 1], () => undefined, { inline: () => `undefined` });
    core("%caught?", [1, 1], (regs, start) => regs[start] instanceof Caught, { inline: unaryInline((v, d) => `${v} instanceof ${d.Caught}`) });
    core("%caught-value", [1, 1], (regs, start) => regs[start].error, { inline: unaryInline(v => `${v}.error`) });
    core("%make-caught", [1, 1], (regs, start) => new Caught(regs[start]), { inline: unaryInline((v, d) => `new ${d.Caught}(${v})`) });
    core("%handler-key", [0, 0], () => EXCEPTION_HANDLERS, { inline: (args, slow, tmp, d) => d.EXCEPTION_HANDLERS });
    core("%values-cons", [2, 2], (regs, start) => {
        const vals = regs[start + 1];
        return new MultipleValues([regs[start], ...(vals instanceof MultipleValues ? vals.values : [vals])]);
    }, { inline: ([x, v], slow, tmp, d) => `(${v} instanceof ${d.MultipleValues} ? new ${d.MultipleValues}([${x}, ...${v}.values]) : new ${d.MultipleValues}([${x}, ${v}]))` });
    core("%list", [0, Infinity], (regs, start, nargs) => makeList(regs, start, nargs), {
        inline: (args, slow, tmp, d) => args.reduceRight((tail, arg) => `new ${d.Cons}(${arg}, ${tail})`, "null"),
    });
    core("%values", [0, Infinity], (regs, start, nargs) => packValues(regs.slice(start, start + nargs)));
    core("%values->list", [1, 1], (regs, start, nargs) => valuesToList(regs, start, nargs));
    core("%list->values", [1, 1], (regs, start, nargs) => listToValues(regs, start, nargs));
    core("%apply-args", [1, 1], (regs, start, nargs) => applyArgsList(regs, start, nargs));
    core("%debug-frames", [2, 2], (regs, start, nargs, ctx) => {
        const { frames, args } = debugTarget(ctx, regs, start);
        const level = typeof args[0] === "number" ? args[0] : 0;
        return Cons.fromArray(frames.slice(level).map(f => [f.name, f.pos?.file ?? false, f.pos?.line ?? false, f.pos?.col ?? false]));
    }, { context: true });
    core("%debug-traceback", [2, 2], (regs, start, nargs, ctx) => {
        const { frames, args } = debugTarget(ctx, regs, start);
        const msg = typeof args[0] === "number" ? undefined : args.shift();
        const level = typeof args[0] === "number" ? args[0] : 0;
        return formatTraceback(frames.slice(level), tracebackMessage(msg));
    }, { context: true });
    // Lua's truncation of multiple values to one: the first value, or <#void> for none
    core("%first-value", [1, 1], (regs, start) => {
        const val = regs[start];
        return val instanceof MultipleValues ? val.values[0] : val;
    }, { inline: unaryInline((v, d) => `(${v} instanceof ${d.MultipleValues} ? ${v}.values[0] : ${v})`) });
    // (%marks-first set key none) / (%marks->list set key): continuation-mark-set-first / ->list
    core("%marks-first", [3, 3], (regs, start) => markFirst(markSetArg("continuation-mark-set-first", regs[start]), regs[start + 1], regs[start + 2]));
    core("%marks->list", [2, 2], (regs, start) => Cons.fromArray(markValues(markSetArg("continuation-mark-set->list", regs[start]), regs[start + 1])));

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
    control("%coroutine-yield", [0, Infinity], (regs, start, nargs) => YieldRequest.of(nargs === 1 ? regs[start] : packValues(copyWindow(regs, start, start + nargs))), false);
    control("%coroutine-yield-list", [1, 1], (regs, start, nargs) => YieldRequest.of(listToValues(regs, start, nargs)), false);
    control("%coroutine-resume", [1, Infinity], (regs, start, nargs) => ResumeRequest.of(regs[start], copyWindow(regs, start + 1, start + nargs)));
    control("%coroutine-resume-list", [2, 2], (regs, start) => ResumeRequest.of(regs[start], listToArray(regs[start + 1])));
    control("%raise", [1, 2], (regs, start, nargs) => RaiseRequest.of(regs[start], nargs === 2 ? raiseContinuable(regs[start + 1]) : false), false);
    control("%current-stack", [0, 1], (regs, start, nargs) => StackRequest.of(nargs === 1 ? stackSkip(regs[start]) : 0), false);
    // applying a procedure ((%apply proc arg ... lst) and %apply-multi compile to these): (proc arg ... last), where
    // last is a list, a forwarded rest array (see ClosureTemplate.restArray), or for %apply-multi a rest array whose own
    // last element is a list
    control("%apply-list", [2, Infinity], (regs, start, nargs) => new HostTail(regs[start], windowApplyArgs(regs, start + 1, nargs - 1)));
    control("%apply-array", [2, Infinity], (regs, start, nargs) => new HostTail(regs[start], restArrayArgs(regs, start + 1, nargs - 1, false)));
    control("%apply-array-multi", [2, 2], (regs, start, nargs) => new HostTail(regs[start], restArrayArgs(regs, start + 1, nargs - 1, true)));
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
    if (args.length < min || args.length > max) throw hostError(arityMessage(name, min, max, args.length));
    return fn(args, 0, args.length, ctx, executor);
};
