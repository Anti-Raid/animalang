import {
    ErrorObject,
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
import { BuiltinFunction, IBUILTINS, BuiltinCodeGenFn } from "../std";

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
    WIND,
    ENDWIND,
    CALLCC,
    TAILCALLCC,
    SETRAISEPROC,
    APPLY,
    TAILAPPLY,
}

export const INSTRUCTION_LENGTHS: Record<OpCode, number> = {
    [OpCode.ENDIF]: 1,
    [OpCode.ENDWIND]: 1,
    [OpCode.NEGATE]: 2,
    [OpCode.HASGLOBAL]: 2,
    [OpCode.ELSE]: 2,
    [OpCode.RETURN]: 2,
    [OpCode.TAILCALLCC]: 2,
    [OpCode.SETRAISEPROC]: 2,
    [OpCode.LOADCONST]: 3,
    [OpCode.LOADU32]: 3,
    [OpCode.LOADGLOBAL]: 3,
    [OpCode.SETGLOBAL]: 3,
    [OpCode.IF]: 3,
    [OpCode.WIND]: 3,
    [OpCode.CALLCC]: 3,
    [OpCode.NEWCLOSURE]: 3,
    [OpCode.BOX]: 3,
    [OpCode.UNBOX]: 3,
    [OpCode.SETBOX]: 3,
    [OpCode.MOVE]: 3,
    [OpCode.TAILCALL]: 4,
    [OpCode.TAILAPPLY]: 4,
    [OpCode.SETUPVAR]: 4,
    [OpCode.LOADUPVAR]: 4,
    [OpCode.CALL]: 5,
    [OpCode.APPLY]: 5,
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

export class WindPoint {
    public readonly depth: number;

    constructor(
        public parent: WindPoint | null,
        public before: any | null = null,
        public after: any | null = null
    ) {
        this.depth = parent === null ? 0 : parent.depth + 1;
    }
}

export type WindAction =
    | { type: "after"; thunk: any; nextWind: WindPoint | null }
    | { type: "before"; thunk: any; nextWind: WindPoint | null };

function depthOf(w: WindPoint | null): number {
    return w === null ? -1 : w.depth;
}

export function computeWindTransition(fromWind: WindPoint | null, toWind: WindPoint | null): { actions: WindAction[] } {
    if (fromWind === toWind) {
        return { actions: [] };
    }

    // Equalize depth, then walk together, finds the LCA with no arrays.
    let a = fromWind;
    let b = toWind;
    while (depthOf(a) > depthOf(b)) a = a!.parent;
    while (depthOf(b) > depthOf(a)) b = b!.parent;
    while (a !== b) {
        a = a!.parent;
        b = b!.parent;
    }
    const lca = a;

    const actions: WindAction[] = [];

    // Unwind: natural leaf-to-root walk order is already correct. Only nodes with after thunks generate actions.
    for (let node = fromWind; node !== lca; node = node!.parent) {
        if (node!.after !== null) {
            actions.push({ type: "after", thunk: node!.after, nextWind: node!.parent });
        }
    }

    // Rewind: collect nodes with before thunks on the path from toWind up to lca,
    // then insert in root-to-leaf order.
    const beforeNodes: WindPoint[] = [];
    for (let node = toWind; node !== lca; node = node!.parent) {
        if (node!.before !== null) {
            beforeNodes.push(node!);
        }
    }
    for (let k = beforeNodes.length - 1; k >= 0; k--) {
        const node = beforeNodes[k];
        actions.push({ type: "before", thunk: node.before, nextWind: node });
    }

    return { actions };
}

export interface PendingWindTransition {
    actions: WindAction[];
    actionIdx: number;
    targetFrame: Frame | null;
    targetVal: any;
    targetWind: WindPoint | null;
}

export class ExecutionContext {
    private static nextId: number = 0;
    public id: number;
    public acc: any = null;
    public epoch: number = 0;
    public currentFrame: Frame | null = null;
    public wind: WindPoint | null = null;
    public pendingWind: PendingWindTransition | null = null;

    constructor(
        public vm: AbstractVM,
        public scope: Table
    ) {
        this.id = ++ExecutionContext.nextId;
    }

    // for %apply and %apply-multi
    #spliceLast(rawArgs: any[]): any[] {
        const actualArgs = rawArgs.slice(0, -1);
        const finalArg = rawArgs[rawArgs.length - 1];
        if (finalArg instanceof Cons) {
            actualArgs.push(...finalArg);
        } else if (finalArg !== null) {
            throw new Error(`apply: last argument must be a list but got ${String(finalArg)}`);
        }
        return actualArgs;
    }

    // %apply: register-window version (compile-time-known arity)
    public flattenDynamicArgs = (regs: any[], startReg: number, nargs: number) => {
        return this.#spliceLast(regs.slice(startReg, startReg + nargs));
    }

    // %apply-multi: runtime-list version (unknown arity until runtime)
    public flattenListArgs = (lst: Cons | null) => {
        return this.#spliceLast(lst === null ? [] : [...lst]);
    }
}

