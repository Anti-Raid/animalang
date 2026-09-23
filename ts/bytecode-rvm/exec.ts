import {
    ErrorObject,
    flattenDynamicArgs,
    Table,
    IProcedure,
    type AbstractVM,
    MissingVarError,
    isTruthy,
    AbstractByteCode,
    BS,
    BSReader,
    SerializableBytecode,
    AbstractClosure
} from "../common";
import { Cons } from "../list";
import { ApplyProc, BuiltinFunction, CallCCProc, TryProc, IBUILTINS, BuiltinCodeGenFn } from "../std";

export const BUILTINS_START = 2**31;

export enum OpCode {
    LOADCONST,
    LOADU32,
    NEGATE,
    LOADUPVAR,
    SETUPVAR,
    LOADGLOBAL,
    SETGLOBAL,
    HASGLOBAL,
    IF,
    ELSE,
    ENDIF,
    CALL,
    TAILCALL,
    RETURN,
    NEWCLOSURE,
    BOX,
    UNBOX,
    SETBOX,
    MOVE,
}

export const INSTRUCTION_LENGTHS: Record<OpCode, number> = {
    [OpCode.ENDIF]: 1,
    [OpCode.NEGATE]: 2,
    [OpCode.HASGLOBAL]: 2,
    [OpCode.ELSE]: 2,
    [OpCode.RETURN]: 2,
    [OpCode.LOADCONST]: 3,
    [OpCode.LOADU32]: 3,
    [OpCode.LOADGLOBAL]: 3,
    [OpCode.SETGLOBAL]: 3,
    [OpCode.IF]: 3,
    [OpCode.NEWCLOSURE]: 3,
    [OpCode.BOX]: 3,
    [OpCode.UNBOX]: 3,
    [OpCode.SETBOX]: 3,
    [OpCode.MOVE]: 3,
    [OpCode.LOADUPVAR]: 4,
    [OpCode.SETUPVAR]: 4,
    [OpCode.TAILCALL]: 4,
    [OpCode.CALL]: 5,
};

export type NativeFn = (
    ctx: any,
    frame: any,
    vm: any,
    executor: any
) => any;

export class ByteCode implements AbstractByteCode {
    public bsid = "ByteCode";
    public nativeFn: NativeFn | null = null;
    public execCount: number = 0;

    constructor(public constants: any[], public inst: Uint32Array, public numReg: number) {}

    dump(bs: BS) {
        bs.writeU32Arr(this.inst);
        bs.writeArray(this.constants);
        bs.writeU32(this.numReg);
    }

    static register(bsr: BSReader) {
        bsr.registerFactory("ByteCode", (bsr) => {
            const inst = bsr.readU32Arr();
            const constants = bsr.readArray();
            const numReg = bsr.readU32();
            return new ByteCode(constants, inst, numReg);
        });
    }
}

export type UpVarLoc = { index: number; local: boolean };

/** A template for a closure that can then be bound to a scope */
export class ClosureTemplate implements SerializableBytecode {
    public bsid = "ClosureTemplate";

    params: symbol[]; // base (individual param binds)
    remParams: symbol | null; // where the remaining params should be bound too (if any). This implicitly makes a closure variadic as well
    code: ByteCode;
    upvarLocs: UpVarLoc[]; // what upvars do we need to capture

    constructor(params: symbol[], remParams: symbol | null, code: ByteCode, upvarLocs: UpVarLoc[]) {
        this.params = params;
        this.remParams = remParams;
        this.code = code;
        this.upvarLocs = upvarLocs;
    }

    dump(bs: BS) {
        bs.writeValue(this.params);
        bs.writeValue(this.remParams);
        bs.writeValue(this.code);
        bs.writeValue(this.upvarLocs);
    }

    static register(bsr: BSReader) {
        bsr.registerFactory("ClosureTemplate", (bsr) => {
            const params = bsr.read() as symbol[];
            const remParams = bsr.read() as symbol | null;
            const code = bsr.readSerializable<ByteCode>("ByteCode");
            const upvarLocs = bsr.readArray() as UpVarLoc[];
            return new ClosureTemplate(params, remParams, code, upvarLocs);
        });
    }
}

