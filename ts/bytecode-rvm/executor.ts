// VMExecutor: calls, returns, continuations, dynamic-wind, exception delivery and coroutines, and the driver loop that
// runs heap frames through the interpreter or AOT code
import { Env, ErrorObject, IProcedure, Msg, UnhandledError, VMError, packValues, vmError } from "../common";
import { BARRIER, Caught, EXCEPTION_HANDLERS, Handlers, MarkEntry, markFirst, markSet, reentersBarrier } from "../marks";
import type { Marks } from "../marks";
import { AotCompiler } from "./aot/compiler";
import { bindArgs, checkArity } from "./arity";
import { ByteCode, CaseLambda, Closure, ClosureTemplate, createRegs } from "./bytecode";
import type { VMHost } from "./bytecode";
import { CORE_INTRINSICS, corePos, tracebackMessage } from "./coreops";
import { BytecodeInterpreter, OpCode } from "./interpreter";
import { INSTRUCTION_LENGTHS, INTRINSIC_OPERANDS } from "./opcodes";
import { Aborted, CatchToken, ComposableContinuation, Coroutine, EscapeContinuation, EscapedError, ExecutionContext, Frame, MAX_JS_DEPTH, ReRaise, Suspend, VMContinuation, WindPoint, caughtValue, mapWind, computeWindTransition, countControlSuspend, errorPos, formatTraceback, frameInfos } from "./values";

// Frames the VM puts under a handler it calls: `handlerReturned` raises the secondary error when the handler of a
// non-continuable raise returns (its marks hold the outer handlers); `escapeWith` escapes to the catch token in its
// register 0 with what a pre-unwind handler returned. `coroutineFinally` is under the procedure of a coroutine with a
// finally thunk (in its register 1): it leaves the thunk's wind and calls it, then returns the procedure's value
export let helpers: { handlerReturned: Closure, escapeWith: Closure, prompt: Closure, coroutineFinally: Closure } | null = null;
export const raiseHelpers = () => helpers ??= {
    handlerReturned: helperClosure(1, [new ErrorObject(vmError(Msg.HandlerReturned))], [
        OpCode.LOADCONST, 0, 0,
        OpCode.CALLHOST, corePos("%raise"), 0, 1, 0,
        OpCode.RETURN, 0,
    ]),
    escapeWith: helperClosure(3, [], [
        OpCode.MOVEACC, 1,
        OpCode.CALLINT, corePos("%make-caught"), 2, 1, 1,
        OpCode.CALL, 0, 2, 1, 1,
    ]),
    // a prompt (%call-with-prompt): r0 the tag, r1 the body thunk, r2 the handler, r4 the wind it was installed in. The
    // body's value, or what an abort to it hands it (an Aborted), goes to %prompt-finish, in tail position
    prompt: helperClosure(5, [], [
        OpCode.CALL, 1, 3, 0, 0,
        OpCode.MOVEACC, 3,
        OpCode.CALLHOST, corePos("%prompt-finish"), 2, 2, 1,
    ], "prompt"),
    coroutineFinally: helperClosure(3, [], [
        OpCode.MOVEACC, 0,
        OpCode.CALLCTX, corePos("%end-wind"), 2, 0, 0,
        OpCode.CALL, 1, 0, 0, 0,
        OpCode.RETURN, 0,
    ], "coroutine-finally"),
};
export const helperClosure = (numReg: number, constants: any[], inst: number[], name: string = "raise"): Closure => {
    const positions = new Set<number>();
    for (let ip = 0; ip < inst.length; ip += INSTRUCTION_LENGTHS[inst[ip]]) for (const off of INTRINSIC_OPERANDS[inst[ip]]) positions.add(inst[ip + off]);
    const used = [...positions].map(pos => CORE_INTRINSICS.entries[pos]).map(({ pos, name, leaf }) => ({ pos, name, leaf }));
    const code = new ByteCode(constants, new Uint32Array(inst), numReg, undefined, undefined, false, CORE_INTRINSICS, used);
    code.internal = true;
    return new Closure(new ClosureTemplate([], null, code, [], name), [], name);
};

export class VMExecutor {
    public nestedResumes: number = 0;

    constructor(public vm: VMHost) {}

    // --- call protocol ---

    public enter(ctx: ExecutionContext, frame: Frame): Frame {
        if (frame.isShared(ctx)) {
            frame = frame.thaw(ctx);
        }
        return frame;
    }