export class VMContinuation extends IProcedure {
    constructor(
        public frame: Frame | null,
        public ctxId: number,
        public wind: WindPoint | null = null
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
        return new Frame(this.closure, [...this.regs], this.ip, this.parent, this.retDestReg, ctx.epoch);
    }

    share(ctx: ExecutionContext): this {
        ctx.epoch++;
        return this;
    }

    isShared(ctx: ExecutionContext): boolean {
        return this.epoch < ctx.epoch;
    }
}

export class UnhandledSchemeError extends Error {
    constructor(public readonly error: any) {
        super(error instanceof Error ? error.message : String(error));
    }
}

export class VMExecutor {
    public raiseProc: any | null = null;

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

    public handleHostException(ctx: ExecutionContext, frame: Frame | null, err: any): Frame | null {
        if (err instanceof UnhandledSchemeError) {
            if (err.error instanceof Error) throw err.error;
            throw new Error(String(err.error));
        }
        if (this.raiseProc !== null && this.raiseProc !== false) {
            const errObj = (err instanceof ErrorObject)
                ? err
                : new ErrorObject(err);
            return this.invoke(ctx, this.raiseProc, frame, [errObj], 0, 1, false);
        }
        if (err instanceof Error) throw err;
        if (err instanceof ErrorObject) throw new Error(err.error);
        throw new Error(String(err));
    }

    public advanceWindTransition(ctx: ExecutionContext): Frame | null {
        while (ctx.pendingWind !== null) {
            const trans = ctx.pendingWind;

            if (trans.actionIdx > 0) {
                const prevAction = trans.actions[trans.actionIdx - 1];
                if (prevAction.type === "before") {
                    ctx.wind = prevAction.nextWind;
                }
            }

            if (trans.actionIdx < trans.actions.length) {
                const action = trans.actions[trans.actionIdx++];
                if (action.type === "after") {
                    ctx.wind = action.nextWind;
                }

                if (action.thunk instanceof BuiltinFunction) {
                    ctx.acc = action.thunk.cb([], 0, 0);
                    continue;
                }

                if (action.thunk instanceof Closure) {
                    const pregs = this.createClosureArg(action.thunk.tmpl, 0, [], 0);
                    return this.newFrame(ctx, action.thunk, pregs, null);
                }

                throw new Error(`Attempted to call a non-procedure in dynamic-wind: ${String(action.thunk)}`);
            }

            const targetFrame = trans.targetFrame;
            const targetVal = trans.targetVal;
            const targetWind = trans.targetWind;
            ctx.pendingWind = null;
            ctx.wind = targetWind;
            ctx.acc = targetVal;

            return this.setRetVal(ctx, targetFrame, targetVal);
        }

        return null;
    }

    public invoke(
        ctx: ExecutionContext,
        proc: any,
        callerFrame: Frame | null,
        callerArgs: any[],
        startReg: number,
        nargs: number,
        isTail: boolean
    ): Frame | null {
        if (proc instanceof BuiltinFunction) {
            ctx.acc = proc.cb(callerArgs, startReg, nargs);
            const target = (callerFrame !== null && isTail) ? callerFrame.parent : callerFrame;
            return this.setRetVal(ctx, target, ctx.acc);
        } else if (proc instanceof Closure) {
            const pregs = this.createClosureArg(proc.tmpl, nargs, callerArgs, startReg);
            if (isTail) {
                if (callerFrame !== null && !callerFrame.isShared(ctx)) {
                    return this.reset(callerFrame, proc, pregs);
                }
                return this.newFrame(ctx, proc, pregs, callerFrame !== null ? callerFrame.parent : null);
            }
            return this.newFrame(ctx, proc, pregs, callerFrame);
        } else if (proc instanceof VMContinuation) {
            if (proc.ctxId !== ctx.id) {
                throw new Error("Cannot invoke a continuation across execution/FFI boundary");
            }
            if (nargs !== 1) throw new Error(`continuation expected exactly 1 argument, but received ${nargs}`);

            const targetVal = callerArgs[startReg];
            const { actions } = computeWindTransition(ctx.wind, proc.wind);

            if (actions.length === 0) {
                ctx.acc = targetVal;
                ctx.wind = proc.wind;
                return this.setRetVal(ctx, proc.frame, ctx.acc);
            }

            ctx.pendingWind = {
                actions,
                actionIdx: 0,
                targetFrame: proc.frame,
                targetVal,
                targetWind: proc.wind,
            };

            return this.advanceWindTransition(ctx);
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
            return frame;
        }

        if (frame === null && ctx.pendingWind !== null) {
            return this.advanceWindTransition(ctx);
        }

        return frame;
    }

