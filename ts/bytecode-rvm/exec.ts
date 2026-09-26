import {
    ErrorObject,
    MissingVarError,
    UnhandledSchemeError,
    isTruthy,
    Table,
    Env,
    IProcedure,
    type AbstractVM,
    AbstractByteCode,
    BS,
    BSReader,
    SerializableBytecode,
    AbstractClosure,
    OpaqueValue,
    packValues,
    unpackValues,
    MultipleValues,
    ASTStringifier,
    type SourcePos,
    formatPos
} from "../common";
import { Cons } from "../list";
import { listToArray, windowApplyArgs, valuesToList, listToValues, applyArgsList } from "../ops";
import { BuiltinFunction, IBUILTINS } from "../std";
import { Caught, ContinuationMarkSet, EXCEPTION_HANDLERS, markFirst, markOwn, markSet, markValues, recordTailMark, TAIL_TRAIL, type Marks, type TailTrail } from "../marks";
import { BUILTIN_INLINES, RUNTIME_INLINES } from "./inline";
import { hostError } from "../errors";

export const BUILTINS_START = 2**31;

// Operands are u32s; reg[x] = register x, constant = a constant-pool index, ip = an instruction index.
// Non-tail CALL/APPLY/CALLCC/CORESUME/COYIELD leave their result in the accumulator, read by a following MOVEACC.
export enum OpCode {
    LOADCONST,   // dst constant       reg[dst] = constants[constant]
    LOADU32,     // dst n              reg[dst] = n (a small non-negative integer)
    LOADUPVAR,   // dst i unbox        reg[dst] = upvars[i] (its box's value if unbox)
    SETUPVAR,    // src i box          upvars[i] = reg[src] (in a new box if box)
    LOADGLOBAL,  // dst constant       reg[dst] = global named constants[constant]
    SETGLOBAL,   // src constant       global named constants[constant] = reg[src]
    IF,          // cond elseIp        jump to elseIp if reg[cond] is false
    ELSE,        // endIp              end of the then branch: jump past the else branch
    ENDIF,       //                    marks the end of an if (for structured AOT code)
    CALL,        // proc start n tail  call reg[proc] (or builtin proc - BUILTINS_START) on reg[start .. start+n)
    RETURN,      // src                return reg[src] from the function
    NEWCLOSURE,  // dst constant       reg[dst] = closure of the template constants[constant], capturing its upvars
    BOX,         // dst src            reg[dst] = new box holding reg[src]
    UNBOX,       // dst src            reg[dst] = value of the box reg[src]
    SETBOX,      // box src            the box reg[box] now holds reg[src]
    MOVE,        // dst src            reg[dst] = reg[src]
    CALLCC,      // proc tail          call reg[proc] with the current continuation
    APPLY,       // proc start n tail  like CALL, with the last argument a list spread into the arguments
    MOVEACC,     // dst                reg[dst] = accumulator (the last call's result)
    COYIELD,     // val                yield reg[val] (already packed multiple values) from the running coroutine
    CALLRT,      // rt dst start n     reg[dst] = RUNTIME[rt] applied to reg[start .. start+n)
    CORESUME,    // co list tail       resume coroutine reg[co] with the values in the list reg[list]
    BLOCK,       // endIp              start of a %block ending at endIp (for structured AOT code)
    LOOP,        // endIp              start of a %loop ending at endIp; its body starts after this
    ENDLOOP,     // headIp             end of a %loop's body: jump back to headIp
    JUMP,        // target             an %escape: jump to target (the end of a %block)
    UNPACK,      // src start n flags  spread reg[src]'s multiple values over reg[start .. start+n) (+ rest list; see UNPACK_*)
    SETMARK,     // key val            set continuation mark reg[key] = reg[val] on the current frame
    MARKSAVE,    // dst                reg[dst], reg[dst+1] = current marks and logical frame, then start a new logical frame
    MARKRESTORE, // src                marks and logical frame = reg[src], reg[src+1]
    CURMARKS,    // dst                reg[dst] = the current continuation marks, as a mark set
    CALLEC,      // proc tok           reg[tok] = a new escape continuation; call reg[proc] with it
    CALLCATCH,   // proc tok pre       reg[tok] = a new catch token; call reg[proc] with it as the innermost exception handler
                 //                    (reg[pre], unless pre is NO_REG, runs on the error before unwinding)
    RAISE,       // obj continuable    deliver reg[obj] to the innermost exception handler
    CURSTACK,    // skip               a snapshot of the current stack, minus its innermost skip frames
    CALLHOST,    // rt start n tail    call host intrinsic runtime[rt] on reg[start .. start+n); a HostTail result is called in its place
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
    [OpCode.BLOCK]: 2,
    [OpCode.LOOP]: 2,
    [OpCode.ENDLOOP]: 2,
    [OpCode.JUMP]: 2,
    [OpCode.UNPACK]: 5,
    [OpCode.SETMARK]: 3,
    [OpCode.MARKSAVE]: 2,
    [OpCode.MARKRESTORE]: 2,
    [OpCode.CURMARKS]: 2,
    [OpCode.CALLEC]: 3,
    [OpCode.CALLCATCH]: 4,
    [OpCode.RAISE]: 3,
    [OpCode.CURSTACK]: 2,
    [OpCode.CALLHOST]: 5,
};

// UNPACK flags
export const UNPACK_REST = 1;
export const UNPACK_STRICT = 2;

// the values of `val` for UNPACK: checks the count when strict; missing values read as undefined (<#void>)
export const unpackForBinding = (val: any, count: number, flags: number): any[] => {
    const vals = unpackValues(val);
    if ((flags & UNPACK_STRICT) !== 0 && ((flags & UNPACK_REST) !== 0 ? vals.length < count : vals.length !== count)) {
        throw hostError(`let-values: expected ${(flags & UNPACK_REST) !== 0 ? "at least " : ""}${count} value${count === 1 ? "" : "s"} but got ${vals.length}`);
    }
    return vals;
};

export const restValues = (vals: any[], count: number): Cons | null => Cons.fromArray(vals.slice(count));

export type ResumeFn = (ctx: ExecutionContext, frame: Frame, executor: VMExecutor) => Frame | null;

// `depth` counts nested direct calls on the js stack; past MAX_JS_DEPTH calls go through heap frames instead. `marks` is
// the continuation's mark list and `mframe` the logical frame the function runs in (a tail call keeps its caller's)
export type DirectFn = (ctx: ExecutionContext, closure: Closure, executor: VMExecutor, depth: number, marks: any, mframe: number, ...args: any[]) => any;

// instruction arrays that several ByteCode copies run (see ByteCode.fresh)
const SHARED_INSTS = new WeakSet<Uint32Array>();

export class ByteCode implements AbstractByteCode {
    public bsid = "ByteCode";
    public resumeFn: ResumeFn | null = null;
    public directFn: DirectFn | null = null;
    public directArity: number = -1;
    public directRestArity: number = -1;
    // how often a direct call of this function ended in a suspend for call/cc, a continuation, a yield or a resume (see
    // resumeSuspend)
    public controlSuspends: number = 0;
    // how often direct code of this function resumed a coroutine in a nested driver loop: past a few, it suspends to heap
    // frames instead, where resuming is a cheap switch inside one loop
    public nestedResumes: number = 0;
    // how often a tail call from this function's heap code into a direct entry came back as a Suspend (e.g. a long chain
    // of tail calls reaching the depth limit): past a few, its heap code tail calls through heap frames, which run such
    // chains in constant space without unwinding the js stack
    public tailSuspends: number = 0;

    // the runtime operations CALLRT operands refer to, as indices into `runtime`, resolved by name to the operations
    // registered now
    readonly rt: number[];

    // lineTable holds (ip, fileIdx, line, col) entries sorted by ip; each covers the code up to the next entry
    constructor(
        public constants: any[],
        public inst: Uint32Array,
        public numReg: number,
        public lineTable: Uint32Array = new Uint32Array(0),
        public files: string[] = [],
        // compiled in debug mode: records tail calls and exact error positions (never mixed with non-debug code)
        public debug: boolean = false,
        // metadata: the names of the runtime operations the code uses
        public readonly runtime: string[] = []
    ) {
        this.rt = runtime.map(name => {
            const idx = RUNTIME_IDX.get(name);
            if (idx === undefined) throw new Error(`bytecode uses the runtime operation '${name}', which is not registered`);
            return idx;
        });
    }

