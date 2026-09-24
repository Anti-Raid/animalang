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
    AbstractClosure,
    OpaqueValue,
    packValues
} from "../common";
import { Cons } from "../list";
import { ARITHMETIC, ARITHMETIC_FNS, makeList, opCons, valuesToList, CXR_PATHS, CXR_FNS, PREDICATES, PREDICATE_FNS } from "../ops";
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
    CALLBUILTIN,
    MOVEACC,
    GETHANDLERS,
    SETHANDLERS,
    COCREATE,
    CORESUME,
    COYIELD,
    COSTATUS,
    CORESUMELIST,
    COYIELDLIST,
    VALUESLIST,
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
    [OpCode.CALLCC]: 2,
    [OpCode.NEWCLOSURE]: 3,
    [OpCode.BOX]: 3,
    [OpCode.UNBOX]: 3,
    [OpCode.SETBOX]: 3,
    [OpCode.MOVE]: 3,
    [OpCode.TAILCALL]: 4,
    [OpCode.TAILAPPLY]: 4,
    [OpCode.SETUPVAR]: 4,
    [OpCode.LOADUPVAR]: 4,
    [OpCode.CALL]: 4,
    [OpCode.APPLY]: 4,
    [OpCode.APPLYLIST]: 3,
    [OpCode.CALLBUILTIN]: 5,
    [OpCode.MOVEACC]: 2,
    [OpCode.GETHANDLERS]: 2,
    [OpCode.SETHANDLERS]: 2,
    [OpCode.COCREATE]: 3,
    [OpCode.CORESUME]: 4,
    [OpCode.COYIELD]: 3,
    [OpCode.CORESUMELIST]: 4,
    [OpCode.COYIELDLIST]: 2,
    [OpCode.COSTATUS]: 3,
    [OpCode.TAILAPPLYLIST]: 3,
    [OpCode.LIST]: 4,
    [OpCode.CONS]: 4,
    [OpCode.VALUESLIST]: 4,
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

export type DirectFn = (ctx: ExecutionContext, closure: Closure, executor: VMExecutor, ...args: any[]) => any;

export class ByteCode implements AbstractByteCode {
    public bsid = "ByteCode";
    public nativeFn: NativeFn | null = null;
    public directFn: DirectFn | null = null;
    public directArity: number = -1;
    public directRestArity: number = -1;
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

const WINDOW_OPS = { makeList, opCons, valuesToList };

const WINDOW_FN_NAMES: Partial<Record<OpCode, keyof typeof WINDOW_OPS>> = {
    [OpCode.LIST]: "makeList",
    [OpCode.CONS]: "opCons",
    [OpCode.VALUESLIST]: "valuesToList",
};


export const createRegs = (numRegs: number) => {
    const regs: any[] = [];
    for (let i = 0; i < numRegs; i++) regs.push(undefined);
    return regs;
};

export const listToArray = (lst: Cons | null): any[] => lst === null ? [] : [...lst];

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
    public jsDepth: number = 0;
    public handlers: Cons | null = null;
    public coroutine: Coroutine | null = null;
    public yielded: boolean = false;

    constructor(
        public vm: AbstractVM,
        public scope: Table
    ) {
        this.id = ++ExecutionContext.nextId;
    }
}

export type CoroutineStatus = "suspended" | "running" | "normal" | "dead";

export class Coroutine extends OpaqueValue {
    public status: CoroutineStatus = "suspended";
    public started: boolean = false;
    public frame: Frame | null = null;
    public readonly ctx: ExecutionContext;

    constructor(public readonly proc: any, vm: AbstractVM, scope: Table) {
        super();
        this.ctx = new ExecutionContext(vm, scope);
        this.ctx.coroutine = this;
    }

    get typeName() {
        return "coroutine";
    }
}

// an error that escaped a coroutine, raised again in the resumer as-is
export class ReRaise {
    constructor(public readonly value: any) {}
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
        public epoch: number = 0
    ) {
        this.code = closure.tmpl.code;
        this.upvars = closure.upvars;
    }

    get debugName(): string {
        return this.closure.debugName ?? "lambda";
    }

    thaw(ctx: ExecutionContext): Frame {
        return new Frame(this.closure, [...this.regs], this.ip, this.parent, ctx.epoch);
    }

    share(ctx: ExecutionContext): this {
        ctx.epoch++;
        return this;
    }

    isShared(ctx: ExecutionContext): boolean {
        return this.epoch < ctx.epoch;
    }
}

const MAX_JS_DEPTH = 1000;

const MISSING = Symbol("missing");

class EscapedError {
    constructor(public readonly error: any) {}
}

type SuspendAction = (ctx: ExecutionContext, executor: VMExecutor, caller: Frame) => Frame | null;

// thrown out of direct-entry code when heap frames are needed; each direct frame on the way out rebuilds itself
export class Suspend {
    innermost: Frame | null = null;
    outermost: Frame | null = null;

    constructor(public readonly action: SuspendAction | null, public readonly error?: any) {}

    push(frame: Frame) {
        if (this.outermost === null) {
            this.innermost = frame;
        } else {
            this.outermost.parent = frame;
        }
        this.outermost = frame;
    }

    static invoke(proc: any, args: any[]) {
        return new Suspend((ctx, executor, caller) => executor.invoke(ctx, proc, caller, args, 0, args.length, false));
    }

    static callCC(proc: any) {
        return new Suspend((ctx, executor, caller) => executor.callCC(ctx, proc, caller, false));
    }

    static error(err: any) {
        return new Suspend(null, err);
    }

    static yield(val: any) {
        return new Suspend((ctx, executor, caller) => executor.coYield(ctx, caller, val));
    }
}

