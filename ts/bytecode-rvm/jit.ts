import {
    ErrorObject,
    MissingVarError,
    isTruthy,
} from "../common";
import {
    Box,
    BUILTINS_START,
    ByteCode,
    Closure,
    INSTRUCTION_LENGTHS,
    OpCode,
    type NativeFn,
} from "./bytecodedef";
import {
    BuiltinFunction,
    IBUILTINS,
    type BuiltinCodeGenFn,
} from "../std";
import { CodeEmitter } from "./code-emitter";

export class JITCompiler {
    public static getBuiltinFunctionCodeGen(procIdx: number): BuiltinCodeGenFn | null {
        if (procIdx >= BUILTINS_START) {
            const builtin = IBUILTINS[procIdx - BUILTINS_START];
            if (builtin instanceof BuiltinFunction && builtin.codeGenFn) {
                return builtin.codeGenFn;
            }
        }
        return null;
    }

    public static compile(code: ByteCode): NativeFn {
        const fn = this.generateFunction(code);
        code.nativeFn = fn;
        return fn;
    }

    public static generateFunction(code: ByteCode): NativeFn {
        const source = this.generateSource(code);
        const factory = new Function(
            "IBUILTINS",
            "BUILTINS_START",
            "isTruthy",
            "Box",
            "ErrorObject",
            "MissingVarError",
            "Closure",
            "BuiltinFunction",
            source
        );
        return factory(
            IBUILTINS,
            BUILTINS_START,
            isTruthy,
            Box,
            ErrorObject,
            MissingVarError,
            Closure,
            BuiltinFunction
        );
    }

    // Finds basic blocks that point to start of next inst
    //
    // needed for call/cc to know where to resume in pure jit mode
    public static findBasicBlocks(inst: Uint32Array): number[] {
        const blocks = new Set<number>([0]);
        let ip = 0;
        while (ip < inst.length) {
            const opIp = ip;
            const opcode: OpCode = inst[ip];
            const len = INSTRUCTION_LENGTHS[opcode] ?? 1;
            const nextIp = opIp + len;

            switch (opcode) {
                case OpCode.IF: {
                    const elseOffset = inst[opIp + 2];
                    blocks.add(nextIp);
                    blocks.add(elseOffset);
                    break;
                }
                case OpCode.ELSE: {
                    const endOffset = inst[opIp + 1];
                    blocks.add(endOffset);
                    break;
                }
                case OpCode.CALL: {
                    const procIdx = inst[opIp + 1];
                    const codeGen = this.getBuiltinFunctionCodeGen(procIdx);
                    const isBuiltin = procIdx >= BUILTINS_START && IBUILTINS[procIdx - BUILTINS_START] instanceof BuiltinFunction;
                    if (!codeGen && !isBuiltin) {
                        blocks.add(nextIp);
                    }
                    break;
                }
            }

            ip = nextIp;
        }
        return Array.from(blocks).sort((a, b) => a - b);
    }

    public static generateSource(code: ByteCode): string {
        const inst = code.inst;
        const out = new CodeEmitter();
        const basicBlocks = this.findBasicBlocks(inst);
        const blockSet = new Set(basicBlocks);

        out.emit(`
            return function(ctx, frame, vm, executor) {
                const regs = frame.regs;
                const upvars = frame.upvars;
                const constants = frame.code.constants;
                try {
        `);

        if (basicBlocks.length <= 1) {
            this.emitInstructions(out, inst, 0, inst.length, null);
        } else {
            out.emit(`
                let ip = frame.ip;
                while (true) {
                    switch (ip) {
            `);
            for (let i = 0; i < basicBlocks.length; i++) {
                const blockStart = basicBlocks[i];
                const blockEnd = (i + 1 < basicBlocks.length) ? basicBlocks[i + 1] : inst.length;
                out.emit(`case ${blockStart}: {`);
                this.emitInstructions(out, inst, blockStart, blockEnd, blockSet);
                out.emit(`}`);
            }
            out.emit(`
                    }
                }
            `);
        }

        out.emit(`
                    return null;
                } catch (err) {
                    if (ctx.exceptionHandlers.length > 0) {
                        const trapFrame = ctx.exceptionHandlers.pop();
                        ctx.acc = new ErrorObject(err);
                        return executor.setRetVal(ctx, trapFrame, ctx.acc);
                    }
                    throw err;
                }
            };
        `);

        return out.toString();
    }

