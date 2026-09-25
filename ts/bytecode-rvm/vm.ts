import { ASTStringifier, ErrorObject, Env, unpackValues, type AbstractVM } from "../common";
import { OpCode, CodeEmitter, AotCompiler, ExecutionContext, Frame, VMContinuation, VMExecutor, BytecodeInterpreter, ByteCode, Closure, ClosureTemplate, Coroutine, ReRaise, createRegs, frameInfos, formatTraceback } from "./exec";

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

export type ExecutionMode = "interp" | "aot";

export class AnimaVM implements AbstractVM {
    readonly executor: VMExecutor;
    public mode: ExecutionMode;

    constructor(mode: ExecutionMode = "interp") {
        this.mode = mode;
        this.executor = new VMExecutor(this);
    }

    public evaluateRaw(code: ByteCode, scope: Env): any {
        const ctx = new ExecutionContext(this, scope);
        const topClosure = new Closure(new ClosureTemplate([], null, code, []), [], "top-level");
        return this.#run(ctx, this.executor.newFrame(ctx, topClosure, createRegs(code.numReg), null));
    }

    public evaluateClosure(code: Closure, scope: Env, args: any[]): any {
        const ctx = new ExecutionContext(this, scope);
        const cargs = this.executor.createClosureArg(code.tmpl, args.length, args, 0);
        return this.#run(ctx, this.executor.newFrame(ctx, code, cargs, null));
    }

    public resumeCoroutine(co: Coroutine, args: any[]): { done: boolean, value: any, values: any[] } {
        try {
            const values = unpackValues(this.executor.coResumeNested(null, co, args));
            return { done: co.status === "dead", value: values[0], values };
        } catch (err) {
            if (!(err instanceof ReRaise)) throw err;
            const val = err.value instanceof ErrorObject ? err.value.error : err.value;
            throw val instanceof Error ? val : new Error(new ASTStringifier().stringify(val));
        }
    }

    public closeCoroutine(co: Coroutine): void {
        try {
            this.executor.coClose(null, co);
        } catch (err) {
            if (!(err instanceof ReRaise)) throw err;
            const val = err.value instanceof ErrorObject ? err.value.error : err.value;
            throw val instanceof Error ? val : new Error(new ASTStringifier().stringify(val));
        }
    }

    // stack traceback of a suspended coroutine (empty if it has not started or is dead)
    public traceback(co: Coroutine, msg?: string): string {
        if (!(co instanceof Coroutine)) throw new Error("traceback: expected a coroutine");
        return formatTraceback(frameInfos(co.frame), msg, co.ctx.tailHistory);
    }

    #run(ctx: ExecutionContext, frame: Frame): any {
        if (this.mode === "aot") {
            AotCompiler.compileAll(frame.code, frame.closure.tmpl);
            return AotCompiler.run(ctx, frame, this.executor);
        }
        return BytecodeInterpreter.run(ctx, frame, this.executor);
    }
}
