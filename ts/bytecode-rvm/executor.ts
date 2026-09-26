// VMExecutor: calls, returns, continuations, dynamic-wind, exception delivery and coroutines, and the driver loop that
// runs heap frames through the interpreter or AOT code
import { Env, ErrorObject, UnhandledError, packValues } from "../common";
import { hostError } from "../errors";
import { Cons } from "../list";
import { Caught, EXCEPTION_HANDLERS, markFirst, markSet } from "../marks";
import type { Marks } from "../marks";
import { AotCompiler } from "./aot/compiler";
import { bindArgs, checkArity, restList } from "./arity";
import { ByteCode, Closure, ClosureTemplate, createRegs } from "./bytecode";
import type { VMHost } from "./bytecode";
import { CORE_INTRINSICS, corePos, tracebackMessage } from "./coreops";
import { BytecodeInterpreter, OpCode } from "./interpreter";
import { INSTRUCTION_LENGTHS, INTRINSIC_OPERANDS } from "./opcodes";
import { CatchToken, Coroutine, EscapeContinuation, EscapedError, ExecutionContext, Frame, ReRaise, VMContinuation, caughtValue, computeWindTransition, countControlSuspend, formatTraceback, frameInfos } from "./values";
import type { Suspend, WindPoint } from "./values";

