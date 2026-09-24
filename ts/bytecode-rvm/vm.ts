import { ASTStringifier, ErrorObject, Table, unpackValues, type AbstractVM } from "../common";
import { OpCode, CodeEmitter, JITCompiler, ExecutionContext, Frame, VMContinuation, VMExecutor, BytecodeInterpreter, ByteCode, Closure, ClosureTemplate, Coroutine, ReRaise, createRegs } from "./exec";

export {
    CodeEmitter,
    JITCompiler,
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

    public evaluateRaw(code: ByteCode, scope: Table): any {
        const ctx = new ExecutionContext(this, scope);
        const topClosure = new Closure(new ClosureTemplate([], null, code, []), [], "top-level");
        return this.#run(ctx, this.executor.newFrame(ctx, topClosure, createRegs(code.numReg), null));
    }

    public evaluateClosure(code: Closure, scope: Table, args: any[]): any {
        const ctx = new ExecutionContext(this, scope);
        const cargs = this.executor.createClosureArg(code.tmpl, args.length, args, 0);
        return this.#run(ctx, this.executor.newFrame(ctx, code, cargs, null));
    }

    public resumeCoroutine(co: Coroutine, args: any[]): { done: boolean, value: any, values: any[] } {
        try {
            const values = unpackValues(this.executor.coResume(null, co, args));
            return { done: co.status === "dead", value: values[0], values };
        } catch (err) {
            if (!(err instanceof ReRaise)) throw err;
            const val = err.value instanceof ErrorObject ? err.value.error : err.value;
            throw val instanceof Error ? val : new Error(new ASTStringifier().stringify(val));
        }
    }

    #run(ctx: ExecutionContext, frame: Frame): any {
        try {
            if (this.mode === "aot") {
                JITCompiler.compileAll(frame.code, frame.closure.tmpl);
                return JITCompiler.run(ctx, frame, this.executor);
            }
            return BytecodeInterpreter.run(ctx, frame, this.executor);
        } catch (err: any) {
            const active = ctx.currentFrame ?? frame;
            console.log(`${err.stack}\n\nCurrent Frame [${active.debugName}] IP: ${active.ip}`);
            throw err;
        }
    }
}