    public invoke(
        ctx: ExecutionContext,
        proc: any,
        callerFrame: Frame | null,
        callerArgs: any[],
        startReg: number,
        nargs: number,
        isTail: boolean,
        // for a tail call made by direct code that left no frame: the marks and logical frame the callee continues
        marks?: Marks,
        mframe: number = 0
    ): Frame | null {
        const returnTo = (isTail && callerFrame !== null) ? callerFrame.parent : callerFrame;

        if (proc instanceof CaseLambda) proc = proc.select(nargs);
        if (proc instanceof Closure) {
            const pregs = this.createClosureArg(proc, nargs, callerArgs, startReg);
            if (marks !== undefined) return this.newFrame(ctx, proc, pregs, returnTo, marks, mframe);
            if (isTail && callerFrame !== null && !callerFrame.isShared(ctx)) {
                return this.reset(callerFrame, proc, pregs);
            }
            // a tail call continues its caller's logical frame, so it keeps its marks
            if (callerFrame === null) return this.newFrame(ctx, proc, pregs, returnTo);
            return this.newFrame(ctx, proc, pregs, returnTo, callerFrame.marks, isTail ? callerFrame.mframe : callerFrame.mframe + 1);
        }

        if (proc instanceof ComposableContinuation) {
            const val = nargs === 1 ? callerArgs[startReg] : packValues(callerArgs.slice(startReg, startReg + nargs));
            if (marks !== undefined) return this.#compose(ctx, proc, returnTo, marks, mframe, val);
            if (callerFrame === null) return this.#compose(ctx, proc, null, null, 0, val);
            return this.#compose(ctx, proc, returnTo, callerFrame.marks, isTail ? callerFrame.mframe : callerFrame.mframe + 1, val);
        }

        if (proc instanceof VMContinuation) {
            if (proc.ctxId !== ctx.id) {
                throw vmError(Msg.ContinuationBoundary);
            }
            if (nargs !== 1) throw vmError(Msg.ContinuationArgs, nargs);
            if (proc.frame !== null && reentersBarrier(proc.frame.marks, marks ?? callerFrame?.marks ?? null)) throw vmError(Msg.BarrierReentry);

            return this.#jumpTo(ctx, proc.frame, proc.wind, callerArgs[startReg]);
        }

        if (proc instanceof EscapeContinuation) {
            if (proc.ctxId !== ctx.id) {
                throw vmError(Msg.EscapeBoundary);
            }
            if (nargs !== 1) throw vmError(Msg.EscapeArgs, nargs);
            const target = proc.target(callerFrame);
            if (target === null) throw vmError(Msg.EscapeOutsideExtent);
            return this.#jumpTo(ctx, target, mapWind(target, proc.wind), callerArgs[startReg]);
        }

        throw vmError(Msg.NonProcedure, proc);
    }