/** An actual anima closure bound to a scope */
export class Closure extends IProcedure implements AbstractClosure {
    public bsid = "Closure";

    constructor(public tmpl: ClosureTemplate, public upvars: any[], debugName: string = "lambda") {
        super(debugName);
    }

    static fromTemplate(tmpl: ClosureTemplate, debugName: string = "lambda") {
        // Allocate enough space for the upvars from outer scopes
        const upvars = new Array(tmpl.upvarLocs.length);
        return new Closure(tmpl, upvars, debugName);
    }

    static create(tmpl: ClosureTemplate, regs: readonly any[], upvars: readonly any[], debugName: string = "lambda") {
        const closure = Closure.fromTemplate(tmpl, debugName);
        for (let i = 0; i < tmpl.upvarLocs.length; i++) {
            const loc = tmpl.upvarLocs[i];
            closure.upvars[i] = loc.local ? regs[loc.index] : upvars[loc.index];
        }
        return closure;
    }

    dump(bs: BS) {
        bs.writeValue(this.upvars);
        bs.writeValue(this.tmpl);
    }

    static register(bsr: BSReader) {
        bsr.registerFactory("Closure", (bsr) => {
            const upvars = bsr.readArray();
            const tmpl = bsr.readSerializable<ClosureTemplate>("ClosureTemplate");
            return new Closure(tmpl, upvars);
        });
    }
}

export const createRegs = (numRegs: number) => {
    return new Array(numRegs).fill(undefined);
};

export class Box {
    constructor(public val: any) {}
}

export class ExecutionContext {
    private static nextId: number = 0;
    public id: number;
    public acc: any = null;
    public epoch: number = 0;
    public currentFrame: Frame | null = null;

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
    public code: ByteCode;
    public upvars: any[];

    constructor(
        public closure: Closure,
        public regs: any[],
        public ip: number,
        public parent: Frame | null,
        public retDestReg: number = -1,
        public trySpot: Frame | null | undefined = undefined,
        public epoch: number = 0
    ) {
        this.code = closure.tmpl.code;
        this.upvars = closure.upvars;
    }

    get debugName(): string {
        return this.closure.debugName ?? "lambda";
    }

    readNext(): number {
        const inst = this.code.inst;
        if (this.ip >= inst.length) {
            throw new Error(`internal error: unexpected end of bytecode, instruction pointer out of bounds (${this.ip} >= ${inst.length}).`);
        }
        return inst[this.ip++];
    }

    getConst(idx: number): any {
        return this.code.constants[idx];
    }