    fresh(copies: Map<ByteCode, ByteCode> = new Map()): ByteCode {
        const known = copies.get(this);
        if (known !== undefined) return known;
        const copy = new ByteCode([], this.inst, this.numReg, this.lineTable, this.files, this.debug, this.runtime);
        copies.set(this, copy);
        SHARED_INSTS.add(this.inst);
        copy.constants = this.constants.map(c => c instanceof ClosureTemplate
            ? new ClosureTemplate(c.params, c.remParams, c.code.fresh(copies), c.upvarLocs, c.name)
            : c);
        return copy;
    }

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
        bs.writeArray(this.runtime);
    }

    static register(bsr: BSReader) {
        bsr.registerFactory("ByteCode", (bsr) => {
            const inst = bsr.readU32Arr();
            const constants = bsr.readArray();
            const numReg = bsr.readU32();
            const lineTable = bsr.readU32Arr();
            const files = bsr.readArray() as string[];
            const debug = bsr.read() as boolean;
            const runtime = bsr.readArray() as string[];
            return new ByteCode(constants, inst, numReg, lineTable, files, debug, runtime);
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
    public wind: WindPoint | null = null;
    public pendingWind: PendingWindTransition | null = null;
    public coroutine: Coroutine | null = null;
    // a throwaway resumer for nested resumes: control coming back here ends the nested driver loop
    public barrier: boolean = false;

    constructor(
        public vm: AbstractVM,
        public scope: Env
    ) {
        this.id = ++ExecutionContext.nextId;
    }
}

// how debug code names a tail-called procedure in the tail-call trails
export const tailName = (proc: any): string =>
    proc instanceof IProcedure ? proc.debugName ?? "?" : proc instanceof OpaqueValue ? proc.typeName : String(proc);

export type CoroutineStatus = "suspended" | "running" | "normal" | "dead";

export class Coroutine extends OpaqueValue {
    public status: CoroutineStatus = "suspended";
    public started: boolean = false;
    public closing: boolean = false;
    public frame: Frame | null = null;
    // `marks`/`mframe`: those of the code that resumed it (a tail resume's frame is gone), where its errors are raised again
    public resumer: { ctx: ExecutionContext, frame: Frame | null, marks: Marks, mframe: number } | null = null;
    public readonly ctx: ExecutionContext;

    constructor(public readonly proc: any, vm: AbstractVM, scope: Env) {
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
    constructor(public readonly value: any, public readonly marks: Marks | undefined = undefined, public readonly mframe: number = 0) {}
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

// a function whose direct calls keep ending in a control transfer (call/cc, a continuation, a yield, an escape) or an
// error pays for it every time: after DIRECT_SUSPEND_LIMIT of them, calls to it use heap frames, where those are cheap
export const countControlSuspend = (code: ByteCode): void => {
    if (++code.controlSuspends === DIRECT_SUSPEND_LIMIT) {
        code.directArity = -1;
        code.directRestArity = -1;
    }
};

// an escape-only continuation (call/ec), usable until its %call/ec returns. The %call/ec's frame is the one of `code`
// holding this in register `reg` (cleared when it returns); a direct-mode %call/ec catches escapes to it itself
export class EscapeContinuation extends IProcedure {
    constructor(public readonly ctxId: number, public readonly wind: WindPoint | null, public readonly code: ByteCode, public readonly reg: number) {
        super("escape continuation");
    }

    // the frame to return to, found among `from` and its callers; copies made by call/cc hold it too
    target(from: Frame | null): Frame | null {
        for (let f = from; f !== null; f = f.parent) {
            if (f.code === this.code && f.regs[this.reg] === this) return f;
        }
        return null;
    }
}

// Frames the VM puts under a handler it calls: `handlerReturned` raises the secondary error when the handler of a
// non-continuable raise returns (its marks hold the outer handlers); `escapeWith` escapes to the catch token in its
// register 0 with what a pre-unwind handler returned
let helpers: { handlerReturned: Closure, escapeWith: Closure } | null = null;
const raiseHelpers = () => helpers ??= {
    handlerReturned: helperClosure(1, [new ErrorObject(hostError("handler returned on non-continuable exception"))], [], [
        OpCode.LOADCONST, 0, 0,
        OpCode.RAISE, 0, 0,
        OpCode.RETURN, 0,
    ]),
    escapeWith: helperClosure(3, [], ["make-caught"], [
        OpCode.MOVEACC, 1,
        OpCode.CALLRT, 0, 2, 1, 1,
        OpCode.CALL, 0, 2, 1, 1,
    ]),
};
const helperClosure = (numReg: number, constants: any[], runtime: string[], inst: number[]): Closure =>
    new Closure(new ClosureTemplate([], null, new ByteCode(constants, new Uint32Array(inst), numReg, undefined, undefined, false, runtime), [], "raise"), [], "raise");

// the handler a %catch installs: raising to it escapes to the %catch with the error wrapped in a Caught
export class CatchToken extends EscapeContinuation {
    constructor(ctxId: number, wind: WindPoint | null, code: ByteCode, reg: number, public readonly pre: any = null) {
        super(ctxId, wind, code, reg);
    }
}

export const NO_REG = 0xFFFFFFFF;

// the value of a caught error, as handlers see it
const caughtValue = (err: any): any =>
    err instanceof ReRaise ? (err.value instanceof Error ? new ErrorObject(err.value) : err.value) : err instanceof ErrorObject ? err : new ErrorObject(err);

// what a direct-mode %catch whose token is `tok` takes from an exception passing through it, or null to let it go on:
// its own escapes, and errors whose innermost handler is `tok` (so nothing else would see them) and which leave no
// dynamic-wind to unwind
export const catchHere = (e: any, tok: CatchToken, ctx: ExecutionContext): any => {
    if (ctx.wind !== tok.wind) return null;
    if (e instanceof Suspend && e.escape === tok) return e.escapeVal;
    // a pre-unwind handler has to run first, in heap code
    if (tok.pre !== null) return null;
    if (!(e instanceof Suspend)) return e instanceof EscapedError ? null : new Caught(caughtValue(e));
    if (e.action !== null) return null;
    const marks = e.marks !== undefined ? e.marks : e.innermost !== null ? e.innermost.marks : undefined;
    if (marks === undefined) return null;
    const handlers = markFirst(marks, EXCEPTION_HANDLERS, null);
    return handlers instanceof Cons && handlers.car === tok ? new Caught(caughtValue(e.error)) : null;
};

export class Frame {
    public code: ByteCode;
    public upvars: any[];
    public epoch: number;
    // exact position of the last instruction run, when debug code knows it better than ip
    public posIp: number = -1;

    // `marks`: the continuation marks visible in this frame; `mframe`: its logical frame (a tail call keeps its caller's)
    constructor(
        public closure: Closure,
        public regs: any[],
        public ip: number,
        public parent: Frame | null,
        public ctx: ExecutionContext,
        public marks: Marks = null,
        public mframe: number = 0
    ) {
        this.code = closure.tmpl.code;
        this.upvars = closure.upvars;
        this.epoch = ctx.epoch;
    }

    get debugName(): string {
        return this.closure.debugName ?? "lambda";
    }

    thaw(ctx: ExecutionContext): Frame {
        return new Frame(this.closure, this.regs.slice(), this.ip, this.parent, ctx, this.marks, this.mframe);
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

const DIRECT_SUSPEND_LIMIT = 8;

const MISSING = Symbol("missing");

class EscapedError {
    constructor(public readonly error: any) {}
}

type SuspendAction = (ctx: ExecutionContext, executor: VMExecutor, caller: Frame, sig: Suspend) => Frame | null;

// thrown out of direct-entry code when heap frames are needed; each direct frame on the way out rebuilds itself
export class Suspend {
    innermost: Frame | null = null;
    outermost: Frame | null = null;
    // the outermost direct function this passed through, i.e. the one heap code called directly
    entered: Closure | null = null;
    // set when invoking an escape continuation, so a direct-mode %call/ec on the way out can take the value itself
    escape: EscapeContinuation | null = null;
    escapeVal: any = undefined;
    // the marks where it was thrown, when that was a tail call (which rebuilds no frame): errors are raised with them
    marks: Marks | undefined = undefined;
    mframe: number = 0;

    // `control`: suspended for call/cc, invoking a continuation, a yield or a coroutine resume, rather than for depth or an error
    constructor(public readonly action: SuspendAction | null, public readonly error?: any, public readonly control: boolean = false) {}

    push(frame: Frame) {
        if (this.outermost === null) {
            this.innermost = frame;
        } else {
            this.outermost.parent = frame;
        }
        this.outermost = frame;
    }

    static invoke(proc: any, args: any[]) {
        const escape = proc instanceof EscapeContinuation;
        const sig = new Suspend((ctx, executor, caller, sig) => executor.invoke(ctx, proc, caller, args, 0, args.length, false, sig.marks, sig.mframe), undefined, escape || proc instanceof VMContinuation);
        if (escape && args.length === 1) {
            sig.escape = proc;
            sig.escapeVal = args[0];
        }
        return sig;
    }

    // raising from direct code: an escape when the innermost handler is a plain catch token (which a direct %catch
    // further out can take), else delivered from heap frames
    static raise(obj: any, continuable: boolean, marks: Marks) {
        const sig = new Suspend((ctx, executor, caller) => executor.raise(ctx, caller, obj, continuable), undefined, true);
        const handlers = markFirst(marks, EXCEPTION_HANDLERS, null);
        if (handlers instanceof Cons && handlers.car instanceof CatchToken && handlers.car.pre === null) {
            sig.escape = handlers.car;
            sig.escapeVal = new Caught(obj);
        }
        return sig;
    }

    // direct code taking a snapshot of the stack: its frames are rebuilt, and the snapshot is the value. Code that keeps
    // doing it is better off on heap frames, where a snapshot needs no rebuilding, so it counts like a control transfer
    static stack(skip: number) {
        return new Suspend((ctx, executor, caller) => executor.setRetVal(ctx, caller, new StackSnapshot(frameInfos(caller, skip))), undefined, true);
    }

    static callCC(proc: any) {
        return new Suspend((ctx, executor, caller, sig) => executor.callCC(ctx, proc, caller, false, sig.marks, sig.mframe), undefined, true);
    }

    static error(err: any) {
        return new Suspend(null, err);
    }

    static resume(co: any, args: any[], marks: Marks, mframe: number) {
        return new Suspend((ctx, executor, caller) => executor.coResume(ctx, caller, co, args, marks, mframe), undefined, true);
    }

    static yield(val: any) {
        return new Suspend((ctx, executor, caller) => executor.coYield(ctx, caller, val), undefined, true);
    }
}

export class VMExecutor {
    public nestedResumes: number = 0;

    constructor(public vm: AbstractVM) {}

    // --- call protocol ---

    public enter(ctx: ExecutionContext, frame: Frame): Frame {
        if (frame.isShared(ctx)) {
            frame = frame.thaw(ctx);
        }
        return frame;
    }

    public invoke(
        ctx: ExecutionContext,
        proc: any,
        callerFrame: Frame | null,
        callerArgs: any[],
        startReg: number,
        nargs: number,
        isTail: boolean,
        // for a tail call made by direct code that left no frame: the marks and logical frame the callee continues
        marks?: Marks,
        mframe: number = 0
    ): Frame | null {
        const returnTo = (isTail && callerFrame !== null) ? callerFrame.parent : callerFrame;

        if (proc instanceof BuiltinFunction) {
            ctx.acc = proc.cb(callerArgs, startReg, nargs);
            return this.setRetVal(ctx, returnTo, ctx.acc);
        }

        if (proc instanceof Closure) {
            const pregs = this.createClosureArg(proc.tmpl, nargs, callerArgs, startReg);
            if (marks !== undefined) return this.newFrame(ctx, proc, pregs, returnTo, marks, mframe);
            if (isTail && callerFrame !== null && !callerFrame.isShared(ctx)) {
                return this.reset(callerFrame, proc, pregs);
            }
            // a tail call continues its caller's logical frame, so it keeps its marks
            if (callerFrame === null) return this.newFrame(ctx, proc, pregs, returnTo);
            return this.newFrame(ctx, proc, pregs, returnTo, callerFrame.marks, isTail ? callerFrame.mframe : callerFrame.mframe + 1);
        }

        if (proc instanceof VMContinuation) {
            if (proc.ctxId !== ctx.id) {
                throw hostError("Cannot invoke a continuation across execution/FFI boundary");
            }
            if (nargs !== 1) throw hostError(`continuation expected exactly 1 argument, but received ${nargs}`);

            return this.#jumpTo(ctx, proc.frame, proc.wind, callerArgs[startReg]);
        }

        if (proc instanceof EscapeContinuation) {
            if (proc.ctxId !== ctx.id) {
                throw hostError("Cannot invoke an escape continuation across execution/FFI boundary");
            }
            if (nargs !== 1) throw hostError(`escape continuation expected exactly 1 argument, but received ${nargs}`);
            const target = proc.target(callerFrame);
            if (target === null) throw hostError("escape continuation invoked outside of its dynamic extent");
            return this.#jumpTo(ctx, target, proc.wind, callerArgs[startReg]);
        }

        throw hostError(`Attempted to call a non-procedure: ${String(proc)}`);
    }

    #jumpTo(ctx: ExecutionContext, frame: Frame | null, wind: WindPoint | null, val: any): Frame | null {
        if (ctx.wind === wind) {
            ctx.acc = val;
            return this.setRetVal(ctx, frame, val);
        }
        ctx.pendingWind = {
            actions: computeWindTransition(ctx.wind, wind),
            actionIdx: 0,
            targetFrame: frame,
            targetVal: val,
            targetWind: wind,
        };
        return this.advanceWindTransition(ctx);
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
        parent: Frame | null,
        marks: Marks = null,
        mframe: number = 0
    ): Frame {
        return new Frame(closure, regs, 0, parent, ctx, marks, mframe);
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
                throw hostError(`expected at least ${arity} args, got ${nargs}`);
            }
        } else {
            if (nargs !== arity) {
                throw hostError(`expected exactly ${arity} args, got ${nargs}`);
            }
        }

        const closureRegs: any[] = createRegs(template.code.numReg);
        for (let i = 0; i < arity; i++) {
            closureRegs[i] = args[startOffset + i];
        }

        if (template.remParams !== null) {
            let restList: any = null;
            for (let i = nargs - 1; i >= arity; i--) {
                restList = new Cons(args[startOffset + i], restList);
            }
            closureRegs[arity] = restList;
        }
        return closureRegs;
    }

    // calls a closure's fixed-arity direct entry with an argument array
    public callDirect(ctx: ExecutionContext, proc: Closure, args: any[], depth: number, marks: any, mframe: number): any {
        const fn = proc.tmpl.code.directFn!;
        switch (args.length) {
            case 0: return fn(ctx, proc, this, depth, marks, mframe);
            case 1: return fn(ctx, proc, this, depth, marks, mframe, args[0]);
            case 2: return fn(ctx, proc, this, depth, marks, mframe, args[0], args[1]);
            case 3: return fn(ctx, proc, this, depth, marks, mframe, args[0], args[1], args[2]);
            case 4: return fn(ctx, proc, this, depth, marks, mframe, args[0], args[1], args[2], args[3]);
        }
        return fn(ctx, proc, this, depth, marks, mframe, ...args);
    }

    public callDirectRest(ctx: ExecutionContext, proc: Closure, args: any[], depth: number, marks: any, mframe: number): any {
        const code = proc.tmpl.code;
        const fn = code.directFn!;
        const numPos = code.directRestArity;
        let rest: Cons | null = null;
        for (let i = args.length - 1; i >= numPos; i--) rest = new Cons(args[i], rest);
        // spreading into the call is slow, so the common arities are called directly
        switch (numPos) {
            case 0: return fn(ctx, proc, this, depth, marks, mframe, rest);
            case 1: return fn(ctx, proc, this, depth, marks, mframe, args[0], rest);
            case 2: return fn(ctx, proc, this, depth, marks, mframe, args[0], args[1], rest);
            case 3: return fn(ctx, proc, this, depth, marks, mframe, args[0], args[1], args[2], rest);
            case 4: return fn(ctx, proc, this, depth, marks, mframe, args[0], args[1], args[2], args[3], rest);
        }
        args.length = numPos;
        args.push(rest);
        return fn(ctx, proc, this, depth, marks, mframe, ...args);
    }

    // --- continuations and dynamic-wind ---

    // calls `proc` with `tok` as the innermost exception handler; its value, or a Caught, is returned to `frame`
    public callCatch(ctx: ExecutionContext, proc: any, frame: Frame, tok: CatchToken): Frame | null {
        const marks = markSet(frame.marks, frame.mframe + 1, EXCEPTION_HANDLERS, new Cons(tok, markFirst(frame.marks, EXCEPTION_HANDLERS, null)));
        if (proc instanceof Closure) return this.newFrame(ctx, proc, this.createClosureArg(proc.tmpl, 0, [], 0), frame, marks, frame.mframe + 1);
        try {
            return this.invoke(ctx, proc, frame, [], 0, 0, false);
        } catch (err) {
            if (err instanceof EscapedError) throw err;
            ctx.acc = new Caught(caughtValue(err));
            return frame;
        }
    }

    public callCC(ctx: ExecutionContext, proc: any, frame: Frame, isTail: boolean, marks?: Marks, mframe?: number): Frame | null {
        const target = isTail ? frame.parent : frame;
        target?.share(ctx);
        const k = new VMContinuation(target, ctx.id, ctx.wind);
        return this.invoke(ctx, proc, frame, [k], 0, 1, isTail, marks, mframe);
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

                throw hostError(`Attempted to call a non-procedure in dynamic-wind: ${String(action.thunk)}`);
            }

            ctx.pendingWind = null;
            ctx.wind = trans.targetWind;
            ctx.acc = trans.targetVal;
            return this.setRetVal(ctx, trans.targetFrame, trans.targetVal);
        }

        return null;
    }

    // --- errors ---

    // `marks`/`mframe`: where the error happened, when that is not `frame` (a tail call that left no frame)
    public handleHostException(ctx: ExecutionContext, frame: Frame | null, err: any, marks?: Marks, mframe: number = 0): Frame | null {
        if (err instanceof EscapedError) throw err;
        if (err instanceof UnhandledSchemeError) {
            const co = ctx.coroutine;
            if (co !== null && co.closing) throw err;
            if (co !== null && co.status === "running") {
                co.status = "dead";
                co.frame = null;
                const resumer = this.#detachResumer(co);
                if (resumer.ctx.barrier) throw new ReRaise(err.error);
                return this.handleHostException(resumer.ctx, resumer.frame, new ReRaise(err.error, resumer.marks, resumer.mframe));
            }
            const out = err.error instanceof Error ? err.error : new Error(String(err.error));
            if (err.traceback !== undefined && (out as any).animaTraceback === undefined) (out as any).animaTraceback = err.traceback;
            throw out;
        }
        if (err instanceof ReRaise && err.marks !== undefined) return this.raise(ctx, frame, caughtValue(err), false, err.marks, err.mframe);
        return this.raise(ctx, frame, caughtValue(err), false, marks, mframe);
    }

    // Delivers `obj` to the innermost exception handler seen from `frame` (or `marks`, where a tail call left no frame):
    // a catch token is escaped to (after its pre-unwind handler, if any); a handler procedure is called with the outer
    // handlers installed, and if it returns, that is the value of a continuable raise, else a secondary error for them
    public raise(ctx: ExecutionContext, frame: Frame | null, obj: any, continuable: boolean, marks: Marks = frame?.marks ?? null, mframe: number = frame?.mframe ?? 0): Frame | null {
        const handlers = markFirst(marks, EXCEPTION_HANDLERS, null);
        if (!(handlers instanceof Cons)) return this.#unhandled(ctx, frame, obj);
        const handler = handlers.car;
        const outer = markSet(marks, mframe + 1, EXCEPTION_HANDLERS, handlers.cdr);
        if (handler instanceof CatchToken) {
            if (handler.pre !== null) {
                const escape = new Frame(raiseHelpers().escapeWith, [handler, undefined, undefined], 0, frame, ctx, outer, mframe + 1);
                return this.invoke(ctx, handler.pre, escape, [obj], 0, 1, false);
            }
            const target = handler.target(frame);
            if (target === null) throw hostError("catch invoked outside of its dynamic extent");
            return this.#jumpTo(ctx, target, handler.wind, new Caught(obj));
        }
        if (continuable) return this.invoke(ctx, handler, frame, [obj], 0, 1, false, outer, mframe + 1);
        const returned = new Frame(raiseHelpers().handlerReturned, [undefined], 0, frame, ctx, outer, mframe + 1);
        return this.invoke(ctx, handler, returned, [obj], 0, 1, false);
    }

    #unhandled(ctx: ExecutionContext, frame: Frame | null, obj: any): Frame | null {
        const traceback = formatTraceback(frameInfos(frame), tracebackMessage(obj));
        const err = obj instanceof ErrorObject ? obj.error : obj;
        if (err instanceof Error && (err as any).animaTraceback === undefined) (err as any).animaTraceback = traceback;
        return this.handleHostException(ctx, frame, new UnhandledSchemeError(err, traceback));
    }

    public resumeSuspend(ctx: ExecutionContext, sig: Suspend): Frame | null {
        const caller = sig.innermost!;
        const entered = sig.entered?.tmpl.code;
        if ((sig.control || sig.action === null) && entered !== undefined) countControlSuspend(entered);
        try {
            if (sig.action === null) return this.handleHostException(ctx, caller, sig.error, sig.marks, sig.mframe);
            try {
                return sig.action(ctx, this, caller, sig);
            } catch (err) {
                return this.handleHostException(ctx, caller, err, sig.marks, sig.mframe);
            }
        } catch (err) {
            throw err instanceof EscapedError ? err : new EscapedError(err);
        }
    }

    // --- coroutines ---

    public coCreate(ctx: ExecutionContext, proc: any): Coroutine {
        if (!(proc instanceof Closure || proc instanceof BuiltinFunction)) {
            throw hostError(`coroutine-create: expected a procedure but got ${String(proc)}`);
        }
        return new Coroutine(proc, ctx.vm, ctx.scope);
    }

    public coStatus(co: any): symbol {
        if (!(co instanceof Coroutine)) throw hostError(`coroutine-status: expected a coroutine but got ${String(co)}`);
        return Symbol.for(co.status);
    }

    public coResume(
        ctx: ExecutionContext,
        resumeTo: Frame | null,
        co: any,
        args: any[],
        marks: Marks = resumeTo?.marks ?? null,
        mframe: number = resumeTo?.mframe ?? 0
    ): Frame | null {
        if (!(co instanceof Coroutine)) throw hostError(`coroutine-resume: expected a coroutine but got ${String(co)}`);
        if (co.status !== "suspended") throw hostError(`coroutine-resume: cannot resume a ${co.status} coroutine`);

        co.resumer = { ctx, frame: resumeTo, marks, mframe };
        // a coroutine resuming another keeps its frames where they can be traced while it waits
        if (ctx.coroutine !== null) {
            ctx.coroutine.status = "normal";
            ctx.coroutine.frame = resumeTo;
        }
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
        const barrier = new ExecutionContext(this.vm, co instanceof Coroutine ? co.ctx.scope : new Env());
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
        if (co === null) throw hostError("coroutine-yield: not inside a coroutine (or across a host call boundary)");
        if (co.closing) throw hostError("coroutine-yield: cannot yield while a coroutine is closing");
        co.frame = frame;
        co.status = "suspended";
        return this.#returnToResumer(co, val);
    }

    // starts or continues a coroutine inside the current driver loop; `resumeTo` is where its yields and final value go

    public coClose(ctx: ExecutionContext | null, co: any): void {
        if (!(co instanceof Coroutine)) throw hostError(`coroutine-close: expected a coroutine but got ${String(co)}`);
        if (co.status === "dead") return;
        if (co.status !== "suspended") throw hostError(`coroutine-close: cannot close a ${co.status} coroutine`);

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

    #detachResumer(co: Coroutine): NonNullable<Coroutine["resumer"]> {
        const resumer = co.resumer!;
        co.resumer = null;
        if (resumer.ctx.coroutine !== null) resumer.ctx.coroutine.status = "running";
        return resumer;
    }

    // --- driver loop ---

    #runLoop(ctx: ExecutionContext, frame: Frame): void {
        if ((this.vm as any).mode === "aot") {
            // compiled code already had its nested templates compiled with it
            if (frame.code.resumeFn === null) AotCompiler.compileAll(frame.code, frame.closure.tmpl);
            AotCompiler.run(ctx, frame, this);
        } else {
            BytecodeInterpreter.run(ctx, frame, this);
        }
    }
}