    public newFrame(
        ctx: ExecutionContext,
        closure: Closure,
        regs: any[],
        parent: Frame | null
    ): Frame {
        return new Frame(closure, regs, 0, parent, -1, ctx.epoch);
    }

    public reset(
        frame: Frame,
        closure: Closure,
        regs: any[]
    ): Frame {
        frame.closure = closure;
        frame.code = closure.tmpl.code;
        frame.upvars = closure.upvars;
        frame.regs = regs;
        frame.ip = 0;
        frame.retDestReg = -1;
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
                    case OpCode.APPLY: {
                        const procIdx = frame.readNext();
                        const proc = (procIdx < BUILTINS_START) ? regs[procIdx] : IBUILTINS[procIdx - BUILTINS_START];
                        const destReg = frame.readNext();
                        const startReg = frame.readNext();
                        const nargs = frame.readNext();
                        const actualArgs = ((nargs | 0) === -1)
                            ? ctx.flattenListArgs(regs[startReg])
                            : ctx.flattenDynamicArgs(regs, startReg, nargs);
                        frame.retDestReg = destReg;
                        frame = executor.invoke(ctx, proc, frame, actualArgs, 0, actualArgs.length, false);
                        break;
                    }
                    case OpCode.TAILAPPLY: {
                        const procIdx = frame.readNext();
                        const proc = (procIdx < BUILTINS_START) ? regs[procIdx] : IBUILTINS[procIdx - BUILTINS_START];
                        const startReg = frame.readNext();
                        const nargs = frame.readNext();
                        const actualArgs = ((nargs | 0) === -1)
                            ? ctx.flattenListArgs(regs[startReg])
                            : ctx.flattenDynamicArgs(regs, startReg, nargs);
                        frame = executor.invoke(ctx, proc, frame, actualArgs, 0, actualArgs.length, true);
                        break;
                    }
                    case OpCode.WIND: {
                        const beforeReg = frame.readNext();
                        const afterReg = frame.readNext();
                        ctx.wind = new WindPoint(ctx.wind, regs[beforeReg], regs[afterReg]);
                        break;
                    }
                    case OpCode.ENDWIND: {
                        if (ctx.wind !== null) {
                            ctx.wind = ctx.wind.parent;
                        }
                        break;
                    }
                    case OpCode.CALLCC: {
                        const destReg = frame.readNext();
                        const procReg = frame.readNext();
                        frame.retDestReg = destReg;
                        frame.share(ctx);
                        const vmCont = new VMContinuation(frame, ctx.id, ctx.wind);
                        frame = executor.invoke(ctx, regs[procReg], frame, [vmCont], 0, 1, false);
                        break;
                    }
                    case OpCode.TAILCALLCC: {
                        const procReg = frame.readNext();
                        const targetFrame = frame.parent;
                        if (targetFrame !== null) {
                            targetFrame.share(ctx);
                        }
                        const vmCont = new VMContinuation(targetFrame, ctx.id, ctx.wind);
                        frame = executor.invoke(ctx, regs[procReg], frame, [vmCont], 0, 1, true);
                        break;
                    }
                    case OpCode.SETRAISEPROC: {
                        const srcReg = frame.readNext();
                        executor.raiseProc = regs[srcReg];
                        break;
                    }
                    default: {
                        const _: never = opcode;
                        throw new Error(`Unhandled opcode: ${opcode}`);
                    }
                }
            } catch (err) {
                frame = executor.handleHostException(ctx, frame, err);
                continue;
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

    public static getProcExprFromProcIdx(procIdx: number): string {
        return procIdx < BUILTINS_START
            ? `regs[${procIdx}]`
            : `IBUILTINS[${procIdx - BUILTINS_START}]`;
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
            "WindPoint",
            "VMContinuation",
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
            BuiltinFunction,
            WindPoint,
            VMContinuation
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
                case OpCode.APPLY: {
                    blocks.add(nextIp);
                    break;
                }
                case OpCode.CALLCC: {
                    blocks.add(nextIp);
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
                    return executor.handleHostException(ctx, frame, err);
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
                    const procExpr = this.getProcExprFromProcIdx(procIdx);
                    out.emit(`
                        {
                            const proc = ${procExpr};
                            frame.ip = ${ip};
                            return executor.invoke(ctx, proc, frame, regs, ${startReg}, ${nargs}, true);
                        }
                    `);
                    return;
                }
                case OpCode.APPLY: {
                    const procIdx = inst[ip++];
                    const destReg = inst[ip++];
                    const startReg = inst[ip++];
                    const nargs = inst[ip++];
                    const nextIp = ip;
                    const flattenCall = ((nargs | 0) === -1)
                        ? `ctx.flattenListArgs(regs[${startReg}])`
                        : `ctx.flattenDynamicArgs(regs, ${startReg}, ${nargs})`;
                    const procExpr = this.getProcExprFromProcIdx(procIdx);
                    out.emit(`
                        {
                            const proc = ${procExpr};
                            const actualArgs = ${flattenCall};
                            if (proc instanceof BuiltinFunction) {
                                frame.ip = ${nextIp};
                                regs[${destReg}] = proc.cb(actualArgs, 0, actualArgs.length);
                                ctx.acc = regs[${destReg}];
                                ${blockSet ? `ip = ${nextIp}; continue;` : ""}
                            } else {
                                frame.retDestReg = ${destReg};
                                frame.ip = ${nextIp};
                                return executor.invoke(ctx, proc, frame, actualArgs, 0, actualArgs.length, false);
                            }
                        }
                    `);
                    return;
                }
                case OpCode.TAILAPPLY: {
                    const procIdx = inst[ip++];
                    const startReg = inst[ip++];
                    const nargs = inst[ip++];
                    const flattenCall = ((nargs | 0) === -1)
                        ? `ctx.flattenListArgs(regs[${startReg}])`
                        : `ctx.flattenDynamicArgs(regs, ${startReg}, ${nargs})`;
                    const procExpr = this.getProcExprFromProcIdx(procIdx);
                    out.emit(`
                        {
                            const proc = ${procExpr};
                            const actualArgs = ${flattenCall};
                            if (proc instanceof BuiltinFunction) {
                                frame.ip = ${ip};
                                ctx.acc = proc.cb(actualArgs, 0, actualArgs.length);
                                return executor.setRetVal(ctx, frame.parent, ctx.acc);
                            } else {
                                frame.ip = ${ip};
                                return executor.invoke(ctx, proc, frame, actualArgs, 0, actualArgs.length, true);
                            }
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
                case OpCode.WIND: {
                    const beforeReg = inst[ip++];
                    const afterReg = inst[ip++];
                    out.emit(`ctx.wind = new WindPoint(ctx.wind, regs[${beforeReg}], regs[${afterReg}]);`);
                    break;
                }
                case OpCode.ENDWIND: {
                    out.emit(`if (ctx.wind !== null) ctx.wind = ctx.wind.parent;`);
                    break;
                }
                case OpCode.CALLCC: {
                    const destReg = inst[ip++];
                    const procReg = inst[ip++];
                    const nextIp = ip;
                    out.emit(`
                        frame.retDestReg = ${destReg};
                        frame.ip = ${nextIp};
                        frame.share(ctx);
                        {
                            const vmCont = new VMContinuation(frame, ctx.id, ctx.wind);
                            return executor.invoke(ctx, regs[${procReg}], frame, [vmCont], 0, 1, false);
                        }
                    `);
                    return;
                }
                case OpCode.TAILCALLCC: {
                    const procReg = inst[ip++];
                    out.emit(`
                        frame.ip = ${ip};
                        {
                            if (frame.parent !== null) {
                                frame.parent.share(ctx);
                            }
                            const vmCont = new VMContinuation(frame.parent, ctx.id, ctx.wind);
                            return executor.invoke(ctx, regs[${procReg}], frame, [vmCont], 0, 1, true);
                        }
                    `);
                    return;
                }
                case OpCode.SETRAISEPROC: {
                    const srcReg = inst[ip++];
                    out.emit(`executor.raiseProc = regs[${srcReg}];`);
                    break;
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