// Frames the VM puts under a handler it calls: `handlerReturned` raises the secondary error when the handler of a
// non-continuable raise returns (its marks hold the outer handlers); `escapeWith` escapes to the catch token in its
// register 0 with what a pre-unwind handler returned
export let helpers: { handlerReturned: Closure, escapeWith: Closure } | null = null;
export const raiseHelpers = () => helpers ??= {
    handlerReturned: helperClosure(1, [new ErrorObject(hostError("handler returned on non-continuable exception"))], [
        OpCode.LOADCONST, 0, 0,
        OpCode.CALLHOST, corePos("%raise"), 0, 1, 0,
        OpCode.RETURN, 0,
    ]),
    escapeWith: helperClosure(3, [], [
        OpCode.MOVEACC, 1,
        OpCode.CALLINT, corePos("%make-caught"), 2, 1, 1,
        OpCode.CALL, 0, 2, 1, 1,
    ]),
};
export const helperClosure = (numReg: number, constants: any[], inst: number[]): Closure => {
    const positions = new Set<number>();
    for (let ip = 0; ip < inst.length; ip += INSTRUCTION_LENGTHS[inst[ip]]) for (const off of INTRINSIC_OPERANDS[inst[ip]]) positions.add(inst[ip + off]);
    const used = [...positions].map(pos => CORE_INTRINSICS.entries[pos]).map(({ pos, name, leaf }) => ({ pos, name, leaf }));
    const code = new ByteCode(constants, new Uint32Array(inst), numReg, undefined, undefined, false, CORE_INTRINSICS, used);
    return new Closure(new ClosureTemplate([], null, code, [], "raise"), [], "raise");
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

        if (proc instanceof VMContinuation) {
            if (proc.ctxId !== ctx.id) {
                throw hostError("Cannot invoke a continuation across execution/FFI boundary");
            }
            if (nargs !== 1) throw hostError(`continuation expected exactly 1 argument, but received ${nargs}`);

            return this.#jumpTo(ctx, proc.frame, proc.wind, callerArgs[startReg]);
        }

        if (proc instanceof EscapeContinuation) {
            if (proc.ctxId !== ctx.id) {
                throw hostError("Cannot invoke an escape continuation across execution/FFI boundary");
            }
            if (nargs !== 1) throw hostError(`escape continuation expected exactly 1 argument, but received ${nargs}`);
            const target = proc.target(callerFrame);
            if (target === null) throw hostError("escape continuation invoked outside of its dynamic extent");
            return this.#jumpTo(ctx, target, proc.wind, callerArgs[startReg]);
        }

        throw hostError(`Attempted to call a non-procedure: ${String(proc)}`);
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
        else bindArgs(arity, closureRegs, args, startOffset, nargs);
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

    public callDirectRest(ctx: ExecutionContext, proc: Closure, args: any[], depth: number, marks: any, mframe: number): any {
        const code = proc.tmpl.code;
        const fn = code.directFn!;
        const numPos = code.directRestArity;
        // `args` is always a fresh array the caller gives up, so a rest array with no positional params can be it
        const rest = proc.tmpl.arity.rest === "array" ? (numPos === 0 ? args : args.slice(numPos)) : restList(args, numPos, args.length);
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
        const marks = markSet(frame.marks, frame.mframe + 1, EXCEPTION_HANDLERS, new Cons(tok, markFirst(frame.marks, EXCEPTION_HANDLERS, null)));
        if (proc instanceof Closure) return this.newFrame(ctx, proc, this.createClosureArg(proc, 0, [], 0), frame, marks, frame.mframe + 1);
        try {
            return this.invoke(ctx, proc, frame, [], 0, 0, false);
        } catch (err) {
            if (err instanceof EscapedError) throw err;
            ctx.acc = new Caught(caughtValue(err));
            return frame;
        }
    }

    public callCC(ctx: ExecutionContext, proc: any, frame: Frame, isTail: boolean, marks?: Marks, mframe?: number): Frame | null {
        const target = isTail ? frame.parent : frame;
        target?.share(ctx);
        const k = new VMContinuation(target, ctx.id, ctx.wind);
        return this.invoke(ctx, proc, frame, [k], 0, 1, isTail, marks, mframe);
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

                throw hostError(`Attempted to call a non-procedure in dynamic-wind: ${String(action.thunk)}`);
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
        if (err instanceof UnhandledError) {
            const co = ctx.coroutine;
            if (co !== null && co.closing) throw err;
            if (co !== null && co.status === "running") {
                co.status = "dead";
                co.frame = null;
                const resumer = this.#detachResumer(co);
                if (resumer.ctx.barrier) throw new ReRaise(err.error);
                return this.handleHostException(resumer.ctx, resumer.frame, new ReRaise(err.error, resumer.marks, resumer.mframe));
            }
            const out = err.error instanceof Error ? err.error : new Error(String(err.error));
            if (err.traceback !== undefined && (out as any).animaTraceback === undefined) (out as any).animaTraceback = err.traceback;
            throw out;
        }
        if (err instanceof ReRaise && err.marks !== undefined) return this.raise(ctx, frame, caughtValue(err), false, err.marks, err.mframe);
        return this.raise(ctx, frame, caughtValue(err), false, marks, mframe);
    }

    // Delivers `obj` to the innermost exception handler seen from `frame` (or `marks`, where a tail call left no frame):
    // a catch token is escaped to (after its pre-unwind handler, if any); a handler procedure is called with the outer
    // handlers installed, and if it returns, that is the value of a continuable raise, else a secondary error for them
    public raise(ctx: ExecutionContext, frame: Frame | null, obj: any, continuable: boolean, marks: Marks = frame?.marks ?? null, mframe: number = frame?.mframe ?? 0): Frame | null {
        const handlers = markFirst(marks, EXCEPTION_HANDLERS, null);
        if (!(handlers instanceof Cons)) return this.#unhandled(ctx, frame, obj);
        const handler = handlers.car;
        const outer = markSet(marks, mframe + 1, EXCEPTION_HANDLERS, handlers.cdr);
        if (handler instanceof CatchToken) {
            if (handler.pre !== null) {
                const escape = new Frame(raiseHelpers().escapeWith, [handler, undefined, undefined], 0, frame, ctx, outer, mframe + 1);
                return this.invoke(ctx, handler.pre, escape, [obj], 0, 1, false);
            }
            const target = handler.target(frame);
            if (target === null) throw hostError("catch invoked outside of its dynamic extent");
            return this.#jumpTo(ctx, target, handler.wind, new Caught(obj));
        }
        if (continuable) return this.invoke(ctx, handler, frame, [obj], 0, 1, false, outer, mframe + 1);
        const returned = new Frame(raiseHelpers().handlerReturned, [undefined], 0, frame, ctx, outer, mframe + 1);
        return this.invoke(ctx, handler, returned, [obj], 0, 1, false);
    }

    #unhandled(ctx: ExecutionContext, frame: Frame | null, obj: any): Frame | null {
        const traceback = formatTraceback(frameInfos(frame), tracebackMessage(obj));
        const err = obj instanceof ErrorObject ? obj.error : obj;
        if (err instanceof Error && (err as any).animaTraceback === undefined) (err as any).animaTraceback = traceback;
        return this.handleHostException(ctx, frame, new UnhandledError(err, traceback));
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

    public coCreate(ctx: ExecutionContext, proc: any): Coroutine {
        if (!(proc instanceof Closure)) {
            throw hostError(`coroutine-create: expected a procedure but got ${String(proc)}`);
        }
        return new Coroutine(proc, ctx.vm, ctx.scope);
    }

    public coStatus(co: any): symbol {
        if (!(co instanceof Coroutine)) throw hostError(`coroutine-status: expected a coroutine but got ${String(co)}`);
        return Symbol.for(co.status);
    }

    public coResume(
        ctx: ExecutionContext,
        resumeTo: Frame | null,
        co: any,
        args: any[],
        marks: Marks = resumeTo?.marks ?? null,
        mframe: number = resumeTo?.mframe ?? 0
    ): Frame | null {
        if (!(co instanceof Coroutine)) throw hostError(`coroutine-resume: expected a coroutine but got ${String(co)}`);
        if (co.status !== "suspended") throw hostError(`coroutine-resume: cannot resume a ${co.status} coroutine`);

        co.resumer = { ctx, frame: resumeTo, marks, mframe };
        // a coroutine resuming another keeps its frames where they can be traced while it waits
        if (ctx.coroutine !== null) {
            ctx.coroutine.status = "normal";
            ctx.coroutine.frame = resumeTo;
        }
        co.status = "running";
        if (!co.started) {
            co.started = true;
            return this.invoke(co.ctx, co.proc, null, args, 0, args.length, false);
        }
        const frame = co.frame;
        co.frame = null;
        co.ctx.acc = packValues(args);
        return frame;
    }

    // runs a coroutine to its next yield or return in a nested driver loop and returns the value (used by the host and by direct-mode code)

    public coResumeNested(ctx: ExecutionContext | null, co: any, args: any[]): any {
        const barrier = new ExecutionContext(this.vm, co instanceof Coroutine ? co.ctx.scope : new Env());
        barrier.barrier = true;
        const outer = ctx?.coroutine ?? null;
        const frame = this.coResume(barrier, null, co, args);
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
        if (co === null) throw hostError("coroutine-yield: not inside a coroutine (or across a host call boundary)");
        if (co.closing) throw hostError("coroutine-yield: cannot yield while a coroutine is closing");
        co.frame = frame;
        co.status = "suspended";
        return this.#returnToResumer(co, val);
    }

    // starts or continues a coroutine inside the current driver loop; `resumeTo` is where its yields and final value go

    public coClose(ctx: ExecutionContext | null, co: any): void {
        if (!(co instanceof Coroutine)) throw hostError(`coroutine-close: expected a coroutine but got ${String(co)}`);
        if (co.status === "dead") return;
        if (co.status !== "suspended") throw hostError(`coroutine-close: cannot close a ${co.status} coroutine`);

        const cctx = co.ctx;
        co.frame = null;
        const actions = computeWindTransition(cctx.wind, null);
        if (actions.length === 0) {
            co.status = "dead";
            return;
        }

        const outer = ctx?.coroutine ?? null;
        if (outer !== null) outer.status = "normal";
        co.status = "running";
        co.closing = true;
        try {
            cctx.pendingWind = { actions, actionIdx: 0, targetFrame: null, targetVal: undefined, targetWind: null };
            const frame = this.advanceWindTransition(cctx);
            if (frame !== null) this.#runLoop(cctx, frame);
        } catch (err) {
            throw new ReRaise(err instanceof UnhandledError ? err.error : err);
        } finally {
            cctx.pendingWind = null;
            co.closing = false;
            co.status = "dead";
            if (outer !== null) outer.status = "running";
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
