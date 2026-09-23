import { Table, type AbstractVM } from "../common";
import { OpCode, CodeEmitter, JITCompiler, ExecutionContext, Frame, VMContinuation, VMExecutor, BytecodeInterpreter, ByteCode, Closure, ClosureTemplate, createRegs } from "./exec";

export {
    CodeEmitter,
    JITCompiler,
    ExecutionContext,
    Frame,
    VMContinuation,
    VMExecutor,
    BytecodeInterpreter,
    ByteCode,
    OpCode
};

export type ExecutionMode = "interp" | "aot";

export function compileAot(code: ByteCode): void {
    if (code.nativeFn === null) {
        JITCompiler.compile(code);
    }
    for (const c of code.constants) {
        if (c instanceof ClosureTemplate) {
            compileAot(c.code);
        }
        if (c instanceof Closure) {
            compileAot(c.tmpl.code);
        }
    }
}

export class AnimaVM implements AbstractVM {
    readonly executor: VMExecutor;
    public mode: ExecutionMode;

    constructor(mode: ExecutionMode = "interp") {
        this.mode = mode;
        this.executor = new VMExecutor(this);
    }

    public evaluateRaw(code: ByteCode, scope: Table): any {
        if (this.mode === "aot") {
            compileAot(code);
        }
        const ctx = new ExecutionContext(this, scope);
        const topClosure = new Closure(new ClosureTemplate([], null, code, []), [], "top-level");
        const frame: Frame = this.executor.newFrame(ctx, topClosure, createRegs(code.numReg), null);
        try {
            if (this.mode === "aot") {
                return this.executor.execAot(ctx, frame);
            } else {
                return BytecodeInterpreter.run(ctx, frame, this.executor);
            }
        } catch (err: any) {
            const active = ctx.currentFrame ?? frame;
            console.log(`${err.stack}\n\nCurrent Frame [${active.debugName}] IP: ${active.ip}`);
            throw err;
        }
    }

    public evaluateClosure(code: Closure, scope: Table, args: any[]): any {
        if (this.mode === "aot") {
            compileAot(code.tmpl.code);
        }
        const ctx = new ExecutionContext(this, scope);
        const cargs = this.executor.createClosureArg(code.tmpl, args.length, args, 0);
        const frame: Frame = this.executor.newFrame(ctx, code, cargs, null);
        try {
            if (this.mode === "aot") {
                return this.executor.execAot(ctx, frame);
            } else {
                return BytecodeInterpreter.run(ctx, frame, this.executor);
            }
        } catch (err: any) {
            const active = ctx.currentFrame ?? frame;
            console.log(`${err.stack}\n\nCurrent Frame [${active.debugName}] IP: ${active.ip}`);
            throw err;
        }
    }
}