const MAX_RESUME_DEPTH = 200;

export class VMExecutor {
    public raiseProc: any | null = null;
    public resumeDepth: number = 0;

    constructor(public vm: AbstractVM) {}

    public enter(ctx: ExecutionContext, frame: Frame): Frame {
        if (frame.isShared(ctx)) {
            frame = frame.thaw(ctx);
        }
        ctx.currentFrame = frame;
        return frame;
    }

    public handleHostException(ctx: ExecutionContext, frame: Frame | null, err: any): Frame | null {
        if (err instanceof EscapedError) throw err;
        if (err instanceof UnhandledSchemeError) {
            if (ctx.coroutine !== null) throw err;
            if (err.error instanceof Error) throw err.error;
            throw new Error(String(err.error));
        }
        if (err instanceof ReRaise) {
            if (this.raiseProc !== null && this.raiseProc !== false) {
                const val = err.value instanceof Error ? new ErrorObject(err.value) : err.value;
                return this.invoke(ctx, this.raiseProc, frame, [val], 0, 1, false);
            }
            const val = err.value instanceof ErrorObject ? err.value.error : err.value;
            throw val instanceof Error ? val : new Error(String(val));
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

    public callDirectRest(ctx: ExecutionContext, proc: Closure, args: any[]): any {
        const code = proc.tmpl.code;
        const numPos = code.directRestArity;
        let rest: Cons | null = null;
        for (let i = args.length - 1; i >= numPos; i--) rest = new Cons(args[i], rest);
        args.length = numPos;
        args.push(rest);
        return code.directFn!(ctx, proc, this, ...args);
    }

    public coCreate(ctx: ExecutionContext, proc: any): Coroutine {
        if (!(proc instanceof Closure || proc instanceof BuiltinFunction)) {
            throw new Error(`coroutine-create: expected a procedure but got ${String(proc)}`);
        }
        return new Coroutine(proc, ctx.vm, ctx.scope);
    }

    public coStatus(co: any): symbol {
        if (!(co instanceof Coroutine)) throw new Error(`coroutine-status: expected a coroutine but got ${String(co)}`);
        return Symbol.for(co.status);
    }

    public coYield(ctx: ExecutionContext, frame: Frame, val: any): Frame | null {
        const co = ctx.coroutine;
        if (co === null) throw new Error("coroutine-yield: not inside a coroutine (or across a host call boundary)");
        co.frame = frame;
        ctx.yielded = true;
        ctx.acc = val;
        return null;
    }

    public coResume(ctx: ExecutionContext | null, co: any, args: any[]): any {
        if (!(co instanceof Coroutine)) throw new Error(`coroutine-resume: expected a coroutine but got ${String(co)}`);
        if (co.status !== "suspended") throw new Error(`coroutine-resume: cannot resume a ${co.status} coroutine`);
        if (this.resumeDepth >= MAX_RESUME_DEPTH) throw new Error("coroutine-resume: too many nested resumes");

        const cctx = co.ctx;
        const outer = ctx?.coroutine ?? null;
        if (outer !== null) outer.status = "normal";
        co.status = "running";
        cctx.yielded = false;
        this.resumeDepth++;
        try {
            let frame: Frame | null;
            if (!co.started) {
                co.started = true;
                frame = this.invoke(cctx, co.proc, null, args, 0, args.length, false);
            } else {
                frame = co.frame;
                co.frame = null;
                cctx.acc = packValues(args);
            }
            if (frame !== null) {
                if ((this.vm as any).mode === "aot") {
                    JITCompiler.compileAll(frame.code, frame.closure.tmpl);
                    JITCompiler.run(cctx, frame, this);
                } else {
                    BytecodeInterpreter.run(cctx, frame, this);
                }
            }
        } catch (err) {
            co.status = "dead";
            throw new ReRaise(err instanceof UnhandledSchemeError ? err.error : err);
        } finally {
            this.resumeDepth--;
            if (outer !== null) outer.status = "running";
        }

        co.status = cctx.yielded ? "suspended" : "dead";
        return cctx.acc;
    }

    public resumeSuspend(ctx: ExecutionContext, sig: Suspend): Frame | null {
        const caller = sig.innermost!;
        try {
            if (sig.action === null) return this.handleHostException(ctx, caller, sig.error);
            try {
                return sig.action(ctx, this, caller);
            } catch (err) {
                return this.handleHostException(ctx, caller, err);
            }
        } catch (err) {
            throw err instanceof EscapedError ? err : new EscapedError(err);
        }
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
        ctx.acc = val;
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
        return new Frame(closure, regs, 0, parent, ctx.epoch);
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

        const closureRegs: any[] = [];
        for (let i = 0; i < arity; i++) {
            closureRegs.push(args[startOffset + i]);
        }

        if (template.remParams !== null) {
            let restList: any = null;
            for (let i = nargs - 1; i >= arity; i--) {
                restList = new Cons(args[startOffset + i], restList);
            }
            closureRegs.push(restList);
        }

        const numReg = template.code.numReg;
        while (closureRegs.length < numReg) closureRegs.push(undefined);
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
                    case OpCode.HASGLOBAL: {
                        const varname = constants[inst[ip++]] as symbol;
                        if (ctx.scope.lookup(varname, MISSING) === MISSING) {
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
                        const proc = regs[inst[ip++]];
                        const startReg = inst[ip++];
                        const nargs = inst[ip++];
                        if (proc instanceof BuiltinFunction) {
                            ctx.acc = proc.cb(regs, startReg, nargs);
                            break;
                        }
                        frame.ip = ip;
                        return executor.invoke(ctx, proc, frame, regs, startReg, nargs, false);
                    }
                    case OpCode.CALLBUILTIN: {
                        const builtin = IBUILTINS[inst[ip++]];
                        const destReg = inst[ip++];
                        const startReg = inst[ip++];
                        regs[destReg] = builtin.cb(regs, startReg, inst[ip++]);
                        break;
                    }
                    case OpCode.MOVEACC: {
                        regs[inst[ip++]] = ctx.acc;
                        break;
                    }
                    case OpCode.GETHANDLERS: {
                        regs[inst[ip++]] = ctx.handlers;
                        break;
                    }
                    case OpCode.SETHANDLERS: {
                        ctx.handlers = regs[inst[ip++]];
                        break;
                    }
                    case OpCode.COCREATE: {
                        const destReg = inst[ip++];
                        regs[destReg] = executor.coCreate(ctx, regs[inst[ip++]]);
                        break;
                    }
                    case OpCode.CORESUME: {
                        const destReg = inst[ip++];
                        const startReg = inst[ip++];
                        const nargs = inst[ip++];
                        regs[destReg] = executor.coResume(ctx, regs[startReg], regs.slice(startReg + 1, startReg + nargs));
                        break;
                    }
                    case OpCode.CORESUMELIST: {
                        const destReg = inst[ip++];
                        const coReg = inst[ip++];
                        regs[destReg] = executor.coResume(ctx, regs[coReg], listToArray(regs[inst[ip++]]));
                        break;
                    }
                    case OpCode.COYIELD: {
                        const startReg = inst[ip++];
                        const nargs = inst[ip++];
                        frame.ip = ip;
                        return executor.coYield(ctx, frame, packValues(regs.slice(startReg, startReg + nargs)));
                    }
                    case OpCode.COYIELDLIST: {
                        const listReg = inst[ip++];
                        frame.ip = ip;
                        return executor.coYield(ctx, frame, packValues(listToArray(regs[listReg])));
                    }
                    case OpCode.COSTATUS: {
                        const destReg = inst[ip++];
                        regs[destReg] = executor.coStatus(regs[inst[ip++]]);
                        break;
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
                        const startReg = inst[ip++];
                        const nargs = inst[ip++];
                        frame.ip = ip;
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
                        const listReg = inst[ip++];
                        frame.ip = ip;
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
                        const procReg = inst[ip++];
                        frame.ip = ip;
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
                    case OpCode.VALUESLIST: {
                        const destReg = inst[ip++];
                        const startReg = inst[ip++];
                        regs[destReg] = valuesToList(regs, startReg, inst[ip++]);
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
    MISSING,
    MAX_JS_DEPTH,
    Frame,
    Suspend,
    packValues,
    listToArray,
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
    | { k: "NewClosure"; dst: number; tmpl: number; captures: UpVarLoc[] }
    | { k: "Wind"; before: number; after: number }
    | { k: "EndWind" }
    | { k: "SetRaiseProc"; src: number }
    | { k: "MoveAcc"; dst: number }
    | { k: "GetHandlers"; dst: number }
    | { k: "SetHandlers"; src: number }
    | { k: "CoCreate"; dst: number; proc: number }
    | { k: "CoResume"; dst: number; start: number; nargs: number }
    | { k: "CoResumeList"; dst: number; co: number; list: number }
    | { k: "CoStatus"; dst: number; co: number }
    | { k: "CallBuiltin"; builtin: number; dst: number; start: number; nargs: number; resume: number }
    | { k: "WindowOp"; fn: keyof typeof WINDOW_OPS; dst: number; start: number; nargs: number }
    | { k: "TableOp"; table: "CXR_FNS" | "PREDICATE_FNS" | "ARITHMETIC_FNS"; idx: number; dst: number; start: number; nargs: number };

type AotTerm =
    | { k: "Jump"; target: number }
    | { k: "Branch"; cond: number; then: number; else: number }
    | { k: "Call"; proc: number; start: number; nargs: number; resume: number }
    | { k: "TailCallBuiltin"; builtin: number; start: number; nargs: number; ip: number }
    | { k: "TailCall"; proc: number; start: number; nargs: number; ip: number }
    | { k: "MaybeSelfTailCall"; proc: number; start: number; nargs: number; ip: number; numPos: number; hasRest: boolean }
    | { k: "Apply"; proc: ProcRef; isTail: boolean; args: { start: number; nargs: number } | { list: number }; resume: number }
    | { k: "CallCC"; proc: number; isTail: boolean; resume: number }
    | { k: "Yield"; args: { start: number; nargs: number } | { list: number }; resume: number }
    | { k: "Return"; reg: number };

type AotBlock = { start: number; insts: AotInst[]; term: AotTerm };

type EmitMode = "resume" | "direct";

const INLINE_BINARY_OPS: Record<string, string> = {
    "+": "+", "-": "-", "*": "*", "/": "/", "=": "===", "<": "<", "<=": "<=", ">": ">", ">=": ">=",
};

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
            try {
                frame = nativeFn(ctx, frame, ctx.vm, executor);
            } catch (err) {
                throw err instanceof EscapedError ? err.error : err;
            }
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
        const { resume, direct } = this.generateFunction(code, tmpl);
        code.nativeFn = resume;
        if (direct !== null && tmpl !== undefined) {
            code.directFn = direct;
            if (tmpl.remParams === null) code.directArity = tmpl.params.length;
            else code.directRestArity = tmpl.params.length;
        }
        return resume;
    }

    public static generateFunction(code: ByteCode, tmpl?: ClosureTemplate): { resume: NativeFn, direct: DirectFn | null } {
        const source = this.generateSource(code, tmpl);
        const factory = new Function(...Object.keys(JIT_DEPS), "CONSTANTS", source);
        return factory(...Object.values(JIT_DEPS), code.constants);
    }

    public static generateSource(code: ByteCode, tmpl?: ClosureTemplate): string {
        const blocks = this.buildAot(code, tmpl);
        const resume = new CodeEmitter("resume");
        resume.emitFunction(blocks, code.inst.length, code.numReg, 0);
        let direct = "null";
        if (tmpl !== undefined) {
            const out = new CodeEmitter("direct");
            out.emitFunction(blocks, code.inst.length, code.numReg, tmpl.params.length + (tmpl.remParams !== null ? 1 : 0));
            direct = out.toString();
        }
        return `return {\nresume: ${resume.toString()},\ndirect: ${direct}\n};`;
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
                case OpCode.APPLY:
                case OpCode.APPLYLIST:
                case OpCode.CALLCC:
                case OpCode.COYIELD:
                case OpCode.COYIELDLIST:
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
                    case OpCode.NEWCLOSURE: {
                        const dst = inst[ip++];
                        const tmplIdx = inst[ip++];
                        insts.push({ k: "NewClosure", dst, tmpl: tmplIdx, captures: (code.constants[tmplIdx] as ClosureTemplate).upvarLocs });
                        break;
                    }
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
                    case OpCode.VALUESLIST:
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
                        const proc = inst[ip++];
                        const start = inst[ip++];
                        const nargs = inst[ip++];
                        term = { k: "Call", proc, start, nargs, resume: ip };
                        break;
                    }
                    case OpCode.CALLBUILTIN: {
                        const builtin = inst[ip++];
                        const dst = inst[ip++];
                        const start = inst[ip++];
                        const nargs = inst[ip++];
                        insts.push({ k: "CallBuiltin", builtin, dst, start, nargs, resume: ip });
                        break;
                    }
                    case OpCode.MOVEACC:
                        insts.push({ k: "MoveAcc", dst: inst[ip++] });
                        break;
                    case OpCode.GETHANDLERS:
                        insts.push({ k: "GetHandlers", dst: inst[ip++] });
                        break;
                    case OpCode.SETHANDLERS:
                        insts.push({ k: "SetHandlers", src: inst[ip++] });
                        break;
                    case OpCode.COCREATE:
                        insts.push({ k: "CoCreate", dst: inst[ip++], proc: inst[ip++] });
                        break;
                    case OpCode.CORESUME:
                        insts.push({ k: "CoResume", dst: inst[ip++], start: inst[ip++], nargs: inst[ip++] });
                        break;
                    case OpCode.COSTATUS:
                        insts.push({ k: "CoStatus", dst: inst[ip++], co: inst[ip++] });
                        break;
                    case OpCode.COYIELD: {
                        const start = inst[ip++];
                        const nargs = inst[ip++];
                        term = { k: "Yield", args: { start, nargs }, resume: ip };
                        break;
                    }
                    case OpCode.COYIELDLIST:
                        term = { k: "Yield", args: { list: inst[ip++] }, resume: ip };
                        break;
                    case OpCode.CORESUMELIST:
                        insts.push({ k: "CoResumeList", dst: inst[ip++], co: inst[ip++], list: inst[ip++] });
                        break;
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
                        const start = inst[ip++];
                        const nargs = inst[ip++];
                        term = { k: "Apply", proc: this.procRef(procIdx), isTail: opcode === OpCode.TAILAPPLY, args: { start, nargs }, resume: ip };
                        break;
                    }
                    case OpCode.APPLYLIST:
                    case OpCode.TAILAPPLYLIST: {
                        const procIdx = inst[ip++];
                        term = { k: "Apply", proc: this.procRef(procIdx), isTail: opcode === OpCode.TAILAPPLYLIST, args: { list: inst[ip++] }, resume: ip };
                        break;
                    }
                    case OpCode.CALLCC:
                    case OpCode.TAILCALLCC:
                        term = { k: "CallCC", proc: inst[ip++], isTail: opcode === OpCode.TAILCALLCC, resume: ip };
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

    constructor(private readonly mode: EmitMode) {}

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

    #spillRegs: number[] = [];
    #written = new Set<number>();
    #liveIn = new Map<number, Set<number>>();
    #numReg = 0;

    emitFunction(blocks: AotBlock[], codeLength: number, numReg: number, arity: number): void {
        this.#numReg = numReg;
        const direct = this.mode === "direct";
        let locals: string[];
        if (direct) {
            locals = Array.from({ length: numReg }, (_, i) => i < arity ? `r${i} = a${i}` : `r${i}`);
        } else {
            this.#spillRegs = CodeEmitter.#writtenRegs(blocks, numReg);
            this.#written = new Set(this.#spillRegs);
            this.#liveIn = CodeEmitter.#liveness(blocks);
            const entryLive = new Set(this.#liveIn.get(0));
            for (const block of blocks) {
                const t = block.term;
                if (t.k === "Call" || t.k === "Apply" || t.k === "CallCC" || t.k === "Yield") {
                    for (const r of this.#liveIn.get(t.resume) ?? []) entryLive.add(r);
                }
            }
            locals = Array.from({ length: numReg }, (_, i) => entryLive.has(i) ? `r${i} = regs[${i}]` : `r${i}`);
        }

        const params = Array.from({ length: arity }, (_, i) => `a${i}`);
        this.emit(direct ? `
            function(ctx, closure, executor${params.map(p => `, ${p}`).join("")}) {
                const upvars = closure.upvars;
                let ip = 0, rip = 0, acc;
        ` : `
            function(ctx, frame, vm, executor) {
                const regs = frame.regs;
                const upvars = frame.upvars;
                let ip = frame.ip;
        `);
        this.emit(`
                ${locals.length > 0 ? `let ${locals.join(", ")};` : ""}
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
        const allRegs = Array.from({ length: numReg }, (_, i) => `r${i}`).join(", ");
        this.emit(direct ? `
                            default:
                                return undefined;
                        }
                    }
                } catch (e) {
                    const sig = e instanceof Suspend ? e : Suspend.error(e);
                    if (rip !== -1) sig.push(new Frame(closure, [${allRegs}], rip, null, ctx.epoch));
                    throw sig;
                }
            }
        ` : `
                            default:
                                return null;
                        }
                    }
                } catch (err) {
                    ${this.#spillAll()}
                    return executor.handleHostException(ctx, frame, err);
                }
            }
        `);
    }

    static #writtenRegs(blocks: AotBlock[], numReg: number): number[] {
        const written = new Set<number>();
        for (const block of blocks) {
            for (const inst of block.insts) {
                if ("dst" in inst && inst.dst !== null && inst.k !== "SetBox") written.add(inst.dst);
            }
            const term = block.term;
            if (term.k === "MaybeSelfTailCall") {
                for (let i = 0; i < term.numPos + (term.hasRest ? 1 : 0); i++) written.add(i);
            }
        }
        return [...written].filter(r => r < numReg).sort((a, b) => a - b);
    }

    static #window(start: number, nargs: number): number[] {
        return Array.from({ length: nargs }, (_, i) => start + i);
    }

    static #instUses(inst: AotInst): number[] {
        switch (inst.k) {
            case "Move": case "Box": case "Unbox": return [inst.src];
            case "SetBox": return [inst.dst, inst.src];
            case "SetUpvar": case "SetGlobal": case "SetRaiseProc": case "SetHandlers": return [inst.src];
            case "CoCreate": return [inst.proc];
            case "CoStatus": return [inst.co];
            case "CoResume": return CodeEmitter.#window(inst.start, inst.nargs);
            case "CoResumeList": return [inst.co, inst.list];
            case "Wind": return [inst.before, inst.after];
            case "NewClosure": return inst.captures.filter(c => c.local).map(c => c.index);
            case "CallBuiltin": case "WindowOp": case "TableOp": return CodeEmitter.#window(inst.start, inst.nargs);
            default: return [];
        }
    }

    static #termUses(term: AotTerm): number[] {
        switch (term.k) {
            case "Branch": return [term.cond];
            case "Call": case "TailCall": case "MaybeSelfTailCall": return [term.proc, ...CodeEmitter.#window(term.start, term.nargs)];
            case "TailCallBuiltin": return CodeEmitter.#window(term.start, term.nargs);
            case "Apply": return [...("reg" in term.proc ? [term.proc.reg] : []), ...("list" in term.args ? [term.args.list] : CodeEmitter.#window(term.args.start, term.args.nargs))];
            case "CallCC": return [term.proc];
            case "Yield": return "list" in term.args ? [term.args.list] : CodeEmitter.#window(term.args.start, term.args.nargs);
            case "Return": return [term.reg];
            default: return [];
        }
    }

    static #successors(term: AotTerm): number[] {
        switch (term.k) {
            case "Jump": return [term.target];
            case "Branch": return [term.then, term.else];
            case "Call": return [term.resume];
            case "MaybeSelfTailCall": return [0];
            default: return [];
        }
    }

    static #liveness(blocks: AotBlock[]): Map<number, Set<number>> {
        const liveIn = new Map<number, Set<number>>(blocks.map(b => [b.start, new Set<number>()]));
        let changed = true;
        while (changed) {
            changed = false;
            for (let b = blocks.length - 1; b >= 0; b--) {
                const block = blocks[b];
                const live = new Set<number>();
                for (const succ of CodeEmitter.#successors(block.term)) {
                    for (const r of liveIn.get(succ) ?? []) live.add(r);
                }
                for (const r of CodeEmitter.#termUses(block.term)) live.add(r);
                for (let i = block.insts.length - 1; i >= 0; i--) {
                    const inst = block.insts[i];
                    if ("dst" in inst && inst.dst !== null && inst.k !== "SetBox") live.delete(inst.dst);
                    for (const r of CodeEmitter.#instUses(inst)) live.add(r);
                }
                const prev = liveIn.get(block.start)!;
                if (live.size !== prev.size || [...live].some(r => !prev.has(r))) {
                    liveIn.set(block.start, live);
                    changed = true;
                }
            }
        }
        return liveIn;
    }

    #spillLive(resume: number, extra: number[] = []): string {
        const regs = new Set(extra);
        for (const r of this.#liveIn.get(resume) ?? []) {
            if (this.#written.has(r)) regs.add(r);
        }
        return [...regs].sort((a, b) => a - b).map(r => `regs[${r}] = r${r};`).join(" ");
    }

    #spillAll(): string {
        return this.#spillRegs.map(r => `regs[${r}] = r${r};`).join(" ");
    }

    #argList(start: number, nargs: number): string {
        return CodeEmitter.#window(start, nargs).map(r => `r${r}`).join(", ");
    }

    // arguments for a (regs, start, nargs) style callee: the spilled register window in resume mode, a fresh array in direct mode
    #windowCall(fn: string, start: number, nargs: number): string {
        if (this.mode === "direct") return `${fn}([${this.#argList(start, nargs)}], 0, ${nargs})`;
        const spills = CodeEmitter.#window(start, nargs).map(r => `regs[${r}] = r${r}`);
        return `(${[...spills, `${fn}(regs, ${start}, ${nargs})`].join(", ")})`;
    }

    #yieldValue(term: Extract<AotTerm, { k: "Yield" }>): string {
        return "list" in term.args
            ? `packValues(listToArray(r${term.args.list}))`
            : `packValues([${this.#argList(term.args.start, term.args.nargs)}])`;
    }

    #acc(): string {
        return this.mode === "direct" ? "acc" : "ctx.acc";
    }

    #emitInst(inst: AotInst): void {
        const direct = this.mode === "direct";
        switch (inst.k) {
            case "LoadConst":
                return this.emit(`r${inst.dst} = CONSTANTS[${inst.idx}];`);
            case "LoadInt":
                return this.emit(`r${inst.dst} = ${inst.value};`);
            case "LoadUpvar":
                return this.emit(`r${inst.dst} = upvars[${inst.idx}]${inst.unbox ? ".val" : ""};`);
            case "SetUpvar":
                return this.emit(`upvars[${inst.idx}] = ${inst.box ? `new Box(r${inst.src})` : `r${inst.src}`};`);
            case "LoadGlobal":
                return this.emit(`
                    {
                        const val = ctx.scope.lookup(CONSTANTS[${inst.sym}], MISSING);
                        if (val === MISSING) {
                            ${direct ? "" : `frame.ip = ${inst.ip};`}
                            throw new MissingVarError("Variable '" + String(CONSTANTS[${inst.sym}]) + "' is not defined in the current scope.");
                        }
                        ${inst.dst !== null ? `r${inst.dst} = val;` : ""}
                    }
                `);
            case "SetGlobal":
                return this.emit(`ctx.scope.set(CONSTANTS[${inst.sym}], r${inst.src});`);
            case "Move":
                return this.emit(`r${inst.dst} = r${inst.src};`);
            case "Box":
                return this.emit(`r${inst.dst} = new Box(r${inst.src});`);
            case "Unbox":
                return this.emit(`r${inst.dst} = r${inst.src}.val;`);
            case "SetBox":
                return this.emit(`r${inst.dst}.val = r${inst.src};`);
            case "NewClosure": {
                const captures = inst.captures.map(c => c.local ? `r${c.index}` : `upvars[${c.index}]`).join(", ");
                return this.emit(`r${inst.dst} = new Closure(CONSTANTS[${inst.tmpl}], [${captures}]);`);
            }
            case "Wind":
                return this.emit(`ctx.wind = new WindPoint(ctx.wind, r${inst.before}, r${inst.after});`);
            case "EndWind":
                return this.emit(`if (ctx.wind !== null) ctx.wind = ctx.wind.parent;`);
            case "SetRaiseProc":
                return this.emit(`executor.raiseProc = r${inst.src};`);
            case "MoveAcc":
                return this.emit(`r${inst.dst} = ${this.#acc()};`);
            case "GetHandlers":
                return this.emit(`r${inst.dst} = ctx.handlers;`);
            case "SetHandlers":
                return this.emit(`ctx.handlers = r${inst.src};`);
            case "CoCreate":
                return this.emit(`r${inst.dst} = executor.coCreate(ctx, r${inst.proc});`);
            case "CoResume":
                return this.emit(`r${inst.dst} = executor.coResume(ctx, r${inst.start}, [${this.#argList(inst.start + 1, inst.nargs - 1)}]);`);
            case "CoResumeList":
                return this.emit(`r${inst.dst} = executor.coResume(ctx, r${inst.co}, listToArray(r${inst.list}));`);
            case "CoStatus":
                return this.emit(`r${inst.dst} = executor.coStatus(r${inst.co});`);
            case "CallBuiltin":
                return this.emit(`
                    ${direct ? "" : `frame.ip = ${inst.resume};`}
                    r${inst.dst} = ${this.#windowCall(`IBUILTINS[${inst.builtin}].cb`, inst.start, inst.nargs)};
                `);
            case "WindowOp": {
                if (inst.fn === "makeList") {
                    let list = "null";
                    for (let i = inst.nargs - 1; i >= 0; i--) list = `new Cons(r${inst.start + i}, ${list})`;
                    return this.emit(`r${inst.dst} = ${list};`);
                }
                if (inst.nargs === 2) return this.emit(`r${inst.dst} = Cons.pair(r${inst.start}, r${inst.start + 1});`);
                return this.emit(`r${inst.dst} = ${this.#windowCall(inst.fn, inst.start, inst.nargs)};`);
            }
            case "TableOp":
                return this.emit(this.#inlineTableOp(inst) ?? `r${inst.dst} = ${this.#windowCall(`${inst.table}[${inst.idx}]`, inst.start, inst.nargs)};`);
            default: {
                const _: never = inst;
            }
        }
    }

    #inlineTableOp(inst: Extract<AotInst, { k: "TableOp" }>): string | null {
        const { dst, start, nargs } = inst;
        const slow = this.#windowCall(`${inst.table}[${inst.idx}]`, start, nargs);
        if (inst.table === "ARITHMETIC_FNS" && nargs === 2) {
            const name = ARITHMETIC[inst.idx][0];
            const a = `r${start}`, b = `r${start + 1}`;
            if (name === "eq?") return `r${dst} = ${a} === ${b};`;
            const op = INLINE_BINARY_OPS[name];
            if (op === undefined) return null;
            const guard = `typeof ${a} === "number" && typeof ${b} === "number"${name === "/" ? ` && ${b} !== 0` : ""}`;
            return `r${dst} = ${guard} ? ${a} ${op} ${b} : ${slow};`;
        }
        if (inst.table === "PREDICATE_FNS" && nargs === 1) {
            const name = PREDICATES[inst.idx][0];
            if (name === "null?") return `r${dst} = r${start} === null;`;
            if (name === "pair?") return `r${dst} = r${start} instanceof Cons;`;
        }
        if (inst.table === "CXR_FNS" && nargs === 1) {
            const path = CXR_PATHS[inst.idx][1];
            if (path === "a" || path === "d") {
                return `r${dst} = r${start} instanceof Cons ? r${start}.${path === "a" ? "car" : "cdr"} : ${slow};`;
            }
        }
        return null;
    }