type RuntimeFn = (ctx: ExecutionContext, executor: VMExecutor, regs: readonly any[], start: number, nargs: number) => any;

// `tails`: the tail calls that led to the frame's current procedure (recorded by debug code), oldest first
export type FrameInfo = { name: string, pos: SourcePos | null, tails: TailTrail | null };

// what (%current-stack) returns: the frames as they were when it ran
export class StackSnapshot extends OpaqueValue {
    constructor(readonly frames: FrameInfo[]) {
        super();
    }

    get typeName() {
        return "stack";
    }
}

export const frameInfos = (frame: Frame | null, level: number = 0): FrameInfo[] => {
    const out: FrameInfo[] = [];
    for (let f = frame, i = 0; f !== null; f = f.parent, i++) {
        if (i >= level) out.push({
            name: f.debugName,
            pos: f.code.positionAt(Math.max((f.posIp !== -1 ? f.posIp : f.ip) - 1, 0)),
            tails: markOwn(f.marks, f.mframe, TAIL_TRAIL, null),
        });
    }
    return out;
};

export const formatTraceback = (frames: FrameInfo[], msg?: string): string => {
    const tails = (t: TailTrail | null) => t === null || t.length === 0 ? "" :
        ` (tail calls: ${t.map(c => c.count > 1 ? `${c.name} x${c.count}` : c.name).reverse().join(" <- ")})`;
    const lines = frames.map(f => `\n  ${formatPos(f.pos)} in ${f.name}${tails(f.tails)}`).join("");
    return `${msg !== undefined ? msg + "\n" : ""}stack traceback:${lines}`;
};

