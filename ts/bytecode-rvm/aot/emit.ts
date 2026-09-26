// JS code generation: the resume entry (heap frames) and the direct entry (no frames) of a function, and the AOT code
// of the core control operations (CONTROL_AOT)



import { Liveness, windowRegs } from "./liveness";
import { MAX_STRUCTURED_NESTING, STRUCTURE_MISMATCH } from "./types";
import type { AotBlock, AotInst, AotTerm } from "./types";
import type { Arity } from "../arity";
import { CORE_COUNT } from "../coreops";
import { OpCode } from "../interpreter";
import type { Intrinsic, Intrinsics } from "../intrinsics";
import { INSTRUCTION_LENGTHS, NO_REG, UNPACK_REST } from "../opcodes";
import { DIRECT_SUSPEND_LIMIT } from "../values";

export const MAX_INDENT = 16;
export const INDENTS = Array.from({ length: MAX_INDENT + 1 }, (_, i) => "    ".repeat(i));

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
// the `d` an intrinsic's inline template gets: the local names of its deps, where a name it did not declare is an error
// the `d` an intrinsic's inline template gets: the local names of its deps (recorded in `used`, as only those are set up),
// where a name it did not declare is an error
export const inlineDeps = (entry: Intrinsic, used: Set<string>): Readonly<Record<string, string>> => new Proxy(entry.deps, {
    get(target, key) {
        if (typeof key !== "string") return undefined;
        if (!Object.hasOwn(target, key)) throw new Error(`the inline template of '${entry.name}' uses '${key}', which is not in its deps`);
        used.add(target[key]);
        return target[key];
    },
});

// AOT code for the core control operations: what carrying out their requests does (see ControlRequest), written out at
// the call so there is no request to make and dispatch on, which shows in tight coroutine and call/cc loops. The
// interpreter carries out the requests themselves. `args` are the arguments' registers (as js expressions): the count
// was checked when compiling.
//  - heap: resume code, after frame.ip is set (and, unless in tail position or `continues`, the live registers are
//    spilled): statements that return the frame to run next, or with `continues`, set ctx.acc and carry on
//  - direct: direct code, after rip is set: statements that throw a Suspend, or set acc (return it, in tail position),
//    or declare `proc` and `args` and then run `callArray`, which calls proc with args (see DirectEmitter.#callArray)
//  - tailProc: in tail position, the first argument is what debug code records as the tail call
export type ControlSite = { args: string[], isTail: boolean };
export type ControlAot = {
    heap: (s: ControlSite) => string,
    direct: (s: ControlSite, callArray: string) => string,
    continues?: boolean,
    tailProc?: boolean,
};
export const valuesOf = (args: string[]) => args.length === 1 ? args[0] : `packValues([${args.join(", ")}])`;
export const resumeArgs = (name: string, args: string[]) => name === "%coroutine-resume" ? `[${args.slice(1).join(", ")}]` : `listToArray(${args[1]})`;
export const applyArgsOf = (name: string, args: string[]) => {
    const rest = args.slice(1);
    const window = `[${rest.join(", ")}], 0, ${rest.length}`;
    return name === "%apply-list" ? `windowApplyArgs(${window})` : `restArrayArgs(${window}, ${name === "%apply-array-multi"})`;
};
export const CONTROL_AOT: ReadonlyMap<string, ControlAot> = new Map<string, ControlAot>([
    ["%call/cc", {
        heap: s => `return executor.callCC(ctx, ${s.args[0]}, frame, ${s.isTail});`,
        direct: s => `throw Suspend.callCC(${s.args[0]});`,
        tailProc: true,
    }],
    ...["%coroutine-yield", "%coroutine-yield-list"].map((name): [string, ControlAot] => {
        const val = (s: ControlSite) => name === "%coroutine-yield" ? valuesOf(s.args) : `listToValues([${s.args[0]}], 0, 1)`;
        return [name, { heap: s => `return executor.coYield(ctx, frame, ${val(s)});`, direct: s => `throw Suspend.yield(${val(s)});` }];
    }),
    ...["%coroutine-resume", "%coroutine-resume-list"].map((name): [string, ControlAot] => [name, {
        heap: s => `return executor.coResume(ctx, ${s.isTail ? "frame.parent" : "frame"}, ${s.args[0]}, ${resumeArgs(name, s.args)}, frame.marks, frame.mframe);`,
        // inside a coroutine, its frames must stay on the heap, where it can be traced while it waits
        direct: s => s.isTail
            ? `throw Suspend.resume(${s.args[0]}, ${resumeArgs(name, s.args)}, marks, mframe);`
            : `if (ctx.coroutine !== null || executor.nestedResumes >= MAX_NESTED_RESUMES || ++closure.tmpl.code.nestedResumes > ${DIRECT_SUSPEND_LIMIT}) throw Suspend.resume(${s.args[0]}, ${resumeArgs(name, s.args)}, marks, mframe);
               acc = executor.coResumeNested(ctx, ${s.args[0]}, ${resumeArgs(name, s.args)});`,
        tailProc: true,
    }]),
    ["%raise", {
        heap: s => `return executor.raise(ctx, frame, ${s.args[0]}, ${s.args.length === 2 ? `raiseContinuable(${s.args[1]})` : "false"});`,
        direct: s => `throw Suspend.raise(${s.args[0]}, ${s.args.length === 2 ? `raiseContinuable(${s.args[1]})` : "false"}, marks);`,
    }],
    ["%current-stack", {
        heap: s => `ctx.acc = new StackSnapshot(frameInfos(frame, ${s.args.length === 1 ? `stackSkip(${s.args[0]})` : "0"}));`,
        direct: s => `throw Suspend.stack(${s.args.length === 1 ? `stackSkip(${s.args[0]})` : "0"});`,
        continues: true,
    }],
    ...["%apply-list", "%apply-array", "%apply-array-multi"].map((name): [string, ControlAot] => [name, {
        heap: s => `{ const args = ${applyArgsOf(name, s.args)}; return executor.invoke(ctx, ${s.args[0]}, frame, args, 0, args.length, ${s.isTail}); }`,
        direct: (s, callArray) => `{ const proc = ${s.args[0]}, args = ${applyArgsOf(name, s.args)}; ${callArray} }`,
        tailProc: true,
    }]),
]);

