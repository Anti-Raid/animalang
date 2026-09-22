import { BS, BSReader, ErrorObject, flattenDynamicArgs, Table, MissingVarError, IProcedure, type SerializableBytecode } from "../common";
import { isTruthy } from "../common";
import { Cons } from "../list";
import { ApplyProc, BuiltinFunction, CallCCProc, IBUILTINS, TryProc } from "../std";

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
    JIF, // jump if false
    JIT, // jump if true
    JUMP, // unconditional jump
    CALL,
    TAILCALL,
    RETURN,
    NEWCLOSURE,
    BOX,
    UNBOX,
    SETBOX,
    MOVE,
}

export class ByteCode implements SerializableBytecode {
    public bsid = "ByteCode"
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
export class Closure extends IProcedure implements SerializableBytecode {
    public bsid = "Closure"
    constructor(public tmpl: ClosureTemplate, public upvars: any[]) {
        super()
    }

    static fromTemplate(tmpl: ClosureTemplate) {
        // Allocate enough space for the upvars from outer scopes
        const upvars = new Array(tmpl.upvarLocs.length)
        return new Closure(tmpl, upvars)
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
    public acc: any = null;

    constructor(
        public vm: AnimaVM,
        public scope: Table
    ) {}
}

class VMContinuation {
    constructor(public frame: Frame | null) {}
}

/** Mark an active frame (and its parents) as shared for copy-on-write */
function markShared(frame: Frame | null) {
    while (frame !== null && !frame.shared) {
        frame.shared = true;
        frame = frame.parent;
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
        public trySpot: Frame | null | undefined = undefined,
        public shared: boolean = false
    ) {}

    readNext() {
        if (this.ip >= this.code.inst.length) {
            throw new Error(`internal error: unexpected end of bytecode, instruction pointer out of bounds (${this.ip} >= ${this.code.inst.length}).`);
        }
        return this.code.inst[this.ip++]
    }

    getConst(idx: number) {
        return this.code.constants[idx]
    }

    thaw(): Frame {
        if (!this.shared) return this;
        return new Frame(this.code, [...this.regs], this.upvars, this.ip, this.parent, this.retDestReg, this.trySpot, false);
    }
}

export class AnimaVM {
    constructor(public steps: number = 0, public maxSteps: number = 0) {}

    public evaluateRaw(code: ByteCode, scope: Table): any {
        const ctx = new ExecutionContext(this, scope);
        let frame: Frame = new Frame(code, createRegs(code.numReg), [], 0, null, -1, undefined, false);
        try {
            return this.#execnext(ctx, frame);
        } catch (err: any) {
            console.log(`${err.stack}\n\nCurrent Frame IP: ${frame.ip}`)
            throw err
        }
    }

    public evaluateClosure(code: Closure, scope: Table, args: any[]): any {
        const ctx = new ExecutionContext(this, scope);
        const cargs = this.#createClosureArg(code.tmpl, args.length, args, 0)
        let frame: Frame = new Frame(code.tmpl.code, cargs, code.upvars, 0, null, -1, undefined, false);
        try {
            return this.#execnext(ctx, frame);
        } catch (err: any) {
            console.log(`${err.stack}\n\nCurrent Frame IP: ${frame.ip}`)
            throw err
        }
    }

    #execnext(ctx: ExecutionContext, initialFrame: Frame) {
        let frame: Frame | null = initialFrame;

