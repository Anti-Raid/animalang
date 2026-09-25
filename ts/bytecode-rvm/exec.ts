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
    packValues,
    ASTStringifier,
    type SourcePos,
    formatPos
} from "../common";
import { Cons } from "../list";
import { listToArray, windowApplyArgs, valuesToList, listToValues, applyArgsList } from "../ops";
import { BuiltinFunction, IBUILTINS } from "../std";

export const BUILTINS_START = 2**31;

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
    CALLCC,
    APPLY,
    MOVEACC,
    COYIELD,
    CALLRT,
    CORESUME,
}

export const INSTRUCTION_LENGTHS: Record<OpCode, number> = {
    [OpCode.ENDIF]: 1,
    [OpCode.ELSE]: 2,
    [OpCode.RETURN]: 2,
    [OpCode.LOADCONST]: 3,
    [OpCode.LOADU32]: 3,
    [OpCode.LOADGLOBAL]: 3,
    [OpCode.SETGLOBAL]: 3,
    [OpCode.IF]: 3,
    [OpCode.CALLCC]: 3,
    [OpCode.NEWCLOSURE]: 3,
    [OpCode.BOX]: 3,
    [OpCode.UNBOX]: 3,
    [OpCode.SETBOX]: 3,
    [OpCode.MOVE]: 3,
    [OpCode.SETUPVAR]: 4,
    [OpCode.LOADUPVAR]: 4,
    [OpCode.CALL]: 5,
    [OpCode.APPLY]: 5,
    [OpCode.MOVEACC]: 2,
    [OpCode.COYIELD]: 2,
    [OpCode.CALLRT]: 5,
    [OpCode.CORESUME]: 4,
};

export type ResumeFn = (ctx: ExecutionContext, frame: Frame, executor: VMExecutor) => Frame | null;

export type DirectFn = (ctx: ExecutionContext, closure: Closure, executor: VMExecutor, ...args: any[]) => any;

export class ByteCode implements AbstractByteCode {
    public bsid = "ByteCode";
    public resumeFn: ResumeFn | null = null;
    public directFn: DirectFn | null = null;
    public directArity: number = -1;
    public directRestArity: number = -1;

    // lineTable holds (ip, fileIdx, line, col) entries sorted by ip; each covers the code up to the next entry
    constructor(
        public constants: any[],
        public inst: Uint32Array,
        public numReg: number,
        public lineTable: Uint32Array = new Uint32Array(0),
        public files: string[] = [],
        // compiled in debug mode: records tail calls and exact error positions (never mixed with non-debug code)
        public debug: boolean = false
    ) {}