export abstract class FunctionEmitter extends CodeEmitter {
    constructor(
        protected readonly blocks: AotBlock[],
        protected readonly inst: Uint32Array,
        protected readonly numReg: number,
        protected readonly debug: boolean = false,
        // the table the code is bound to: its intrinsics are the hoisted locals I<pos>, their deps D<slot>
        protected readonly table: Intrinsics | null = null,
        // the deps' locals the inline templates used (shared by the emitters of one function)
        readonly usedDeps: Set<string> = new Set()
    ) {
        super();
    }

    // debug code only: statement recording the exact position of the op about to run
    protected abstract debugPos(ip: number): string;

    protected debugHooks(x: { at?: number }, tailProc?: string): string {
        if (!this.debug || x.at === undefined) return "";
        return `${this.debugPos(x.at + 1)}${tailProc !== undefined ? ` ${this.marksVar} = recordTailMark(${this.marksVar}, ${this.mframeVar}, tailName(${tailProc}));` : ""}`;
    }

    // debug code only: records a control request made in tail position as the tail call, as debugHooks does for a call
    protected tailMark(req: string): string {
        if (!this.debug) return "";
        return `if (${req}.tailProc !== undefined) ${this.marksVar} = recordTailMark(${this.marksVar}, ${this.mframeVar}, tailName(${req}.tailProc));`;
    }

    // the AOT code of a core control operation a CALLHOST calls, if it is one
    protected controlOf(term: Extract<AotTerm, { k: "HostCall" }>): ControlAot | undefined {
        return term.pos < CORE_COUNT ? CONTROL_AOT.get(this.table!.entries[term.pos].name) : undefined;
    }

    protected tailProcOf(term: AotTerm): string | undefined {
        if (term.k === "HostCall" && term.isTail && this.controlOf(term)?.tailProc) return `r${term.start}`;
        switch (term.k) {
            case "TailCall": case "MaybeSelfTailCall": return `r${term.proc}`;
            default: return undefined;
        }
    }

    abstract emitFunction(arity: Arity): void;

    protected abstract emitTerm(term: AotTerm, next: number): void;

    // a (regs, start, nargs)-style call of `fn` over the register window; runtime functions also take (ctx, executor) first
    // a call of `fn` over the register window (followed by ctx and executor for an intrinsic that takes the context)
    protected abstract windowCall(fn: string, start: number, nargs: number, withContext?: boolean): string;

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


    protected directGuard(proc: string, nargs: string): string {
        return `${proc} instanceof Closure && ${proc}.tmpl.code.directArity === ${nargs}${this.depthCheck}`;
    }

    protected restGuard(proc: string, nargs: string): string {
        return `${proc} instanceof Closure && ${proc}.tmpl.code.directRestArity !== -1 && ${nargs} >= ${proc}.tmpl.code.directRestArity${this.depthCheck}`;
    }

