import {
    ErrorObject,
    flattenDynamicArgs,
    Table,
    IProcedure,
    type AbstractVM,
} from "../common";
import { Cons } from "../list";
import { ApplyProc, BuiltinFunction, CallCCProc, TryProc } from "../std";
import {
    Box,
    ByteCode,
    Closure,
    ClosureTemplate,
    createRegs,
} from "./bytecodedef";

export class ExecutionContext {
    public static nextId: number = 0;
    public id: number;
    public acc: any = null;
    public epoch: number = 0;
    public currentFrame: Frame | null = null;
    public exceptionHandlers: (Frame | null)[] = [];

    constructor(
        public vm: AbstractVM,
        public scope: Table
    ) {
        this.id = ++ExecutionContext.nextId;
    }
}

export class VMContinuation extends IProcedure {
    constructor(
        public frame: Frame | null,
        public ctxId: number
    ) {
        super("continuation");
    }
}

export class Frame {
    constructor(
        public code: ByteCode,
        public regs: any[],
        public upvars: any[],
        public ip: number,
        public parent: Frame | null,
        public retDestReg: number = -1,
        public epoch: number = 0,
        public debugName: string = "anonymous"
    ) {}

    readNext(): number {
        if (this.ip >= this.code.inst.length) {
            throw new Error(`internal error: unexpected end of bytecode, instruction pointer out of bounds (${this.ip} >= ${this.code.inst.length}).`);
        }
        return this.code.inst[this.ip++];
    }

    getConst(idx: number): any {
        return this.code.constants[idx];
    }

    thaw(ctx: ExecutionContext): Frame {
        return new Frame(this.code, [...this.regs], this.upvars, this.ip, this.parent, this.retDestReg, ctx.epoch, this.debugName);
    }

    share(ctx: ExecutionContext): this {
        ctx.epoch++;
        return this;
    }

    isShared(ctx: ExecutionContext): boolean {
        return this.epoch < ctx.epoch;
    }
}

export class VMExecutor {
    constructor(public vm: AbstractVM) {}

    public execAot(ctx: ExecutionContext, initialFrame: Frame): any {
        let frame: Frame | null = initialFrame;

        while (frame !== null) {
            ctx.currentFrame = frame;

            if (frame.isShared(ctx)) {
                frame = frame.thaw(ctx);
                ctx.currentFrame = frame;
            }

            if (frame.code.nativeFn !== null) {
                frame = frame.code.nativeFn(ctx, frame, this.vm, this);
                continue;
            }

            throw new Error(`AOT mode encountered uncompiled code in frame: ${frame.debugName}`);
        }

        return ctx.acc;
    }

