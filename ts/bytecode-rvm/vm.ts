import {
    BS,
    BSReader,
    ErrorObject,
    flattenDynamicArgs,
    Table,
    MissingVarError,
    IProcedure,
    isTruthy,
    type SerializableBytecode,
    type AbstractByteCode,
    type AbstractClosure,
    type AbstractVM
} from "../common";
import { Cons } from "../list";
import { ApplyProc, BuiltinFunction, CallCCProc, IBUILTINS, TryProc, type BuiltinCodeGenFn } from "../std";
import { CodeEmitter } from "./code-emitter";

export { CodeEmitter };

export const BUILTINS_START = 2**31

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

export class ByteCode implements AbstractByteCode {
    public bsid = "ByteCode"
    public nativeFn: NativeFn | null = null;
    public execCount: number = 0;
    constructor(public constants: any[], public inst: Uint32Array, public numReg: number) {}
    dump(bs: BS) {
        bs.writeU32Arr(this.inst)
        bs.writeArray(this.constants)
        bs.writeU32(this.numReg)
    }
    static register(bsr: BSReader) {
        bsr.registerFactory("ByteCode", (bsr) => {
            const inst = bsr.readU32Arr()
            const constants = bsr.readArray()
            const numReg = bsr.readU32()
            return new ByteCode(constants, inst, numReg)
        })
    }
}

export type UpVarLoc = { index: number, local: boolean }

/** A template for a closure that can then be bound to a scope */
export class ClosureTemplate implements SerializableBytecode {
    public bsid = "ClosureTemplate"

    params: symbol[]; // base (individual param binds)
    remParams: symbol | null; // where the remaining params should be bound too (if any). This implicitly makes a closure variadic as well
    code: ByteCode
    upvarLocs: UpVarLoc[] // what upvars do we need to capture

    constructor(params: symbol[], remParams: symbol | null, code: ByteCode, upvarLocs: UpVarLoc[]) {
        this.params = params
        this.remParams = remParams
        this.code = code
        this.upvarLocs = upvarLocs
    }

    dump(bs: BS) {
        bs.writeValue(this.params)
        bs.writeValue(this.remParams)
        bs.writeValue(this.code)
        bs.writeValue(this.upvarLocs)
    }
    static register(bsr: BSReader) {
        bsr.registerFactory("ClosureTemplate", (bsr) => {
            const params = bsr.read() as symbol[]
            const remParams = bsr.read() as symbol | null
            const code = bsr.readSerializable<ByteCode>("ByteCode")
            const upvarLocs = bsr.readArray() as UpVarLoc[]
            return new ClosureTemplate(params, remParams, code, upvarLocs)
        })
    }
}

/** An actual anima closure bound to a scope */
export class Closure extends IProcedure implements AbstractClosure {
    public bsid = "Closure"
    constructor(public tmpl: ClosureTemplate, public upvars: any[], debugName: string = "lambda") {
        super(debugName);
    }

    static fromTemplate(tmpl: ClosureTemplate, debugName: string = "lambda") {
        // Allocate enough space for the upvars from outer scopes
        const upvars = new Array(tmpl.upvarLocs.length)
        return new Closure(tmpl, upvars, debugName)
    }

    dump(bs: BS) {
        bs.writeValue(this.upvars)
        bs.writeValue(this.tmpl)
    }
    static register(bsr: BSReader) {
        bsr.registerFactory("Closure", (bsr) => {
            const upvars = bsr.readArray()
            const tmpl = bsr.readSerializable<ClosureTemplate>("ClosureTemplate")
            return new Closure(tmpl, upvars)
        })
    }
}

const createRegs = (numRegs: number) => {
    return new Array(numRegs).fill(undefined)
}

const regOut = (reg: any): any => {
    if (reg instanceof Box) return `Box<${regOut(reg.val)}>`
    if (reg instanceof Closure) return `Closure<${reg.tmpl.params.map(x => x.description).join(", ")}>`
    if (typeof reg === "symbol") return `${reg.description || '<symbol>'}`
    if (reg === undefined) return '#<void>'
    if (reg === null) return `()`
    if (typeof reg !== "object") return `${reg}`
    return `<object ${Object.keys(reg)}>`
}

// To make life debugging registers easier
class Box {
    constructor(public val: any) {}
}

export class ExecutionContext {
    public static nextId: number = 0;
    public id: number;
    public acc: any = null;
    public epoch: number = 0;
    public steps: number = 0;
    public maxSteps: number = 0;
    public currentFrame: Frame | null = null;