    #jumpTo(ctx: ExecutionContext, frame: Frame | null, wind: WindPoint | null, val: any): Frame | null {
        if (ctx.wind === wind) {
            ctx.acc = val;
            return this.setRetVal(ctx, frame, val);
        }
        ctx.pendingWind = {
            actions: computeWindTransition(ctx.wind, wind),
            actionIdx: 0,
            targetFrame: frame,
            targetVal: val,
            targetWind: wind,
        };
        return this.advanceWindTransition(ctx);
    }

    public apply(ctx: ExecutionContext, proc: any, frame: Frame, args: any[], isTail: boolean): Frame | null {
        return this.invoke(ctx, proc, frame, args, 0, args.length, isTail);
    }

    public setRetVal(ctx: ExecutionContext, frame: Frame | null, val: any): Frame | null {
        // a finished coroutine hands its value to its resumer, which may itself be a coroutine finishing through a tail resume
        while (true) {
            ctx.acc = val;
            if (frame !== null) return frame;
            if (ctx.pendingWind !== null) return this.advanceWindTransition(ctx);
            const co = ctx.coroutine;
            if (co === null || co.status !== "running" || co.closing) return null;
            co.status = "dead";
            const resumer = this.#detachResumer(co);
            ctx = resumer.ctx;
            frame = resumer.frame;
        }
    }

    public newFrame(
        ctx: ExecutionContext,
        closure: Closure,
        regs: any[],
        parent: Frame | null,
        marks: Marks = null,
        mframe: number = 0
    ): Frame {
        return new Frame(closure, regs, 0, parent, ctx, marks, mframe);
    }

    public reset(
        frame: Frame,
        closure: Closure,
        regs: any[]
    ): Frame {
        frame.closure = closure;
        frame.code = closure.tmpl.code;
        frame.upvars = closure.upvars;
        frame.regs = regs;
        frame.ip = 0;
        return frame;
    }

    public createClosureArg(closure: Closure, nargs: number, args: any[], startOffset: number): any[] {
        const arity = closure.tmpl.arity;
        if (nargs < arity.min || nargs > arity.max) checkArity(closure.debugName ?? "lambda", arity, nargs);
        const closureRegs: any[] = createRegs(closure.tmpl.code.numReg);
        // bindArgs, with its common case inline: this runs on every call
        if (arity.rest === "none") for (let i = 0; i < nargs; i++) closureRegs[i] = args[startOffset + i];
        else bindArgs(arity, closureRegs, args, startOffset, nargs, closure.tmpl.code.pack);
        return closureRegs;
    }

    // calls a closure's fixed-arity direct entry with an argument array
    public callDirect(ctx: ExecutionContext, proc: Closure, args: any[], depth: number, marks: any, mframe: number): any {
        const fn = proc.tmpl.code.directFn!;
        switch (args.length) {
            case 0: return fn(ctx, proc, this, depth, marks, mframe);
            case 1: return fn(ctx, proc, this, depth, marks, mframe, args[0]);
            case 2: return fn(ctx, proc, this, depth, marks, mframe, args[0], args[1]);
            case 3: return fn(ctx, proc, this, depth, marks, mframe, args[0], args[1], args[2]);
            case 4: return fn(ctx, proc, this, depth, marks, mframe, args[0], args[1], args[2], args[3]);
        }
        return fn(ctx, proc, this, depth, marks, mframe, ...args);
    }

    // a call of a case-lambda from direct code: its clause's direct entry, else heap frames
    public callCase(ctx: ExecutionContext, proc: CaseLambda, args: any[], depth: number, marks: any, mframe: number): any {
        const clause = proc.select(args.length);
        const code = clause.tmpl.code;
        if (depth < MAX_JS_DEPTH) {
            if (code.directArity === args.length) return this.callDirect(ctx, clause, args, depth, marks, mframe);
            if (code.directRestArity !== -1 && args.length >= code.directRestArity) return this.callDirectRest(ctx, clause, args, depth, marks, mframe);
        }
        throw Suspend.invoke(clause, args);
    }

    public callDirectRest(ctx: ExecutionContext, proc: Closure, args: any[], depth: number, marks: any, mframe: number): any {
        const code = proc.tmpl.code;
        const fn = code.directFn!;
        const numPos = code.directRestArity;
        // `args` is always a fresh array the caller gives up, so a rest array with no positional params can be it
        const rest = proc.tmpl.arity.rest === "array" ? (numPos === 0 ? args : args.slice(numPos)) : code.pack!(args, numPos, args.length - numPos);
        // spreading into the call is slow, so the common arities are called directly
        switch (numPos) {
            case 0: return fn(ctx, proc, this, depth, marks, mframe, rest);
            case 1: return fn(ctx, proc, this, depth, marks, mframe, args[0], rest);
            case 2: return fn(ctx, proc, this, depth, marks, mframe, args[0], args[1], rest);
            case 3: return fn(ctx, proc, this, depth, marks, mframe, args[0], args[1], args[2], rest);
            case 4: return fn(ctx, proc, this, depth, marks, mframe, args[0], args[1], args[2], args[3], rest);
        }
        args.length = numPos;
        args.push(rest);
        return fn(ctx, proc, this, depth, marks, mframe, ...args);
    }

    // --- continuations and dynamic-wind ---

    // calls `proc` with `tok` as the innermost exception handler; its value, or a Caught, is returned to `frame`
    public callCatch(ctx: ExecutionContext, proc: any, frame: Frame, tok: CatchToken): Frame | null {
        const marks = markSet(frame.marks, frame.mframe + 1, EXCEPTION_HANDLERS, new Handlers(tok, markFirst(frame.marks, EXCEPTION_HANDLERS, null)));
        if (proc instanceof Closure) return this.newFrame(ctx, proc, this.createClosureArg(proc, 0, [], 0), frame, marks, frame.mframe + 1);
        try {
            return this.invoke(ctx, proc, frame, [], 0, 0, false);
        } catch (err) {
            if (err instanceof EscapedError) throw err;
            ctx.acc = new Caught(caughtValue(err, this.vm));
            return frame;
        }
    }

    public callCC(ctx: ExecutionContext, proc: any, frame: Frame, isTail: boolean, marks?: Marks, mframe?: number): Frame | null {
        const target = isTail ? frame.parent : frame;
        target?.share(ctx);
        const k = new VMContinuation(target, ctx.id, ctx.wind);
        return this.invoke(ctx, proc, frame, [k], 0, 1, isTail, marks, mframe);
    }

    // --- delimited continuations ---

    // runs `thunk` under a prompt tagged `tag` (see raiseHelpers().prompt), returning to `frame` (its caller for a tail call)
    public callPrompt(ctx: ExecutionContext, frame: Frame, isTail: boolean, tag: any, thunk: any, handler: any, marks?: Marks, mframe?: number): Frame | null {
        const regs = [tag, thunk, handler, undefined, ctx.wind];
        const returnTo = isTail ? frame.parent : frame;
        if (marks !== undefined) return this.newFrame(ctx, raiseHelpers().prompt, regs, returnTo, marks, mframe);
        return this.newFrame(ctx, raiseHelpers().prompt, regs, returnTo, frame.marks, isTail ? frame.mframe : frame.mframe + 1);
    }

    #prompt(from: Frame | null, tag: any): Frame {
        const code = raiseHelpers().prompt.tmpl.code;
        for (let f = from; f !== null; f = f.parent) if (f.code === code && f.regs[0] === tag) return f;
        throw vmError(Msg.NoPrompt, tag);
    }

    // calls `proc` with the continuation up to the nearest prompt tagged `tag`, as a procedure that runs it on top of
    // whatever continuation calls it. The frames are shared from then on (as call/cc shares them), so they stay as captured
    public callComposable(ctx: ExecutionContext, proc: any, tag: any, frame: Frame, isTail: boolean, marks?: Marks, mframe?: number): Frame | null {
        const target = isTail ? frame.parent : frame;
        const prompt = this.#prompt(target, tag);
        const frames: Frame[] = [];
        for (let f = target; f !== prompt; f = f!.parent) frames.push(f!);
        const promptWind = mapWind(prompt, prompt.regs[4]);
        const winds: WindPoint[] = [];
        for (let w = ctx.wind; w !== promptWind && w !== null; w = w.parent) winds.push(w);
        target?.share(ctx);
        const k = new ComposableContinuation(frames, winds, promptWind, prompt.mframe + 1);
        return this.invoke(ctx, proc, frame, [k], 0, 1, isTail, marks, mframe);
    }

    // unwinds to the nearest prompt tagged `tag` (running dynamic-wind after-thunks), which calls its handler with `values`
    public abort(ctx: ExecutionContext, frame: Frame | null, tag: any, values: any[]): Frame | null {
        const prompt = this.#prompt(frame, tag);
        return this.#jumpTo(ctx, prompt, mapWind(prompt, prompt.regs[4]), new Aborted(values));
    }

    // runs a composable continuation's frames, copied, on top of `returnTo`: their marks and logical frames moved onto
    // `marks` and `base`, and the wind points entered since the prompt entered again, as copies on top of the current ones
    #compose(ctx: ExecutionContext, k: ComposableContinuation, returnTo: Frame | null, marks: Marks, base: number, val: any): Frame | null {
        const shift = base - k.base;
        const winds = new Map<WindPoint | null, WindPoint | null>([[k.promptWind, ctx.wind]]);
        let wind = ctx.wind;
        for (let i = k.winds.length - 1; i >= 0; i--) {
            wind = new WindPoint(wind, k.winds[i].before, k.winds[i].after);
            winds.set(k.winds[i], wind);
        }
        const moved = new Map<Marks, Marks>();
        const move = (m: Marks): Marks => {
            if (m === null || m.frame < k.base) return marks;
            let out = moved.get(m);
            if (out === undefined) {
                if (m.key === BARRIER) throw vmError(Msg.BarrierReentry);
                out = new MarkEntry(m.key, m.value, m.frame + shift, move(m.next));
                moved.set(m, out);
            }
            return out;
        };
        let parent = returnTo;
        for (let i = k.frames.length - 1; i >= 0; i--) {
            const f = k.frames[i];
            const copy = new Frame(f.closure, f.regs.slice(), f.ip, parent, ctx, move(f.marks), f.mframe + shift);
            copy.posIp = f.posIp;
            if (f.winds === null) {
                copy.winds = winds;
            } else {
                copy.winds = new Map(winds);
                for (const [orig, mid] of f.winds) copy.winds.set(orig, winds.has(mid) ? winds.get(mid)! : mid);
            }
            parent = copy;
        }
        return this.#jumpTo(ctx, parent, wind, val);
    }

    public advanceWindTransition(ctx: ExecutionContext): Frame | null {
        while (ctx.pendingWind !== null) {
            const trans = ctx.pendingWind;

            if (trans.actionIdx > 0) {
                const prevAction = trans.actions[trans.actionIdx - 1];
                if (prevAction.type === "before") {
                    ctx.wind = prevAction.nextWind;
                }
            }

            if (trans.actionIdx < trans.actions.length) {
                const action = trans.actions[trans.actionIdx++];
                if (action.type === "after") {
                    ctx.wind = action.nextWind;
                }

                if (action.thunk instanceof Closure) {
                    const pregs = this.createClosureArg(action.thunk, 0, [], 0);
                    return this.newFrame(ctx, action.thunk, pregs, null);
                }

                throw vmError(Msg.NonProcedureWind, action.thunk);
            }

            ctx.pendingWind = null;
            ctx.wind = trans.targetWind;
            ctx.acc = trans.targetVal;
            return this.setRetVal(ctx, trans.targetFrame, trans.targetVal);
        }

        return null;
    }

    // --- errors ---

    // `marks`/`mframe`: where the error happened, when that is not `frame` (a tail call that left no frame)
    public handleHostException(ctx: ExecutionContext, frame: Frame | null, err: any, marks?: Marks, mframe: number = 0): Frame | null {
        if (err instanceof EscapedError) throw err;
        if (err instanceof VMError) this.vm.message(err, errorPos(frame));
        if (err instanceof UnhandledError) {
            const co = ctx.coroutine;
            if (co !== null && co.closing) throw err;
            if (co !== null && co.status === "running") {
                co.frame = null;
                // the coroutine is left: its pending dynamic-wind after-thunks run first, and an error in one replaces this one
                let error = err.error;
                try {
                    this.#unwindCoroutine(co);
                } catch (thunkErr) {
                    error = thunkErr instanceof UnhandledError ? thunkErr.error : thunkErr;
                }
                co.status = "dead";
                const resumer = this.#detachResumer(co);
                if (resumer.ctx.barrier) throw new ReRaise(error);
                return this.handleHostException(resumer.ctx, resumer.frame, new ReRaise(error, resumer.marks, resumer.mframe));
            }
            const out = err.error instanceof Error ? err.error : new Error(this.vm.intrinsics.format(Msg.Unhandled, [err.error], this.vm.intrinsics.format, null));
            if (err.traceback !== undefined && (out as any).animaTraceback === undefined) (out as any).animaTraceback = err.traceback;
            throw out;
        }
        if (err instanceof ReRaise && err.marks !== undefined) return this.raise(ctx, frame, caughtValue(err, this.vm), false, err.marks, err.mframe);
        return this.raise(ctx, frame, caughtValue(err, this.vm), false, marks, mframe);
    }

    // Delivers `obj` to the innermost exception handler seen from `frame` (or `marks`, where a tail call left no frame):
    // a catch token is escaped to (after its pre-unwind handler, if any); a handler procedure is called with the outer
    // handlers installed, and if it returns, that is the value of a continuable raise, else a secondary error for them
    public raise(ctx: ExecutionContext, frame: Frame | null, obj: any, continuable: boolean, marks: Marks = frame?.marks ?? null, mframe: number = frame?.mframe ?? 0): Frame | null {
        if (obj instanceof ErrorObject) this.vm.message(obj.error);
        const handlers = markFirst(marks, EXCEPTION_HANDLERS, null);
        if (!(handlers instanceof Handlers)) return this.#unhandled(ctx, frame, obj);
        const handler = handlers.handler;
        const outer = markSet(marks, mframe + 1, EXCEPTION_HANDLERS, handlers.outer);
        if (handler instanceof CatchToken) {
            if (handler.pre !== null) {
                const preMarks = handler.guarded ? markSet(marks, mframe + 1, EXCEPTION_HANDLERS, new Handlers(handler.forPre(), handlers.outer)) : outer;
                const escape = new Frame(raiseHelpers().escapeWith, [handler, undefined, undefined], 0, frame, ctx, preMarks, mframe + 1);
                return this.invoke(ctx, handler.pre, escape, [obj], 0, 1, false);
            }
            const target = handler.target(frame);
            if (target === null) throw vmError(Msg.CatchOutsideExtent);
            const val = handler.inPre ? new ErrorObject(this.vm.message(vmError(Msg.ErrorInHandler, obj), errorPos(frame))) : obj;
            return this.#jumpTo(ctx, target, mapWind(target, handler.wind), new Caught(val));
        }
        if (continuable) return this.invoke(ctx, handler, frame, [obj], 0, 1, false, outer, mframe + 1);
        const returned = new Frame(raiseHelpers().handlerReturned, [undefined], 0, frame, ctx, outer, mframe + 1);
        return this.invoke(ctx, handler, returned, [obj], 0, 1, false);
    }

    #unhandled(ctx: ExecutionContext, frame: Frame | null, obj: any): Frame | null {
        const traceback = formatTraceback(frameInfos(frame), tracebackMessage(obj, v => this.vm.print(v)), this.vm.intrinsics.format);
        const err = obj instanceof ErrorObject ? obj.error : obj;
        if (err instanceof Error && (err as any).animaTraceback === undefined) (err as any).animaTraceback = traceback;
        return this.handleHostException(ctx, frame, new UnhandledError(err, traceback, this.vm.intrinsics.format));
    }

    public resumeSuspend(ctx: ExecutionContext, sig: Suspend): Frame | null {
        const caller = sig.innermost!;
        const entered = sig.entered?.tmpl.code;
        if ((sig.control || sig.action === null) && entered !== undefined) countControlSuspend(entered);
        try {
            if (sig.action === null) return this.handleHostException(ctx, caller, sig.error, sig.marks, sig.mframe);
            try {
                return sig.action(ctx, this, caller, sig);
            } catch (err) {
                return this.handleHostException(ctx, caller, err, sig.marks, sig.mframe);
            }
        } catch (err) {
            throw err instanceof EscapedError ? err : new EscapedError(err);
        }
    }

    // --- coroutines ---

    public coCreate(ctx: ExecutionContext, proc: any, fin: any = null): Coroutine {
        // the body runs as the coroutine's first frame, so it must be Anima code: a closure (builtins used as values are
        // closures too), not a continuation
        if (!(proc instanceof Closure)) {
            throw vmError(Msg.ExpectedClosure, "coroutine-create", proc);
        }
        if (fin !== null && !(fin instanceof IProcedure)) {
            throw vmError(Msg.ExpectedFinally, "coroutine-create", fin);
        }
        return new Coroutine(proc, ctx.vm, ctx.scope, fin);
    }

    public coStatus(co: any): symbol {
        if (!(co instanceof Coroutine)) throw vmError(Msg.ExpectedCoroutine, "coroutine-status", co);
        return Symbol.for(co.status);
    }

    public coResume(
        ctx: ExecutionContext,
        resumeTo: Frame | null,
        co: any,
        args: any[],
        marks: Marks = resumeTo?.marks ?? null,
        mframe: number = resumeTo?.mframe ?? 0,
        raising: boolean = false
    ): Frame | null {
        const who = raising ? "coroutine-raise" : "coroutine-resume";
        if (!(co instanceof Coroutine)) throw vmError(Msg.ExpectedCoroutine, who, co);
        if (co.status !== "suspended") throw vmError(Msg.CannotResume, who, co.status);

        co.resumer = { ctx, frame: resumeTo, marks, mframe };
        // a coroutine resuming another keeps its frames where they can be traced while it waits
        if (ctx.coroutine !== null) {
            ctx.coroutine.status = "normal";
            ctx.coroutine.frame = resumeTo;
        }
        co.status = "running";
        if (!co.started) {
            co.started = true;
            // raised into a coroutine that never ran: there is no handler, so it dies with the error
            if (raising) return this.raise(co.ctx, null, args[0], false);
            let bottom: Frame | null = null;
            // the procedure runs as the body of a dynamic-wind whose after thunk is `fin`, returning through the frame
            // that leaves it and calls it (so an error or close runs it too, as the coroutine's pending after thunk)
            if (co.fin !== null) {
                co.ctx.wind = new WindPoint(null, null, co.fin);
                bottom = new Frame(raiseHelpers().coroutineFinally, [undefined, co.fin, undefined], 0, null, co.ctx);
            }
            return this.invoke(co.ctx, co.proc, bottom, args, 0, args.length, false);
        }
        const frame = co.frame;
        co.frame = null;
        // (%coroutine-raise co obj): the pending yield raises obj, under the coroutine's own handlers
        if (raising) return this.raise(co.ctx, frame, args[0], false);
        co.ctx.acc = packValues(args);
        return frame;
    }

    // runs a coroutine to its next yield or return in a nested driver loop and returns the value (used by the host and by direct-mode code)

    public coResumeNested(ctx: ExecutionContext | null, co: any, args: any[], raising: boolean = false): any {
        const barrier = new ExecutionContext(this.vm, co instanceof Coroutine ? co.ctx.scope : new Env());
        barrier.barrier = true;
        const outer = ctx?.coroutine ?? null;
        const frame = this.coResume(barrier, null, co, args, null, 0, raising);
        if (outer !== null) outer.status = "normal";
        this.nestedResumes++;
        try {
            if (frame !== null) this.#runLoop(barrier, frame);
        } finally {
            this.nestedResumes--;
            if (outer !== null) outer.status = "running";
        }
        return barrier.acc;
    }

    public coYield(ctx: ExecutionContext, frame: Frame, val: any): Frame | null {
        const co = ctx.coroutine;
        if (co === null) throw vmError(Msg.YieldOutside);
        if (co.closing) throw vmError(Msg.YieldClosing);
        co.frame = frame;
        co.status = "suspended";
        return this.#returnToResumer(co, val);
    }

    // starts or continues a coroutine inside the current driver loop; `resumeTo` is where its yields and final value go

    public coClose(ctx: ExecutionContext | null, co: any): void {
        if (!(co instanceof Coroutine)) throw vmError(Msg.ExpectedCoroutine, "coroutine-close", co);
        if (co.status === "dead") return;
        if (co.status !== "suspended") throw vmError(Msg.CannotClose, "coroutine-close", co.status);

        co.frame = null;
        if (co.ctx.wind === null) {
            co.status = "dead";
            return;
        }

        const outer = ctx?.coroutine ?? null;
        if (outer !== null) outer.status = "normal";
        co.status = "running";
        try {
            this.#unwindCoroutine(co);
        } catch (err) {
            throw new ReRaise(err instanceof UnhandledError ? err.error : err);
        } finally {
            co.status = "dead";
            if (outer !== null) outer.status = "running";
        }
    }

    // runs a coroutine's pending dynamic-wind after-thunks (innermost first, inside the coroutine, which cannot yield
    // meanwhile) in a nested driver loop; an error in one is thrown
    #unwindCoroutine(co: Coroutine): void {
        const cctx = co.ctx;
        const actions = computeWindTransition(cctx.wind, null);
        if (actions.length === 0) return;
        co.closing = true;
        try {
            cctx.pendingWind = { actions, actionIdx: 0, targetFrame: null, targetVal: undefined, targetWind: null };
            const frame = this.advanceWindTransition(cctx);
            if (frame !== null) this.#runLoop(cctx, frame);
        } finally {
            cctx.pendingWind = null;
            co.closing = false;
        }
    }

    #returnToResumer(co: Coroutine, val: any): Frame | null {
        const resumer = this.#detachResumer(co);
        return this.setRetVal(resumer.ctx, resumer.frame, val);
    }

    #detachResumer(co: Coroutine): NonNullable<Coroutine["resumer"]> {
        const resumer = co.resumer!;
        co.resumer = null;
        if (resumer.ctx.coroutine !== null) resumer.ctx.coroutine.status = "running";
        return resumer;
    }

    // --- driver loop ---

    #runLoop(ctx: ExecutionContext, frame: Frame): void {
        if (this.vm.mode === "aot") {
            // compiled code already had its nested templates compiled with it
            if (frame.code.resumeFn === null) AotCompiler.compileAll(frame.code, frame.closure.tmpl);
            AotCompiler.run(ctx, frame, this);
        } else {
            BytecodeInterpreter.run(ctx, frame, this);
        }
    }
}
