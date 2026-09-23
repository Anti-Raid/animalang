import {
    Box,
    BUILTINS_START,
    Closure,
    ClosureTemplate,
    OpCode,
} from "./bytecodedef";
import { IBUILTINS } from "../std";
import { ErrorObject, isTruthy, MissingVarError } from "../common";
import type { ExecutionContext, Frame, VMExecutor } from "./core";

export class BytecodeInterpreter {
    public static run(ctx: ExecutionContext, initialFrame: Frame, executor: VMExecutor): any {
        let frame: Frame | null = initialFrame;

        while (frame !== null) {
            ctx.currentFrame = frame;

            if (frame.isShared(ctx)) {
                frame = frame.thaw(ctx);
                ctx.currentFrame = frame;
            }

            const regs = frame.regs;

            try {
                const opcode: OpCode = frame.readNext();
                switch (opcode) {
                    case OpCode.LOADCONST: {
                        const destReg = frame.readNext();
                        const constIdx = frame.readNext();
                        regs[destReg] = frame.getConst(constIdx);
                        break;
                    }
                    case OpCode.LOADU32: {
                        const destReg = frame.readNext();
                        const u32Val = frame.readNext();
                        regs[destReg] = u32Val;
                        break;
                    }
                    case OpCode.NEGATE: {
                        const reg = frame.readNext();
                        if (typeof regs[reg] !== "number") {
                            throw new Error("cannot negate non-number");
                        }
                        regs[reg] = -regs[reg];
                        break;
                    }
                    case OpCode.LOADUPVAR: {
                        const destReg = frame.readNext();
                        const upvarIdx = frame.readNext();
                        const andUnbox = frame.readNext();
                        regs[destReg] = andUnbox ? (frame.upvars[upvarIdx] as Box).val : frame.upvars[upvarIdx];
                        break;
                    }
                    case OpCode.SETUPVAR: {
                        const srcReg = frame.readNext();
                        const upvarIdx = frame.readNext();
                        const andBox = frame.readNext();
                        frame.upvars[upvarIdx] = andBox ? new Box(regs[srcReg]) : regs[srcReg];
                        break;
                    }
                    case OpCode.LOADGLOBAL: {
                        const destReg = frame.readNext();
                        const varname = frame.getConst(frame.readNext()) as symbol;
                        if (!ctx.scope.has(varname)) {
                            throw new MissingVarError(`Variable '${String(varname)}' is not defined in the current scope.`);
                        }
                        regs[destReg] = ctx.scope.get(varname);
                        break;
                    }
                    case OpCode.SETGLOBAL: {
                        const srcReg = frame.readNext();
                        const varname = frame.getConst(frame.readNext()) as symbol;
                        ctx.scope.set(varname, regs[srcReg]);
                        break;
                    }
                    case OpCode.HASGLOBAL: {
                        const varname = frame.getConst(frame.readNext()) as symbol;
                        if (!ctx.scope.has(varname)) {
                            throw new MissingVarError(`Variable '${String(varname)}' is not defined in the current scope.`);
                        }
                        break;
                    }
                    case OpCode.IF: {
                        const condReg = frame.readNext();
                        const elseOffset = frame.readNext();
                        if (!isTruthy(regs[condReg])) {
                            frame.ip = elseOffset;
                        }
                        break;
                    }
                    case OpCode.ELSE: {
                        const endOffset = frame.readNext();
                        frame.ip = endOffset;
                        break;
                    }
                    case OpCode.ENDIF: {
                        break;
                    }
                    case OpCode.NEWCLOSURE: {
                        const destReg = frame.readNext();
                        const tidx = frame.readNext();
                        const template = frame.getConst(tidx) as ClosureTemplate;
                        regs[destReg] = Closure.create(template, regs, frame.upvars);
                        break;
                    }
                    case OpCode.BOX: {
                        const destReg = frame.readNext();
                        const srcReg = frame.readNext();
                        regs[destReg] = new Box(regs[srcReg]);
                        break;
                    }
                    case OpCode.UNBOX: {
                        const destReg = frame.readNext();
                        const srcReg = frame.readNext();
                        regs[destReg] = (regs[srcReg] as Box).val;
                        break;
                    }
                    case OpCode.SETBOX: {
                        const destReg = frame.readNext();
                        const srcReg = frame.readNext();
                        (regs[destReg] as Box).val = regs[srcReg];
                        break;
                    }
                    case OpCode.MOVE: {
                        const destReg = frame.readNext();
                        const srcReg = frame.readNext();
                        regs[destReg] = regs[srcReg];
                        break;
                    }
                    case OpCode.RETURN: {
                        const reg = frame.readNext();
                        ctx.acc = regs[reg];
                        frame = executor.setRetVal(ctx, frame.parent, ctx.acc);
                        break;
                    }
                    case OpCode.CALL: {
                        const procIdx = frame.readNext();
                        const proc = (procIdx < BUILTINS_START) ? regs[procIdx] : IBUILTINS[procIdx - BUILTINS_START];
                        const destReg = frame.readNext();
                        const startReg = frame.readNext();
                        const nargs = frame.readNext();
                        frame.retDestReg = destReg;
                        frame = executor.invoke(ctx, proc, frame, regs, startReg, nargs, false);
                        break;
                    }
                    case OpCode.TAILCALL: {
                        const procIdx = frame.readNext();
                        const proc = (procIdx < BUILTINS_START) ? regs[procIdx] : IBUILTINS[procIdx - BUILTINS_START];
                        const startReg = frame.readNext();
                        const nargs = frame.readNext();
                        frame = executor.invoke(ctx, proc, frame, regs, startReg, nargs, true);
                        break;
                    }
                    default: {
                        const _: never = opcode;
                        throw new Error(`Unhandled opcode: ${opcode}`);
                    }
                }
            } catch (err) {
                if (ctx.exceptionHandlers.length > 0) {
                    const trapFrame = ctx.exceptionHandlers.pop()!;
                    ctx.acc = new ErrorObject(err);
                    frame = executor.setRetVal(ctx, trapFrame, ctx.acc);
                    continue;
                }
                throw err;
            }
        }

        return ctx.acc;
    }
}