    public invoke(
        ctx: ExecutionContext,
        proc: any,
        callerFrame: Frame,
        callerArgs: any[],
        startReg: number,
        nargs: number,
        isTail: boolean
    ): Frame | null {
        if (proc instanceof BuiltinFunction) {
            ctx.acc = proc.cb(callerArgs, startReg, nargs);
            const target = isTail ? callerFrame.parent : callerFrame;
            return this.setRetVal(ctx, target, ctx.acc);
        } else if (proc instanceof Closure) {
            const pregs = this.createClosureArg(proc.tmpl, nargs, callerArgs, startReg);
            const debugName = proc.debugName ?? "lambda";
            if (isTail) {
                if (!callerFrame.isShared(ctx)) {
                    return this.reset(callerFrame, proc.tmpl.code, pregs, proc.upvars, debugName);
                }
                return this.newFrame(ctx, proc.tmpl.code, pregs, proc.upvars, callerFrame.parent, debugName);
            }
            return this.newFrame(ctx, proc.tmpl.code, pregs, proc.upvars, callerFrame, debugName);
        } else if (proc instanceof ApplyProc) {
            const actualProc = callerArgs[startReg];
            const actualArgs = flattenDynamicArgs([], callerArgs, startReg, nargs, "apply");
            return this.invoke(ctx, actualProc, callerFrame, actualArgs, 0, actualArgs.length, isTail);
        } else if (proc instanceof TryProc) {
            const actualProc = callerArgs[startReg];
            const actualArgs = flattenDynamicArgs([], callerArgs, startReg, nargs, "try");
            const trapFrame = isTail ? callerFrame.parent : callerFrame;
            ctx.exceptionHandlers.push(trapFrame);

            try {
                return this.invoke(ctx, actualProc, callerFrame, actualArgs, 0, actualArgs.length, isTail);
            } catch (err) {
                if (ctx.exceptionHandlers.length > 0 && ctx.exceptionHandlers[ctx.exceptionHandlers.length - 1] === trapFrame) {
                    ctx.exceptionHandlers.pop();
                }
                ctx.acc = new ErrorObject(err);
                return this.setRetVal(ctx, trapFrame, ctx.acc);
            }
        } else if (proc instanceof CallCCProc) {
            callerFrame.share(ctx);
            const targetFrame = isTail ? callerFrame.parent : callerFrame;
            const vmCont = new VMContinuation(targetFrame, ctx.id);
            const userProc = callerArgs[startReg];
            return this.invoke(ctx, userProc, callerFrame, [vmCont], 0, 1, isTail);
        } else if (proc instanceof VMContinuation) {
            if (proc.ctxId !== ctx.id) {
                throw new Error("Cannot invoke a continuation across execution/FFI boundary");
            }
            if (nargs !== 1) throw new Error(`continuation expected exactly 1 argument, but received ${nargs}`);
            ctx.acc = callerArgs[startReg];
            return this.setRetVal(ctx, proc.frame, ctx.acc);
        } else {
            throw new Error(`Attempted to call a non-procedure: ${String(proc)}`);
        }
    }

    public setRetVal(ctx: ExecutionContext, frame: Frame | null, val: any): Frame | null {
        if (ctx.exceptionHandlers.length > 0 && ctx.exceptionHandlers[ctx.exceptionHandlers.length - 1] === frame) {
            ctx.exceptionHandlers.pop();
        }
        if (frame !== null && frame.retDestReg !== -1) {
            if (frame.isShared(ctx)) {
                frame = frame.thaw(ctx);
            }
            frame.regs[frame.retDestReg] = val;
            frame.retDestReg = -1;
        }
        return frame;
    }

    public newFrame(
        ctx: ExecutionContext,
        code: ByteCode,
        regs: any[],
        upvars: any[],
        parent: Frame | null,
        debugName: string = "anonymous"
    ): Frame {
        return new Frame(code, regs, upvars, 0, parent, -1, ctx.epoch, debugName);
    }

    public reset(
        frame: Frame,
        code: ByteCode,
        regs: any[],
        upvars: any[],
        debugName: string = "anonymous"
    ): Frame {
        frame.code = code;
        frame.regs = regs;
        frame.upvars = upvars;
        frame.ip = 0;
        frame.retDestReg = -1;
        frame.debugName = debugName;
        return frame;
    }

    public createClosureArg(template: ClosureTemplate, nargs: number, args: any[], startOffset: number): any[] {
        const arity = template.params.length;
        if (template.remParams !== null) {
            if (nargs < arity) {
                throw new Error(`expected at least ${arity} args, got ${nargs}`);
            }
        } else {
            if (nargs !== arity) {
                throw new Error(`expected exactly ${arity} args, got ${nargs}`);
            }
        }

        const closureRegs = createRegs(template.code.numReg);

        for (let i = 0; i < arity; i++) {
            closureRegs[i] = args[startOffset + i];
        }

        if (template.remParams !== null) {
            const restCount = nargs - arity;
            let restList: any = null;
            for (let i = restCount - 1; i >= 0; i--) {
                restList = new Cons(args[startOffset + arity + i], restList);
            }
            closureRegs[arity] = restList;
        }

        return closureRegs;
    }
}