    constructor(
        public vm: AnimaVM,
        public scope: Table,
        maxSteps?: number
    ) {
        this.id = ++ExecutionContext.nextId;
        this.maxSteps = maxSteps ?? vm.maxSteps;
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
    public deopted: boolean = false;

    constructor(
        public code: ByteCode,
        public regs: any[],
        public upvars: any[],
        public ip: number,
        public parent: Frame | null,
        public retDestReg: number = -1,
        public trySpot: Frame | null | undefined = undefined,
        public epoch: number = 0,
        public debugName: string = "anonymous"
    ) {}

    public deopt(ip: number): this {
        this.deopted = true;
        this.ip = ip;
        return this;
    }

    readNext() {
        if (this.ip >= this.code.inst.length) {
            throw new Error(`internal error: unexpected end of bytecode, instruction pointer out of bounds (${this.ip} >= ${this.code.inst.length}).`);
        }
        return this.code.inst[this.ip++]
    }

    getConst(idx: number) {
        return this.code.constants[idx]
    }

    thaw(ctx: ExecutionContext): Frame {
        const f = new Frame(this.code, [...this.regs], this.upvars, this.ip, this.parent, this.retDestReg, this.trySpot, ctx.epoch, this.debugName);
        f.deopted = this.deopted;
        return f;
    }

    share(ctx: ExecutionContext): this {
        ctx.epoch++;
        return this;
    }

    isShared(ctx: ExecutionContext): boolean {
        return this.epoch < ctx.epoch;
    }
}

export class AnimaVM implements AbstractVM {
    readonly executor: VMExecutor;

    constructor(public steps: number = 0, public maxSteps: number = 0) {
        this.executor = new VMExecutor(this);
    }

    public evaluateRaw(code: ByteCode, scope: Table, maxSteps?: number): any {
        const ctx = new ExecutionContext(this, scope, maxSteps);
        let frame: Frame = this.executor.newFrame(ctx, code, createRegs(code.numReg), [], null, undefined, "top-level");
        try {
            return this.executor.execnext(ctx, frame);
        } catch (err: any) {
            const active = ctx.currentFrame ?? frame;
            console.log(`${err.stack}\n\nCurrent Frame [${active.debugName}] IP: ${active.ip}`)
            throw err
        }
    }

    public evaluateClosure(code: Closure, scope: Table, args: any[], maxSteps?: number): any {
        const ctx = new ExecutionContext(this, scope, maxSteps);
        const cargs = this.executor.createClosureArg(code.tmpl, args.length, args, 0);
        const debugName = code.debugName ?? "lambda";
        let frame: Frame = this.executor.newFrame(ctx, code.tmpl.code, cargs, code.upvars, null, undefined, debugName);
        try {
            return this.executor.execnext(ctx, frame);
        } catch (err: any) {
            const active = ctx.currentFrame ?? frame;
            console.log(`${err.stack}\n\nCurrent Frame [${active.debugName}] IP: ${active.ip}`)
            throw err
        }
    }
}

/** Highly internal, actually evaluates JS code, all APIs here are private */
class VMExecutor {
    constructor(public vm: AnimaVM) {}

