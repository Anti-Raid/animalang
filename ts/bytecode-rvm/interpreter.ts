// The opcodes and the bytecode interpreter. The OpCode enum is declared here, next to the interpreter's switch: esbuild
// only inlines an enum's values in the file that declares it, and a switch over imported enum members is far slower
import { MissingVarError, isTruthy } from "../common";
import { ContinuationMarkSet, markSet, recordTailMark } from "../marks";
import { bindArgs } from "./arity";
import { Closure } from "./bytecode";
import type { ClosureTemplate } from "./bytecode";
import { ControlRequest, applyIntrinsic } from "./coreops";
import type { VMExecutor } from "./executor";
import { windowApplyArgs, windowRestArgs } from "./lists";
import { NO_REG, UNPACK_REST } from "./opcodes";
import { Box, CatchToken, EscapeContinuation, MISSING, restValues, tailName, unpackForBinding } from "./values";
import type { ExecutionContext, Frame } from "./values";
// The opcodes, whose operands and meaning OPCODES (opcodes.ts) describes, in the same order. Declared here because the
// interpreter switches over them: esbuild only inlines an enum's values in the file that declares it
export enum OpCode {
    LOADCONST,
    LOADU32,
    LOADUPVAR,
    SETUPVAR,
    LOADGLOBAL,
    SETGLOBAL,
    IF,
    ELSE,
    ENDIF,
    CALL,
    RETURN,
    NEWCLOSURE,
    BOX,
    UNBOX,
    SETBOX,
    MOVE,
    MOVEACC,
    BLOCK,
    LOOP,
    ENDLOOP,
    JUMP,
    UNPACK,
    SETMARK,
    MARKSAVE,
    MARKRESTORE,
    CURMARKS,
    CALLEC,
    CALLCATCH,
    CALLHOST,
    CALLINT,
    APPLYINT,
    ELSEIF,
    APPLYINTR,
    CALLCTX,
}


export class BytecodeInterpreter {
    public static run(ctx: ExecutionContext, initialFrame: Frame, executor: VMExecutor): any {
        let frame: Frame | null = initialFrame;
        while (frame !== null) {
            frame = BytecodeInterpreter.step(frame.ctx, executor.enter(frame.ctx, frame), executor);
        }
        return ctx.acc;
    }

