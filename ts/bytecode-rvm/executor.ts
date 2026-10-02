// VMExecutor: calls, returns, continuations, dynamic-wind, exception delivery and coroutines, and the driver loop that
// runs heap frames through their AOT code
import { Env, ErrorObject, IProcedure, Msg, TRY_CALL, UnhandledError, VMError, packValues, vmError } from "../common";
import { BARRIER, Caught, EXCEPTION_HANDLERS, Handlers, MarkEntry, markFirst, markSet, reentersBarrier } from "../marks";
import type { Marks } from "../marks";
import { AotCompiler } from "./aot/compiler";
import { bindArgs, checkArity } from "./arity";
import { Code, CaseLambda, Closure, ClosureTemplate, createRegs } from "./code";
import type { VMHost } from "./code";
import { CORE_INTRINSICS, ControlRequest, InterruptRequest, YieldRequest, corePos, tracebackMessage } from "./coreops";
import { OP_SIZE, type DistributiveOmit, type Op } from "./ops";
import { Aborted, CatchToken, ComposableContinuation, Coroutine, EscapeContinuation, EscapedError, ExecutionContext, Frame, INTERRUPT_INTERVAL, InterruptError, MAX_JS_DEPTH, ReRaise, Suspend, VMContinuation, WindPoint, caughtValue, mapWind, computeWindTransition, countControlSuspend, errorPos, formatTraceback, frameInfos, type Resumer } from "./values";

// Frames the VM puts under a handler it calls: `handlerReturned` raises the secondary error when the handler of a
// non-continuable raise returns (its marks hold the outer handlers); `escapeWith` escapes to the catch token in its
// register 0 with what a pre-unwind handler returned. `coroutineFinally` is under the procedure of a coroutine with a
// finally thunk (in its register 1): it leaves the thunk's wind and calls it, then returns the procedure's value.
export let helpers: { handlerReturned: Closure, escapeWith: Closure, prompt: Closure, coroutineFinally: Closure } | null = null;
export const raiseHelpers = () => helpers ??= {
    handlerReturned: helperClosure(1, [new ErrorObject(vmError(Msg.HandlerReturned))], [
        { k: "LoadConst", dst: 0, idx: 0 },
        { k: "HostCall", pos: corePos("%raise"), start: 0, nargs: 1, tail: false },
        { k: "Return", src: 0 },
    ]),
    escapeWith: helperClosure(3, [], [
        { k: "MoveAcc", dst: 1 },
        { k: "IntCall", pos: corePos("%make-caught"), dst: 2, start: 1, nargs: 1 },
        { k: "Call", proc: 0, start: 2, nargs: 1, tail: true },
    ]),
    // a prompt (%call-with-prompt): r0 the tag, r1 the body thunk, r2 the handler, r4 the wind it was installed in. The
    // body's value, or what an abort to it hands it (an Aborted), goes to %prompt-finish, in tail position
    prompt: helperClosure(5, [], [
        { k: "Call", proc: 1, start: 3, nargs: 0, tail: false },
        { k: "MoveAcc", dst: 3 },
        { k: "HostCall", pos: corePos("%prompt-finish"), start: 2, nargs: 2, tail: true },
    ], "prompt"),
    coroutineFinally: helperClosure(3, [], [
        { k: "MoveAcc", dst: 0 },
        { k: "IntCall", pos: corePos("%end-wind"), dst: 2, start: 0, nargs: 0 },
        { k: "Call", proc: 1, start: 0, nargs: 0, tail: false },
        { k: "Return", src: 0 },
    ], "coroutine-finally"),
};

const escapeTarget = (tok: EscapeContinuation, from: Frame | null): Frame | null => {
    const owner = tok.owner;
    for (let f = from; f !== null; f = f.parent) if (f.escape === owner) return f;
    return null;
};
export const helperClosure = (numReg: number, constants: any[], body: DistributiveOmit<Op, "ip">[], name: string = "raise"): Closure => {
    let ip = 0;
    const ops = body.map(op => { const full = { ...op, ip } as Op; ip += OP_SIZE[op.k]; return full; });
    const positions = new Set<number>();
    for (const op of ops) if (op.k === "HostCall" || op.k === "IntCall" || op.k === "IntApply") positions.add(op.pos);
    const used = [...positions].map(pos => CORE_INTRINSICS.entries[pos]).map(({ pos, name, leaf }) => ({ pos, name, leaf }));
    const code = new Code(constants, ops, ip, numReg, undefined, undefined, false, CORE_INTRINSICS, used);
    code.internal = true;
    return new Closure(new ClosureTemplate([], null, code, [], name), [], name);
};

