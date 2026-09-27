import { ErrorObject, Env, VMError, unpackValues, type SourcePos } from "../common";
import { type ExecutionMode, OpCode, CodeEmitter, AotCompiler, ExecutionContext, Frame, VMContinuation, VMExecutor, BytecodeInterpreter, ByteCode, Closure, ClosureTemplate, Coroutine, ReRaise, createRegs, frameInfos, formatTraceback } from "./exec";
import { Intrinsics } from "./intrinsics";
import { newIntrinsics } from "./core";

export {
    CodeEmitter,
    AotCompiler,
    ExecutionContext,
    Frame,
    VMContinuation,
    VMExecutor,
    BytecodeInterpreter,
    ByteCode,
    OpCode,
    Coroutine
};

export type { ExecutionMode };

export class AnimaVM {
    readonly executor: VMExecutor;
    public mode: ExecutionMode;

    // the intrinsics this VM's compiler compiles against (code carries the table it was compiled or loaded with)
    constructor(mode: ExecutionMode = "interp", readonly intrinsics: Intrinsics = newIntrinsics()) {
        this.mode = mode;
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

    public evaluateRaw(code: ByteCode, scope: Env): any {
        const ctx = new ExecutionContext(this, scope);
        const topClosure = new Closure(new ClosureTemplate([], null, code, []), [], "top-level");
        return this.#run(ctx, this.executor.newFrame(ctx, topClosure, createRegs(code.numReg), null));
    }

    public evaluateClosure(code: Closure, scope: Env, args: any[]): any {
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

    // stack traceback of a suspended coroutine (empty if it has not started or is dead)
    public traceback(co: Coroutine, msg?: string): string {
        if (!(co instanceof Coroutine)) throw new Error("traceback: expected a coroutine");
        return formatTraceback(frameInfos(co.frame), msg, this.intrinsics.format);
    }

    #run(ctx: ExecutionContext, frame: Frame): any {
        if (this.mode === "aot") {
            AotCompiler.compileAll(frame.code, frame.closure.tmpl);
            return AotCompiler.run(ctx, frame, this.executor);
        }
        return BytecodeInterpreter.run(ctx, frame, this.executor);
    }
}