    thaw(ctx: ExecutionContext): Frame {
        return new Frame(this.closure, [...this.regs], this.ip, this.parent, this.retDestReg, this.trySpot, ctx.epoch);
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
        isTail: boolean,
        overrideTrySpot?: Frame | null
    ): Frame | null {
        const trySpot = (overrideTrySpot !== undefined) ? overrideTrySpot : callerFrame.trySpot;

        if (proc instanceof BuiltinFunction) {
            ctx.acc = proc.cb(callerArgs, startReg, nargs);
            const target = isTail ? callerFrame.parent : callerFrame;
            return this.setRetVal(ctx, target, ctx.acc);
        } else if (proc instanceof Closure) {
            const pregs = this.createClosureArg(proc.tmpl, nargs, callerArgs, startReg);
            if (isTail) {
                if (!callerFrame.isShared(ctx)) {
                    return this.reset(callerFrame, proc, pregs, trySpot);
                }
                return this.newFrame(ctx, proc, pregs, callerFrame.parent, trySpot);
            }
            return this.newFrame(ctx, proc, pregs, callerFrame, trySpot);
        } else if (proc instanceof ApplyProc) {
            const actualProc = callerArgs[startReg];
            const actualArgs = flattenDynamicArgs([], callerArgs, startReg, nargs, "apply");
            return this.invoke(ctx, actualProc, callerFrame, actualArgs, 0, actualArgs.length, isTail, overrideTrySpot);
        } else if (proc instanceof TryProc) {
            const actualProc = callerArgs[startReg];
            const actualArgs = flattenDynamicArgs([], callerArgs, startReg, nargs, "try");
            const trapFrame = isTail ? callerFrame.parent : callerFrame;

            try {
                return this.invoke(ctx, actualProc, callerFrame, actualArgs, 0, actualArgs.length, isTail, trapFrame);
            } catch (err) {
                ctx.acc = new ErrorObject(err);
                return this.setRetVal(ctx, trapFrame, ctx.acc);
            }
        } else if (proc instanceof CallCCProc) {
            callerFrame.share(ctx);
            const targetFrame = isTail ? callerFrame.parent : callerFrame;
            const vmCont = new VMContinuation(targetFrame, ctx.id);
            const userProc = callerArgs[startReg];
            return this.invoke(ctx, userProc, callerFrame, [vmCont], 0, 1, isTail, overrideTrySpot);
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
        closure: Closure,
        regs: any[],
        parent: Frame | null,
        trySpot: Frame | null | undefined = undefined
    ): Frame {
        return new Frame(closure, regs, 0, parent, -1, trySpot, ctx.epoch);
    }

    public reset(
        frame: Frame,
        closure: Closure,
        regs: any[],
        trySpot: Frame | null | undefined = undefined
    ): Frame {
        frame.closure = closure;
        frame.code = closure.tmpl.code;
        frame.upvars = closure.upvars;
        frame.regs = regs;
        frame.ip = 0;
        frame.retDestReg = -1;
        frame.trySpot = trySpot;
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

                        if (proc === frame.closure && !frame.isShared(ctx)) {
                            const tmpl = proc.tmpl;
                            const numPos = tmpl.params.length;
                            if (tmpl.remParams !== null ? nargs >= numPos : nargs === numPos) {
                                let restList: any = null;
                                if (tmpl.remParams !== null) {
                                    for (let i = nargs - 1; i >= numPos; i--) {
                                        restList = new Cons(regs[startReg + i], restList);
                                    }
                                }
                                for (let i = 0; i < numPos; i++) {
                                    regs[i] = regs[startReg + i];
                                }
                                if (tmpl.remParams !== null) {
                                    regs[numPos] = restList;
                                }
                                frame.ip = 0;
                                break;
                            }
                        }

                        frame = executor.invoke(ctx, proc, frame, regs, startReg, nargs, true);
                        break;
                    }
                    default: {
                        const _: never = opcode;
                        throw new Error(`Unhandled opcode: ${opcode}`);
                    }
                }
            } catch (err) {
                if (frame !== null && frame.trySpot !== undefined) {
                    ctx.acc = new ErrorObject(err);
                    frame = executor.setRetVal(ctx, frame.trySpot, ctx.acc);
                    continue;
                }
                throw err;
            }
        }

        return ctx.acc;
    }
}

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
                    if (frame !== null && frame.trySpot !== undefined) {
                        ctx.acc = new ErrorObject(err);
                        return executor.setRetVal(ctx, frame.trySpot, ctx.acc);
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

export class CodeEmitter {
    private lines: string[] = [];
    private depth: number = 0;

    emit(str: string): void {
        const rawLines = str.split("\n");
        for (const raw of rawLines) {
            const trimmed = raw.trim();
            if (!trimmed) continue;

            let lineDepth = this.depth;
            if (trimmed.startsWith("}") || trimmed.startsWith("]")) {
                lineDepth = Math.max(0, this.depth - 1);
            }

            this.lines.push("    ".repeat(lineDepth) + trimmed);

            for (const ch of trimmed) {
                if (ch === "{" || ch === "[") this.depth++;
                else if (ch === "}" || ch === "]") this.depth = Math.max(0, this.depth - 1);
            }
        }
    }

    toString(): string {
        return this.lines.join("\n");
    }
}