export class VMExecutor {
    public nestedResumes: number = 0;
    // the coroutine running now, or null outside any
    public running: Coroutine | null = null;

    // interrupt checks left before one calls the handler (see Intrinsics.setInterruptHandler)
    public interruptLeft: number = INTERRUPT_INTERVAL;

    constructor(public vm: VMHost) {}

    // --- interrupts ---

    // an interrupt check: nothing, or what the handler asked for (a yield or a stop)
    public interrupt(ctx: ExecutionContext): ControlRequest | undefined {
        return --this.interruptLeft > 0 ? undefined : this.interruptSlow(ctx);
    }

    // the count ran out: it starts again, and the handler is called
    public interruptSlow(ctx: ExecutionContext): ControlRequest | undefined {
        this.interruptLeft = INTERRUPT_INTERVAL;
        // a pause the handler asked for while an intrinsic ran (see checkInterrupt) happens now, if the code can pause
        const pending = this.#pendingPause;
        if (pending !== null) {
            this.#pendingPause = null;
            return ctx.coroutineYieldable ? pending : undefined;
        }
        const handler = this.vm.intrinsics.interruptHandler;
        // code compiled with checks, run by an instance without interrupts
        if (handler === -1) return undefined;
        return this.#vetInterrupt(this.vm.intrinsics.fns[handler]([], 0, 0, ctx, this), ctx);
    }

