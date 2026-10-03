import { ErrorObject, Env, VMError, unpackValues, type SourcePos } from "../common";
import { CodeEmitter, AotCompiler, ExecutionContext, Frame, VMContinuation, VMExecutor, Code, Closure, ClosureTemplate, Coroutine, InterruptError, ReRaise, createRegs, frameInfos, formatTraceback } from "./exec";
import { Intrinsics } from "./intrinsics";
import { newIntrinsics } from "./core";
import { CaseLambda } from "./code";

export {
    CodeEmitter,
    AotCompiler,
    ExecutionContext,
    Frame,
    VMContinuation,
    VMExecutor,
    Code,
    Coroutine
};

export class AnimaVM {
    readonly executor: VMExecutor;
    // the intrinsics this VM's compiler compiles against (code carries the table it was compiled with)
    constructor(readonly intrinsics: Intrinsics = newIntrinsics()) {
        this.executor = new VMExecutor(this);
    }

    print(v: any): string {
        return this.intrinsics.print(v);
    }

    // the error's message as this VM's front end words it
    message<E>(err: E, at: SourcePos | null = null): E {
        if (err instanceof VMError) {
            err.at ??= at;
            err.format(this.intrinsics.format);
        }
        return err;
    }

    public evaluateRaw(code: Code, scope: Env): any {
        if (this.intrinsics.interrupts && !code.interrupts) throw new Error("this code was compiled without interrupt checks, but interrupts are on: compile it again");
        const ctx = new ExecutionContext(this, scope);
        const topClosure = new Closure(new ClosureTemplate([], null, code, []), [], "top-level");
        return this.#run(ctx, this.executor.newFrame(ctx, topClosure, createRegs(code.numReg), null));
    }

    public evaluateClosure(code: Closure | CaseLambda, scope: Env, args: any[]): any {
        if (code instanceof CaseLambda) code = this.#entry(() => (code as CaseLambda).select(args.length));
        const ctx = new ExecutionContext(this, scope);
        const cargs = this.executor.createClosureArg(code, args.length, args, 0);
        return this.#run(ctx, this.executor.newFrame(ctx, code, cargs, null));
    }

    public resumeCoroutine(co: Coroutine, args: any[], raising: boolean = false): { done: boolean, value: any, values: any[] } {
        try {
            const values = unpackValues(this.executor.coResumeNested(null, co, args, raising));
            return { done: co.status === "dead", value: values[0], values };
        } catch (err) {
            if (!(err instanceof ReRaise)) throw this.message(err);
            const val = err.value instanceof ErrorObject ? err.value.error : err.value;
            throw val instanceof Error ? val : new Error(this.print(val));
        }
    }

    public closeCoroutine(co: Coroutine): void {
        try {
            this.executor.coClose(null, co);
        } catch (err) {
            if (!(err instanceof ReRaise)) throw this.message(err);
            const val = err.value instanceof ErrorObject ? err.value.error : err.value;
            throw val instanceof Error ? val : new Error(this.print(val));
        }
    }

    // the coroutine running the code that called into the host now, or null outside any
    public currentCoroutine(): Coroutine | null {
        return this.executor.running;
    }

    // whether the Anima code that called into the host now could yield: inside a coroutine that is not being closed
    public coroutineYieldable(): boolean {
        const co = this.executor.running;
        return co !== null && !co.closing;
    }

    // stack traceback of a suspended coroutine (empty if it has not started or is dead)
    public traceback(co: Coroutine, msg?: string): string {
        if (!(co instanceof Coroutine)) throw new Error("traceback: expected a coroutine");
        return formatTraceback(frameInfos(co.frame), msg, this.intrinsics.format);
    }

    // an error that leaves for the host is worded, whatever path it took out; code run from the host runs outside any
    // coroutine, until it resumes one
    #entry<T>(run: () => T): T {
        const running = this.executor.running;
        this.executor.running = null;
        try {
            return run();
        } catch (err) {
            // a stop: the coroutines it left die
            if (err instanceof InterruptError) this.executor.abortRunning();
            throw this.message(err);
        } finally {
            this.executor.running = running;
            this.executor.dropPendingPause();
        }
    }

    #run(ctx: ExecutionContext, frame: Frame): any {
        return this.#entry(() => {
            AotCompiler.compileAll(frame.code, frame.closure.tmpl);
            return AotCompiler.run(ctx, frame, this.executor);
        });
    }
}