// (%debug-frames k args) / (%debug-traceback k args): args is ([coroutine] [msg] [level]), k the caller's continuation
// the frames %debug-frames / %debug-traceback describe: the stack snapshot they are given, or a coroutine's
const debugTarget = (ctx: ExecutionContext, regs: readonly any[], start: number) => {
    let frames = (regs[start] as StackSnapshot).frames;
    const args = listToArray(regs[start + 1]);
    if (args[0] instanceof Coroutine) {
        const co = args.shift() as Coroutine;
        if (co !== ctx.coroutine) frames = frameInfos(co.frame);
    }
    return { frames, args };
};

const tracebackMessage = (msg: any): string | undefined => {
    if (msg === undefined) return undefined;
    if (typeof msg === "string") return msg;
    if (msg instanceof ErrorObject) return msg.error instanceof Error ? msg.error.message : String(msg.error);
    if (msg instanceof Error) return msg.message;
    return new ASTStringifier().stringify(msg);
};

const markSetArg = (who: string, set: any): Marks => {
    if (!(set instanceof ContinuationMarkSet)) throw hostError(`${who}: expected a continuation mark set`);
    return set.marks;
};

export const RUNTIME: [name: string, fn: RuntimeFn][] = [
    ["coroutine-create", (ctx, executor, regs, start) => executor.coCreate(ctx, regs[start])],
    ["coroutine-status", (ctx, executor, regs, start) => executor.coStatus(regs[start])],
    ["coroutine-close", (ctx, executor, regs, start) => { executor.coClose(ctx, regs[start]); }],
    ["wind", (ctx, executor, regs, start) => { ctx.wind = new WindPoint(ctx.wind, regs[start], regs[start + 1]); }],
    ["end-wind", (ctx) => { if (ctx.wind !== null) ctx.wind = ctx.wind.parent; }],
    ["end-escape", () => undefined],
    ["caught?", (ctx, executor, regs, start) => regs[start] instanceof Caught],
    ["caught-value", (ctx, executor, regs, start) => regs[start].error],
    ["make-caught", (ctx, executor, regs, start) => new Caught(regs[start])],
    ["handler-key", () => EXCEPTION_HANDLERS],
    ["values-cons", (ctx, executor, regs, start) => {
        const vals = regs[start + 1];
        return new MultipleValues([regs[start], ...(vals instanceof MultipleValues ? vals.values : [vals])]);
    }],
    ["values->list", (ctx, executor, regs, start, nargs) => valuesToList(regs, start, nargs)],
    ["list->values", (ctx, executor, regs, start, nargs) => listToValues(regs, start, nargs)],
    ["apply-args", (ctx, executor, regs, start, nargs) => applyArgsList(regs, start, nargs)],
    ["debug-frames", (ctx, executor, regs, start) => {
        const { frames, args } = debugTarget(ctx, regs, start);
        const level = typeof args[0] === "number" ? args[0] : 0;
        return Cons.fromArray(frames.slice(level).map(f => [f.name, f.pos?.file ?? false, f.pos?.line ?? false, f.pos?.col ?? false]));
    }],
    ["debug-traceback", (ctx, executor, regs, start) => {
        const { frames, args } = debugTarget(ctx, regs, start);
        const msg = typeof args[0] === "number" ? undefined : args.shift();
        const level = typeof args[0] === "number" ? args[0] : 0;
        return formatTraceback(frames.slice(level), tracebackMessage(msg));
    }],
    // Lua's truncation of multiple values to one: the first value, or <#void> for none
    ["first-value", (ctx, executor, regs, start) => {
        const val = regs[start];
        return val instanceof MultipleValues ? val.values[0] : val;
    }],
    // (%marks-first set key none) / (%marks->list set key): continuation-mark-set-first / ->list
    ["marks-first", (ctx, executor, regs, start) => markFirst(markSetArg("continuation-mark-set-first", regs[start]), regs[start + 1], regs[start + 2])],
    ["marks->list", (ctx, executor, regs, start) => Cons.fromArray(markValues(markSetArg("continuation-mark-set->list", regs[start]), regs[start + 1]))],
];