    // what an interrupt handler returned, as what the check does: nothing, a pause or a stop
    #vetInterrupt(res: any, ctx: ExecutionContext): ControlRequest | undefined {
        if (!(res instanceof ControlRequest) || res instanceof InterruptRequest) return res instanceof InterruptRequest ? res : undefined;
        if (!(res instanceof YieldRequest)) return new InterruptRequest(new Error("an interrupt handler can only continue (return a value), pause (hostYield) or stop (hostInterruptError)"));
        if (!ctx.coroutineYieldable) return new InterruptRequest(new Error("an interrupt handler paused (hostYield) code that is not in a coroutine it can pause"));
        return res;
    }

    #pendingPause: YieldRequest | null = null;

    // An interrupt check a host intrinsic makes itself, as it works (Anima.checkInterrupt): `work` counts against the
    // instance's count, and when that runs out the handler is called. A stop throws an InterruptError out of the
    // intrinsic, as uncatchable as any; a pause cannot stop a JS function midway, so it happens at the next check of the
    // code that called the intrinsic, which the count, run out, makes call no handler (if that code cannot pause there, or
    // leaves for the host first, the pause is dropped)
    public checkInterrupt(work: number = 1): void {
        const handler = this.vm.intrinsics.interruptHandler;
        if (handler === -1 || (this.interruptLeft -= work) > 0) return;
        this.interruptLeft = INTERRUPT_INTERVAL;
        const res = this.vm.intrinsics.fns[handler]([], 0, 0, undefined, this);
        if (!(res instanceof ControlRequest)) return;
        if (res instanceof InterruptRequest) throw new InterruptError(res.value);
        if (!(res instanceof YieldRequest)) throw new InterruptError(new Error("an interrupt handler can only continue (return a value), pause (hostYield) or stop (hostInterruptError)"));
        this.#pendingPause = res;
        this.interruptLeft = 0;
    }

    public dropPendingPause(): void {
        this.#pendingPause = null;
    }

    // the slow path of a check in direct code, a call of its own, as code the path is written into runs measurably slower:
    // a yield or a stop is thrown
    public interruptDirect(ctx: ExecutionContext, closure: Closure, marks: Marks, mframe: number): void {
        const res = this.interruptSlow(ctx);
        if (res !== undefined) res.direct(ctx, this, closure, marks, mframe, false);
    }

    // a stop is leaving: the coroutine running and those waiting on it, up to one resumed from outside the VM (or by a
    // nested driver loop, which does the same for its own), die where they are
    public abortRunning(): void {
        for (let co = this.running; co !== null;) {
            // one being closed has no resumer: whoever closed it is outside it, and goes on until the stop reaches it
            const resumer: Resumer | null = co.detachResumer();
            co.finish();
            co = resumer?.ctx.coroutine ?? null;
        }
        this.running = null;
    }

    // --- call protocol ---

    public enter(ctx: ExecutionContext, frame: Frame): Frame {
        if (frame.isShared(ctx)) {
            frame = frame.thaw(ctx);
        }
        if (frame.escape !== null) frame.escape = null;
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
            const target = escapeTarget(proc, callerFrame);
            if (target === null) throw vmError(Msg.EscapeOutsideExtent);
            return this.#jumpTo(ctx, target, mapWind(target, proc.wind), callerArgs[startReg]);
        }

        const handler = this.#hooked(proc);
        if (handler === null) throw vmError(Msg.NonProcedure, proc);
        const args = [proc];
        for (let i = 0; i < nargs; i++) args.push(callerArgs[startReg + i]);
        return this.invoke(ctx, handler, callerFrame, args, 0, args.length, isTail, marks, mframe);
    }

    // the procedure `value` gives to be called in its place (see TRY_CALL), if it is not a procedure
    #hooked(value: any): IProcedure | null {
        if (value === null || value === undefined || value instanceof IProcedure) return null;
        const handler = value[TRY_CALL];
        return handler instanceof IProcedure ? handler : null;
    }

    // a call from direct code of what is not a closure or case-lambda: a continuation on heap frames, else the
    // procedure the value gives (TRY_CALL), with the value before `args`
    public callOther(ctx: ExecutionContext, value: any, args: any[], depth: number, marks: any, mframe: number): any {
        const handler = this.#hooked(value);
        if (handler === null) throw Suspend.invoke(value, args);
        const all = [value, ...args];
        if (handler instanceof CaseLambda) return this.callCase(ctx, handler, all, depth, marks, mframe);
        if (handler instanceof Closure) {
            if (handler.tmpl.arity.pad) return this.callPadded(ctx, handler, all, depth, marks, mframe);
            const code = handler.tmpl.code;
            if (depth < MAX_JS_DEPTH) {
                if (code.directArity === all.length) return this.callDirect(ctx, handler, all, depth, marks, mframe);
                if (code.directRestArity !== -1 && all.length >= code.directRestArity) return this.callDirectRest(ctx, handler, all, depth, marks, mframe);
            }
        }
        throw Suspend.invoke(handler, all);
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
            co.finish();
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
        if (arity.rest === "none" && !arity.pad) for (let i = 0; i < nargs; i++) closureRegs[i] = args[startOffset + i];
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

    // a call of a padded closure from direct code with another count than its parameters': the arguments padded with
    // <#void> or cut to them, to its direct entry, else heap frames. `args` is a new array the caller gives up
    public callPadded(ctx: ExecutionContext, proc: Closure, args: any[], depth: number, marks: any, mframe: number): any {
        const code = proc.tmpl.code;
        const n = proc.tmpl.arity.params;
        if (depth < MAX_JS_DEPTH && (code.directArity !== -1 || code.directRestArity !== -1)) {
            while (args.length < n) args.push(undefined);
            if (code.directArity !== -1) {
                args.length = n;
                return this.callDirect(ctx, proc, args, depth, marks, mframe);
            }
            return this.callDirectRest(ctx, proc, args, depth, marks, mframe);
        }
        throw Suspend.invoke(proc, args);
    }

    // a call of a case-lambda from direct code: its clause's direct entry, else heap frames
    public callCase(ctx: ExecutionContext, proc: CaseLambda, args: any[], depth: number, marks: any, mframe: number): any {
        const clause = proc.select(args.length);
        if (clause.tmpl.arity.pad) return this.callPadded(ctx, clause, args, depth, marks, mframe);
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

    // direct code's %call/ec or %catch, as an exception it does not take leaves it: the frame rebuilt for it holds the
    // token, and a call not yet made is made with `marks`
    public pushEscape(e: any, tok: EscapeContinuation, marks: Marks, mframe: number): any {
        if (e instanceof Suspend) {
            if (e.innermost === null && e.marks === undefined) {
                e.marks = marks;
                e.mframe = mframe + 1;
            }
            e.pendingEscape = tok;
        }
        return e;
    }

    // calls `proc` with a new escape continuation, which `frame` holds until it resumes
    public callEscape(ctx: ExecutionContext, proc: any, frame: Frame): Frame | null {
        const tok = frame.escape = new EscapeContinuation(ctx.id, ctx.wind);
        return this.invoke(ctx, proc, frame, [tok], 0, 1, false, frame.marks, frame.mframe + 1);
    }

    // calls `proc` with a new catch token as the innermost exception handler; its value, or a Caught, is returned to `frame`
    public callCatch(ctx: ExecutionContext, proc: any, frame: Frame, pre: any, guarded: boolean): Frame | null {
        const tok = frame.escape = new CatchToken(ctx.id, ctx.wind, pre, guarded);
        const marks = markSet(frame.marks, frame.mframe + 1, EXCEPTION_HANDLERS, new Handlers(tok, markFirst(frame.marks, EXCEPTION_HANDLERS, null)));
        try {
            return this.invoke(ctx, proc, frame, [], 0, 0, false, marks, frame.mframe + 1);
        } catch (err) {
            if (err instanceof EscapedError || err instanceof InterruptError) throw err;
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
            copy.escape = f.escape;
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

                if (action.thunk instanceof IProcedure || this.#hooked(action.thunk) !== null) return this.invoke(ctx, action.thunk, null, [], 0, 0, false);
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
        if (err instanceof EscapedError || err instanceof InterruptError) throw err;
        if (err instanceof VMError) this.vm.message(err, errorPos(frame));
        if (err instanceof UnhandledError) {
            const co = ctx.coroutine;
            if (co !== null && co.closing) throw err;
            if (co !== null && co.status === "running") {
                // the coroutine is left: its pending dynamic-wind after-thunks run first, and an error in one replaces this one
                let error = err.error;
                try {
                    this.#unwindCoroutine(co);
                } catch (thunkErr) {
                    if (thunkErr instanceof InterruptError) throw thunkErr;
                    error = thunkErr instanceof UnhandledError ? thunkErr.error : thunkErr;
                }
                co.finish();
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
            const target = escapeTarget(handler, frame);
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
            throw err instanceof EscapedError || err instanceof InterruptError ? err : new EscapedError(err);
        }
    }

    // --- coroutines ---

    public coCreate(ctx: ExecutionContext, proc: any, fin: any = null): Coroutine {
        // the body runs as the coroutine's first frame, so it must be Anima code: a closure (builtins used as values are
        // closures too), not a continuation
        if (!(proc instanceof Closure || proc instanceof CaseLambda)) {
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

        // a coroutine resuming another keeps its frames where they can be traced while it waits
        ctx.coroutine?.waitOn(resumeTo);
        const { first, frame, marks: yieldMarks, mframe: yieldMframe } = co.resume({ ctx, frame: resumeTo, marks, mframe });
        this.running = co;
        if (first) {
            // raised into a coroutine that never ran: there is no handler, so it dies with the error
            if (raising) return this.raise(co.ctx, null, args[0], false);
            let bottom: Frame | null = null;
            // the procedure runs as the body of a dynamic-wind whose after thunk is `fin`, returning through the frame
            // that leaves it and calls it (so an error or close runs it too, as the coroutine's pending after thunk)
            if (co.fin !== null) {
                co.ctx.wind = new WindPoint(null, null, co.fin);
                bottom = new Frame(raiseHelpers().coroutineFinally, [undefined, co.fin, undefined], 0, null, co.ctx);
            }
            try {
                return this.invoke(co.ctx, co.proc, bottom, args, 0, args.length, false);
            } catch (err) {
                // e.g. a wrong argument count: the coroutine dies with it, and its resumer gets it
                return this.handleHostException(co.ctx, bottom, err);
            }
        }
        // (%coroutine-raise co obj): the pending yield raises obj, under the coroutine's own handlers
        if (raising) return this.raise(co.ctx, frame, args[0], false, yieldMarks, yieldMframe);
        co.ctx.acc = packValues(args);
        return frame !== null ? frame : this.setRetVal(co.ctx, null, co.ctx.acc);
    }

    // runs a coroutine to its next yield or return in a nested driver loop and returns the value (used by the host and by direct-mode code)

    public coResumeNested(ctx: ExecutionContext | null, co: any, args: any[], raising: boolean = false): any {
        const barrier = new ExecutionContext(this.vm, co instanceof Coroutine ? co.ctx.scope : new Env());
        barrier.barrier = true;
        const outer = ctx?.coroutine ?? null;
        const running = this.running;
        this.nestedResumes++;
        try {
            const frame = this.coResume(barrier, null, co, args, null, 0, raising);
            outer?.waitOn(null);
            if (frame !== null) this.#runLoop(barrier, frame);
        } catch (err) {
            if (err instanceof InterruptError) this.abortRunning();
            throw err;
        } finally {
            this.nestedResumes--;
            outer?.wake();
            this.running = running;
        }
        return barrier.acc;
    }

    // `marks`/`mframe`: where it yielded, when that is not `frame` (a tail yield)
    public coYield(ctx: ExecutionContext, frame: Frame | null, val: any, marks: Marks = frame?.marks ?? null, mframe: number = frame?.mframe ?? 0): Frame | null {
        const co = ctx.coroutine;
        if (co === null) throw vmError(Msg.YieldOutside);
        if (co.closing) throw vmError(Msg.YieldClosing);
        co.suspend(frame, marks, mframe);
        return this.#returnToResumer(co, val);
    }

    // starts or continues a coroutine inside the current driver loop; `resumeTo` is where its yields and final value go

    public coClose(ctx: ExecutionContext | null, co: any): void {
        if (!(co instanceof Coroutine)) throw vmError(Msg.ExpectedCoroutine, "coroutine-close", co);
        if (co.status === "dead") return;
        if (co.status !== "suspended") throw vmError(Msg.CannotClose, "coroutine-close", co.status);

        if (co.ctx.wind === null) {
            co.finish();
            return;
        }

        const outer = ctx?.coroutine ?? null;
        const running = this.running;
        outer?.waitOn(null);
        co.startClose();
        this.running = co;
        try {
            this.#unwindCoroutine(co);
        } catch (err) {
            if (err instanceof InterruptError) throw err;
            throw new ReRaise(err instanceof UnhandledError ? err.error : err);
        } finally {
            co.finish();
            outer?.wake();
            this.running = running;
        }
    }

    // runs a coroutine's pending dynamic-wind after-thunks (innermost first, inside the coroutine, which cannot yield
    // meanwhile) in a nested driver loop; an error in one is thrown
    #unwindCoroutine(co: Coroutine): void {
        const cctx = co.ctx;
        const actions = computeWindTransition(cctx.wind, null);
        if (actions.length === 0) return;
        co.markClosing(true);
        try {
            cctx.pendingWind = { actions, actionIdx: 0, targetFrame: null, targetVal: undefined, targetWind: null };
            const frame = this.advanceWindTransition(cctx);
            if (frame !== null) this.#runLoop(cctx, frame);
        } finally {
            cctx.pendingWind = null;
            co.markClosing(false);
        }
    }

    #returnToResumer(co: Coroutine, val: any): Frame | null {
        const resumer = this.#detachResumer(co);
        return this.setRetVal(resumer.ctx, resumer.frame, val);
    }

    #detachResumer(co: Coroutine): Resumer {
        const resumer = co.detachResumer();
        resumer.ctx.coroutine?.wake();
        this.running = resumer.ctx.coroutine;
        return resumer;
    }

    // --- driver loop ---

    #runLoop(ctx: ExecutionContext, frame: Frame): void {
        // compiled code already had its nested templates compiled with it
        if (frame.code.resumeFn === null) AotCompiler.compileAll(frame.code, frame.closure.tmpl);
        AotCompiler.run(ctx, frame, this);
    }
}