    private static emitInstructions(
        out: CodeEmitter,
        inst: Uint32Array,
        startIp: number,
        endIp: number,
        blockSet: Set<number> | null
    ): void {
        let ip = startIp;

        while (ip < endIp) {
            const opIp = ip;
            const opcode: OpCode = inst[ip++];

            switch (opcode) {
                case OpCode.LOADCONST: {
                    const destReg = inst[ip++];
                    const constIdx = inst[ip++];
                    out.emit(`regs[${destReg}] = constants[${constIdx}];`);
                    break;
                }
                case OpCode.LOADU32: {
                    const destReg = inst[ip++];
                    const u32Val = inst[ip++];
                    out.emit(`regs[${destReg}] = ${u32Val};`);
                    break;
                }
                case OpCode.NEGATE: {
                    const reg = inst[ip++];
                    out.emit(`
                        if (typeof regs[${reg}] !== "number") {
                            frame.ip = ${opIp};
                            throw new Error("cannot negate non-number");
                        }
                        regs[${reg}] = -regs[${reg}];
                    `);
                    break;
                }
                case OpCode.LOADUPVAR: {
                    const destReg = inst[ip++];
                    const upvarIdx = inst[ip++];
                    const andUnbox = inst[ip++];
                    if (andUnbox) {
                        out.emit(`regs[${destReg}] = (upvars[${upvarIdx}]).val;`);
                    } else {
                        out.emit(`regs[${destReg}] = upvars[${upvarIdx}];`);
                    }
                    break;
                }
                case OpCode.SETUPVAR: {
                    const srcReg = inst[ip++];
                    const upvarIdx = inst[ip++];
                    const andBox = inst[ip++];
                    if (andBox) {
                        out.emit(`upvars[${upvarIdx}] = new Box(regs[${srcReg}]);`);
                    } else {
                        out.emit(`upvars[${upvarIdx}] = regs[${srcReg}];`);
                    }
                    break;
                }
                case OpCode.LOADGLOBAL: {
                    const destReg = inst[ip++];
                    const symConstIdx = inst[ip++];
                    out.emit(`
                        {
                            const varname = constants[${symConstIdx}];
                            if (!ctx.scope.has(varname)) {
                                frame.ip = ${opIp};
                                throw new MissingVarError("Variable '" + String(varname) + "' is not defined in the current scope.");
                            }
                            regs[${destReg}] = ctx.scope.get(varname);
                        }
                    `);
                    break;
                }
                case OpCode.SETGLOBAL: {
                    const srcReg = inst[ip++];
                    const symConstIdx = inst[ip++];
                    out.emit(`ctx.scope.set(constants[${symConstIdx}], regs[${srcReg}]);`);
                    break;
                }
                case OpCode.HASGLOBAL: {
                    const symConstIdx = inst[ip++];
                    out.emit(`
                        {
                            const varname = constants[${symConstIdx}];
                            if (!ctx.scope.has(varname)) {
                                frame.ip = ${opIp};
                                throw new MissingVarError("Variable '" + String(varname) + "' is not defined in the current scope.");
                            }
                        }
                    `);
                    break;
                }
                case OpCode.IF: {
                    const condReg = inst[ip++];
                    const elseOffset = inst[ip++];
                    const thenOffset = ip;
                    if (blockSet) {
                        out.emit(`
                            if (isTruthy(regs[${condReg}])) {
                                ip = ${thenOffset};
                                continue;
                            } else {
                                ip = ${elseOffset};
                                continue;
                            }
                        `);
                        return;
                    } else {
                        out.emit(`if (isTruthy(regs[${condReg}])) {`);
                    }
                    break;
                }
                case OpCode.ELSE: {
                    const endOffset = inst[ip++];
                    if (blockSet) {
                        out.emit(`
                            ip = ${endOffset};
                            continue;
                        `);
                        return;
                    } else {
                        out.emit(`} else {`);
                    }
                    break;
                }
                case OpCode.ENDIF: {
                    if (blockSet) {
                        out.emit(`
                            ip = ${ip};
                            continue;
                        `);
                        return;
                    } else {
                        out.emit(`}`);
                    }
                    break;
                }
                case OpCode.BOX: {
                    const destReg = inst[ip++];
                    const srcReg = inst[ip++];
                    out.emit(`regs[${destReg}] = new Box(regs[${srcReg}]);`);
                    break;
                }
                case OpCode.UNBOX: {
                    const destReg = inst[ip++];
                    const srcReg = inst[ip++];
                    out.emit(`regs[${destReg}] = (regs[${srcReg}]).val;`);
                    break;
                }
                case OpCode.SETBOX: {
                    const destReg = inst[ip++];
                    const srcReg = inst[ip++];
                    out.emit(`(regs[${destReg}]).val = regs[${srcReg}];`);
                    break;
                }
                case OpCode.MOVE: {
                    const destReg = inst[ip++];
                    const srcReg = inst[ip++];
                    out.emit(`regs[${destReg}] = regs[${srcReg}];`);
                    break;
                }
                case OpCode.NEWCLOSURE: {
                    const destReg = inst[ip++];
                    const tidx = inst[ip++];
                    out.emit(`regs[${destReg}] = Closure.create(constants[${tidx}], regs, upvars);`);
                    break;
                }
                case OpCode.CALL: {
                    const procIdx = inst[ip++];
                    const destReg = inst[ip++];
                    const startReg = inst[ip++];
                    const nargs = inst[ip++];
                    const nextIp = ip;
                    const codeGenFn = this.getBuiltinFunctionCodeGen(procIdx);
                    if (codeGenFn) {
                        out.emit(`frame.ip = ${nextIp};`);
                        const res = codeGenFn(out, startReg, nargs, destReg);
                        if (typeof res === "string") {
                            out.emit(`regs[${destReg}] = ${res};`);
                            out.emit(`ctx.acc = regs[${destReg}];`);
                        } else if (res === undefined) {
                            out.emit(`ctx.acc = regs[${destReg}];`);
                        }
                        break;
                    }

                    if (procIdx >= BUILTINS_START) {
                        const builtin = IBUILTINS[procIdx - BUILTINS_START];
                        if (builtin instanceof BuiltinFunction) {
                            out.emit(`
                                frame.ip = ${nextIp};
                                regs[${destReg}] = IBUILTINS[${procIdx - BUILTINS_START}].cb(regs, ${startReg}, ${nargs});
                                ctx.acc = regs[${destReg}];
                            `);
                            break;
                        } else {
                            out.emit(`
                                frame.retDestReg = ${destReg};
                                frame.ip = ${nextIp};
                                return executor.invoke(ctx, IBUILTINS[${procIdx - BUILTINS_START}], frame, regs, ${startReg}, ${nargs}, false);
                            `);
                            return;
                        }
                    } else {
                        out.emit(`
                            {
                                const proc = regs[${procIdx}];
                                if (proc instanceof BuiltinFunction) {
                                    frame.ip = ${nextIp};
                                    regs[${destReg}] = proc.cb(regs, ${startReg}, ${nargs});
                                    ctx.acc = regs[${destReg}];
                                    ${blockSet ? `ip = ${nextIp}; continue;` : ""}
                                } else {
                                    frame.retDestReg = ${destReg};
                                    frame.ip = ${nextIp};
                                    return executor.invoke(ctx, proc, frame, regs, ${startReg}, ${nargs}, false);
                                }
                            }
                        `);
                        return;
                    }
                }
                case OpCode.TAILCALL: {
                    const procIdx = inst[ip++];
                    const startReg = inst[ip++];
                    const nargs = inst[ip++];
                    const codeGenFn = this.getBuiltinFunctionCodeGen(procIdx);
                    if (codeGenFn) {
                        out.emit(`frame.ip = ${ip};`);
                        const res = codeGenFn(out, startReg, nargs);
                        if (typeof res === "string") {
                            out.emit(`ctx.acc = ${res};`);
                        }
                        out.emit(`return executor.setRetVal(ctx, frame.parent, ctx.acc);`);
                        return;
                    }
                    if (procIdx >= BUILTINS_START) {
                        const builtin = IBUILTINS[procIdx - BUILTINS_START];
                        if (builtin instanceof BuiltinFunction) {
                            out.emit(`
                                frame.ip = ${ip};
                                ctx.acc = IBUILTINS[${procIdx - BUILTINS_START}].cb(regs, ${startReg}, ${nargs});
                                return executor.setRetVal(ctx, frame.parent, ctx.acc);
                            `);
                            return;
                        }
                    }
                    out.emit(`
                        {
                            const proc = (${procIdx} < BUILTINS_START) ? regs[${procIdx}] : IBUILTINS[${procIdx} - BUILTINS_START];
                            frame.ip = ${ip};
                            return executor.invoke(ctx, proc, frame, regs, ${startReg}, ${nargs}, true);
                        }
                    `);
                    return;
                }
                case OpCode.RETURN: {
                    const reg = inst[ip++];
                    out.emit(`
                        ctx.acc = regs[${reg}];
                        return executor.setRetVal(ctx, frame.parent, ctx.acc);
                    `);
                    return;
                }
                default: {
                    throw new Error(`Unhandled opcode in JIT: ${opcode}`);
                }
            }
        }

        if (blockSet && ip < inst.length) {
            out.emit(`
                ip = ${ip};
                continue;
            `);
        }
    }
}