    #jump(target: number, next: number, codeLength: number): string {
        if (target === next && target < codeLength) return "";
        if (target >= codeLength) return this.mode === "direct" ? "return undefined;" : "return null;";
        return `ip = ${target}; continue;`;
    }

    #procExpr(proc: ProcRef): string {
        return "reg" in proc ? `r${proc.reg}` : `IBUILTINS[${proc.builtin}]`;
    }

    #directGuard(proc: string, nargs: string): string {
        return `${proc} instanceof Closure && ${proc}.tmpl.code.directArity === ${nargs} && ctx.jsDepth < MAX_JS_DEPTH`;
    }

    #restGuard(proc: string, nargs: string): string {
        return `${proc} instanceof Closure && ${proc}.tmpl.code.directRestArity !== -1 && ${nargs} >= ${proc}.tmpl.code.directRestArity && ctx.jsDepth < MAX_JS_DEPTH`;
    }

    #heapDirectCall(call: string): string {
        return `
            const depth = ctx.jsDepth;
            ctx.jsDepth = depth + 1;
            try {
                ctx.acc = ${call};
            } catch (e) {
                ctx.jsDepth = depth;
                if (!(e instanceof Suspend)) throw e;
                e.push(frame);
                return executor.resumeSuspend(ctx, e);
            }
            ctx.jsDepth = depth;
        `;
    }

    #emitTerm(term: AotTerm, next: number, codeLength: number): void {
        if (this.mode === "direct") return this.#emitDirectTerm(term, next, codeLength);
        switch (term.k) {
            case "Jump":
                return this.emit(this.#jump(term.target, next, codeLength));
            case "Branch":
                if (term.then === next) {
                    return this.emit(`if (!isTruthy(r${term.cond})) { ${this.#jump(term.else, -1, codeLength)} }`);
                }
                return this.emit(`ip = isTruthy(r${term.cond}) ? ${term.then} : ${term.else}; continue;`);
            case "Call":
                return this.emit(`
                    {
                        const proc = r${term.proc};
                        frame.ip = ${term.resume};
                        ${this.#spillLive(term.resume, CodeEmitter.#window(term.start, term.nargs))}
                        if (${this.#directGuard("proc", `${term.nargs}`)}) {
                            ${this.#heapDirectCall(`proc.tmpl.code.directFn(ctx, proc, executor${term.nargs > 0 ? ", " + this.#argList(term.start, term.nargs) : ""})`)}
                        } else if (${this.#restGuard("proc", `${term.nargs}`)}) {
                            ${this.#heapDirectCall(`executor.callDirectRest(ctx, proc, [${this.#argList(term.start, term.nargs)}])`)}
                        } else if (proc instanceof BuiltinFunction) {
                            ctx.acc = proc.cb(regs, ${term.start}, ${term.nargs});
                        } else {
                            return executor.invoke(ctx, proc, frame, regs, ${term.start}, ${term.nargs}, false);
                        }
                    }
                    ${this.#jump(term.resume, next, codeLength)}
                `);
            case "TailCallBuiltin":
                return this.emit(`
                    frame.ip = ${term.ip};
                    ctx.acc = ${this.#windowCall(`IBUILTINS[${term.builtin}].cb`, term.start, term.nargs)};
                    return executor.setRetVal(ctx, frame.parent, ctx.acc);
                `);
            case "TailCall":
                return this.emit(`
                    frame.ip = ${term.ip};
                    ${CodeEmitter.#window(term.start, term.nargs).map(r => `regs[${r}] = r${r};`).join(" ")}
                    return executor.invoke(ctx, r${term.proc}, frame, regs, ${term.start}, ${term.nargs}, true);
                `);
            case "MaybeSelfTailCall":
                return this.emit(`
                    {
                        const proc = r${term.proc};
                        if (proc === frame.closure && !frame.isShared(ctx)) {
                            ${this.#selfMoves(term)}
                            ip = 0;
                            continue;
                        }
                        frame.ip = ${term.ip};
                        ${CodeEmitter.#window(term.start, term.nargs).map(r => `regs[${r}] = r${r};`).join(" ")}
                        return executor.invoke(ctx, proc, frame, regs, ${term.start}, ${term.nargs}, true);
                    }
                `);
            case "Apply": {
                const window = "list" in term.args ? [] : CodeEmitter.#window(term.args.start, term.args.nargs);
                const args = "list" in term.args
                    ? `listApplyArgs(r${term.args.list})`
                    : `windowApplyArgs(regs, ${term.args.start}, ${term.args.nargs})`;
                const spill = term.isTail
                    ? window.map(r => `regs[${r}] = r${r};`).join(" ")
                    : this.#spillLive(term.resume, window);
                return this.emit(`
                    frame.ip = ${term.resume};
                    ${spill}
                    return executor.apply(ctx, ${this.#procExpr(term.proc)}, frame, ${args}, ${term.isTail});
                `);
            }
            case "CallCC":
                return this.emit(`
                    frame.ip = ${term.resume};
                    ${term.isTail ? "" : this.#spillLive(term.resume)}
                    return executor.callCC(ctx, r${term.proc}, frame, ${term.isTail});
                `);
            case "Yield":
                return this.emit(`
                    frame.ip = ${term.resume};
                    ${this.#spillLive(term.resume)}
                    return executor.coYield(ctx, frame, ${this.#yieldValue(term)});
                `);
            case "Return":
                return this.emit(`
                    ctx.acc = r${term.reg};
                    return executor.setRetVal(ctx, frame.parent, ctx.acc);
                `);
            default: {
                const _: never = term;
            }
        }
    }

    #selfMoves(term: Extract<AotTerm, { k: "MaybeSelfTailCall" }>): string {
        const moves: string[] = [];
        if (term.hasRest) {
            moves.push(`let rest = null;`);
            for (let i = term.nargs - 1; i >= term.numPos; i--) moves.push(`rest = new Cons(r${term.start + i}, rest);`);
        }
        for (let i = 0; i < term.numPos; i++) {
            if (term.start + i !== i) moves.push(`r${i} = r${term.start + i};`);
        }
        if (term.hasRest) moves.push(`r${term.numPos} = rest;`);
        return moves.join("\n");
    }

    // a tail call from direct code: stays direct when possible, otherwise suspends without rebuilding this frame
    #directTailCall(proc: string, start: number, nargs: number): string {
        const args = this.#argList(start, nargs);
        return `
            rip = -1;
            if (${this.#directGuard(proc, `${nargs}`)}) {
                ctx.jsDepth++;
                const val = ${proc}.tmpl.code.directFn(ctx, ${proc}, executor${nargs > 0 ? ", " + args : ""});
                ctx.jsDepth--;
                return val;
            }
            if (${this.#restGuard(proc, `${nargs}`)}) {
                ctx.jsDepth++;
                const val = executor.callDirectRest(ctx, ${proc}, [${args}]);
                ctx.jsDepth--;
                return val;
            }
            if (${proc} instanceof BuiltinFunction) return ${proc}.cb([${args}], 0, ${nargs});
            throw Suspend.invoke(${proc}, [${args}]);
        `;
    }

    #emitDirectTerm(term: AotTerm, next: number, codeLength: number): void {
        switch (term.k) {
            case "Jump":
                return this.emit(this.#jump(term.target, next, codeLength));
            case "Branch":
                if (term.then === next) {
                    return this.emit(`if (!isTruthy(r${term.cond})) { ${this.#jump(term.else, -1, codeLength)} }`);
                }
                return this.emit(`ip = isTruthy(r${term.cond}) ? ${term.then} : ${term.else}; continue;`);
            case "Call": {
                const args = this.#argList(term.start, term.nargs);
                return this.emit(`
                    {
                        const proc = r${term.proc};
                        rip = ${term.resume};
                        if (${this.#directGuard("proc", `${term.nargs}`)}) {
                            ctx.jsDepth++;
                            acc = proc.tmpl.code.directFn(ctx, proc, executor${term.nargs > 0 ? ", " + args : ""});
                            ctx.jsDepth--;
                        } else if (${this.#restGuard("proc", `${term.nargs}`)}) {
                            ctx.jsDepth++;
                            acc = executor.callDirectRest(ctx, proc, [${args}]);
                            ctx.jsDepth--;
                        } else if (proc instanceof BuiltinFunction) {
                            acc = proc.cb([${args}], 0, ${term.nargs});
                        } else {
                            throw Suspend.invoke(proc, [${args}]);
                        }
                    }
                    ${this.#jump(term.resume, next, codeLength)}
                `);
            }
            case "TailCallBuiltin":
                return this.emit(`return ${this.#windowCall(`IBUILTINS[${term.builtin}].cb`, term.start, term.nargs)};`);
            case "TailCall":
                return this.emit(`{ const proc = r${term.proc}; ${this.#directTailCall("proc", term.start, term.nargs)} }`);
            case "MaybeSelfTailCall":
                return this.emit(`
                    {
                        const proc = r${term.proc};
                        if (proc === closure) {
                            ${this.#selfMoves(term)}
                            ip = 0;
                            continue;
                        }
                        ${this.#directTailCall("proc", term.start, term.nargs)}
                    }
                `);
            case "Apply": {
                const args = "list" in term.args
                    ? `listApplyArgs(r${term.args.list})`
                    : `windowApplyArgs([${this.#argList(term.args.start, term.args.nargs)}], 0, ${term.args.nargs})`;
                const done = term.isTail ? "return" : "acc =";
                return this.emit(`
                    {
                        const proc = ${this.#procExpr(term.proc)};
                        const args = ${args};
                        rip = ${term.isTail ? -1 : term.resume};
                        if (proc instanceof BuiltinFunction) {
                            ${done} proc.cb(args, 0, args.length);
                        } else if (${this.#directGuard("proc", "args.length")}) {
                            ctx.jsDepth++;
                            ${term.isTail ? "const val =" : "acc ="} proc.tmpl.code.directFn(ctx, proc, executor, ...args);
                            ctx.jsDepth--;
                            ${term.isTail ? "return val;" : ""}
                        } else if (${this.#restGuard("proc", "args.length")}) {
                            ctx.jsDepth++;
                            ${term.isTail ? "const val =" : "acc ="} executor.callDirectRest(ctx, proc, args);
                            ctx.jsDepth--;
                            ${term.isTail ? "return val;" : ""}
                        } else {
                            throw Suspend.invoke(proc, args);
                        }
                    }
                    ${term.isTail ? "" : this.#jump(term.resume, next, codeLength)}
                `);
            }
            case "CallCC":
                return this.emit(`
                    rip = ${term.isTail ? -1 : term.resume};
                    throw Suspend.callCC(r${term.proc});
                `);
            case "Yield":
                return this.emit(`
                    rip = ${term.resume};
                    throw Suspend.yield(${this.#yieldValue(term)});
                `);
            case "Return":
                return this.emit(`return r${term.reg};`);
            default: {
                const _: never = term;
            }
        }
    }
}