    positionAt(ip: number): SourcePos | null {
        const table = this.lineTable;
        let lo = 0, hi = table.length / 4 - 1, found = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (table[mid * 4] <= ip) {
                found = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        if (found === -1) return null;
        return { file: this.files[table[found * 4 + 1]], line: table[found * 4 + 2], col: table[found * 4 + 3] };
    }

    dump(bs: BS) {
        bs.writeU32Arr(this.inst);
        bs.writeArray(this.constants);
        bs.writeU32(this.numReg);
        bs.writeU32Arr(this.lineTable);
        bs.writeArray(this.files);
        bs.writeValue(this.debug);
    }

    static register(bsr: BSReader) {
        bsr.registerFactory("ByteCode", (bsr) => {
            const inst = bsr.readU32Arr();
            const constants = bsr.readArray();
            const numReg = bsr.readU32();
            const lineTable = bsr.readU32Arr();
            const files = bsr.readArray() as string[];
            const debug = bsr.read() as boolean;
            return new ByteCode(constants, inst, numReg, lineTable, files, debug);
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

    constructor(params: symbol[], remParams: symbol | null, code: ByteCode, upvarLocs: UpVarLoc[], public name: string | null = null) {
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
        bs.writeValue(this.name);
    }

    static register(bsr: BSReader) {
        bsr.registerFactory("ClosureTemplate", (bsr) => {
            const params = bsr.read() as symbol[];
            const remParams = bsr.read() as symbol | null;
            const code = bsr.readSerializable<ByteCode>("ByteCode");
            const upvarLocs = bsr.readArray() as UpVarLoc[];
            const name = bsr.read() as string | null;
            return new ClosureTemplate(params, remParams, code, upvarLocs, name);
        });
    }
}

/** An actual anima closure bound to a scope */
export class Closure extends IProcedure implements AbstractClosure {
    public bsid = "Closure";

    constructor(public tmpl: ClosureTemplate, public upvars: any[], debugName: string = tmpl.name ?? "lambda") {
        super(debugName);
    }

    static fromTemplate(tmpl: ClosureTemplate, debugName?: string) {
        // Allocate enough space for the upvars from outer scopes
        const upvars = new Array(tmpl.upvarLocs.length);
        return new Closure(tmpl, upvars, debugName);
    }

    static create(tmpl: ClosureTemplate, regs: readonly any[], upvars: readonly any[], debugName?: string) {
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
    const regs: any[] = [];
    for (let i = 0; i < numRegs; i++) regs.push(undefined);
    return regs;
};


export const resolveProc = (regs: readonly any[], procIdx: number): any => {
    return procIdx < BUILTINS_START ? regs[procIdx] : IBUILTINS[procIdx - BUILTINS_START];
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
    // a throwaway resumer for nested resumes: control coming back here ends the nested driver loop
    public barrier: boolean = false;
    // recent tail calls, newest last (only recorded by debug code)
    public tailHistory: { name: string, count: number }[] = [];

    constructor(
        public vm: AbstractVM,
        public scope: Table
    ) {
        this.id = ++ExecutionContext.nextId;
    }

    recordTail(proc: any): void {
        const name = proc instanceof IProcedure ? proc.debugName ?? "?" : proc instanceof OpaqueValue ? proc.typeName : String(proc);
        const hist = this.tailHistory;
        const last = hist[hist.length - 1];
        if (last !== undefined && last.name === name) {
            last.count++;
            return;
        }
        hist.push({ name, count: 1 });
        if (hist.length > TAIL_HISTORY_SIZE) hist.shift();
    }
}

const TAIL_HISTORY_SIZE = 16;

export type CoroutineStatus = "suspended" | "running" | "normal" | "dead";

export class Coroutine extends OpaqueValue {
    public status: CoroutineStatus = "suspended";
    public started: boolean = false;
    public closing: boolean = false;
    public frame: Frame | null = null;
    public resumer: { ctx: ExecutionContext, frame: Frame | null } | null = null;
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
    public epoch: number;
    // exact position of the last instruction run, when debug code knows it better than ip
    public posIp: number = -1;

    constructor(
        public closure: Closure,
        public regs: any[],
        public ip: number,
        public parent: Frame | null,
        public ctx: ExecutionContext
    ) {
        this.code = closure.tmpl.code;
        this.upvars = closure.upvars;
        this.epoch = ctx.epoch;
    }

    get debugName(): string {
        return this.closure.debugName ?? "lambda";
    }

    thaw(ctx: ExecutionContext): Frame {
        return new Frame(this.closure, [...this.regs], this.ip, this.parent, ctx);
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

const MAX_NESTED_RESUMES = 16;

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

    static resume(co: any, args: any[]) {
        return new Suspend((ctx, executor, caller) => executor.coResume(ctx, caller, co, args));
    }

    static yield(val: any) {
        return new Suspend((ctx, executor, caller) => executor.coYield(ctx, caller, val));
    }
}

export class VMExecutor {
    public raiseProc: any | null = null;
    public nestedResumes: number = 0;

    constructor(public vm: AbstractVM) {}

    // --- call protocol ---

    public enter(ctx: ExecutionContext, frame: Frame): Frame {
        if (frame.isShared(ctx)) {
            frame = frame.thaw(ctx);
        }
        ctx.currentFrame = frame;
        return frame;
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

    public setRetVal(ctx: ExecutionContext, frame: Frame | null, val: any): Frame | null {
        // a finished coroutine hands its value to its resumer, which may itself be a coroutine finishing through a tail resume
        while (true) {
            ctx.acc = val;
            if (frame !== null) return frame;
            if (ctx.pendingWind !== null) return this.advanceWindTransition(ctx);
            const co = ctx.coroutine;
            if (co === null || co.status !== "running" || co.closing) return null;
            co.status = "dead";
            const resumer = this.#detachResumer(co);
            ctx = resumer.ctx;
            frame = resumer.frame;
        }
    }

    public newFrame(
        ctx: ExecutionContext,
        closure: Closure,
        regs: any[],
        parent: Frame | null
    ): Frame {
        return new Frame(closure, regs, 0, parent, ctx);
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

    public callDirectRest(ctx: ExecutionContext, proc: Closure, args: any[]): any {
        const code = proc.tmpl.code;
        const numPos = code.directRestArity;
        let rest: Cons | null = null;
        for (let i = args.length - 1; i >= numPos; i--) rest = new Cons(args[i], rest);
        args.length = numPos;
        args.push(rest);
        return code.directFn!(ctx, proc, this, ...args);
    }

    // --- continuations and dynamic-wind ---

    public callCC(ctx: ExecutionContext, proc: any, frame: Frame, isTail: boolean): Frame | null {
        const target = isTail ? frame.parent : frame;
        target?.share(ctx);
        const k = new VMContinuation(target, ctx.id, ctx.wind);
        return this.invoke(ctx, proc, frame, [k], 0, 1, isTail);
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

    // --- errors ---

    public handleHostException(ctx: ExecutionContext, frame: Frame | null, err: any): Frame | null {
        if (err instanceof EscapedError) throw err;
        if (err instanceof UnhandledSchemeError) {
            const co = ctx.coroutine;
            if (co !== null && co.closing) throw err;
            if (co !== null && co.status === "running") {
                co.status = "dead";
                co.frame = null;
                const resumer = this.#detachResumer(co);
                if (resumer.ctx.barrier) throw new ReRaise(err.error);
                return this.handleHostException(resumer.ctx, resumer.frame, new ReRaise(err.error));
            }
            const out = err.error instanceof Error ? err.error : new Error(String(err.error));
            if (err.traceback !== undefined && (out as any).animaTraceback === undefined) (out as any).animaTraceback = err.traceback;
            throw out;
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

    // --- coroutines ---

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

    public coResume(ctx: ExecutionContext, resumeTo: Frame | null, co: any, args: any[]): Frame | null {
        if (!(co instanceof Coroutine)) throw new Error(`coroutine-resume: expected a coroutine but got ${String(co)}`);
        if (co.status !== "suspended") throw new Error(`coroutine-resume: cannot resume a ${co.status} coroutine`);

        co.resumer = { ctx, frame: resumeTo };
        if (ctx.coroutine !== null) ctx.coroutine.status = "normal";
        co.status = "running";
        if (!co.started) {
            co.started = true;
            return this.invoke(co.ctx, co.proc, null, args, 0, args.length, false);
        }
        const frame = co.frame;
        co.frame = null;
        co.ctx.acc = packValues(args);
        return frame;
    }

    // runs a coroutine to its next yield or return in a nested driver loop and returns the value (used by the host and by direct-mode code)

    public coResumeNested(ctx: ExecutionContext | null, co: any, args: any[]): any {
        const barrier = new ExecutionContext(this.vm, co instanceof Coroutine ? co.ctx.scope : new Table());
        barrier.barrier = true;
        const outer = ctx?.coroutine ?? null;
        const frame = this.coResume(barrier, null, co, args);
        if (outer !== null) outer.status = "normal";
        this.nestedResumes++;
        try {
            if (frame !== null) this.#runLoop(barrier, frame);
        } finally {
            this.nestedResumes--;
            if (outer !== null) outer.status = "running";
        }
        return barrier.acc;
    }

    public coYield(ctx: ExecutionContext, frame: Frame, val: any): Frame | null {
        const co = ctx.coroutine;
        if (co === null) throw new Error("coroutine-yield: not inside a coroutine (or across a host call boundary)");
        if (co.closing) throw new Error("coroutine-yield: cannot yield while a coroutine is closing");
        co.frame = frame;
        co.status = "suspended";
        return this.#returnToResumer(co, val);
    }

    // starts or continues a coroutine inside the current driver loop; `resumeTo` is where its yields and final value go

    public coClose(ctx: ExecutionContext | null, co: any): void {
        if (!(co instanceof Coroutine)) throw new Error(`coroutine-close: expected a coroutine but got ${String(co)}`);
        if (co.status === "dead") return;
        if (co.status !== "suspended") throw new Error(`coroutine-close: cannot close a ${co.status} coroutine`);

        const cctx = co.ctx;
        co.frame = null;
        const actions = computeWindTransition(cctx.wind, null);
        if (actions.length === 0) {
            co.status = "dead";
            return;
        }

        const outer = ctx?.coroutine ?? null;
        if (outer !== null) outer.status = "normal";
        co.status = "running";
        co.closing = true;
        try {
            cctx.pendingWind = { actions, actionIdx: 0, targetFrame: null, targetVal: undefined, targetWind: null };
            const frame = this.advanceWindTransition(cctx);
            if (frame !== null) this.#runLoop(cctx, frame);
        } catch (err) {
            throw new ReRaise(err instanceof UnhandledSchemeError ? err.error : err);
        } finally {
            cctx.pendingWind = null;
            co.closing = false;
            co.status = "dead";
            if (outer !== null) outer.status = "running";
        }
    }

    #returnToResumer(co: Coroutine, val: any): Frame | null {
        const resumer = this.#detachResumer(co);
        return this.setRetVal(resumer.ctx, resumer.frame, val);
    }

    #detachResumer(co: Coroutine): { ctx: ExecutionContext, frame: Frame | null } {
        const resumer = co.resumer!;
        co.resumer = null;
        if (resumer.ctx.coroutine !== null) resumer.ctx.coroutine.status = "running";
        return resumer;
    }

    // --- driver loop ---

    #runLoop(ctx: ExecutionContext, frame: Frame): void {
        if ((this.vm as any).mode === "aot") {
            AotCompiler.compileAll(frame.code, frame.closure.tmpl);
            AotCompiler.run(ctx, frame, this);
        } else {
            BytecodeInterpreter.run(ctx, frame, this);
        }
    }
}

type RuntimeFn = (ctx: ExecutionContext, executor: VMExecutor, regs: readonly any[], start: number, nargs: number) => any;

export type FrameInfo = { name: string, pos: SourcePos | null };

export const frameInfos = (frame: Frame | null, level: number = 0): FrameInfo[] => {
    const out: FrameInfo[] = [];
    for (let f = frame, i = 0; f !== null; f = f.parent, i++) {
        if (i >= level) out.push({ name: f.debugName, pos: f.code.positionAt(Math.max((f.posIp !== -1 ? f.posIp : f.ip) - 1, 0)) });
    }
    return out;
};

export const formatTraceback = (frames: FrameInfo[], msg?: string, tailHistory: { name: string, count: number }[] = []): string => {
    const lines = frames.map(f => `\n  ${formatPos(f.pos)} in ${f.name}`).join("");
    const tails = tailHistory.length === 0 ? "" : "\nrecent tail calls (newest first):\n  " +
        tailHistory.map(t => t.count > 1 ? `${t.name} x${t.count}` : t.name).reverse().join(" <- ");
    return `${msg !== undefined ? msg + "\n" : ""}stack traceback:${lines}${tails}`;
};

// (%debug-frames k args) / (%debug-traceback k args): args is ([coroutine] [msg] [level]), k the caller's continuation
const debugTarget = (ctx: ExecutionContext, regs: readonly any[], start: number) => {
    let frame = (regs[start] as VMContinuation).frame;
    let target = ctx;
    const args = listToArray(regs[start + 1]);
    if (args[0] instanceof Coroutine) {
        const co = args.shift() as Coroutine;
        target = co.ctx;
        if (co !== ctx.coroutine) frame = co.frame;
    }
    return { frame, args, tailHistory: target.tailHistory };
};

const tracebackMessage = (msg: any): string | undefined => {
    if (msg === undefined) return undefined;
    if (typeof msg === "string") return msg;
    if (msg instanceof ErrorObject) return msg.error instanceof Error ? msg.error.message : String(msg.error);
    if (msg instanceof Error) return msg.message;
    return new ASTStringifier().stringify(msg);
};

export const RUNTIME: [name: string, fn: RuntimeFn][] = [
    ["coroutine-create", (ctx, executor, regs, start) => executor.coCreate(ctx, regs[start])],
    ["coroutine-status", (ctx, executor, regs, start) => executor.coStatus(regs[start])],
    ["coroutine-close", (ctx, executor, regs, start) => { executor.coClose(ctx, regs[start]); }],
    ["handlers", (ctx) => ctx.handlers],
    ["set-handlers!", (ctx, executor, regs, start) => { ctx.handlers = regs[start]; }],
    ["set-raise-proc", (ctx, executor, regs, start) => { executor.raiseProc = regs[start]; }],
    ["wind", (ctx, executor, regs, start) => { ctx.wind = new WindPoint(ctx.wind, regs[start], regs[start + 1]); }],
    ["end-wind", (ctx) => { if (ctx.wind !== null) ctx.wind = ctx.wind.parent; }],
    ["values->list", (ctx, executor, regs, start, nargs) => valuesToList(regs, start, nargs)],
    ["list->values", (ctx, executor, regs, start, nargs) => listToValues(regs, start, nargs)],
    ["apply-args", (ctx, executor, regs, start, nargs) => applyArgsList(regs, start, nargs)],
    ["debug-frames", (ctx, executor, regs, start) => {
        const { frame, args } = debugTarget(ctx, regs, start);
        const level = typeof args[0] === "number" ? args[0] : 0;
        return Cons.fromArray(frameInfos(frame, level).map(f => [f.name, f.pos?.file ?? false, f.pos?.line ?? false, f.pos?.col ?? false]));
    }],
    ["debug-traceback", (ctx, executor, regs, start) => {
        const { frame, args, tailHistory } = debugTarget(ctx, regs, start);
        const msg = typeof args[0] === "number" ? undefined : args.shift();
        const level = typeof args[0] === "number" ? args[0] : 0;
        return formatTraceback(frameInfos(frame, level), tracebackMessage(msg), tailHistory);
    }],
];

export const RUNTIME_IDX = new Map(RUNTIME.map(([name], idx) => [name, idx]));

const RUNTIME_FNS = RUNTIME.map(([, fn]) => fn);

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
                        const proc = resolveProc(regs, inst[ip++]);
                        const startReg = inst[ip++];
                        const nargs = inst[ip++];
                        const isTail = inst[ip++] !== 0;
                        if (isTail && frame.code.debug) ctx.recordTail(proc);

                        if (!isTail && proc instanceof BuiltinFunction) {
                            ctx.acc = proc.cb(regs, startReg, nargs);
                            break;
                        }

                        // self tail call: rebind the params in place and jump back to the start
                        if (isTail && proc === frame.closure && !frame.isShared(ctx)) {
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
                        return executor.invoke(ctx, proc, frame, regs, startReg, nargs, isTail);
                    }
                    case OpCode.MOVEACC: {
                        regs[inst[ip++]] = ctx.acc;
                        break;
                    }
                    case OpCode.COYIELD: {
                        const valReg = inst[ip++];
                        frame.ip = ip;
                        return executor.coYield(ctx, frame, regs[valReg]);
                    }
                    case OpCode.CORESUME: {
                        const coReg = inst[ip++];
                        const listReg = inst[ip++];
                        const isTail = inst[ip++] !== 0;
                        if (isTail && frame.code.debug) ctx.recordTail(regs[coReg]);
                        frame.ip = ip;
                        return executor.coResume(ctx, isTail ? frame.parent : frame, regs[coReg], listToArray(regs[listReg]));
                    }
                    case OpCode.CALLRT: {
                        const fn = RUNTIME_FNS[inst[ip++]];
                        const destReg = inst[ip++];
                        const startReg = inst[ip++];
                        regs[destReg] = fn(ctx, executor, regs, startReg, inst[ip++]);
                        break;
                    }
                    case OpCode.APPLY: {
                        const proc = resolveProc(regs, inst[ip++]);
                        const startReg = inst[ip++];
                        const nargs = inst[ip++];
                        const isTail = inst[ip++] !== 0;
                        if (isTail && frame.code.debug) ctx.recordTail(proc);
                        frame.ip = ip;
                        return executor.apply(ctx, proc, frame, windowApplyArgs(regs, startReg, nargs), isTail);
                    }
                    case OpCode.CALLCC: {
                        const procReg = inst[ip++];
                        const isTail = inst[ip++] !== 0;
                        if (isTail && frame.code.debug) ctx.recordTail(regs[procReg]);
                        frame.ip = ip;
                        return executor.callCC(ctx, regs[procReg], frame, isTail);
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
    IProcedure,
    ErrorObject,
    isTruthy,
    Box,
    MissingVarError,
    Closure,
    BuiltinFunction,
    WindPoint,
    windowApplyArgs,
    RUNTIME_FNS,
    listToArray,
    Cons,
    MISSING,
    MAX_JS_DEPTH,
    MAX_NESTED_RESUMES,
    Table,
    Frame,
    Suspend,
};

type ProcRef = { reg: number } | { builtin: number };

// `at` is the ip of the instruction an op or terminator was decoded from
type AotInst = { at?: number } & (
    | { k: "LoadConst"; dst: number; idx: number }
    | { k: "LoadInt"; dst: number; value: number }
    | { k: "LoadUpvar"; dst: number; idx: number; unbox: boolean }
    | { k: "SetUpvar"; src: number; idx: number; box: boolean }
    | { k: "LoadGlobal"; dst: number; sym: number; ip: number }
    | { k: "SetGlobal"; src: number; sym: number }
    | { k: "Move" | "Box" | "Unbox" | "SetBox"; dst: number; src: number }
    | { k: "NewClosure"; dst: number; tmpl: number; captures: UpVarLoc[] }
    | { k: "MoveAcc"; dst: number }
    | { k: "CallBuiltin"; builtin: number; dst: number; start: number; nargs: number; resume: number }
    | { k: "RtCall"; rt: number; dst: number; start: number; nargs: number });

type AotTerm = { at?: number } & (
    | { k: "Jump"; target: number }
    | { k: "Branch"; cond: number; then: number; else: number }
    | { k: "Call"; proc: number; start: number; nargs: number; resume: number }
    | { k: "TailCall"; proc: number; start: number; nargs: number; ip: number }
    | { k: "MaybeSelfTailCall"; proc: number; start: number; nargs: number; ip: number; numPos: number; hasRest: boolean }
    | { k: "Apply"; proc: ProcRef; isTail: boolean; start: number; nargs: number; resume: number }
    | { k: "CallCC"; proc: number; isTail: boolean; resume: number }
    | { k: "Yield"; val: number; resume: number }
    | { k: "CoResume"; co: number; list: number; isTail: boolean; resume: number }
    | { k: "Return"; reg: number });

type AotBlock = { start: number; insts: AotInst[]; term: AotTerm };

const STRUCTURE_MISMATCH = Symbol("structure mismatch");

export class AotCompiler {
    public static run(ctx: ExecutionContext, initialFrame: Frame, executor: VMExecutor): any {
        let frame: Frame | null = initialFrame;

        while (frame !== null) {
            const frameCtx: ExecutionContext = frame.ctx;
            frame = executor.enter(frameCtx, frame);
            const resumeFn = frame.code.resumeFn;
            if (resumeFn === null) {
                throw new Error(`AOT mode encountered uncompiled code in frame: ${frame.debugName}`);
            }
            try {
                frame = resumeFn(frameCtx, frame, executor);
            } catch (err) {
                throw err instanceof EscapedError ? err.error : err;
            }
        }

        return ctx.acc;
    }

    public static compileAll(code: ByteCode, tmpl?: ClosureTemplate): void {
        if (code.resumeFn === null) {
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

    public static compile(code: ByteCode, tmpl?: ClosureTemplate): ResumeFn {
        const { resume, direct } = this.generateFunction(code, tmpl);
        code.resumeFn = resume;
        if (direct !== null && tmpl !== undefined) {
            code.directFn = direct;
            if (tmpl.remParams === null) code.directArity = tmpl.params.length;
            else code.directRestArity = tmpl.params.length;
        }
        return resume;
    }

    public static generateFunction(code: ByteCode, tmpl?: ClosureTemplate): { resume: ResumeFn, direct: DirectFn | null } {
        const source = this.generateSource(code, tmpl);
        const globalCache: Record<number, { scope: Table | null, version: number, value: any }> = {};
        for (let ip = 0; ip < code.inst.length; ip += INSTRUCTION_LENGTHS[code.inst[ip] as OpCode]) {
            if (code.inst[ip] === OpCode.LOADGLOBAL) globalCache[ip] = { scope: null, version: -1, value: undefined };
        }
        const factory = new Function(...Object.keys(JIT_DEPS), "CONSTANTS", "GLOBAL_CACHE", source);
        return factory(...Object.values(JIT_DEPS), code.constants, globalCache);
    }

    public static generateSource(code: ByteCode, tmpl?: ClosureTemplate): string {
        const blocks = this.buildAot(code, tmpl);
        const resume = new ResumeEmitter(blocks, code.inst, code.numReg, code.debug);
        resume.emitFunction();
        let direct = "null";
        if (tmpl !== undefined) {
            const out = new DirectEmitter(blocks, code.inst, code.numReg, code.debug);
            out.emitFunction(tmpl.params.length + (tmpl.remParams !== null ? 1 : 0));
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
                case OpCode.COYIELD:
                    blocks.add(nextIp);
                    break;
                case OpCode.CALL:
                    if (inst[nextIp - 1] === 0 && inst[ip + 1] < BUILTINS_START) blocks.add(nextIp);
                    break;
                case OpCode.APPLY:
                case OpCode.CALLCC:
                case OpCode.CORESUME:
                    if (inst[nextIp - 1] === 0) blocks.add(nextIp);
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
                const numInsts = insts.length;
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
                        const start = inst[ip++];
                        const nargs = inst[ip++];
                        const isTail = inst[ip++] !== 0;
                        if (!isTail && procIdx >= BUILTINS_START) {
                            if (inst[ip] !== OpCode.MOVEACC) throw new Error("internal error: builtin CALL must be followed by MOVEACC");
                            const dst = inst[ip + 1];
                            ip += 2;
                            insts.push({ k: "CallBuiltin", builtin: procIdx - BUILTINS_START, dst, start, nargs, resume: ip });
                            break;
                        }
                        if (!isTail) {
                            term = { k: "Call", proc: procIdx, start, nargs, resume: ip };
                            break;
                        }
                        if (procIdx >= BUILTINS_START) throw new Error("internal error: builtins are never tail called");
                        const numPos = tmpl ? tmpl.params.length : -1;
                        const hasRest = tmpl ? tmpl.remParams !== null : false;
                        const arityFits = tmpl !== undefined && (hasRest ? nargs >= numPos : nargs === numPos);
                        term = arityFits
                            ? { k: "MaybeSelfTailCall", proc: procIdx, start, nargs, ip, numPos, hasRest }
                            : { k: "TailCall", proc: procIdx, start, nargs, ip };
                        break;
                    }
                    case OpCode.MOVEACC:
                        insts.push({ k: "MoveAcc", dst: inst[ip++] });
                        break;
                    case OpCode.COYIELD:
                        term = { k: "Yield", val: inst[ip++], resume: ip };
                        break;
                    case OpCode.CORESUME: {
                        const co = inst[ip++];
                        const list = inst[ip++];
                        term = { k: "CoResume", co, list, isTail: inst[ip++] !== 0, resume: ip };
                        break;
                    }
                    case OpCode.CALLRT:
                        insts.push({ k: "RtCall", rt: inst[ip++], dst: inst[ip++], start: inst[ip++], nargs: inst[ip++] });
                        break;
                    case OpCode.APPLY: {
                        const procIdx = inst[ip++];
                        const start = inst[ip++];
                        const nargs = inst[ip++];
                        term = { k: "Apply", proc: this.procRef(procIdx), isTail: inst[ip++] !== 0, start, nargs, resume: ip };
                        break;
                    }
                    case OpCode.CALLCC: {
                        const proc = inst[ip++];
                        term = { k: "CallCC", proc, isTail: inst[ip++] !== 0, resume: ip };
                        break;
                    }
                    case OpCode.RETURN:
                        term = { k: "Return", reg: inst[ip++] };
                        break;
                    default: {
                        const _: never = opcode;
                        throw new Error(`Unhandled opcode in JIT: ${opcode}`);
                    }
                }
                if (insts.length > numInsts) insts[insts.length - 1].at = opIp;
                if (term !== null) term.at = opIp;
            }

            blocks.push({ start: starts[b], insts, term: term ?? { k: "Jump", target: ip } });
        }

        return blocks;
    }

    private static procRef(procIdx: number): ProcRef {
        return procIdx >= BUILTINS_START ? { builtin: procIdx - BUILTINS_START } : { reg: procIdx };
    }
}

const windowRegs = (start: number, nargs: number): number[] => Array.from({ length: nargs }, (_, i) => start + i);

// which registers each resume-mode block needs on entry, and which ones the function ever writes
class Liveness {
    readonly written: number[];
    readonly liveIn: Map<number, Set<number>>;
    readonly entryLive: Set<number>;

    constructor(blocks: AotBlock[], numReg: number) {
        this.written = Liveness.#writtenRegs(blocks, numReg);
        this.liveIn = Liveness.#compute(blocks);
        this.entryLive = new Set(this.liveIn.get(0));
        for (const block of blocks) {
            const resume = Liveness.#resumePoint(block.term);
            if (resume !== null) for (const r of this.liveIn.get(resume) ?? []) this.entryLive.add(r);
        }
    }

    // registers to write back to frame.regs before leaving at `resume`: live there and possibly changed, plus `extra`
    spillsFor(resume: number, extra: number[] = []): number[] {
        const regs = new Set(extra);
        const written = new Set(this.written);
        for (const r of this.liveIn.get(resume) ?? []) if (written.has(r)) regs.add(r);
        return [...regs].sort((a, b) => a - b);
    }

    static #resumePoint(term: AotTerm): number | null {
        switch (term.k) {
            case "Call": case "Apply": case "CallCC": case "Yield": case "CoResume": return term.resume;
            default: return null;
        }
    }

    static #writtenRegs(blocks: AotBlock[], numReg: number): number[] {
        const written = new Set<number>();
        for (const block of blocks) {
            for (const inst of block.insts) {
                if ("dst" in inst && inst.k !== "SetBox") written.add(inst.dst);
            }
            const term = block.term;
            if (term.k === "MaybeSelfTailCall") {
                for (let i = 0; i < term.numPos + (term.hasRest ? 1 : 0); i++) written.add(i);
            }
        }
        return [...written].filter(r => r < numReg).sort((a, b) => a - b);
    }

    static #instUses(inst: AotInst): number[] {
        switch (inst.k) {
            case "Move": case "Box": case "Unbox": return [inst.src];
            case "SetBox": return [inst.dst, inst.src];
            case "SetUpvar": case "SetGlobal": return [inst.src];
            case "NewClosure": return inst.captures.filter(c => c.local).map(c => c.index);
            case "CallBuiltin": case "RtCall": return windowRegs(inst.start, inst.nargs);
            default: return [];
        }
    }

    static #termUses(term: AotTerm): number[] {
        switch (term.k) {
            case "Branch": return [term.cond];
            case "Call": case "TailCall": case "MaybeSelfTailCall": return [term.proc, ...windowRegs(term.start, term.nargs)];
            case "Apply": return [...("reg" in term.proc ? [term.proc.reg] : []), ...windowRegs(term.start, term.nargs)];
            case "CallCC": return [term.proc];
            case "Yield": return [term.val];
            case "CoResume": return [term.co, term.list];
            case "Return": return [term.reg];
            default: return [];
        }
    }

    static #successors(term: AotTerm): number[] {
        switch (term.k) {
            case "Jump": return [term.target];
            case "Branch": return [term.then, term.else];
            case "Call": case "Yield": return [term.resume];
            case "Apply": case "CallCC": case "CoResume": return term.isTail ? [] : [term.resume];
            case "MaybeSelfTailCall": return [0];
            default: return [];
        }
    }

    static #compute(blocks: AotBlock[]): Map<number, Set<number>> {
        const liveIn = new Map<number, Set<number>>(blocks.map(b => [b.start, new Set<number>()]));
        let changed = true;
        while (changed) {
            changed = false;
            for (let b = blocks.length - 1; b >= 0; b--) {
                const block = blocks[b];
                const live = new Set<number>();
                for (const succ of Liveness.#successors(block.term)) {
                    for (const r of liveIn.get(succ) ?? []) live.add(r);
                }
                for (const r of Liveness.#termUses(block.term)) live.add(r);
                for (let i = block.insts.length - 1; i >= 0; i--) {
                    const inst = block.insts[i];
                    if ("dst" in inst && inst.k !== "SetBox") live.delete(inst.dst);
                    for (const r of Liveness.#instUses(inst)) live.add(r);
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
}

// accumulates generated js, re-indenting it by brace depth
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

// emits one entry point of a compiled function; subclasses decide how registers reach callees, how values come back and how control leaves
abstract class FunctionEmitter extends CodeEmitter {
    constructor(protected readonly blocks: AotBlock[], protected readonly inst: Uint32Array, protected readonly numReg: number, protected readonly debug: boolean = false) {
        super();
    }

    // debug code only: statement recording the exact position of the op about to run
    protected abstract debugPos(ip: number): string;

    protected debugHooks(x: { at?: number }, tailProc?: string): string {
        if (!this.debug || x.at === undefined) return "";
        return `${this.debugPos(x.at + 1)}${tailProc !== undefined ? ` ctx.recordTail(${tailProc});` : ""}`;
    }

    protected tailProcOf(term: AotTerm): string | undefined {
        switch (term.k) {
            case "TailCall": case "MaybeSelfTailCall": return `r${term.proc}`;
            case "Apply": return term.isTail ? this.procExpr(term.proc) : undefined;
            case "CallCC": return term.isTail ? `r${term.proc}` : undefined;
            case "CoResume": return term.isTail ? `r${term.co}` : undefined;
            default: return undefined;
        }
    }

    abstract emitFunction(arity: number): void;

    protected abstract emitTerm(term: AotTerm, next: number): void;

    // a (regs, start, nargs)-style call of `fn` over the register window; runtime functions also take (ctx, executor) first
    protected abstract windowCall(fn: string, start: number, nargs: number, withRuntime?: boolean): string;

    // where the value of the last call is (read by MOVEACC)
    protected abstract readonly accExpr: string;

    // statement recording where to resume before an instruction that may throw (heap mode only)
    protected abstract recordIp(ip: number): string;

    protected abstract readonly endOfCode: string;

    protected emitSwitchBody(): void {
        for (let i = 0; i < this.blocks.length; i++) {
            const next = i + 1 < this.blocks.length ? this.blocks[i + 1].start : this.inst.length;
            this.emit(`case ${this.blocks[i].start}: {`);
            for (const inst of this.blocks[i].insts) this.emitInst(inst);
            this.emitTerm(this.blocks[i].term, next);
            this.emit(`}`);
        }
    }

    protected argList(start: number, nargs: number): string {
        return windowRegs(start, nargs).map(r => `r${r}`).join(", ");
    }

    protected jump(target: number, next: number): string {
        if (target === next && target < this.inst.length) return "";
        if (target >= this.inst.length) return this.endOfCode;
        return `ip = ${target}; continue;`;
    }

    protected branch(term: Extract<AotTerm, { k: "Branch" }>, next: number): string {
        if (term.then === next) return `if (!isTruthy(r${term.cond})) { ${this.jump(term.else, -1)} }`;
        return `ip = isTruthy(r${term.cond}) ? ${term.then} : ${term.else}; continue;`;
    }

    protected procExpr(proc: ProcRef): string {
        return "reg" in proc ? `r${proc.reg}` : `IBUILTINS[${proc.builtin}]`;
    }

    protected directGuard(proc: string, nargs: string): string {
        return `${proc} instanceof Closure && ${proc}.tmpl.code.directArity === ${nargs} && ctx.jsDepth < MAX_JS_DEPTH`;
    }

    protected restGuard(proc: string, nargs: string): string {
        return `${proc} instanceof Closure && ${proc}.tmpl.code.directRestArity !== -1 && ${nargs} >= ${proc}.tmpl.code.directRestArity && ctx.jsDepth < MAX_JS_DEPTH`;
    }

    protected selfMoves(term: Extract<AotTerm, { k: "MaybeSelfTailCall" }>): string {
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

    protected emitInst(inst: AotInst): void {
        if (this.debug) this.emit(this.debugHooks(inst));
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
                        const cache = GLOBAL_CACHE[${inst.ip}];
                        if (cache.scope === ctx.scope && cache.version === Table.globalsVersion) {
                            r${inst.dst} = cache.value;
                        } else {
                            const val = ctx.scope.lookup(CONSTANTS[${inst.sym}], MISSING);
                            if (val === MISSING) {
                                ${this.recordIp(inst.ip)}
                                throw new MissingVarError("Variable '" + String(CONSTANTS[${inst.sym}]) + "' is not defined in the current scope.");
                            }
                            ctx.scope.watch();
                            cache.scope = ctx.scope;
                            cache.version = Table.globalsVersion;
                            cache.value = val;
                            r${inst.dst} = val;
                        }
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
            case "MoveAcc":
                return this.emit(`r${inst.dst} = ${this.accExpr};`);
            case "RtCall":
                return this.emit(this.#inlineRuntime(inst) ?? `r${inst.dst} = ${this.windowCall(`RUNTIME_FNS[${inst.rt}]`, inst.start, inst.nargs, true)};`);
            case "CallBuiltin": {
                const inline = this.inlineBuiltin(inst.builtin, inst.start, inst.nargs);
                if (inline !== null) return this.emit(`r${inst.dst} = ${inline};`);
                return this.emit(`
                    ${this.recordIp(inst.resume)}
                    r${inst.dst} = ${this.windowCall(`IBUILTINS[${inst.builtin}].cb`, inst.start, inst.nargs)};
                `);
            }
            default: {
                const _: never = inst;
            }
        }
    }

    #inlineRuntime(inst: Extract<AotInst, { k: "RtCall" }>): string | null {
        const a = `r${inst.start}`, b = `r${inst.start + 1}`, dst = `r${inst.dst}`;
        switch (RUNTIME[inst.rt][0]) {
            case "handlers": return `${dst} = ctx.handlers;`;
            case "set-handlers!": return `ctx.handlers = ${a}; ${dst} = undefined;`;
            case "set-raise-proc": return `executor.raiseProc = ${a}; ${dst} = undefined;`;
            case "wind": return `ctx.wind = new WindPoint(ctx.wind, ${a}, ${b}); ${dst} = undefined;`;
            case "end-wind": return `if (ctx.wind !== null) ctx.wind = ctx.wind.parent; ${dst} = undefined;`;
            default: return null;
        }
    }

    // an expression computing a builtin call inline (see InlineFn), or null
    protected inlineBuiltin(builtin: number, start: number, nargs: number): string | null {
        const inline = IBUILTINS[builtin].inline;
        if (inline === undefined) return null;
        return inline(windowRegs(start, nargs).map(r => `r${r}`), this.windowCall(`IBUILTINS[${builtin}].cb`, start, nargs), "tmp");
    }
}

// the frame-based entry the driver loop uses: registers live in locals and are spilled to frame.regs whenever control may leave
class ResumeEmitter extends FunctionEmitter {
    protected readonly accExpr = "ctx.acc";
    protected readonly endOfCode = "return null;";
    readonly #liveness: Liveness;

    constructor(blocks: AotBlock[], inst: Uint32Array, numReg: number, debug: boolean = false) {
        super(blocks, inst, numReg, debug);
        this.#liveness = new Liveness(blocks, numReg);
    }

    protected recordIp(ip: number): string {
        return `frame.ip = ${ip};`;
    }

    protected debugPos(ip: number): string {
        return `frame.posIp = ${ip};`;
    }

    protected windowCall(fn: string, start: number, nargs: number, withRuntime: boolean = false): string {
        const spills = windowRegs(start, nargs).map(r => `regs[${r}] = r${r}`);
        return `(${[...spills, `${fn}(${withRuntime ? "ctx, executor, " : ""}regs, ${start}, ${nargs})`].join(", ")})`;
    }

    #spills(regs: number[]): string {
        return regs.map(r => `regs[${r}] = r${r};`).join(" ");
    }

    #directCall(call: string): string {
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

    emitFunction(): void {
        const locals = Array.from({ length: this.numReg }, (_, i) => this.#liveness.entryLive.has(i) ? `r${i} = regs[${i}]` : `r${i}`);
        this.emit(`
            function(ctx, frame, executor) {
                const regs = frame.regs;
                const upvars = frame.upvars;
                let ip = frame.ip, tmp;
                ${locals.length > 0 ? `let ${locals.join(", ")};` : ""}
                try {
                    while (true) {
                        switch (ip) {
        `);
        this.emitSwitchBody();
        this.emit(`
                            default:
                                return null;
                        }
                    }
                } catch (err) {
                    ${this.#spills(this.#liveness.written)}
                    return executor.handleHostException(ctx, frame, err);
                }
            }
        `);
    }

    protected emitTerm(term: AotTerm, next: number): void {
        const live = this.#liveness;
        if (this.debug) this.emit(this.debugHooks(term, this.tailProcOf(term)));
        switch (term.k) {
            case "Jump":
                return this.emit(this.jump(term.target, next));
            case "Branch":
                return this.emit(this.branch(term, next));
            case "Call":
                return this.emit(`
                    {
                        const proc = r${term.proc};
                        frame.ip = ${term.resume};
                        ${this.#spills(live.spillsFor(term.resume, windowRegs(term.start, term.nargs)))}
                        if (${this.directGuard("proc", `${term.nargs}`)}) {
                            ${this.#directCall(`proc.tmpl.code.directFn(ctx, proc, executor${term.nargs > 0 ? ", " + this.argList(term.start, term.nargs) : ""})`)}
                        } else if (${this.restGuard("proc", `${term.nargs}`)}) {
                            ${this.#directCall(`executor.callDirectRest(ctx, proc, [${this.argList(term.start, term.nargs)}])`)}
                        } else if (proc instanceof BuiltinFunction) {
                            ctx.acc = proc.cb(regs, ${term.start}, ${term.nargs});
                        } else {
                            return executor.invoke(ctx, proc, frame, regs, ${term.start}, ${term.nargs}, false);
                        }
                    }
                    ${this.jump(term.resume, next)}
                `);
            case "TailCall":
                return this.emit(`
                    frame.ip = ${term.ip};
                    ${this.#spills(windowRegs(term.start, term.nargs))}
                    return executor.invoke(ctx, r${term.proc}, frame, regs, ${term.start}, ${term.nargs}, true);
                `);
            case "MaybeSelfTailCall":
                return this.emit(`
                    {
                        const proc = r${term.proc};
                        if (proc === frame.closure && !frame.isShared(ctx)) {
                            ${this.selfMoves(term)}
                            ip = 0;
                            continue;
                        }
                        frame.ip = ${term.ip};
                        ${this.#spills(windowRegs(term.start, term.nargs))}
                        return executor.invoke(ctx, proc, frame, regs, ${term.start}, ${term.nargs}, true);
                    }
                `);
            case "Apply": {
                const window = windowRegs(term.start, term.nargs);
                return this.emit(`
                    frame.ip = ${term.resume};
                    ${this.#spills(term.isTail ? window : live.spillsFor(term.resume, window))}
                    return executor.apply(ctx, ${this.procExpr(term.proc)}, frame, windowApplyArgs(regs, ${term.start}, ${term.nargs}), ${term.isTail});
                `);
            }
            case "CallCC":
                return this.emit(`
                    frame.ip = ${term.resume};
                    ${term.isTail ? "" : this.#spills(live.spillsFor(term.resume))}
                    return executor.callCC(ctx, r${term.proc}, frame, ${term.isTail});
                `);
            case "Yield":
                return this.emit(`
                    frame.ip = ${term.resume};
                    ${this.#spills(live.spillsFor(term.resume))}
                    return executor.coYield(ctx, frame, r${term.val});
                `);
            case "CoResume":
                return this.emit(`
                    frame.ip = ${term.resume};
                    ${term.isTail ? "" : this.#spills(live.spillsFor(term.resume))}
                    return executor.coResume(ctx, ${term.isTail ? "frame.parent" : "frame"}, r${term.co}, listToArray(r${term.list}));
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
}

// the frameless entry used by direct calls: arguments arrive as js arguments and the value is returned
class DirectEmitter extends FunctionEmitter {
    protected readonly accExpr = "acc";
    protected readonly endOfCode = "return undefined;";

    protected recordIp(): string {
        return "";
    }

    protected debugPos(ip: number): string {
        return `dip = ${ip};`;
    }

    protected windowCall(fn: string, start: number, nargs: number, withRuntime: boolean = false): string {
        return `${fn}(${withRuntime ? "ctx, executor, " : ""}[${this.argList(start, nargs)}], 0, ${nargs})`;
    }

    emitFunction(arity: number): void {
        const params = Array.from({ length: arity }, (_, i) => `, a${i}`).join("");
        const locals = Array.from({ length: this.numReg }, (_, i) => i < arity ? `r${i} = a${i}` : `r${i}`);
        const allRegs = Array.from({ length: this.numReg }, (_, i) => `r${i}`).join(", ");
        this.emit(`
            function(ctx, closure, executor${params}) {
                const upvars = closure.upvars;
                let ip = 0, rip = 0, acc, tmp${this.debug ? ", dip = 0" : ""};
                ${locals.length > 0 ? `let ${locals.join(", ")};` : ""}
                try {
        `);
        const structured = this.#structuredBody();
        if (structured !== null) {
            this.emit(`
                    for (;;) {
                        ${structured}
                        return undefined;
                    }
            `);
        } else {
            this.emit(`
                    while (true) {
                        switch (ip) {
            `);
            this.emitSwitchBody();
            this.emit(`
                            default:
                                return undefined;
                        }
                    }
            `);
        }
        this.emit(`
                } catch (e) {
                    const sig = e instanceof Suspend ? e : Suspend.error(e);
                    if (rip !== -1) {
                        const f = new Frame(closure, [${allRegs}], rip, null, ctx);
                        ${this.debug ? "if (!(e instanceof Suspend)) f.posIp = dip;" : ""}
                        sig.push(f);
                    }
                    throw sig;
                }
            }
        `);
    }

    // direct-entry code never resumes mid-function, so compiled `if`s (IF c else ... ELSE end, else: ... ENDIF, end:) can be emitted as nested js if/else
    #structuredBody(): string | null {
        const body = new DirectEmitter(this.blocks, this.inst, this.numReg, this.debug);
        const index = new Map(this.blocks.map((b, i) => [b.start, i]));
        try {
            body.#walk(index, 0, this.inst.length);
        } catch (e) {
            if (e === STRUCTURE_MISMATCH) return null;
            throw e;
        }
        return body.toString();
    }

    #walk(index: Map<number, number>, from: number, stop: number): void {
        const { blocks, inst } = this;
        let i = index.get(from);
        if (i === undefined) throw STRUCTURE_MISMATCH;
        while (i < blocks.length && blocks[i].start < stop) {
            const block = blocks[i];
            const next = i + 1 < blocks.length ? blocks[i + 1].start : inst.length;
            for (const x of block.insts) this.emitInst(x);
            const term = block.term;
            if (term.k === "Branch") {
                const elseIp = term.else;
                if (term.then !== next || inst[elseIp - 2] !== OpCode.ELSE) throw STRUCTURE_MISMATCH;
                const endIp = inst[elseIp - 1];
                if (inst[endIp - 1] !== OpCode.ENDIF) throw STRUCTURE_MISMATCH;
                this.emit(`if (isTruthy(r${term.cond})) {`);
                this.#walk(index, term.then, elseIp - 2);
                this.emit(`} else {`);
                this.#walk(index, elseIp, endIp - 1);
                this.emit(`}`);
                if (endIp >= stop) return;
                i = index.get(endIp);
                if (i === undefined) throw STRUCTURE_MISMATCH;
                continue;
            }
            if (term.k === "Jump") {
                if (term.target < stop) throw STRUCTURE_MISMATCH;
                return;
            }
            this.emitTerm(term, next);
            i++;
        }
    }

    // a tail call from direct code: stays direct when possible, otherwise suspends without rebuilding this frame
    #tailCall(proc: string, start: number, nargs: number): string {
        const args = this.argList(start, nargs);
        return `
            rip = -1;
            if (${this.directGuard(proc, `${nargs}`)}) {
                ctx.jsDepth++;
                const val = ${proc}.tmpl.code.directFn(ctx, ${proc}, executor${nargs > 0 ? ", " + args : ""});
                ctx.jsDepth--;
                return val;
            }
            if (${this.restGuard(proc, `${nargs}`)}) {
                ctx.jsDepth++;
                const val = executor.callDirectRest(ctx, ${proc}, [${args}]);
                ctx.jsDepth--;
                return val;
            }
            if (${proc} instanceof BuiltinFunction) return ${proc}.cb([${args}], 0, ${nargs});
            throw Suspend.invoke(${proc}, [${args}]);
        `;
    }

    protected emitTerm(term: AotTerm, next: number): void {
        if (this.debug) this.emit(this.debugHooks(term, this.tailProcOf(term)));
        switch (term.k) {
            case "Jump":
                return this.emit(this.jump(term.target, next));
            case "Branch":
                return this.emit(this.branch(term, next));
            case "Call": {
                const args = this.argList(term.start, term.nargs);
                return this.emit(`
                    {
                        const proc = r${term.proc};
                        rip = ${term.resume};
                        if (${this.directGuard("proc", `${term.nargs}`)}) {
                            ctx.jsDepth++;
                            acc = proc.tmpl.code.directFn(ctx, proc, executor${term.nargs > 0 ? ", " + args : ""});
                            ctx.jsDepth--;
                        } else if (${this.restGuard("proc", `${term.nargs}`)}) {
                            ctx.jsDepth++;
                            acc = executor.callDirectRest(ctx, proc, [${args}]);
                            ctx.jsDepth--;
                        } else if (proc instanceof BuiltinFunction) {
                            acc = proc.cb([${args}], 0, ${term.nargs});
                        } else {
                            throw Suspend.invoke(proc, [${args}]);
                        }
                    }
                    ${this.jump(term.resume, next)}
                `);
            }
            case "TailCall":
                return this.emit(`{ const proc = r${term.proc}; ${this.#tailCall("proc", term.start, term.nargs)} }`);
            case "MaybeSelfTailCall":
                return this.emit(`
                    {
                        const proc = r${term.proc};
                        if (proc === closure) {
                            ${this.selfMoves(term)}
                            ip = 0;
                            continue;
                        }
                        ${this.#tailCall("proc", term.start, term.nargs)}
                    }
                `);
            case "Apply": {
                const done = term.isTail ? "return" : "acc =";
                return this.emit(`
                    {
                        const proc = ${this.procExpr(term.proc)};
                        const args = windowApplyArgs([${this.argList(term.start, term.nargs)}], 0, ${term.nargs});
                        rip = ${term.isTail ? -1 : term.resume};
                        if (proc instanceof BuiltinFunction) {
                            ${done} proc.cb(args, 0, args.length);
                        } else if (${this.directGuard("proc", "args.length")}) {
                            ctx.jsDepth++;
                            ${term.isTail ? "const val =" : "acc ="} proc.tmpl.code.directFn(ctx, proc, executor, ...args);
                            ctx.jsDepth--;
                            ${term.isTail ? "return val;" : ""}
                        } else if (${this.restGuard("proc", "args.length")}) {
                            ctx.jsDepth++;
                            ${term.isTail ? "const val =" : "acc ="} executor.callDirectRest(ctx, proc, args);
                            ctx.jsDepth--;
                            ${term.isTail ? "return val;" : ""}
                        } else {
                            throw Suspend.invoke(proc, args);
                        }
                    }
                    ${term.isTail ? "" : this.jump(term.resume, next)}
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
                    throw Suspend.yield(r${term.val});
                `);
            case "CoResume":
                if (term.isTail) {
                    return this.emit(`
                        rip = -1;
                        throw Suspend.resume(r${term.co}, listToArray(r${term.list}));
                    `);
                }
                return this.emit(`
                    rip = ${term.resume};
                    if (executor.nestedResumes >= MAX_NESTED_RESUMES) throw Suspend.resume(r${term.co}, listToArray(r${term.list}));
                    acc = executor.coResumeNested(ctx, r${term.co}, listToArray(r${term.list}));
                    ${this.jump(term.resume, next)}
                `);
            case "Return":
                return this.emit(`return r${term.reg};`);
            default: {
                const _: never = term;
            }
        }
    }
}
