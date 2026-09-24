import {
    ErrorObject,
    MissingVarError,
    UnhandledSchemeError,
    isTruthy,
    Table,
    IProcedure,
    type AbstractVM,
    AbstractByteCode,
    BS,
    BSReader,
    SerializableBytecode,
    AbstractClosure
} from "../common";
import { Cons } from "../list";
import { ARITHMETIC_FNS, makeList, opCons, CXR_FNS, PREDICATE_FNS } from "../ops";
import { BuiltinFunction, IBUILTINS } from "../std";

export const BUILTINS_START = 2**31;

export enum OpCode {
    LOADCONST,
    LOADU32,
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
    APPLYLIST,
    TAILAPPLYLIST,
    LIST,
    CONS,
    CXR,
    PREDICATE,
    ARITHMETIC,
}

export const INSTRUCTION_LENGTHS: Record<OpCode, number> = {
    [OpCode.ENDIF]: 1,
    [OpCode.ENDWIND]: 1,
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
    [OpCode.APPLYLIST]: 4,
    [OpCode.TAILAPPLYLIST]: 3,
    [OpCode.LIST]: 4,
    [OpCode.CONS]: 4,
    [OpCode.CXR]: 5,
    [OpCode.PREDICATE]: 5,
    [OpCode.ARITHMETIC]: 5,
};

export type NativeFn = (
    ctx: ExecutionContext,
    frame: Frame,
    vm: AbstractVM,
    executor: VMExecutor
) => Frame | null;

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

const WINDOW_OPS = { makeList, opCons };

const WINDOW_FN_NAMES: Partial<Record<OpCode, keyof typeof WINDOW_OPS>> = {
    [OpCode.LIST]: "makeList",
    [OpCode.CONS]: "opCons",
};


export const createRegs = (numRegs: number) => {
    return new Array(numRegs).fill(undefined);
};

export const resolveProc = (regs: readonly any[], procIdx: number): any => {
    return procIdx < BUILTINS_START ? regs[procIdx] : IBUILTINS[procIdx - BUILTINS_START];
};

const spliceLast = (args: any[]): any[] => {
    const finalArg = args.pop();
    if (finalArg instanceof Cons) {
        for (const v of finalArg) args.push(v);
    } else if (finalArg !== null) {
        throw new Error(`apply: last argument must be a list but got ${String(finalArg)}`);
    }
    return args;
};

export const windowApplyArgs = (regs: readonly any[], startReg: number, nargs: number): any[] => {
    return spliceLast(regs.slice(startReg, startReg + nargs));
};