    protected selfMoves(term: Extract<AotTerm, { k: "MaybeSelfTailCall" }>): string {
        // as bindArgs, over registers held in js variables: the rest value first, then the positionals, moving down
        const { min, rest } = term.arity;
        const restRegs = Array.from({ length: term.nargs - min }, (_, i) => `r${term.start + min + i}`);
        const moves: string[] = [];
        if (rest === "array") moves.push(`const rest = [${restRegs.join(", ")}];`);
        if (rest === "list") moves.push(`const rest = ${restRegs.reduceRight((tail, reg) => `new Cons(${reg}, ${tail})`, "null")};`);
        for (let i = 0; i < min; i++) {
            if (term.start + i !== i) moves.push(`r${i} = r${term.start + i};`);
        }
        if (rest !== "none") moves.push(`r${min} = rest;`);
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
            case "IntCall":
                return this.emit(`r${inst.dst} = ${this.intrinsicCall(inst.pos, inst.start, inst.nargs)};`);
            case "IntApply": {
                const entry = this.table!.entries[inst.pos];
                return this.emit(`r${inst.dst} = applyIntrinsic(I${inst.pos}, ${JSON.stringify(entry.name)}, ${entry.min}, ${entry.max}, windowApplyArgs([${this.argList(inst.start, inst.nargs)}], 0, ${inst.nargs}), ctx, executor);`);
            }
            case "IntApplyRest": {
                // a rest array alone is the argument array itself: intrinsics never write to or keep it
                const entry = this.table!.entries[inst.pos];
                const args = inst.nargs === 1 ? `r${inst.start}` : `windowRestArgs([${this.argList(inst.start, inst.nargs)}], 0, ${inst.nargs}, false)`;
                return this.emit(`r${inst.dst} = applyIntrinsic(I${inst.pos}, ${JSON.stringify(entry.name)}, ${entry.min}, ${entry.max}, ${args}, ctx, executor);`);
            }
            default: {
                const _: never = inst;
            }
        }
    }

    // an expression calling the intrinsic at `pos`: its inline template, whose fallback is a call of its function over the
    // register window. A call that is the fast path goes through the hoisted local I<pos>, which V8 may inline; a template's
    // fallback goes through RT[pos], so V8 does not inline the function into the cold path (which slows the hot one)
    protected intrinsicCall(pos: number, start: number, nargs: number): string {
        const entry = this.table!.entries[pos];
        const direct = this.windowCall(`I${pos}`, start, nargs, entry.context);
        if (entry.inline === undefined) return direct;
        const inlined = entry.inline(windowRegs(start, nargs).map(r => `r${r}`), this.windowCall(`RT[${pos}]`, start, nargs, entry.context), "tmp", inlineDeps(entry, this.usedDeps));
        return inlined ?? direct;
    }

}

// the frame-based entry the driver loop uses: registers live in locals and are spilled to frame.regs whenever control may leave
export class ResumeEmitter extends FunctionEmitter {
    protected readonly accExpr = "ctx.acc";
    protected readonly endOfCode = "return null;";
    // resume functions run from the driver loop, at the base of the js stack
    protected readonly depthCheck = "";
    protected readonly marksVar = "frame.marks";
    protected readonly mframeVar = "frame.mframe";
    readonly #liveness: Liveness;

