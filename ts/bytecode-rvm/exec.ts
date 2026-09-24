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

    public static compileAll(code: ByteCode): void {
        if (code.nativeFn === null) {
            this.compile(code);
        }
        for (const c of code.constants) {
            if (c instanceof ClosureTemplate) {
                this.compileAll(c.code);
            } else if (c instanceof Closure) {
                this.compileAll(c.tmpl.code);
            }
        }
    }

    public static compile(code: ByteCode): NativeFn {
        const fn = this.generateFunction(code);
        code.nativeFn = fn;
        return fn;
    }

    public static generateFunction(code: ByteCode): NativeFn {
        const source = this.generateSource(code);
        const factory = new Function(...Object.keys(JIT_DEPS), source);
        return factory(...Object.values(JIT_DEPS));
    }

    private static builtinIdx(procIdx: number): number | null {
        return procIdx >= BUILTINS_START ? procIdx - BUILTINS_START : null;
    }

    private static procExpr(procIdx: number): string {
        const bidx = this.builtinIdx(procIdx);
        return bidx === null ? `regs[${procIdx}]` : `IBUILTINS[${bidx}]`;
    }

    // Finds basic blocks that point to start of next inst
    //
    // needed for call/cc to know where to resume in pure jit mode
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

    public static generateSource(code: ByteCode): string {
        const inst = code.inst;
        const out = new CodeEmitter();
        const basicBlocks = this.findBasicBlocks(inst);

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
            const blockSet = new Set(basicBlocks);
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
                case OpCode.LOADUPVAR: {
                    const destReg = inst[ip++];
                    const upvarIdx = inst[ip++];
                    const andUnbox = inst[ip++];
                    out.emit(`regs[${destReg}] = upvars[${upvarIdx}]${andUnbox ? ".val" : ""};`);
                    break;
                }
                case OpCode.SETUPVAR: {
                    const srcReg = inst[ip++];
                    const upvarIdx = inst[ip++];
                    const andBox = inst[ip++];
                    out.emit(`upvars[${upvarIdx}] = ${andBox ? `new Box(regs[${srcReg}])` : `regs[${srcReg}]`};`);
                    break;
                }
                case OpCode.LOADGLOBAL:
                case OpCode.HASGLOBAL: {
                    const destReg = opcode === OpCode.LOADGLOBAL ? inst[ip++] : null;
                    const symConstIdx = inst[ip++];
                    out.emit(`
                        {
                            const varname = constants[${symConstIdx}];
                            if (!ctx.scope.has(varname)) {
                                frame.ip = ${opIp};
                                throw new MissingVarError("Variable '" + String(varname) + "' is not defined in the current scope.");
                            }
                            ${destReg !== null ? `regs[${destReg}] = ctx.scope.get(varname);` : ""}
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
                case OpCode.IF: {
                    const condReg = inst[ip++];
                    const elseOffset = inst[ip++];
                    if (blockSet) {
                        out.emit(`ip = isTruthy(regs[${condReg}]) ? ${ip} : ${elseOffset}; continue;`);
                        return;
                    }
                    out.emit(`if (isTruthy(regs[${condReg}])) {`);
                    break;
                }
                case OpCode.ELSE: {
                    const endOffset = inst[ip++];
                    if (blockSet) {
                        out.emit(`ip = ${endOffset}; continue;`);
                        return;
                    }
                    out.emit(`} else {`);
                    break;
                }
                case OpCode.ENDIF: {
                    if (blockSet) {
                        out.emit(`ip = ${ip}; continue;`);
                        return;
                    }
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
                    out.emit(`regs[${destReg}] = regs[${srcReg}].val;`);
                    break;
                }
                case OpCode.SETBOX: {
                    const destReg = inst[ip++];
                    const srcReg = inst[ip++];
                    out.emit(`regs[${destReg}].val = regs[${srcReg}];`);
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
                    const bidx = this.builtinIdx(procIdx);

                    if (bidx !== null) {
                        out.emit(`
                            frame.ip = ${ip};
                            regs[${destReg}] = IBUILTINS[${bidx}].cb(regs, ${startReg}, ${nargs});
                            ctx.acc = regs[${destReg}];
                        `);
                        break;
                    }

                    out.emit(`
                        {
                            const proc = regs[${procIdx}];
                            frame.ip = ${ip};
                            if (proc instanceof BuiltinFunction) {
                                regs[${destReg}] = proc.cb(regs, ${startReg}, ${nargs});
                                ctx.acc = regs[${destReg}];
                                ${blockSet ? `ip = ${ip}; continue;` : ""}
                            } else {
                                frame.retDestReg = ${destReg};
                                return executor.invoke(ctx, proc, frame, regs, ${startReg}, ${nargs}, false);
                            }
                        }
                    `);
                    return;
                }
                case OpCode.TAILCALL: {
                    const procIdx = inst[ip++];
                    const startReg = inst[ip++];
                    const nargs = inst[ip++];
                    const bidx = this.builtinIdx(procIdx);
                    out.emit(`frame.ip = ${ip};`);

                    if (bidx !== null) {
                        out.emit(`
                            ctx.acc = IBUILTINS[${bidx}].cb(regs, ${startReg}, ${nargs});
                            return executor.setRetVal(ctx, frame.parent, ctx.acc);
                        `);
                        return;
                    }

                    out.emit(`return executor.invoke(ctx, regs[${procIdx}], frame, regs, ${startReg}, ${nargs}, true);`);
                    return;
                }
                case OpCode.APPLY: {
                    const procIdx = inst[ip++];
                    const destReg = inst[ip++];
                    const startReg = inst[ip++];
                    const nargs = inst[ip++];
                    out.emit(`
                        frame.ip = ${ip};
                        frame.retDestReg = ${destReg};
                        return executor.apply(ctx, ${this.procExpr(procIdx)}, frame, windowApplyArgs(regs, ${startReg}, ${nargs}), false);
                    `);
                    return;
                }
                case OpCode.TAILAPPLY: {
                    const procIdx = inst[ip++];
                    const startReg = inst[ip++];
                    const nargs = inst[ip++];
                    out.emit(`
                        frame.ip = ${ip};
                        return executor.apply(ctx, ${this.procExpr(procIdx)}, frame, windowApplyArgs(regs, ${startReg}, ${nargs}), true);
                    `);
                    return;
                }
                case OpCode.APPLYLIST: {
                    const procIdx = inst[ip++];
                    const destReg = inst[ip++];
                    const listReg = inst[ip++];
                    out.emit(`
                        frame.ip = ${ip};
                        frame.retDestReg = ${destReg};
                        return executor.apply(ctx, ${this.procExpr(procIdx)}, frame, listApplyArgs(regs[${listReg}]), false);
                    `);
                    return;
                }
                case OpCode.TAILAPPLYLIST: {
                    const procIdx = inst[ip++];
                    const listReg = inst[ip++];
                    out.emit(`
                        frame.ip = ${ip};
                        return executor.apply(ctx, ${this.procExpr(procIdx)}, frame, listApplyArgs(regs[${listReg}]), true);
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
                    out.emit(`
                        frame.ip = ${ip};
                        frame.retDestReg = ${destReg};
                        return executor.callCC(ctx, regs[${procReg}], frame, false);
                    `);
                    return;
                }
                case OpCode.TAILCALLCC: {
                    const procReg = inst[ip++];
                    out.emit(`
                        frame.ip = ${ip};
                        return executor.callCC(ctx, regs[${procReg}], frame, true);
                    `);
                    return;
                }
                case OpCode.SETRAISEPROC: {
                    const srcReg = inst[ip++];
                    out.emit(`executor.raiseProc = regs[${srcReg}];`);
                    break;
                }
                case OpCode.LIST:
                case OpCode.CONS:
                {
                    const destReg = inst[ip++];
                    const startReg = inst[ip++];
                    const nargs = inst[ip++];
                    out.emit(`regs[${destReg}] = ${WINDOW_FN_NAMES[opcode]}(regs, ${startReg}, ${nargs});`);
                    break;
                }
                case OpCode.CXR: {
                    const destReg = inst[ip++];
                    const startReg = inst[ip++];
                    const nargs = inst[ip++];
                    const idx = inst[ip++];
                    out.emit(`regs[${destReg}] = CXR_FNS[${idx}](regs, ${startReg}, ${nargs});`);
                    break;
                }
                case OpCode.PREDICATE: {
                    const destReg = inst[ip++];
                    const startReg = inst[ip++];
                    const nargs = inst[ip++];
                    const idx = inst[ip++];
                    out.emit(`regs[${destReg}] = PREDICATE_FNS[${idx}](regs, ${startReg}, ${nargs});`);
                    break;
                }
                case OpCode.ARITHMETIC: {
                    const destReg = inst[ip++];
                    const startReg = inst[ip++];
                    const nargs = inst[ip++];
                    const idx = inst[ip++];
                    out.emit(`regs[${destReg}] = ARITHMETIC_FNS[${idx}](regs, ${startReg}, ${nargs});`);
                    break;
                }
                default: {
                    throw new Error(`Unhandled opcode in JIT: ${opcode}`);
                }
            }
        }

        if (blockSet && ip < inst.length) {
            out.emit(`ip = ${ip}; continue;`);
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