    public execnext(ctx: ExecutionContext, initialFrame: Frame) {
        let frame: Frame | null = initialFrame;

        while(frame !== null) {
            ctx.currentFrame = frame;
            ctx.steps++;
            this.vm.steps++;
            if (ctx.maxSteps && ctx.steps > ctx.maxSteps) {
                throw new Error(`Script ran for more than ${ctx.maxSteps} instructions.`);
            }

            if (frame.isShared(ctx)) {
                frame = frame.thaw(ctx);
                ctx.currentFrame = frame;
            }

            if (!frame.deopted && frame.ip === 0) {
                frame.code.execCount++;
                if (frame.code.execCount > 1 && frame.code.nativeFn === null) {
                    JITCompiler.compile(frame.code);
                }
                if (frame.code.nativeFn !== null) {
                    frame = frame.code.nativeFn(ctx, frame, this.vm, this);
                    continue;
                }
            }

            const regs = frame.regs

            try {
                const opcode: OpCode = frame.readNext()
                //console.log(`[Frame #${frame.id}]: ${OpCode[opcode]} ${regs.map(r => regOut(r)).join(', ')}`)
                switch (opcode) {
                    // Load
                    case OpCode.LOADCONST: {
                        const destReg = frame.readNext()
                        const constIdx = frame.readNext()
                        regs[destReg] = frame.getConst(constIdx);
                        break;
                    }
                    case OpCode.LOADU32: {
                        const destReg = frame.readNext()
                        const u32Val = frame.readNext()
                        regs[destReg] = u32Val 
                        break
                    }
                    case OpCode.NEGATE: {
                        const reg = frame.readNext()
                        if (typeof regs[reg] !== "number") throw new Error("cannot negate non-number")
                        regs[reg] = -regs[reg] 
                        break
                    }
                    case OpCode.LOADUPVAR: {
                        const destReg = frame.readNext()
                        const upvarIdx = frame.readNext()
                        const andUnbox = frame.readNext()
                        regs[destReg] = andUnbox ? (frame.upvars[upvarIdx] as Box).val : frame.upvars[upvarIdx]
                        break
                    }
                    case OpCode.SETUPVAR: {
                        const srcReg = frame.readNext()
                        const upvarIdx = frame.readNext()
                        const andBox = frame.readNext()
                        frame.upvars[upvarIdx] = andBox ? new Box(regs[srcReg]) : regs[srcReg]
                        break
                    }
                    case OpCode.LOADGLOBAL: {
                        const destReg = frame.readNext()
                        const varname = frame.getConst(frame.readNext()) as symbol // compiler ensures its a symbol
                        if (!ctx.scope.has(varname)) {
                            throw new MissingVarError(`Variable '${String(varname)}' is not defined in the current scope.`);
                        }
                        regs[destReg] = ctx.scope.get(varname)
                        break
                    }
                    case OpCode.SETGLOBAL: {
                        const srcReg = frame.readNext()
                        const varname = frame.getConst(frame.readNext()) as symbol // compiler ensures its a symbol
                        ctx.scope.set(varname, regs[srcReg])
                        break
                    }
                    case OpCode.HASGLOBAL: {
                        const varname = frame.getConst(frame.readNext()) as symbol // compiler ensures its a symbol
                        if (!ctx.scope.has(varname)) {
                            throw new MissingVarError(`Variable '${String(varname)}' is not defined in the current scope.`);
                        }
                        break
                    }
                    case OpCode.IF: {
                        const condReg = frame.readNext()
                        const elseOffset = frame.readNext()
                        if (!isTruthy(regs[condReg])) {
                            frame.ip = elseOffset
                        }
                        break
                    }
                    case OpCode.ELSE: {
                        const endOffset = frame.readNext()
                        frame.ip = endOffset
                        break
                    }
                    case OpCode.ENDIF: {
                        break
                    }
                    case OpCode.NEWCLOSURE: {
                        const destReg = frame.readNext()
                        const tidx = frame.readNext()
                        const template = frame.getConst(tidx) as ClosureTemplate
                        const closure = Closure.fromTemplate(template)
                        // Copy over upvalues
                        for (let i = 0; i < template.upvarLocs.length; i++) {
                            const loc = template.upvarLocs[i]
                            if (loc.local) {
                                closure.upvars[i] = regs[loc.index];
                            } else {
                                // Grab from the current frame's upvars
                                closure.upvars[i] = frame.upvars[loc.index];
                            }
                        }
                        regs[destReg] = closure
                        break;
                    }
                    case OpCode.BOX: {
                        const destReg = frame.readNext();
                        const srcReg = frame.readNext();
                        regs[destReg] = new Box(regs[srcReg])
                        break
                    }
                    case OpCode.UNBOX: {
                        const destReg = frame.readNext();
                        const srcReg = frame.readNext();
                        regs[destReg] = (regs[srcReg] as Box).val
                        break
                    }
                    case OpCode.SETBOX: {
                        const destReg = frame.readNext();
                        const srcReg = frame.readNext();
                        (regs[destReg] as Box).val = regs[srcReg]
                        break
                    }
                    case OpCode.MOVE: {
                        const destReg = frame.readNext();
                        const srcReg = frame.readNext();
                        regs[destReg] = regs[srcReg]
                        break
                    }
                    case OpCode.RETURN: {
                        const reg = frame.readNext();
                        ctx.acc = regs[reg];
                        frame = this.setRetVal(ctx, frame.parent, ctx.acc);
                        break;
                    }
                    case OpCode.CALL: {
                        const procIdx = frame.readNext();
                        const proc = (procIdx < BUILTINS_START) ? regs[procIdx] : IBUILTINS[procIdx - BUILTINS_START];
                        const destReg = frame.readNext();
                        const startReg = frame.readNext();
                        const nargs = frame.readNext();

                        frame.retDestReg = destReg;
                        frame = this.invoke(ctx, proc, frame, regs, startReg, nargs, false);
                        break;
                    }
                    case OpCode.TAILCALL: {
                        const procIdx = frame.readNext();
                        const proc = (procIdx < BUILTINS_START) ? regs[procIdx] : IBUILTINS[procIdx - BUILTINS_START];
                        const startReg = frame.readNext();
                        const nargs = frame.readNext();

                        frame = this.invoke(ctx, proc, frame, regs, startReg, nargs, true);
                        break;
                    }
                    default:
                        let _: never = opcode;
                }
            } catch (err) {
                if (frame !== null && frame.trySpot !== undefined) {
                    ctx.acc = new ErrorObject(err);
                    frame = this.setRetVal(ctx, frame.trySpot, ctx.acc);
                    continue;
                }
                throw err;
            }
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
            const debugName = proc.debugName ?? "lambda";
            if (isTail && !callerFrame.isShared(ctx)) {
                return this.reset(callerFrame, proc.tmpl.code, pregs, proc.upvars, trySpot, debugName);
            }
            const parent = isTail ? callerFrame.parent : callerFrame;
            return this.newFrame(ctx, proc.tmpl.code, pregs, proc.upvars, parent, trySpot, debugName);
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
        code: ByteCode,
        regs: any[],
        upvars: any[],
        parent: Frame | null,
        trySpot: Frame | null | undefined,
        debugName: string = "anonymous"
    ): Frame {
        return new Frame(code, regs, upvars, 0, parent, -1, trySpot, ctx.epoch, debugName);
    }

    public reset(
        frame: Frame,
        code: ByteCode,
        regs: any[],
        upvars: any[],
        trySpot: Frame | null | undefined,
        debugName: string = "anonymous"
    ): Frame {
        frame.code = code;
        frame.regs = regs;
        frame.upvars = upvars;
        frame.ip = 0;
        frame.retDestReg = -1;
        frame.trySpot = trySpot;
        frame.debugName = debugName;
        frame.deopted = false;
        return frame;
    }

    public createClosureArg(template: ClosureTemplate, nargs: number, args: any[], startOffset: number) {
        const arity = template.params.length; // number of required args
        if (template.remParams !== null) {
            // variadic
            if (nargs < arity) {
                throw new Error(`expected at least ${arity} args, got ${nargs}`);
            }
        } else {
            if (nargs !== arity) {
                throw new Error(`expected exactly ${arity} args, got ${nargs}`);
            }
        }

        const closureRegs = createRegs(template.code.numReg)

        // required
        for (let i = 0; i < arity; i++) {
            closureRegs[i] = args[startOffset+i]
        }

        // variadic
        if (template.remParams !== null) {
            let tail: any = null;
            for (let i = startOffset + nargs - 1; i >= startOffset + arity; i--) {
                tail = new Cons(args[i], tail);
            }
            closureRegs[arity] = tail;
        }

        return closureRegs
    }

    public callJit(
        ctx: ExecutionContext,
        proc: any,
        callerFrame: Frame,
        callerArgs: any[],
        startReg: number,
        nargs: number,
        destReg: number
    ): boolean {
        if (proc instanceof BuiltinFunction) {
            callerFrame.regs[destReg] = proc.cb(callerArgs, startReg, nargs);
            ctx.acc = callerFrame.regs[destReg];
            return true;
        }

        if (proc instanceof Closure) {
            callerFrame.retDestReg = destReg;
            const calleeFrame = this.invoke(ctx, proc, callerFrame, callerArgs, startReg, nargs, false);
            if (calleeFrame === null) return false;

            if (proc.tmpl.code.nativeFn === null) {
                proc.tmpl.code.execCount++;
                if (proc.tmpl.code.execCount > 1) {
                    JITCompiler.compile(proc.tmpl.code);
                }
            }

            if (proc.tmpl.code.nativeFn !== null) {
                const resFrame = proc.tmpl.code.nativeFn(ctx, calleeFrame, this.vm, this);
                if (resFrame === callerFrame) {
                    return true;
                }
            }

            return false;
        }

        return false;
    }
}

type NativeFn = (
    ctx: ExecutionContext,
    frame: Frame,
    vm: AnimaVM,
    executor: VMExecutor
) => Frame | null;

const INSTRUCTION_LENGTHS: Record<OpCode, number> = {
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
        console.log(`[JIT Compiled Function]:\n${source}\n`);
        const factory = new Function(
            "IBUILTINS",
            "BUILTINS_START",
            "isTruthy",
            "Box",
            "ErrorObject",
            "MissingVarError",
            "Closure",
            source
        );
        return factory(
            IBUILTINS,
            BUILTINS_START,
            isTruthy,
            Box,
            ErrorObject,
            MissingVarError,
            Closure
        );
    }