    constructor(blocks: AotBlock[], inst: Uint32Array, numReg: number, debug: boolean = false, table: Intrinsics | null = null, usedDeps: Set<string> = new Set()) {
        super(blocks, inst, numReg, debug, table, usedDeps);
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

    protected windowCall(fn: string, start: number, nargs: number, withContext: boolean = false): string {
        const spills = windowRegs(start, nargs).map(r => `regs[${r}] = r${r}`);
        return `(${[...spills, `${fn}(regs, ${start}, ${nargs}${withContext ? ", ctx, executor" : ""})`].join(", ")})`;
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
            case "HostCall": {
                const control = this.controlOf(term);
                if (control !== undefined) {
                    const site = { args: windowRegs(term.start, term.nargs).map(r => `r${r}`), isTail: term.isTail };
                    return this.emit(`
                        frame.ip = ${term.resume};
                        ${term.isTail || control.continues ? "" : this.#spills(live.spillsFor(term.resume))}
                        ${control.heap(site)}
                        ${control.continues ? this.jump(term.resume, next) : ""}
                    `);
                }
                return this.emit(`
                    frame.ip = ${term.resume};
                    {
                        const res = ${this.intrinsicCall(term.pos, term.start, term.nargs)};
                        if (res instanceof ControlRequest) {
                            ${term.isTail ? this.tailMark("res") : this.#spills(live.spillsFor(term.resume))}
                            return res.run(ctx, executor, frame, ${term.isTail});
                        }
                        ctx.acc = res;
                        ${term.isTail ? "return executor.setRetVal(ctx, frame.parent, res);" : ""}
                    }
                    ${term.isTail ? "" : this.jump(term.resume, next)}
                `);
            }
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
export class DirectEmitter extends FunctionEmitter {
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

    protected windowCall(fn: string, start: number, nargs: number, withContext: boolean = false): string {
        return `${fn}([${this.argList(start, nargs)}], 0, ${nargs}${withContext ? ", ctx, executor" : ""})`;
    }

    // the direct entry takes the parameters' values (the rest parameter's last) as js arguments
    emitFunction(closureArity: Arity): void {
        this.#selfArity = closureArity.rest === "none" ? closureArity.min : -1;
        const arity = closureArity.min + (closureArity.rest === "none" ? 0 : 1);
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
        const body = new DirectEmitter(this.blocks, this.inst, this.numReg, this.debug, this.table, this.usedDeps);
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

    // the labels of the if chains being walked, by the ip of their end
    readonly #chains = new Map<number, string>();

    // whether the else branch of the if ending at endIp starts an ELSEIF of the same chain (whose then branch ends with
    // ELSE endIp; a nested if's chain has its own end)
    #hasElseIf(elseIp: number, endIp: number): boolean {
        const inst = this.inst;
        for (let ip = elseIp; ip < endIp - 1; ip += INSTRUCTION_LENGTHS[inst[ip] as OpCode]) {
            if (inst[ip] !== OpCode.ELSEIF) continue;
            const target = inst[ip + 2];
            if (inst[target - 2] === OpCode.ELSE && inst[target - 1] === endIp) return true;
        }
        return false;
    }

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
                // a later clause of the chain being walked: a sibling of the first, leaving the chain's block when taken
                if (term.elseif) {
                    const chain = this.#chains.get(endIp);
                    if (chain === undefined) throw STRUCTURE_MISMATCH;
                    this.emit(`if (isTruthy(r${term.cond})) {`);
                    this.#walk(index, term.then, elseIp - 2);
                    this.emit(`break ${chain}; }`);
                    i = index.get(elseIp);
                    if (i === undefined) throw STRUCTURE_MISMATCH;
                    continue;
                }
                if (this.#hasElseIf(elseIp, endIp)) {
                    // a chain is flat: C: { if (c1) { e1; break C; } <c2> if (c2) { e2; break C; } ... else }
                    const chain = `C${block.start}`;
                    this.#chains.set(endIp, chain);
                    this.emit(`${chain}: {`);
                    this.emit(`if (isTruthy(r${term.cond})) {`);
                    this.#walk(index, term.then, elseIp - 2);
                    this.emit(`break ${chain}; }`);
                    this.#walk(index, elseIp, endIp - 1);
                    this.emit(`}`);
                    this.#chains.delete(endIp);
                } else {
                    this.emit(`if (isTruthy(r${term.cond})) {`);
                    this.#walk(index, term.then, elseIp - 2);
                    this.emit(`} else {`);
                    this.#walk(index, elseIp, endIp - 1);
                    this.emit(`}`);
                }
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
            throw Suspend.invoke(${proc}, [${args}]);
        `;
    }

    // calls `proc` with the array `args` (both in scope), leaving the value in acc, or returning it for a tail call
    #callArray(isTail: boolean): string {
        const done = isTail ? "return" : "acc =";
        const frameArg = isTail ? "mframe" : "mframe + 1";
        return `
            if (${this.directGuard("proc", "args.length")}) {
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
            case "HostCall": {
                const control = this.controlOf(term);
                if (control !== undefined) {
                    const site = { args: windowRegs(term.start, term.nargs).map(r => `r${r}`), isTail: term.isTail };
                    return this.emit(`
                        rip = ${term.isTail ? -1 : term.resume};
                        ${control.direct(site, this.#callArray(term.isTail))}
                        ${term.isTail ? "" : this.jump(term.resume, next)}
                    `);
                }
                return this.emit(`
                    {
                        rip = ${term.isTail ? -1 : term.resume};
                        const res = ${this.intrinsicCall(term.pos, term.start, term.nargs)};
                        if (res instanceof HostTail) {
                            ${term.isTail ? this.tailMark("res") : ""}
                            const proc = res.proc, args = res.args;
                            ${this.#callArray(term.isTail)}
                        } else if (res instanceof ControlRequest) {
                            ${term.isTail ? this.tailMark("res") : ""}
                            ${term.isTail ? "return" : "acc ="} res.direct(ctx, executor, closure, marks, mframe, ${term.isTail});
                        } else {
                            ${term.isTail ? "return res;" : "acc = res;"}
                        }
                    }
                    ${term.isTail ? "" : this.jump(term.resume, next)}
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
                            continue top;
                        }
                        ${this.#tailCall("proc", term.start, term.nargs)}
                    }
                `);
            case "Return":
                return this.emit(`return r${term.reg};`);
            default: {
                const _: never = term;
            }
        }
    }
}