        while(frame !== null) {
            this.steps++;
            if (this.maxSteps && this.steps > this.maxSteps) {
                throw new Error(`Script ran for more than ${this.maxSteps} instructions.`);
            }

            if (frame.shared) {
                frame = frame.thaw();
            }
            if (frame.retDestReg !== -1) {
                frame.regs[frame.retDestReg] = ctx.acc;
                frame.retDestReg = -1;
            }
            const regs = frame.regs
            if (frame.ip >= frame.code.inst.length) {
                throw new Error(`internal error: ${frame.ip} >= ${frame.code.inst.length}`)
            }

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
                        regs[reg] = -1*regs[reg] 
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
                    case OpCode.JIF: {
                        const condReg = frame.readNext()
                        const jumpIdx = frame.readNext()
                        if (!isTruthy(regs[condReg])) {
                            frame.ip = jumpIdx
                        }
                        break
                    }
                    case OpCode.JIT: {
                        const condReg = frame.readNext()
                        const jumpIdx = frame.readNext()
                        if (isTruthy(regs[condReg])) {
                            frame.ip = jumpIdx
                        }
                        break
                    }
                    case OpCode.JUMP: {
                        const jumpIdx = frame.readNext()
                        frame.ip = jumpIdx
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
                        frame = frame.parent;
                        break;
                    }
                    case OpCode.CALL: {
                        const procIdx = frame.readNext();
                        const proc = (procIdx < BUILTINS_START) ? regs[procIdx] : IBUILTINS[procIdx - BUILTINS_START];
                        const destReg = frame.readNext();
                        const startReg = frame.readNext();
                        const nargs = frame.readNext();

                        frame.retDestReg = destReg;
                        frame = this.#invoke(ctx, proc, frame, regs, startReg, nargs, false);
                        break;
                    }
                    case OpCode.TAILCALL: {
                        const procIdx = frame.readNext();
                        const proc = (procIdx < BUILTINS_START) ? regs[procIdx] : IBUILTINS[procIdx - BUILTINS_START];
                        const startReg = frame.readNext();
                        const nargs = frame.readNext();

                        frame = this.#invoke(ctx, proc, frame, regs, startReg, nargs, true);
                        break;
                    }
                    default:
                        let _: never = opcode;
                }
            } catch (err) {
                if (frame !== null && frame.trySpot !== undefined) {
                    ctx.acc = new ErrorObject(err);
                    frame = frame.trySpot;
                    continue;
                }
                throw err;
            }
        }

        return ctx.acc;
    }

    #invoke(
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
            return isTail ? callerFrame.parent : callerFrame;
        } else if (proc instanceof Closure) {
            const pregs = this.#createClosureArg(proc.tmpl, nargs, callerArgs, startReg);
            const parent = isTail ? callerFrame.parent : callerFrame;
            return new Frame(
                proc.tmpl.code,
                pregs,
                proc.upvars,
                0,
                parent,
                -1,
                trySpot,
                false
            );
        } else if (proc instanceof ApplyProc) {
            const actualProc = callerArgs[startReg];
            const actualArgs = flattenDynamicArgs([], callerArgs, startReg, nargs, "apply");
            return this.#invoke(ctx, actualProc, callerFrame, actualArgs, 0, actualArgs.length, isTail, overrideTrySpot);
        } else if (proc instanceof TryProc) {
            const actualProc = callerArgs[startReg];
            const actualArgs = flattenDynamicArgs([], callerArgs, startReg, nargs, "try");
            const trapFrame = isTail ? callerFrame.parent : callerFrame;

            try {
                return this.#invoke(ctx, actualProc, callerFrame, actualArgs, 0, actualArgs.length, isTail, trapFrame);
            } catch (err) {
                ctx.acc = new ErrorObject(err);
                return trapFrame;
            }
        } else if (proc instanceof CallCCProc) {
            markShared(callerFrame);
            const targetFrame = isTail ? callerFrame.parent : callerFrame;
            const vmCont = new VMContinuation(targetFrame);
            const userProc = callerArgs[startReg];
            return this.#invoke(ctx, userProc, callerFrame, [vmCont], 0, 1, isTail);
        } else if (proc instanceof VMContinuation) {
            if (nargs !== 1) throw new Error(`continuation expected exactly 1 argument, but received ${nargs}`);
            ctx.acc = callerArgs[startReg];
            return proc.frame;
        } else {
            throw new Error(`Attempted to call a non-procedure: ${String(proc)}`);
        }
    }

    #createClosureArg(template: ClosureTemplate, nargs: number, args: any[], startOffset: number) {
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
}