    public static step(ctx: ExecutionContext, frame: Frame, executor: VMExecutor): Frame | null {
        const regs = frame.regs;
        const inst = frame.code.inst;
        const constants = frame.code.constants;
        let ip = frame.ip;

        try {
            while (true) {
                const opcode: OpCode = inst[ip++];
                switch (opcode) {
                    case OpCode.LOADCONST: {
                        const destReg = inst[ip++];
                        regs[destReg] = constants[inst[ip++]];
                        break;
                    }
                    case OpCode.LOADU32: {
                        const destReg = inst[ip++];
                        regs[destReg] = inst[ip++];
                        break;
                    }
                    case OpCode.LOADUPVAR: {
                        const destReg = inst[ip++];
                        const upvarIdx = inst[ip++];
                        const andUnbox = inst[ip++];
                        regs[destReg] = andUnbox ? (frame.upvars[upvarIdx] as Box).val : frame.upvars[upvarIdx];
                        break;
                    }
                    case OpCode.SETUPVAR: {
                        const srcReg = inst[ip++];
                        const upvarIdx = inst[ip++];
                        const andBox = inst[ip++];
                        frame.upvars[upvarIdx] = andBox ? new Box(regs[srcReg]) : regs[srcReg];
                        break;
                    }
                    case OpCode.LOADGLOBAL: {
                        const destReg = inst[ip++];
                        const varname = constants[inst[ip++]] as symbol;
                        const val = ctx.scope.lookup(varname, MISSING);
                        if (val === MISSING) {
                            throw new MissingVarError(`Variable '${String(varname)}' is not defined in the current scope.`);
                        }
                        regs[destReg] = val;
                        break;
                    }
                    case OpCode.SETGLOBAL: {
                        const srcReg = inst[ip++];
                        ctx.scope.set(constants[inst[ip++]], regs[srcReg]);
                        break;
                    }
                    case OpCode.IF:
                    case OpCode.ELSEIF: {
                        const condReg = inst[ip++];
                        const elseOffset = inst[ip++];
                        if (!isTruthy(regs[condReg])) {
                            ip = elseOffset;
                        }
                        break;
                    }
                    case OpCode.ELSE: {
                        ip = inst[ip];
                        break;
                    }
                    case OpCode.ENDIF: {
                        break;
                    }
                    // BLOCK and LOOP only mark structure (their operand is the end, used by AOT)
                    case OpCode.BLOCK:
                    case OpCode.LOOP: {
                        ip++;
                        break;
                    }
                    case OpCode.ENDLOOP:
                    case OpCode.JUMP: {
                        ip = inst[ip];
                        break;
                    }
                    case OpCode.UNPACK: {
                        const srcReg = inst[ip++];
                        const startReg = inst[ip++];
                        const count = inst[ip++];
                        const flags = inst[ip++];
                        const vals = unpackForBinding(regs[srcReg], count, flags);
                        for (let i = 0; i < count; i++) regs[startReg + i] = vals[i];
                        if ((flags & UNPACK_REST) !== 0) regs[startReg + count] = restValues(vals, count);
                        break;
                    }
                    case OpCode.SETMARK: {
                        const keyReg = inst[ip++];
                        frame.marks = markSet(frame.marks, frame.mframe, regs[keyReg], regs[inst[ip++]]);
                        break;
                    }
                    case OpCode.MARKSAVE: {
                        const reg = inst[ip++];
                        regs[reg] = frame.marks;
                        regs[reg + 1] = frame.mframe;
                        frame.mframe++;
                        break;
                    }
                    case OpCode.MARKRESTORE: {
                        const reg = inst[ip++];
                        frame.marks = regs[reg];
                        frame.mframe = regs[reg + 1];
                        break;
                    }
                    case OpCode.CURMARKS: {
                        regs[inst[ip++]] = new ContinuationMarkSet(frame.marks);
                        break;
                    }
                    case OpCode.NEWCLOSURE: {
                        const destReg = inst[ip++];
                        const template = constants[inst[ip++]] as ClosureTemplate;
                        regs[destReg] = Closure.create(template, regs, frame.upvars);
                        break;
                    }
                    case OpCode.BOX: {
                        const destReg = inst[ip++];
                        regs[destReg] = new Box(regs[inst[ip++]]);
                        break;
                    }
                    case OpCode.UNBOX: {
                        const destReg = inst[ip++];
                        regs[destReg] = (regs[inst[ip++]] as Box).val;
                        break;
                    }
                    case OpCode.SETBOX: {
                        const destReg = inst[ip++];
                        (regs[destReg] as Box).val = regs[inst[ip++]];
                        break;
                    }
                    case OpCode.MOVE: {
                        const destReg = inst[ip++];
                        regs[destReg] = regs[inst[ip++]];
                        break;
                    }
                    case OpCode.RETURN: {
                        ctx.acc = regs[inst[ip++]];
                        frame.ip = ip;
                        return executor.setRetVal(ctx, frame.parent, ctx.acc);
                    }
                    case OpCode.CALL: {
                        const proc = regs[inst[ip++]];
                        const startReg = inst[ip++];
                        const nargs = inst[ip++];
                        const isTail = inst[ip++] !== 0;
                        if (isTail && frame.code.debug) frame.marks = recordTailMark(frame.marks, frame.mframe, tailName(proc));

                        // self tail call: rebind the params in place and jump back to the start
                        if (isTail && proc === frame.closure && !frame.isShared(ctx)) {
                            const arity = proc.tmpl.arity;
                            if (nargs >= arity.min && nargs <= arity.max) {
                                // bindArgs, with its common case inline: V8 does not inline calls into this loop
                                if (arity.rest === "none") for (let i = 0; i < nargs; i++) regs[i] = regs[startReg + i];
                                else bindArgs(arity, regs, regs, startReg, nargs);
                                ip = 0;
                                break;
                            }
                        }

                        frame.ip = ip;
                        return executor.invoke(ctx, proc, frame, regs, startReg, nargs, isTail);
                    }
                    case OpCode.MOVEACC: {
                        regs[inst[ip++]] = ctx.acc;
                        break;
                    }
                    case OpCode.CALLINT: {
                        const fn = frame.code.table!.fns[inst[ip++]];
                        const destReg = inst[ip++];
                        const startReg = inst[ip++];
                        regs[destReg] = fn(regs, startReg, inst[ip++]);
                        break;
                    }
                    case OpCode.CALLCTX: {
                        const fn = frame.code.table!.fns[inst[ip++]];
                        const destReg = inst[ip++];
                        const startReg = inst[ip++];
                        regs[destReg] = fn(regs, startReg, inst[ip++], ctx, executor);
                        break;
                    }
                    case OpCode.APPLYINT: {
                        const entry = frame.code.table!.entries[inst[ip++]];
                        const destReg = inst[ip++];
                        const startReg = inst[ip++];
                        regs[destReg] = applyIntrinsic(entry.fn, entry.name, entry.min, entry.max, windowApplyArgs(regs, startReg, inst[ip++]), ctx, executor);
                        break;
                    }
                    case OpCode.APPLYINTR: {
                        const entry = frame.code.table!.entries[inst[ip++]];
                        const destReg = inst[ip++];
                        const startReg = inst[ip++];
                        const nargs = inst[ip++];
                        // a rest array alone is the argument array itself: intrinsics never write to or keep it
                        regs[destReg] = applyIntrinsic(entry.fn, entry.name, entry.min, entry.max, nargs === 1 ? regs[startReg] : windowRestArgs(regs, startReg, nargs, false), ctx, executor);
                        break;
                    }
                    case OpCode.CALLEC: {
                        const procReg = inst[ip++];
                        const tokReg = inst[ip++];
                        regs[tokReg] = new EscapeContinuation(ctx.id, ctx.wind, frame.code, tokReg);
                        frame.ip = ip;
                        return executor.invoke(ctx, regs[procReg], frame, regs, tokReg, 1, false);
                    }
                    case OpCode.CALLCATCH: {
                        const procReg = inst[ip++];
                        const tokReg = inst[ip++];
                        const preReg = inst[ip++];
                        const tok = regs[tokReg] = new CatchToken(ctx.id, ctx.wind, frame.code, tokReg, preReg === NO_REG ? null : regs[preReg]);
                        frame.ip = ip;
                        return executor.callCatch(ctx, regs[procReg], frame, tok);
                    }
                    case OpCode.CALLHOST: {
                        const entry = frame.code.table!.entries[inst[ip++]];
                        const startReg = inst[ip++];
                        const nargs = inst[ip++];
                        const isTail = inst[ip++] !== 0;
                        frame.ip = ip;
                        // only core operations take the context: passing it to the others costs measurably
                        const res = entry.context ? entry.fn(regs, startReg, nargs, ctx, executor) : entry.fn(regs, startReg, nargs);
                        if (res instanceof ControlRequest) {
                            if (isTail && frame.code.debug && res.tailProc !== undefined) frame.marks = recordTailMark(frame.marks, frame.mframe, tailName(res.tailProc));
                            return res.run(ctx, executor, frame, isTail);
                        }
                        ctx.acc = res;
                        if (isTail) return executor.setRetVal(ctx, frame.parent, res);
                        break;
                    }
                    default: {
                        const _: never = opcode;
                        throw new Error(`Unhandled opcode: ${opcode}`);
                    }
                }
            }
        } catch (err) {
            frame.ip = ip;
            return executor.handleHostException(ctx, frame, err);
        }
    }
}