export const listApplyArgs = (lst: Cons | null): any[] => {
    return spliceLast(lst === null ? [] : [...lst]);
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

export type WindAction = { type: "after" | "before"; thunk: any; nextWind: WindPoint | null };

function depthOf(w: WindPoint | null): number {
    return w === null ? -1 : w.depth;
}

export function computeWindTransition(fromWind: WindPoint | null, toWind: WindPoint | null): WindAction[] {
    if (fromWind === toWind) {
        return [];
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

    return actions;
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

export class VMExecutor {
    public raiseProc: any | null = null;

    constructor(public vm: AbstractVM) {}

    public enter(ctx: ExecutionContext, frame: Frame): Frame {
        if (frame.isShared(ctx)) {
            frame = frame.thaw(ctx);
        }
        ctx.currentFrame = frame;
        return frame;
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

            ctx.pendingWind = null;
            ctx.wind = trans.targetWind;
            ctx.acc = trans.targetVal;
            return this.setRetVal(ctx, trans.targetFrame, trans.targetVal);
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
        const returnTo = (isTail && callerFrame !== null) ? callerFrame.parent : callerFrame;

        if (proc instanceof BuiltinFunction) {
            ctx.acc = proc.cb(callerArgs, startReg, nargs);
            return this.setRetVal(ctx, returnTo, ctx.acc);
        }

        if (proc instanceof Closure) {
            const pregs = this.createClosureArg(proc.tmpl, nargs, callerArgs, startReg);
            if (isTail && callerFrame !== null && !callerFrame.isShared(ctx)) {
                return this.reset(callerFrame, proc, pregs);
            }
            return this.newFrame(ctx, proc, pregs, returnTo);
        }

        if (proc instanceof VMContinuation) {
            if (proc.ctxId !== ctx.id) {
                throw new Error("Cannot invoke a continuation across execution/FFI boundary");
            }
            if (nargs !== 1) throw new Error(`continuation expected exactly 1 argument, but received ${nargs}`);

            const targetVal = callerArgs[startReg];
            const actions = computeWindTransition(ctx.wind, proc.wind);

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
        }

        throw new Error(`Attempted to call a non-procedure: ${String(proc)}`);
    }

    public apply(ctx: ExecutionContext, proc: any, frame: Frame, args: any[], isTail: boolean): Frame | null {
        return this.invoke(ctx, proc, frame, args, 0, args.length, isTail);
    }

    public callCC(ctx: ExecutionContext, proc: any, frame: Frame, isTail: boolean): Frame | null {
        const target = isTail ? frame.parent : frame;
        target?.share(ctx);
        const k = new VMContinuation(target, ctx.id, ctx.wind);
        return this.invoke(ctx, proc, frame, [k], 0, 1, isTail);
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
            frame = BytecodeInterpreter.step(ctx, executor.enter(ctx, frame), executor);
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
                        if (!ctx.scope.has(varname)) {
                            throw new MissingVarError(`Variable '${String(varname)}' is not defined in the current scope.`);
                        }
                        regs[destReg] = ctx.scope.get(varname);
                        break;
                    }
                    case OpCode.SETGLOBAL: {
                        const srcReg = inst[ip++];
                        ctx.scope.set(constants[inst[ip++]], regs[srcReg]);
                        break;
                    }
                    case OpCode.HASGLOBAL: {
                        const varname = constants[inst[ip++]] as symbol;
                        if (!ctx.scope.has(varname)) {
                            throw new MissingVarError(`Variable '${String(varname)}' is not defined in the current scope.`);
                        }
                        break;
                    }
                    case OpCode.IF: {
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
                        const procIdx = inst[ip++];
                        const destReg = inst[ip++];
                        const startReg = inst[ip++];
                        const nargs = inst[ip++];

                        if (procIdx >= BUILTINS_START) {
                            regs[destReg] = IBUILTINS[procIdx - BUILTINS_START].cb(regs, startReg, nargs);
                            break;
                        }
                        const proc = regs[procIdx];
                        if (proc instanceof BuiltinFunction) {
                            regs[destReg] = proc.cb(regs, startReg, nargs);
                            break;
                        }

                        frame.ip = ip;
                        frame.retDestReg = destReg;
                        return executor.invoke(ctx, proc, frame, regs, startReg, nargs, false);
                    }
                    case OpCode.TAILCALL: {
                        const proc = resolveProc(regs, inst[ip++]);
                        const startReg = inst[ip++];
                        const nargs = inst[ip++];

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
                                ip = 0;
                                break;
                            }
                        }

                        frame.ip = ip;
                        return executor.invoke(ctx, proc, frame, regs, startReg, nargs, true);
                    }
                    case OpCode.APPLY: {
                        const proc = resolveProc(regs, inst[ip++]);
                        const destReg = inst[ip++];
                        const startReg = inst[ip++];
                        const nargs = inst[ip++];
                        frame.ip = ip;
                        frame.retDestReg = destReg;
                        return executor.apply(ctx, proc, frame, windowApplyArgs(regs, startReg, nargs), false);
                    }
                    case OpCode.TAILAPPLY: {
                        const proc = resolveProc(regs, inst[ip++]);
                        const startReg = inst[ip++];
                        const nargs = inst[ip++];
                        frame.ip = ip;
                        return executor.apply(ctx, proc, frame, windowApplyArgs(regs, startReg, nargs), true);
                    }
                    case OpCode.APPLYLIST: {
                        const proc = resolveProc(regs, inst[ip++]);
                        const destReg = inst[ip++];
                        const listReg = inst[ip++];
                        frame.ip = ip;
                        frame.retDestReg = destReg;
                        return executor.apply(ctx, proc, frame, listApplyArgs(regs[listReg]), false);
                    }
                    case OpCode.TAILAPPLYLIST: {
                        const proc = resolveProc(regs, inst[ip++]);
                        const listReg = inst[ip++];
                        frame.ip = ip;
                        return executor.apply(ctx, proc, frame, listApplyArgs(regs[listReg]), true);
                    }
                    case OpCode.WIND: {
                        const beforeReg = inst[ip++];
                        const afterReg = inst[ip++];
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
                        const destReg = inst[ip++];
                        const procReg = inst[ip++];
                        frame.ip = ip;
                        frame.retDestReg = destReg;
                        return executor.callCC(ctx, regs[procReg], frame, false);
                    }
                    case OpCode.TAILCALLCC: {
                        const procReg = inst[ip++];
                        frame.ip = ip;
                        return executor.callCC(ctx, regs[procReg], frame, true);
                    }
                    case OpCode.SETRAISEPROC: {
                        executor.raiseProc = regs[inst[ip++]];
                        break;
                    }
                    case OpCode.LIST: {
                        const destReg = inst[ip++];
                        const startReg = inst[ip++];
                        regs[destReg] = makeList(regs, startReg, inst[ip++]);
                        break;
                    }
                    case OpCode.CONS: {
                        const destReg = inst[ip++];
                        const startReg = inst[ip++];
                        regs[destReg] = opCons(regs, startReg, inst[ip++]);
                        break;
                    }
                    case OpCode.CXR: {
                        const destReg = inst[ip++];
                        const startReg = inst[ip++];
                        const nargs = inst[ip++];
                        regs[destReg] = CXR_FNS[inst[ip++]](regs, startReg, nargs);
                        break;
                    }
                    case OpCode.PREDICATE: {
                        const destReg = inst[ip++];
                        const startReg = inst[ip++];
                        const nargs = inst[ip++];
                        regs[destReg] = PREDICATE_FNS[inst[ip++]](regs, startReg, nargs);
                        break;
                    }
                    case OpCode.ARITHMETIC: {
                        const destReg = inst[ip++];
                        const startReg = inst[ip++];
                        const nargs = inst[ip++];
                        regs[destReg] = ARITHMETIC_FNS[inst[ip++]](regs, startReg, nargs);
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

const JIT_DEPS = {
    IBUILTINS,
    isTruthy,
    Box,
    MissingVarError,
    Closure,
    BuiltinFunction,
    WindPoint,
    ...WINDOW_OPS,
    CXR_FNS,
    PREDICATE_FNS,
    ARITHMETIC_FNS,
    windowApplyArgs,
    listApplyArgs,
    Cons,
};

type ProcRef = { reg: number } | { builtin: number };

type AotInst =
    | { k: "LoadConst"; dst: number; idx: number }
    | { k: "LoadInt"; dst: number; value: number }
    | { k: "LoadUpvar"; dst: number; idx: number; unbox: boolean }
    | { k: "SetUpvar"; src: number; idx: number; box: boolean }
    | { k: "LoadGlobal"; dst: number | null; sym: number; ip: number }
    | { k: "SetGlobal"; src: number; sym: number }
    | { k: "Move" | "Box" | "Unbox" | "SetBox"; dst: number; src: number }
    | { k: "NewClosure"; dst: number; tmpl: number }
    | { k: "Wind"; before: number; after: number }
    | { k: "EndWind" }
    | { k: "SetRaiseProc"; src: number }
    | { k: "CallBuiltin"; builtin: number; dst: number; start: number; nargs: number; resume: number }
    | { k: "WindowOp"; fn: keyof typeof WINDOW_OPS; dst: number; start: number; nargs: number }
    | { k: "TableOp"; table: "CXR_FNS" | "PREDICATE_FNS" | "ARITHMETIC_FNS"; idx: number; dst: number; start: number; nargs: number };

type AotTerm =
    | { k: "Jump"; target: number }
    | { k: "Branch"; cond: number; then: number; else: number }
    | { k: "Call"; proc: number; dst: number; start: number; nargs: number; resume: number }
    | { k: "TailCallBuiltin"; builtin: number; start: number; nargs: number; ip: number }
    | { k: "TailCall"; proc: number; start: number; nargs: number; ip: number }
    | { k: "MaybeSelfTailCall"; proc: number; start: number; nargs: number; ip: number; numPos: number; hasRest: boolean }
    | { k: "Apply"; proc: ProcRef; dst: number | null; args: { start: number; nargs: number } | { list: number }; resume: number }
    | { k: "CallCC"; proc: number; dst: number | null; resume: number }
    | { k: "Return"; reg: number };

type AotBlock = { start: number; insts: AotInst[]; term: AotTerm };

const TABLE_OPS: Partial<Record<OpCode, "CXR_FNS" | "PREDICATE_FNS" | "ARITHMETIC_FNS">> = {
    [OpCode.CXR]: "CXR_FNS",
    [OpCode.PREDICATE]: "PREDICATE_FNS",
    [OpCode.ARITHMETIC]: "ARITHMETIC_FNS",
};

export class JITCompiler {
    public static run(ctx: ExecutionContext, initialFrame: Frame, executor: VMExecutor): any {
        let frame: Frame | null = initialFrame;

        while (frame !== null) {
            frame = executor.enter(ctx, frame);
            const nativeFn = frame.code.nativeFn;
            if (nativeFn === null) {
                throw new Error(`AOT mode encountered uncompiled code in frame: ${frame.debugName}`);
            }
            frame = nativeFn(ctx, frame, ctx.vm, executor);
        }

        return ctx.acc;
    }

    public static compileAll(code: ByteCode, tmpl?: ClosureTemplate): void {
        if (code.nativeFn === null) {
            this.compile(code, tmpl);
        }
        for (const c of code.constants) {
            if (c instanceof ClosureTemplate) {
                this.compileAll(c.code, c);
            } else if (c instanceof Closure) {
                this.compileAll(c.tmpl.code, c.tmpl);
            }
        }
    }

    public static compile(code: ByteCode, tmpl?: ClosureTemplate): NativeFn {
        const fn = this.generateFunction(code, tmpl);
        code.nativeFn = fn;
        return fn;
    }

    public static generateFunction(code: ByteCode, tmpl?: ClosureTemplate): NativeFn {
        const source = this.generateSource(code, tmpl);
        const factory = new Function(...Object.keys(JIT_DEPS), source);
        return factory(...Object.values(JIT_DEPS));
    }

    public static generateSource(code: ByteCode, tmpl?: ClosureTemplate): string {
        const out = new CodeEmitter();
        out.emitFunction(this.buildAot(code, tmpl), code.inst.length);
        return out.toString();
    }

    public static findBasicBlocks(inst: Uint32Array): number[] {
        const blocks = new Set<number>([0]);
        let ip = 0;
        while (ip < inst.length) {
            const opcode: OpCode = inst[ip];
            const nextIp = ip + (INSTRUCTION_LENGTHS[opcode] ?? 1);

            switch (opcode) {
                case OpCode.IF:
                    blocks.add(nextIp);
                    blocks.add(inst[ip + 2]);
                    break;
                case OpCode.ELSE:
                    blocks.add(inst[ip + 1]);
                    break;
                case OpCode.CALL:
                    if (inst[ip + 1] < BUILTINS_START) blocks.add(nextIp);
                    break;
                case OpCode.APPLY:
                case OpCode.APPLYLIST:
                case OpCode.CALLCC:
                    blocks.add(nextIp);
                    break;
            }

            ip = nextIp;
        }
        return Array.from(blocks).sort((a, b) => a - b);
    }

    public static buildAot(code: ByteCode, tmpl?: ClosureTemplate): AotBlock[] {
        const inst = code.inst;
        const starts = this.findBasicBlocks(inst);
        const blocks: AotBlock[] = [];

        for (let b = 0; b < starts.length; b++) {
            const end = b + 1 < starts.length ? starts[b + 1] : inst.length;
            const insts: AotInst[] = [];
            let term: AotTerm | null = null;
            let ip = starts[b];

            while (ip < end && term === null) {
                const opIp = ip;
                const opcode: OpCode = inst[ip++];
                switch (opcode) {
                    case OpCode.LOADCONST:
                        insts.push({ k: "LoadConst", dst: inst[ip++], idx: inst[ip++] });
                        break;
                    case OpCode.LOADU32:
                        insts.push({ k: "LoadInt", dst: inst[ip++], value: inst[ip++] });
                        break;
                    case OpCode.LOADUPVAR:
                        insts.push({ k: "LoadUpvar", dst: inst[ip++], idx: inst[ip++], unbox: inst[ip++] !== 0 });
                        break;
                    case OpCode.SETUPVAR:
                        insts.push({ k: "SetUpvar", src: inst[ip++], idx: inst[ip++], box: inst[ip++] !== 0 });
                        break;
                    case OpCode.LOADGLOBAL:
                        insts.push({ k: "LoadGlobal", dst: inst[ip++], sym: inst[ip++], ip: opIp });
                        break;
                    case OpCode.HASGLOBAL:
                        insts.push({ k: "LoadGlobal", dst: null, sym: inst[ip++], ip: opIp });
                        break;
                    case OpCode.SETGLOBAL:
                        insts.push({ k: "SetGlobal", src: inst[ip++], sym: inst[ip++] });
                        break;
                    case OpCode.MOVE:
                        insts.push({ k: "Move", dst: inst[ip++], src: inst[ip++] });
                        break;
                    case OpCode.BOX:
                        insts.push({ k: "Box", dst: inst[ip++], src: inst[ip++] });
                        break;
                    case OpCode.UNBOX:
                        insts.push({ k: "Unbox", dst: inst[ip++], src: inst[ip++] });
                        break;
                    case OpCode.SETBOX:
                        insts.push({ k: "SetBox", dst: inst[ip++], src: inst[ip++] });
                        break;
                    case OpCode.NEWCLOSURE:
                        insts.push({ k: "NewClosure", dst: inst[ip++], tmpl: inst[ip++] });
                        break;
                    case OpCode.WIND:
                        insts.push({ k: "Wind", before: inst[ip++], after: inst[ip++] });
                        break;
                    case OpCode.ENDWIND:
                        insts.push({ k: "EndWind" });
                        break;
                    case OpCode.SETRAISEPROC:
                        insts.push({ k: "SetRaiseProc", src: inst[ip++] });
                        break;
                    case OpCode.LIST:
                    case OpCode.CONS:
                        insts.push({ k: "WindowOp", fn: WINDOW_FN_NAMES[opcode]!, dst: inst[ip++], start: inst[ip++], nargs: inst[ip++] });
                        break;
                    case OpCode.CXR:
                    case OpCode.PREDICATE:
                    case OpCode.ARITHMETIC:
                        insts.push({ k: "TableOp", table: TABLE_OPS[opcode]!, dst: inst[ip++], start: inst[ip++], nargs: inst[ip++], idx: inst[ip++] });
                        break;
                    case OpCode.IF: {
                        const cond = inst[ip++];
                        const elseIp = inst[ip++];
                        term = { k: "Branch", cond, then: ip, else: elseIp };
                        break;
                    }
                    case OpCode.ELSE:
                        term = { k: "Jump", target: inst[ip++] };
                        break;
                    case OpCode.ENDIF:
                        term = { k: "Jump", target: ip };
                        break;
                    case OpCode.CALL: {
                        const procIdx = inst[ip++];
                        const dst = inst[ip++];
                        const start = inst[ip++];
                        const nargs = inst[ip++];
                        if (procIdx >= BUILTINS_START) {
                            insts.push({ k: "CallBuiltin", builtin: procIdx - BUILTINS_START, dst, start, nargs, resume: ip });
                        } else {
                            term = { k: "Call", proc: procIdx, dst, start, nargs, resume: ip };
                        }
                        break;
                    }
                    case OpCode.TAILCALL: {
                        const procIdx = inst[ip++];
                        const start = inst[ip++];
                        const nargs = inst[ip++];
                        if (procIdx >= BUILTINS_START) {
                            term = { k: "TailCallBuiltin", builtin: procIdx - BUILTINS_START, start, nargs, ip };
                            break;
                        }
                        const numPos = tmpl ? tmpl.params.length : -1;
                        const hasRest = tmpl ? tmpl.remParams !== null : false;
                        const arityFits = tmpl !== undefined && (hasRest ? nargs >= numPos : nargs === numPos);
                        term = arityFits
                            ? { k: "MaybeSelfTailCall", proc: procIdx, start, nargs, ip, numPos, hasRest }
                            : { k: "TailCall", proc: procIdx, start, nargs, ip };
                        break;
                    }
                    case OpCode.APPLY:
                    case OpCode.TAILAPPLY: {
                        const procIdx = inst[ip++];
                        const dst = opcode === OpCode.APPLY ? inst[ip++] : null;
                        const start = inst[ip++];
                        const nargs = inst[ip++];
                        term = { k: "Apply", proc: this.procRef(procIdx), dst, args: { start, nargs }, resume: ip };
                        break;
                    }
                    case OpCode.APPLYLIST:
                    case OpCode.TAILAPPLYLIST: {
                        const procIdx = inst[ip++];
                        const dst = opcode === OpCode.APPLYLIST ? inst[ip++] : null;
                        term = { k: "Apply", proc: this.procRef(procIdx), dst, args: { list: inst[ip++] }, resume: ip };
                        break;
                    }
                    case OpCode.CALLCC: {
                        const dst = inst[ip++];
                        term = { k: "CallCC", proc: inst[ip++], dst, resume: ip };
                        break;
                    }
                    case OpCode.TAILCALLCC:
                        term = { k: "CallCC", proc: inst[ip++], dst: null, resume: ip };
                        break;
                    case OpCode.RETURN:
                        term = { k: "Return", reg: inst[ip++] };
                        break;
                    default: {
                        const _: never = opcode;
                        throw new Error(`Unhandled opcode in JIT: ${opcode}`);
                    }
                }
            }

            blocks.push({ start: starts[b], insts, term: term ?? { k: "Jump", target: ip } });
        }

        return blocks;
    }

    private static procRef(procIdx: number): ProcRef {
        return procIdx >= BUILTINS_START ? { builtin: procIdx - BUILTINS_START } : { reg: procIdx };
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

    emitFunction(blocks: AotBlock[], codeLength: number): void {
        this.emit(`
            return function(ctx, frame, vm, executor) {
                const regs = frame.regs;
                const upvars = frame.upvars;
                const constants = frame.code.constants;
                let ip = frame.ip;
                try {
                    while (true) {
                        switch (ip) {
        `);
        for (let i = 0; i < blocks.length; i++) {
            const next = i + 1 < blocks.length ? blocks[i + 1].start : codeLength;
            this.emit(`case ${blocks[i].start}: {`);
            for (const inst of blocks[i].insts) this.#emitInst(inst);
            this.#emitTerm(blocks[i].term, next, codeLength);
            this.emit(`}`);
        }
        this.emit(`
                            default:
                                return null;
                        }
                    }
                } catch (err) {
                    return executor.handleHostException(ctx, frame, err);
                }
            };
        `);
    }

    #emitInst(inst: AotInst): void {
        switch (inst.k) {
            case "LoadConst":
                return this.emit(`regs[${inst.dst}] = constants[${inst.idx}];`);
            case "LoadInt":
                return this.emit(`regs[${inst.dst}] = ${inst.value};`);
            case "LoadUpvar":
                return this.emit(`regs[${inst.dst}] = upvars[${inst.idx}]${inst.unbox ? ".val" : ""};`);
            case "SetUpvar":
                return this.emit(`upvars[${inst.idx}] = ${inst.box ? `new Box(regs[${inst.src}])` : `regs[${inst.src}]`};`);
            case "LoadGlobal":
                return this.emit(`
                    {
                        const varname = constants[${inst.sym}];
                        if (!ctx.scope.has(varname)) {
                            frame.ip = ${inst.ip};
                            throw new MissingVarError("Variable '" + String(varname) + "' is not defined in the current scope.");
                        }
                        ${inst.dst !== null ? `regs[${inst.dst}] = ctx.scope.get(varname);` : ""}
                    }
                `);
            case "SetGlobal":
                return this.emit(`ctx.scope.set(constants[${inst.sym}], regs[${inst.src}]);`);
            case "Move":
                return this.emit(`regs[${inst.dst}] = regs[${inst.src}];`);
            case "Box":
                return this.emit(`regs[${inst.dst}] = new Box(regs[${inst.src}]);`);
            case "Unbox":
                return this.emit(`regs[${inst.dst}] = regs[${inst.src}].val;`);
            case "SetBox":
                return this.emit(`regs[${inst.dst}].val = regs[${inst.src}];`);
            case "NewClosure":
                return this.emit(`regs[${inst.dst}] = Closure.create(constants[${inst.tmpl}], regs, upvars);`);
            case "Wind":
                return this.emit(`ctx.wind = new WindPoint(ctx.wind, regs[${inst.before}], regs[${inst.after}]);`);
            case "EndWind":
                return this.emit(`if (ctx.wind !== null) ctx.wind = ctx.wind.parent;`);
            case "SetRaiseProc":
                return this.emit(`executor.raiseProc = regs[${inst.src}];`);
            case "CallBuiltin":
                return this.emit(`
                    frame.ip = ${inst.resume};
                    regs[${inst.dst}] = IBUILTINS[${inst.builtin}].cb(regs, ${inst.start}, ${inst.nargs});
                    ctx.acc = regs[${inst.dst}];
                `);
            case "WindowOp":
                return this.emit(`regs[${inst.dst}] = ${inst.fn}(regs, ${inst.start}, ${inst.nargs});`);
            case "TableOp":
                return this.emit(`regs[${inst.dst}] = ${inst.table}[${inst.idx}](regs, ${inst.start}, ${inst.nargs});`);
            default: {
                const _: never = inst;
            }
        }
    }

    #jump(target: number, next: number, codeLength: number): string {
        if (target === next && target < codeLength) return "";
        if (target >= codeLength) return "return null;";
        return `ip = ${target}; continue;`;
    }

    #procExpr(proc: ProcRef): string {
        return "reg" in proc ? `regs[${proc.reg}]` : `IBUILTINS[${proc.builtin}]`;
    }

    #emitTerm(term: AotTerm, next: number, codeLength: number): void {
        switch (term.k) {
            case "Jump":
                return this.emit(this.#jump(term.target, next, codeLength));
            case "Branch":
                if (term.then === next) {
                    return this.emit(`if (!isTruthy(regs[${term.cond}])) { ${this.#jump(term.else, -1, codeLength)} }`);
                }
                return this.emit(`ip = isTruthy(regs[${term.cond}]) ? ${term.then} : ${term.else}; continue;`);
            case "Call":
                return this.emit(`
                    {
                        const proc = regs[${term.proc}];
                        frame.ip = ${term.resume};
                        if (proc instanceof BuiltinFunction) {
                            regs[${term.dst}] = proc.cb(regs, ${term.start}, ${term.nargs});
                            ctx.acc = regs[${term.dst}];
                        } else {
                            frame.retDestReg = ${term.dst};
                            return executor.invoke(ctx, proc, frame, regs, ${term.start}, ${term.nargs}, false);
                        }
                    }
                    ${this.#jump(term.resume, next, codeLength)}
                `);
            case "TailCallBuiltin":
                return this.emit(`
                    frame.ip = ${term.ip};
                    ctx.acc = IBUILTINS[${term.builtin}].cb(regs, ${term.start}, ${term.nargs});
                    return executor.setRetVal(ctx, frame.parent, ctx.acc);
                `);
            case "TailCall":
                return this.emit(`
                    frame.ip = ${term.ip};
                    return executor.invoke(ctx, regs[${term.proc}], frame, regs, ${term.start}, ${term.nargs}, true);
                `);
            case "MaybeSelfTailCall": {
                const moves: string[] = [];
                if (term.hasRest) {
                    moves.push(`let rest = null;`);
                    for (let i = term.nargs - 1; i >= term.numPos; i--) moves.push(`rest = new Cons(regs[${term.start + i}], rest);`);
                }
                for (let i = 0; i < term.numPos; i++) {
                    if (term.start + i !== i) moves.push(`regs[${i}] = regs[${term.start + i}];`);
                }
                if (term.hasRest) moves.push(`regs[${term.numPos}] = rest;`);
                return this.emit(`
                    {
                        const proc = regs[${term.proc}];
                        if (proc === frame.closure && !frame.isShared(ctx)) {
                            ${moves.join("\n")}
                            ip = 0;
                            continue;
                        }
                        frame.ip = ${term.ip};
                        return executor.invoke(ctx, proc, frame, regs, ${term.start}, ${term.nargs}, true);
                    }
                `);
            }
            case "Apply": {
                const args = "list" in term.args
                    ? `listApplyArgs(regs[${term.args.list}])`
                    : `windowApplyArgs(regs, ${term.args.start}, ${term.args.nargs})`;
                return this.emit(`
                    frame.ip = ${term.resume};
                    ${term.dst !== null ? `frame.retDestReg = ${term.dst};` : ""}
                    return executor.apply(ctx, ${this.#procExpr(term.proc)}, frame, ${args}, ${term.dst === null});
                `);
            }
            case "CallCC":
                return this.emit(`
                    frame.ip = ${term.resume};
                    ${term.dst !== null ? `frame.retDestReg = ${term.dst};` : ""}
                    return executor.callCC(ctx, regs[${term.proc}], frame, ${term.dst === null});
                `);
            case "Return":
                return this.emit(`
                    ctx.acc = regs[${term.reg}];
                    return executor.setRetVal(ctx, frame.parent, ctx.acc);
                `);
            default: {
                const _: never = term;
            }
        }
    }
}