    public static generateSource(code: ByteCode): string {
        const inst = code.inst;
        const out = new CodeEmitter();
        let ip = 0;

        out.emit(`
            return function(ctx, frame, vm, executor) {
                const regs = frame.regs;
                const upvars = frame.upvars;
                const constants = frame.code.constants;
                try {
        `);

        while (ip < inst.length) {
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
                    out.emit(`if (isTruthy(regs[${condReg}])) {`);
                    break;
                }
                case OpCode.ELSE: {
                    const endOffset = inst[ip++];
                    out.emit(`} else {`);
                    break;
                }
                case OpCode.ENDIF: {
                    out.emit(`}`);
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
                    out.emit(`
                        {
                            const template = constants[${tidx}];
                            const closure = Closure.fromTemplate(template);
                            for (let i = 0; i < template.upvarLocs.length; i++) {
                                const loc = template.upvarLocs[i];
                                closure.upvars[i] = loc.local ? regs[loc.index] : upvars[loc.index];
                            }
                            regs[${destReg}] = closure;
                        }
                    `);
                    break;
                }
                case OpCode.CALL: {
                    const procIdx = inst[ip++];
                    const destReg = inst[ip++];
                    const startReg = inst[ip++];
                    const nargs = inst[ip++];
                    const codeGenFn = this.getBuiltinFunctionCodeGen(procIdx);
                    if (codeGenFn) {
                        out.emit(`frame.ip = ${opIp};`);
                        const res = codeGenFn(out, startReg, nargs, destReg);
                        if (typeof res === "string") {
                            out.emit(`regs[${destReg}] = ${res};`);
                            out.emit(`ctx.acc = regs[${destReg}];`);
                            break;
                        } else if (res === undefined) {
                            out.emit(`ctx.acc = regs[${destReg}];`);
                            break;
                        }
                    }
                    out.emit(`
                        {
                            const proc = (${procIdx} < BUILTINS_START) ? regs[${procIdx}] : IBUILTINS[${procIdx} - BUILTINS_START];
                            frame.ip = ${opIp};
                            if (!executor.callJit(ctx, proc, frame, regs, ${startReg}, ${nargs}, ${destReg})) {
                                return frame.deopt(${opIp});
                            }
                        }
                    `);
                    break;
                }
                case OpCode.TAILCALL: {
                    const procIdx = inst[ip++];
                    const startReg = inst[ip++];
                    const nargs = inst[ip++];
                    const codeGenFn = this.getBuiltinFunctionCodeGen(procIdx);
                    if (codeGenFn) {
                        out.emit(`frame.ip = ${opIp};`);
                        const res = codeGenFn(out, startReg, nargs);
                        if (typeof res === "string") {
                            out.emit(`ctx.acc = ${res};`);
                            out.emit(`return executor.setRetVal(ctx, frame.parent, ctx.acc);`);
                            break;
                        } else if (res === undefined) {
                            out.emit(`return executor.setRetVal(ctx, frame.parent, ctx.acc);`);
                            break;
                        }
                    }
                    out.emit(`
                        {
                            const proc = (${procIdx} < BUILTINS_START) ? regs[${procIdx}] : IBUILTINS[${procIdx} - BUILTINS_START];
                            frame.ip = ${opIp};
                            return executor.invoke(ctx, proc, frame, regs, ${startReg}, ${nargs}, true);
                        }
                    `);
                    break;
                }
                case OpCode.RETURN: {
                    const reg = inst[ip++];
                    out.emit(`
                        ctx.acc = regs[${reg}];
                        return executor.setRetVal(ctx, frame.parent, ctx.acc);
                    `);
                    break;
                }
                default: {
                    out.emit(`return frame.deopt(${opIp});`);
                    const len = INSTRUCTION_LENGTHS[opcode] ?? 1;
                    ip = opIp + len;
                    break;
                }
            }
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
}