export const RUNTIME_IDX = new Map(RUNTIME.map(([name], idx) => [name, idx]));

// A host intrinsic that is not a leaf may return this instead of a value: the value is then (proc args ...), called as
// Scheme code (so it can yield, capture continuations and raise)
export class HostTail {
    constructor(readonly proc: any, readonly args: any[]) {}
}

export const hostTail = (proc: any, ...args: any[]): HostTail => new HostTail(proc, args);

// the functions of host intrinsics, by runtime index, called directly by AOT code
export const HOST_FNS: (((...args: any[]) => any) | undefined)[] = [];

export const addRuntimeOp = (name: string, fn: RuntimeFn): number => {
    if (RUNTIME_IDX.has(name)) throw new Error(`the runtime operation '${name}' is already registered`);
    const idx = RUNTIME.push([name, fn]) - 1;
    RUNTIME_FNS.push(fn);
    RUNTIME_IDX.set(name, idx);
    return idx;
};

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
                        const proc = resolveProc(regs, inst[ip++]);
                        const startReg = inst[ip++];
                        const nargs = inst[ip++];
                        const isTail = inst[ip++] !== 0;
                        if (isTail && frame.code.debug) frame.marks = recordTailMark(frame.marks, frame.mframe, tailName(proc));

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
                        if (isTail && frame.code.debug) frame.marks = recordTailMark(frame.marks, frame.mframe, tailName(regs[coReg]));
                        frame.ip = ip;
                        return executor.coResume(ctx, isTail ? frame.parent : frame, regs[coReg], listToArray(regs[listReg]), frame.marks, frame.mframe);
                    }
                    case OpCode.CALLRT: {
                        const fn = RUNTIME_FNS[frame.code.rt[inst[ip++]]];
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
                        if (isTail && frame.code.debug) frame.marks = recordTailMark(frame.marks, frame.mframe, tailName(proc));
                        frame.ip = ip;
                        return executor.apply(ctx, proc, frame, windowApplyArgs(regs, startReg, nargs), isTail);
                    }
                    case OpCode.CALLCC: {
                        const procReg = inst[ip++];
                        const isTail = inst[ip++] !== 0;
                        if (isTail && frame.code.debug) frame.marks = recordTailMark(frame.marks, frame.mframe, tailName(regs[procReg]));
                        frame.ip = ip;
                        return executor.callCC(ctx, regs[procReg], frame, isTail);
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
                    case OpCode.RAISE: {
                        const objReg = inst[ip++];
                        const continuable = inst[ip++] !== 0;
                        frame.ip = ip;
                        return executor.raise(ctx, frame, regs[objReg], continuable);
                    }
                    case OpCode.CURSTACK: {
                        const skip = inst[ip++];
                        frame.ip = ip;
                        ctx.acc = new StackSnapshot(frameInfos(frame, skip));
                        break;
                    }
                    case OpCode.CALLHOST: {
                        const fn = RUNTIME_FNS[frame.code.rt[inst[ip++]]];
                        const startReg = inst[ip++];
                        const nargs = inst[ip++];
                        const isTail = inst[ip++] !== 0;
                        frame.ip = ip;
                        const res = fn(ctx, executor, regs, startReg, nargs);
                        if (res instanceof HostTail) return executor.invoke(ctx, res.proc, frame, res.args, 0, res.args.length, isTail);
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

const JIT_DEPS = {
    IBUILTINS,
    markSet,
    recordTailMark,
    tailName,
    ContinuationMarkSet,
    MultipleValues,
    unpackForBinding,
    restValues,
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
    Env,
    Frame,
    Suspend,
    EscapeContinuation,
    countControlSuspend,
    StackSnapshot,
    frameInfos,
    HOST_FNS,
    HostTail,
    CatchToken,
    Caught,
    catchHere,
    markFirst,
    EXCEPTION_HANDLERS,
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
    | { k: "RtCall"; rt: number; dst: number; start: number; nargs: number }
    | { k: "Unpack"; src: number; start: number; count: number; flags: number }
    | { k: "SetMark"; key: number; val: number }
    | { k: "MarkSave" | "MarkRestore"; reg: number }
    | { k: "CurMarks"; dst: number });

type AotTerm = { at?: number } & (
    // `escape` jumps leave a %block early; `loopBack` jumps close a %loop
    | { k: "Jump"; target: number; escape?: boolean; loopBack?: boolean }
    | { k: "Block" | "Loop"; body: number; end: number }
    | { k: "Branch"; cond: number; then: number; else: number }
    | { k: "Call"; proc: number; start: number; nargs: number; resume: number }
    | { k: "TailCall"; proc: number; start: number; nargs: number; ip: number }
    | { k: "MaybeSelfTailCall"; proc: number; start: number; nargs: number; ip: number; numPos: number; hasRest: boolean }
    | { k: "Apply"; proc: ProcRef; isTail: boolean; start: number; nargs: number; resume: number }
    | { k: "CallCC"; proc: number; isTail: boolean; resume: number }
    | { k: "CallEC"; proc: number; tok: number; resume: number }
    | { k: "CallCatch"; proc: number; tok: number; pre: number; resume: number }
    | { k: "Raise"; obj: number; continuable: boolean; resume: number }
    | { k: "CurStack"; skip: number; resume: number }
    | { k: "HostCall"; rt: number; start: number; nargs: number; isTail: boolean; resume: number }
    | { k: "Yield"; val: number; resume: number }
    | { k: "CoResume"; co: number; list: number; isTail: boolean; resume: number }
    | { k: "Return"; reg: number });

type AotBlock = { start: number; insts: AotInst[]; term: AotTerm };

const STRUCTURE_MISMATCH = Symbol("structure mismatch");

const MAX_STRUCTURED_NESTING = 250;

export class AotCompiler {
    public static run(ctx: ExecutionContext, initialFrame: Frame, executor: VMExecutor): any {
        let frame: Frame | null = initialFrame;

        // one try around the loop: any error ends the run
        try {
            if (frame.ip === 0 && frame.code.directArity === 0 && !frame.isShared(frame.ctx)) frame = this.#runDirect(frame, executor);
            while (frame !== null) {
                const frameCtx: ExecutionContext = frame.ctx;
                frame = executor.enter(frameCtx, frame);
                const resumeFn = frame.code.resumeFn ?? this.compile(frame.code, frame.closure.tmpl);
                frame = resumeFn(frameCtx, frame, executor);
            }
        } catch (err) {
            throw err instanceof EscapedError ? err.error : err;
        }

        return ctx.acc;
    }

    // a fresh zero-argument frame (top-level code) runs through its direct entry, falling back to heap frames on a Suspend
    static #runDirect(frame: Frame, executor: VMExecutor): Frame | null {
        const ctx = frame.ctx;
        let val;
        try {
            val = frame.code.directFn!(ctx, frame.closure, executor, 1, frame.marks, frame.mframe);
        } catch (e) {
            if (!(e instanceof Suspend)) throw e;
            if (frame.parent !== null) e.push(frame.parent);
            return executor.resumeSuspend(ctx, e);
        }
        return executor.setRetVal(ctx, frame.parent, val);
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

    // generated source of shared instruction arrays: copies of a ByteCode (ByteCode.fresh) only build their own functions
    static readonly #sources = new WeakMap<Uint32Array, string>();

    public static generateFunction(code: ByteCode, tmpl?: ClosureTemplate): { resume: ResumeFn, direct: DirectFn | null } {
        let source = this.#sources.get(code.inst);
        if (source === undefined) {
            source = this.generateSource(code, tmpl);
            if (SHARED_INSTS.has(code.inst)) this.#sources.set(code.inst, source);
        }
        const globalCache: Record<number, { scope: Env | null, version: number, value: any }> = {};
        for (const ip of this.#globalLoads(code)) globalCache[ip] = { scope: null, version: -1, value: undefined };
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
            out.emitFunction(tmpl.params.length + (tmpl.remParams !== null ? 1 : 0), tmpl.remParams !== null);
            direct = out.toString();
        }
        const caches = this.#globalLoads(code).map(ip => `const GC${ip} = GLOBAL_CACHE[${ip}];\n`).join("");
        return `${caches}return {\nresume: ${resume.toString()},\ndirect: ${direct}\n};`;
    }

    static #globalLoads(code: ByteCode): number[] {
        const ips: number[] = [];
        for (let ip = 0; ip < code.inst.length; ip += INSTRUCTION_LENGTHS[code.inst[ip] as OpCode]) {
            if (code.inst[ip] === OpCode.LOADGLOBAL) ips.push(ip);
        }
        return ips;
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
                case OpCode.BLOCK:
                case OpCode.LOOP:
                case OpCode.ENDLOOP:
                case OpCode.JUMP:
                    blocks.add(nextIp);
                    blocks.add(inst[ip + 1]);
                    break;
                case OpCode.COYIELD:
                case OpCode.CALLEC:
                case OpCode.CALLCATCH:
                case OpCode.RAISE:
                case OpCode.CURSTACK:
                    blocks.add(nextIp);
                    break;
                case OpCode.CALL:
                    if (inst[nextIp - 1] === 0 && inst[ip + 1] < BUILTINS_START) blocks.add(nextIp);
                    break;
                case OpCode.APPLY:
                case OpCode.CALLCC:
                case OpCode.CORESUME:
                case OpCode.CALLHOST:
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
                    case OpCode.BLOCK:
                    case OpCode.LOOP: {
                        const end = inst[ip++];
                        term = { k: opcode === OpCode.BLOCK ? "Block" : "Loop", body: ip, end };
                        break;
                    }
                    case OpCode.ENDLOOP:
                        term = { k: "Jump", target: inst[ip++], loopBack: true };
                        break;
                    case OpCode.JUMP:
                        term = { k: "Jump", target: inst[ip++], escape: true };
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
                    case OpCode.UNPACK:
                        insts.push({ k: "Unpack", src: inst[ip++], start: inst[ip++], count: inst[ip++], flags: inst[ip++] });
                        break;
                    case OpCode.SETMARK:
                        insts.push({ k: "SetMark", key: inst[ip++], val: inst[ip++] });
                        break;
                    case OpCode.MARKSAVE:
                        insts.push({ k: "MarkSave", reg: inst[ip++] });
                        break;
                    case OpCode.MARKRESTORE:
                        insts.push({ k: "MarkRestore", reg: inst[ip++] });
                        break;
                    case OpCode.CURMARKS:
                        insts.push({ k: "CurMarks", dst: inst[ip++] });
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
                        insts.push({ k: "RtCall", rt: code.rt[inst[ip++]], dst: inst[ip++], start: inst[ip++], nargs: inst[ip++] });
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
                    case OpCode.CALLEC: {
                        const proc = inst[ip++];
                        term = { k: "CallEC", proc, tok: inst[ip++], resume: ip };
                        break;
                    }
                    case OpCode.CALLCATCH: {
                        const proc = inst[ip++];
                        const tok = inst[ip++];
                        term = { k: "CallCatch", proc, tok, pre: inst[ip++], resume: ip };
                        break;
                    }
                    case OpCode.RAISE: {
                        const obj = inst[ip++];
                        term = { k: "Raise", obj, continuable: inst[ip++] !== 0, resume: ip };
                        break;
                    }
                    case OpCode.CURSTACK:
                        term = { k: "CurStack", skip: inst[ip++], resume: ip };
                        break;
                    case OpCode.CALLHOST: {
                        const rt = code.rt[inst[ip++]];
                        const start = inst[ip++];
                        const nargs = inst[ip++];
                        term = { k: "HostCall", rt, start, nargs, isTail: inst[ip++] !== 0, resume: ip };
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
    readonly #writtenSet: Set<number>;
    readonly liveIn: Map<number, Set<number>>;
    readonly entryLive: Set<number>;

    constructor(blocks: AotBlock[], numReg: number) {
        this.written = Liveness.#writtenRegs(blocks, numReg);
        this.#writtenSet = new Set(this.written);
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
        for (const r of this.liveIn.get(resume) ?? []) if (this.#writtenSet.has(r)) regs.add(r);
        return [...regs].sort((a, b) => a - b);
    }

    static #resumePoint(term: AotTerm): number | null {
        switch (term.k) {
            case "Call": case "Apply": case "CallCC": case "CallEC": case "CallCatch": case "Raise": case "CurStack": case "Yield": case "CoResume": return term.resume;
            case "HostCall": return term.isTail ? null : term.resume;
            default: return null;
        }
    }

    static #writtenRegs(blocks: AotBlock[], numReg: number): number[] {
        const written = new Set<number>();
        for (const block of blocks) {
            for (const inst of block.insts) {
                for (const r of Liveness.#instDefs(inst)) written.add(r);
            }
            const term = block.term;
            if (term.k === "MaybeSelfTailCall") {
                for (let i = 0; i < term.numPos + (term.hasRest ? 1 : 0); i++) written.add(i);
            }
            if (term.k === "CallEC" || term.k === "CallCatch") written.add(term.tok);
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
            case "Unpack": return [inst.src];
            case "SetMark": return [inst.key, inst.val];
            case "MarkRestore": return [inst.reg, inst.reg + 1];
            default: return [];
        }
    }

    // registers an instruction overwrites
    static #instDefs(inst: AotInst): number[] {
        if (inst.k === "Unpack") return windowRegs(inst.start, inst.count + ((inst.flags & UNPACK_REST) !== 0 ? 1 : 0));
        if (inst.k === "MarkSave") return [inst.reg, inst.reg + 1];
        return "dst" in inst && inst.k !== "SetBox" ? [inst.dst] : [];
    }

    static #termUses(term: AotTerm): number[] {
        switch (term.k) {
            case "Branch": return [term.cond];
            case "Call": case "TailCall": case "MaybeSelfTailCall": return [term.proc, ...windowRegs(term.start, term.nargs)];
            case "Apply": return [...("reg" in term.proc ? [term.proc.reg] : []), ...windowRegs(term.start, term.nargs)];
            case "CallCC": return [term.proc];
            case "CallEC": return [term.proc];
            case "CallCatch": return term.pre === NO_REG ? [term.proc] : [term.proc, term.pre];
            case "Raise": return [term.obj];
            case "HostCall": return windowRegs(term.start, term.nargs);
            case "Yield": return [term.val];
            case "CoResume": return [term.co, term.list];
            case "Return": return [term.reg];
            default: return [];
        }
    }

    static #successors(term: AotTerm): number[] {
        switch (term.k) {
            case "Jump": return [term.target];
            case "Block": case "Loop": return [term.body];
            case "Branch": return [term.then, term.else];
            case "Call": case "CallEC": case "CallCatch": case "Raise": case "CurStack": case "Yield": return [term.resume];
            case "Apply": case "CallCC": case "CoResume": case "HostCall": return term.isTail ? [] : [term.resume];
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
                    for (const r of Liveness.#instDefs(inst)) live.delete(r);
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

const MAX_INDENT = 16;
const INDENTS = Array.from({ length: MAX_INDENT + 1 }, (_, i) => "    ".repeat(i));

// accumulates generated js, re-indenting it by brace depth
export class CodeEmitter {
    private lines: string[] = [];
    private depth: number = 0;
    // deeper code is not indented further: indenting by depth makes the output quadratic in deeply nested code

    emit(str: string): void {
        const rawLines = str.split("\n");
        for (const raw of rawLines) {
            const trimmed = raw.trim();
            if (!trimmed) continue;

            let lineDepth = this.depth;
            if (trimmed.startsWith("}") || trimmed.startsWith("]")) {
                lineDepth = Math.max(0, this.depth - 1);
            }

            this.lines.push(INDENTS[Math.min(lineDepth, MAX_INDENT)] + trimmed);

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
        return `${this.debugPos(x.at + 1)}${tailProc !== undefined ? ` ${this.marksVar} = recordTailMark(${this.marksVar}, ${this.mframeVar}, tailName(${tailProc}));` : ""}`;
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

    // the check that one more nested direct call is allowed (as `&& ...`)
    protected abstract readonly depthCheck: string;

    // where the running function's continuation marks and logical frame are
    protected abstract readonly marksVar: string;
    protected abstract readonly mframeVar: string;

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
        return `ip = ${target}; continue top;`;
    }

    protected branch(term: Extract<AotTerm, { k: "Branch" }>, next: number): string {
        if (term.then === next) return `if (!isTruthy(r${term.cond})) { ${this.jump(term.else, -1)} }`;
        return `ip = isTruthy(r${term.cond}) ? ${term.then} : ${term.else}; continue top;`;
    }

    protected procExpr(proc: ProcRef): string {
        return "reg" in proc ? `r${proc.reg}` : `IBUILTINS[${proc.builtin}]`;
    }

    protected directGuard(proc: string, nargs: string): string {
        return `${proc} instanceof Closure && ${proc}.tmpl.code.directArity === ${nargs}${this.depthCheck}`;
    }

    protected restGuard(proc: string, nargs: string): string {
        return `${proc} instanceof Closure && ${proc}.tmpl.code.directRestArity !== -1 && ${nargs} >= ${proc}.tmpl.code.directRestArity${this.depthCheck}`;
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
                        const cache = GC${inst.ip};
                        if (cache.scope === ctx.scope && cache.version === Env.globalsVersion) {
                            r${inst.dst} = cache.value;
                        } else {
                            const val = ctx.scope.lookup(CONSTANTS[${inst.sym}], MISSING);
                            if (val === MISSING) {
                                ${this.recordIp(inst.ip)}
                                throw new MissingVarError("Variable '" + String(CONSTANTS[${inst.sym}]) + "' is not defined in the current scope.");
                            }
                            ctx.scope.watch();
                            cache.scope = ctx.scope;
                            cache.version = Env.globalsVersion;
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
            case "SetMark":
                return this.emit(`${this.marksVar} = markSet(${this.marksVar}, ${this.mframeVar}, r${inst.key}, r${inst.val});`);
            case "MarkSave":
                return this.emit(`r${inst.reg} = ${this.marksVar}; r${inst.reg + 1} = ${this.mframeVar}; ${this.mframeVar}++;`);
            case "MarkRestore":
                return this.emit(`${this.marksVar} = r${inst.reg}; ${this.mframeVar} = r${inst.reg + 1};`);
            case "CurMarks":
                return this.emit(`r${inst.dst} = new ContinuationMarkSet(${this.marksVar});`);
            case "Unpack": {
                const moves = Array.from({ length: inst.count }, (_, i) => `r${inst.start + i} = tmp[${i}];`);
                if ((inst.flags & UNPACK_REST) !== 0) moves.push(`r${inst.start + inst.count} = restValues(tmp, ${inst.count});`);
                return this.emit(`tmp = unpackForBinding(r${inst.src}, ${inst.count}, ${inst.flags}); ${moves.join(" ")}`);
            }
            case "RtCall": {
                const slow = this.windowCall(`RUNTIME_FNS[${inst.rt}]`, inst.start, inst.nargs, true);
                const inline = RUNTIME_INLINES.get(RUNTIME[inst.rt][0])?.(windowRegs(inst.start, inst.nargs).map(r => `r${r}`), slow, "tmp");
                return this.emit(`r${inst.dst} = ${inline ?? slow};`);
            }
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

    // an expression calling a host intrinsic: its inline template, whose fallback is a direct call of its function
    protected hostCall(rt: number, start: number, nargs: number): string {
        const args = windowRegs(start, nargs).map(r => `r${r}`);
        const direct = `HOST_FNS[${rt}](${args.join(", ")})`;
        return RUNTIME_INLINES.get(RUNTIME[rt][0])?.(args, direct, "tmp") ?? direct;
    }

    // an expression computing a builtin call inline (see inline.ts), or null
    protected inlineBuiltin(builtin: number, start: number, nargs: number): string | null {
        const inline = BUILTIN_INLINES.get(Symbol.keyFor(IBUILTINS[builtin].name)!);
        if (inline === undefined) return null;
        return inline(windowRegs(start, nargs).map(r => `r${r}`), this.windowCall(`IBUILTINS[${builtin}].cb`, start, nargs), "tmp");
    }
}

// the frame-based entry the driver loop uses: registers live in locals and are spilled to frame.regs whenever control may leave
class ResumeEmitter extends FunctionEmitter {
    protected readonly accExpr = "ctx.acc";
    protected readonly endOfCode = "return null;";
    // resume functions run from the driver loop, at the base of the js stack
    protected readonly depthCheck = "";
    protected readonly marksVar = "frame.marks";
    protected readonly mframeVar = "frame.mframe";
    readonly #liveness: Liveness;

    constructor(blocks: AotBlock[], inst: Uint32Array, numReg: number, debug: boolean = false) {
        super(blocks, inst, numReg, debug);
        this.#liveness = new Liveness(blocks, numReg);
    }
    // follows jumps through empty blocks (left by loops and blocks) to where control really goes, saving dispatches
    #thread(target: number): number {
        if (this.debug) return target;
        const byStart = this.#blocksByStart ??= new Map(this.blocks.map(b => [b.start, b]));
        const seen: number[] = [];
        let end = target;
        for (let steps = 0; steps < this.blocks.length; steps++) {
            const known = this.#threaded.get(end);
            if (known !== undefined) {
                end = known;
                break;
            }
            const block = byStart.get(end);
            if (block === undefined || block.insts.length !== 0) break;
            const term = block.term;
            let next: number;
            if (term.k === "Jump") next = term.target;
            else if (term.k === "Block" || term.k === "Loop") next = term.body;
            else break;
            seen.push(end);
            end = next;
        }
        for (const start of seen) this.#threaded.set(start, end);
        return end;
    }

    #blocksByStart: Map<number, AotBlock> | null = null;
    readonly #threaded = new Map<number, number>();

    protected jump(target: number, next: number): string {
        return super.jump(this.#thread(target), next);
    }

    protected branch(term: Extract<AotTerm, { k: "Branch" }>, next: number): string {
        return super.branch({ ...term, then: this.#thread(term.then), else: this.#thread(term.else) }, next);
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
            try {
                ctx.acc = ${call};
            } catch (e) {
                if (!(e instanceof Suspend)) throw e;
                e.push(frame);
                return executor.resumeSuspend(ctx, e);
            }
        `;
    }

    // A tail call from heap code: through the callee's direct entry when it has one (the js stack does not grow, since
    // this returns right after), else a heap frame replacing this one. A Suspend out of the direct callee rebuilds its
    // frames on top of this frame's caller, as the call is a tail call.
    #tailCall(proc: string, args: string, nargs: string, heapCall: string): string {
        return `
            if (frame.code.tailSuspends < ${DIRECT_SUSPEND_LIMIT} && (${this.directGuard(proc, nargs)} || ${this.restGuard(proc, nargs)})) {
                let val;
                try {
                    val = ${proc}.tmpl.code.directArity !== -1
                        ? ${proc}.tmpl.code.directFn(ctx, ${proc}, executor, 1, frame.marks, frame.mframe${args === "" ? "" : ", " + args})
                        : executor.callDirectRest(ctx, ${proc}, [${args}], 1, frame.marks, frame.mframe);
                } catch (e) {
                    if (!(e instanceof Suspend)) throw e;
                    frame.code.tailSuspends++;
                    if (frame.parent !== null) e.push(frame.parent);
                    return executor.resumeSuspend(ctx, e);
                }
                return executor.setRetVal(ctx, frame.parent, val);
            }
            ${heapCall}
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
                    top: while (true) {
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
            case "Block":
            case "Loop":
                return this.emit(this.jump(term.body, next));
            case "Call":
                return this.emit(`
                    {
                        const proc = r${term.proc};
                        frame.ip = ${term.resume};
                        ${this.#spills(live.spillsFor(term.resume, windowRegs(term.start, term.nargs)))}
                        if (${this.directGuard("proc", `${term.nargs}`)}) {
                            ${this.#directCall(`proc.tmpl.code.directFn(ctx, proc, executor, 1, frame.marks, frame.mframe + 1${term.nargs > 0 ? ", " + this.argList(term.start, term.nargs) : ""})`)}
                        } else if (${this.restGuard("proc", `${term.nargs}`)}) {
                            ${this.#directCall(`executor.callDirectRest(ctx, proc, [${this.argList(term.start, term.nargs)}], 1, frame.marks, frame.mframe + 1)`)}
                        } else if (proc instanceof BuiltinFunction) {
                            ctx.acc = proc.cb(regs, ${term.start}, ${term.nargs});
                        } else {
                            return executor.invoke(ctx, proc, frame, regs, ${term.start}, ${term.nargs}, false);
                        }
                    }
                    ${this.jump(term.resume, next)}
                `);
            // the receiver gets a heap frame, so escapes from its body are jumps rather than js exceptions
            case "CallEC":
                return this.emit(`
                    r${term.tok} = new EscapeContinuation(ctx.id, ctx.wind, frame.code, ${term.tok});
                    frame.ip = ${term.resume};
                    ${this.#spills(live.spillsFor(term.resume, [term.tok]))}
                    return executor.invoke(ctx, r${term.proc}, frame, [r${term.tok}], 0, 1, false);
                `);
            case "CallCatch":
                return this.emit(`
                    r${term.tok} = new CatchToken(ctx.id, ctx.wind, frame.code, ${term.tok}${term.pre === NO_REG ? "" : `, r${term.pre}`});
                    frame.ip = ${term.resume};
                    ${this.#spills(live.spillsFor(term.resume, [term.tok]))}
                    return executor.callCatch(ctx, r${term.proc}, frame, r${term.tok});
                `);
            case "Raise":
                return this.emit(`
                    frame.ip = ${term.resume};
                    ${this.#spills(live.spillsFor(term.resume))}
                    return executor.raise(ctx, frame, r${term.obj}, ${term.continuable});
                `);
            case "CurStack":
                return this.emit(`
                    frame.ip = ${term.resume};
                    ctx.acc = new StackSnapshot(frameInfos(frame, ${term.skip}));
                    ${this.jump(term.resume, next)}
                `);
            case "HostCall":
                return this.emit(`
                    frame.ip = ${term.resume};
                    {
                        const res = ${this.hostCall(term.rt, term.start, term.nargs)};
                        if (res instanceof HostTail) {
                            ${term.isTail ? "" : this.#spills(live.spillsFor(term.resume))}
                            return executor.invoke(ctx, res.proc, frame, res.args, 0, res.args.length, ${term.isTail});
                        }
                        ctx.acc = res;
                        ${term.isTail ? "return executor.setRetVal(ctx, frame.parent, res);" : ""}
                    }
                    ${term.isTail ? "" : this.jump(term.resume, next)}
                `);
            case "TailCall":
                return this.emit(`
                    {
                        const proc = r${term.proc};
                        ${this.#tailCall("proc", this.argList(term.start, term.nargs), `${term.nargs}`, `
                            frame.ip = ${term.ip};
                            ${this.#spills(windowRegs(term.start, term.nargs))}
                            return executor.invoke(ctx, proc, frame, regs, ${term.start}, ${term.nargs}, true);
                        `)}
                    }
                `);
            case "MaybeSelfTailCall":
                return this.emit(`
                    {
                        const proc = r${term.proc};
                        if (proc === frame.closure && !frame.isShared(ctx)) {
                            ${this.selfMoves(term)}
                            ip = 0;
                            continue top;
                        }
                        ${this.#tailCall("proc", this.argList(term.start, term.nargs), `${term.nargs}`, `
                            frame.ip = ${term.ip};
                            ${this.#spills(windowRegs(term.start, term.nargs))}
                            return executor.invoke(ctx, proc, frame, regs, ${term.start}, ${term.nargs}, true);
                        `)}
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
                    return executor.coResume(ctx, ${term.isTail ? "frame.parent" : "frame"}, r${term.co}, listToArray(r${term.list}), frame.marks, frame.mframe);
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
    protected readonly depthCheck = " && depth < MAX_JS_DEPTH";
    protected readonly marksVar = "marks";
    protected readonly mframeVar = "mframe";
    // this function's own arity, when a call to its own closure can call it by name (no rest parameter)
    #selfArity = -1;
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

    emitFunction(arity: number, hasRest: boolean = false): void {
        this.#selfArity = hasRest ? -1 : arity;
        const params = Array.from({ length: arity }, (_, i) => `, a${i}`).join("");
        const locals = Array.from({ length: this.numReg }, (_, i) => i < arity ? `r${i} = a${i}` : `r${i}`);
        const allRegs = Array.from({ length: this.numReg }, (_, i) => `r${i}`).join(", ");
        this.emit(`
            function direct$(ctx, closure, executor, depth, marks, mframe${params}) {
                const upvars = closure.upvars;
                let ip = 0, rip = 0, acc, tmp${this.debug ? ", dip = 0" : ""};
                ${locals.length > 0 ? `let ${locals.join(", ")};` : ""}
                try {
        `);
        const structured = this.#structuredBody();
        if (structured !== null) {
            this.emit(`
                    top: for (;;) {
                        ${structured}
                        return undefined;
                    }
            `);
        } else {
            this.emit(`
                    top: while (true) {
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
                    sig.entered = closure;
                    if (rip === -1) {
                        if (sig.innermost === null && sig.marks === undefined) {
                            sig.marks = marks;
                            sig.mframe = mframe;
                        }
                    } else {
                        const f = new Frame(closure, [${allRegs}], rip, null, ctx, marks, mframe);
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
        body.#selfArity = this.#selfArity;
        const index = new Map(this.blocks.map((b, i) => [b.start, i]));
        try {
            body.#walk(index, 0, this.inst.length);
        } catch (e) {
            if (e === STRUCTURE_MISMATCH) return null;
            throw e;
        }
        return body.toString();
    }

    readonly #blockLabels = new Map<number, string>();

    // how deeply the structured code nests so far; V8 fails to compile js nested thousands of levels deep, so past
    // MAX_STRUCTURED_NESTING the direct entry falls back to switch dispatch
    #nesting = 0;

    #walk(index: Map<number, number>, from: number, stop: number): void {
        const { blocks, inst } = this;
        let i = index.get(from);
        if (i === undefined) throw STRUCTURE_MISMATCH;
        if (++this.#nesting > MAX_STRUCTURED_NESTING) throw STRUCTURE_MISMATCH;
        try {
            this.#walkRegion(index, i, stop);
        } finally {
            this.#nesting--;
        }
    }

    #walkRegion(index: Map<number, number>, first: number, stop: number): void {
        const { blocks, inst } = this;
        let i: number | undefined = first;
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
            if (term.k === "Block" || term.k === "Loop") {
                if (term.body !== next) throw STRUCTURE_MISMATCH;
                if (term.k === "Block") {
                    // escapes to the block's end become `break` of a label unique to this block
                    const label = `B${block.start}`;
                    const outer = this.#blockLabels.get(term.end);
                    this.#blockLabels.set(term.end, label);
                    this.emit(`${label}: {`);
                    this.#walk(index, term.body, term.end);
                    this.emit(`}`);
                    if (outer === undefined) this.#blockLabels.delete(term.end);
                    else this.#blockLabels.set(term.end, outer);
                } else {
                    this.emit(`for (;;) {`);
                    this.#walk(index, term.body, term.end);
                    this.emit(`}`);
                }
                if (term.end >= stop) return;
                i = index.get(term.end);
                if (i === undefined) throw STRUCTURE_MISMATCH;
                continue;
            }
            if (term.k === "Jump") {
                if (term.escape) {
                    const label = this.#blockLabels.get(term.target);
                    if (label === undefined) throw STRUCTURE_MISMATCH;
                    this.emit(`break ${label};`);
                    i++;
                    continue;
                }
                // the back edge closing the loop being walked: the js for loop repeats by itself
                if (term.loopBack) return;
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
                const val = ${proc}.tmpl.code.directFn(ctx, ${proc}, executor, depth + 1, marks, mframe${nargs > 0 ? ", " + args : ""});
                return val;
            }
            if (${this.restGuard(proc, `${nargs}`)}) {
                const val = executor.callDirectRest(ctx, ${proc}, [${args}], depth + 1, marks, mframe);
                return val;
            }
            if (${proc} instanceof BuiltinFunction) return ${proc}.cb([${args}], 0, ${nargs});
            throw Suspend.invoke(${proc}, [${args}]);
        `;
    }

    // calls `proc` with the array `args` (both in scope), leaving the value in acc, or returning it for a tail call
    #callArray(isTail: boolean): string {
        const done = isTail ? "return" : "acc =";
        const frameArg = isTail ? "mframe" : "mframe + 1";
        return `
            if (proc instanceof BuiltinFunction) {
                ${done} proc.cb(args, 0, args.length);
            } else if (${this.directGuard("proc", "args.length")}) {
                ${done} executor.callDirect(ctx, proc, args, depth + 1, marks, ${frameArg});
            } else if (${this.restGuard("proc", "args.length")}) {
                ${done} executor.callDirectRest(ctx, proc, args, depth + 1, marks, ${frameArg});
            } else {
                throw Suspend.invoke(proc, args);
            }
        `;
    }

    #call(procReg: number, start: number, nargs: number, resume: number, marksExpr: string = "marks"): string {
        const args = this.argList(start, nargs);
        return `
            {
                const proc = r${procReg};
                rip = ${resume};
                ${nargs === this.#selfArity ? `if (proc === closure && depth < MAX_JS_DEPTH) {
                    acc = direct$(ctx, proc, executor, depth + 1, ${marksExpr}, mframe + 1${nargs > 0 ? ", " + args : ""});
                } else ` : ""}if (${this.directGuard("proc", `${nargs}`)}) {
                    acc = proc.tmpl.code.directFn(ctx, proc, executor, depth + 1, ${marksExpr}, mframe + 1${nargs > 0 ? ", " + args : ""});
                } else if (${this.restGuard("proc", `${nargs}`)}) {
                    acc = executor.callDirectRest(ctx, proc, [${args}], depth + 1, ${marksExpr}, mframe + 1);
                } else if (proc instanceof BuiltinFunction) {
                    acc = proc.cb([${args}], 0, ${nargs});
                } else {
                    throw Suspend.invoke(proc, [${args}]);
                }
            }
        `;
    }

    protected emitTerm(term: AotTerm, next: number): void {
        if (this.debug) this.emit(this.debugHooks(term, this.tailProcOf(term)));
        switch (term.k) {
            case "Jump":
                return this.emit(this.jump(term.target, next));
            case "Branch":
                return this.emit(this.branch(term, next));
            case "Block":
            case "Loop":
                return this.emit(this.jump(term.body, next));
            case "Call":
                return this.emit(`
                    ${this.#call(term.proc, term.start, term.nargs, term.resume)}
                    ${this.jump(term.resume, next)}
                `);
            case "CallEC":
                // escapes that need no unwinding end here; others go on out and find this frame once it is rebuilt
                return this.emit(`
                    r${term.tok} = new EscapeContinuation(ctx.id, ctx.wind, closure.tmpl.code, ${term.tok});
                    try {
                        ${this.#call(term.proc, term.tok, 1, term.resume)}
                    } catch (e) {
                        const own = e instanceof Suspend && e.escape === r${term.tok};
                        if (own) countControlSuspend(closure.tmpl.code);
                        if (!own || ctx.wind !== r${term.tok}.wind) throw e;
                        acc = e.escapeVal;
                    }
                    ${this.jump(term.resume, next)}
                `);
            case "CallCatch":
                return this.emit(`
                    r${term.tok} = new CatchToken(ctx.id, ctx.wind, closure.tmpl.code, ${term.tok}${term.pre === NO_REG ? "" : `, r${term.pre}`});
                    try {
                        const handlers = markSet(marks, mframe + 1, EXCEPTION_HANDLERS, new Cons(r${term.tok}, markFirst(marks, EXCEPTION_HANDLERS, null)));
                        ${this.#call(term.proc, 0, 0, term.resume, "handlers")}
                    } catch (e) {
                        const caught = catchHere(e, r${term.tok}, ctx);
                        if (caught === null) throw e;
                        countControlSuspend(closure.tmpl.code);
                        acc = caught;
                    }
                    ${this.jump(term.resume, next)}
                `);
            case "Raise":
                return this.emit(`
                    rip = ${term.resume};
                    throw Suspend.raise(r${term.obj}, ${term.continuable}, marks);
                `);
            case "CurStack":
                return this.emit(`
                    rip = ${term.resume};
                    throw Suspend.stack(${term.skip});
                `);
            case "HostCall":
                return this.emit(`
                    {
                        rip = ${term.isTail ? -1 : term.resume};
                        const res = ${this.hostCall(term.rt, term.start, term.nargs)};
                        if (res instanceof HostTail) {
                            const proc = res.proc, args = res.args;
                            ${this.#callArray(term.isTail)}
                        } else {
                            ${term.isTail ? "return res;" : "acc = res;"}
                        }
                    }
                    ${term.isTail ? "" : this.jump(term.resume, next)}
                `);
            case "TailCall":
                return this.emit(`{ const proc = r${term.proc}; ${this.#tailCall("proc", term.start, term.nargs)} }`);
            case "MaybeSelfTailCall":
                return this.emit(`
                    {
                        const proc = r${term.proc};
                        if (proc === closure) {
                            ${this.selfMoves(term)}
                            ip = 0;
                            continue top;
                        }
                        ${this.#tailCall("proc", term.start, term.nargs)}
                    }
                `);
            case "Apply": {
                return this.emit(`
                    {
                        const proc = ${this.procExpr(term.proc)};
                        const args = windowApplyArgs([${this.argList(term.start, term.nargs)}], 0, ${term.nargs});
                        rip = ${term.isTail ? -1 : term.resume};
                        ${this.#callArray(term.isTail)}
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
                        throw Suspend.resume(r${term.co}, listToArray(r${term.list}), marks, mframe);
                    `);
                }
                return this.emit(`
                    rip = ${term.resume};
                    // inside a coroutine, its frames must stay on the heap, where it can be traced while it waits
                    if (ctx.coroutine !== null || executor.nestedResumes >= MAX_NESTED_RESUMES || ++closure.tmpl.code.nestedResumes > ${DIRECT_SUSPEND_LIMIT}) throw Suspend.resume(r${term.co}, listToArray(r${term.list}), marks, mframe);
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
