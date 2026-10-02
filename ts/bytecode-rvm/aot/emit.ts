// JS code generation: the resume entry (heap frames) and the direct entry (no frames) of a function, and the AOT code
// of the core control operations (CONTROL_AOT)



import { Liveness, windowRegs } from "./liveness";
import { blockFacts, transfer, type Facts, type Aliases } from "./facts";
import { MAX_STRUCTURED_NESTING, STRUCTURE_MISMATCH } from "./types";
import type { AotBlock, AotInst, AotTerm } from "./types";
import type { Arity } from "../arity";
import { CORE_COUNT } from "../coreops";
import { Intrinsics, type Intrinsic, type Kind } from "../intrinsics";
import { OP_SIZE, UNPACK_REST, type Op } from "../ops";
import { DIRECT_SUSPEND_LIMIT } from "../values";

// where a function's instructions are, for the structured code of its direct entry: their positions and its size
export type Layout = { readonly ops: readonly Op[], readonly at: ReadonlyMap<number, Op>, readonly size: number };

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
// other requests carry themselves out (ControlRequest.run). `args` are the arguments' registers (as js expressions): the count
// was checked when compiling.
//  - heap: resume code, after frame.ip is set (and, unless in tail position or `continues`, the live registers are
//    spilled): statements that return the frame to run next, or with `continues`, set ctx.acc and carry on. `spills`
//    spills the live registers, for a `continues` operation that leaves the frame only sometimes
//  - direct: direct code, after rip is set: statements that throw a Suspend, or set acc (return it, in tail position),
//    or declare `proc` and `args` and then run `callArray`, which calls proc with args (see DirectEmitter.#callArray)
//    or `call`, which calls `proc` (in scope) with args, leaving its value in acc
//  - tailProc: in tail position, the first argument is what debug code records as the tail call
// `resume`: the ip after the call, which the emitter stores (frame.ip, rip) before the template unless `setsResume`;
// `loopCount`: in direct code, the call is at a loop's back-edge (its next instruction is EndLoop), where a function can
// count in its local `ic` (a loop there runs within one call of the function)
export type ControlSite = { args: string[], isTail: boolean, resume: number, loopCount: boolean };
export type ControlAot = {
    heap: (s: ControlSite, spills: string) => string,
    direct: (s: ControlSite, callArray: string, call: (args: string[], marks: string) => string) => string,
    continues?: boolean,
    tailProc?: boolean,
    // the template stores the resume point itself, only on a path that needs it
    setsResume?: boolean,
};
export const valuesOf = (args: string[]) => args.length === 1 ? args[0] : `packValues([${args.join(", ")}])`;
export const resumeArgs = (name: string, args: string[]) => name === "%coroutine-resume" ? `[${args.slice(1).join(", ")}]` : `arrayArg("%coroutine-resume-array", ${args[1]}).slice()`;
export const applyArgsOf = (name: string, args: string[]) => name === "%apply-fresh" ? `arrayArg("%apply", ${args[1]})` : `applyArgs([${args.slice(1).join(", ")}], 0, ${args.length - 1})`;
// counting an interrupt check in the function's local `ic` (see %interrupt below)
const LOOP_COUNT = "--ic < 0 && (ic = 255, (executor.interruptLeft -= 256) <= 0)";
export const CONTROL_AOT: ReadonlyMap<string, ControlAot> = new Map<string, ControlAot>([
    ["%call/cc", {
        heap: s => `return executor.callCC(ctx, ${s.args[0]}, frame, ${s.isTail});`,
        direct: s => `throw Suspend.callCC(${s.args[0]});`,
        tailProc: true,
    }],
    ["%call/ec", {
        heap: s => `return executor.callEscape(ctx, ${s.args[0]}, frame);`,
        direct: (s, callArray, call) => `{
            const tok = new EscapeContinuation(ctx.id, ctx.wind);
            try {
                const proc = ${s.args[0]};
                ${call(["tok"], "marks")}
            } catch (e) {
                if (!(e instanceof Suspend && e.escape === tok && ctx.wind === tok.wind)) throw executor.pushEscape(e, tok, marks, mframe);
                countControlSuspend(closure.tmpl.code);
                acc = e.escapeVal;
            }
        }`,
    }],
    ["%call-catching", {
        heap: s => `return executor.callCatch(ctx, ${s.args[0]}, frame, ${s.args[1] ?? "null"}, ${s.args.length === 3 ? `catchGuard(${s.args[2]})` : "false"});`,
        direct: (s, callArray, call) => `{
            const tok = new CatchToken(ctx.id, ctx.wind, ${s.args[1] ?? "null"}, ${s.args.length === 3 ? `catchGuard(${s.args[2]})` : "false"});
            const handlers = markSet(marks, mframe + 1, EXCEPTION_HANDLERS, new Handlers(tok, markFirst(marks, EXCEPTION_HANDLERS, null)));
            try {
                const proc = ${s.args[0]};
                ${call([], "handlers")}
            } catch (e) {
                const caught = catchHere(e, tok, ctx);
                if (caught === null) throw executor.pushEscape(e, tok, handlers, mframe);
                countControlSuspend(closure.tmpl.code);
                acc = caught;
            }
        }`,
    }],
    ["%coroutine-yield", { heap: s => `return executor.coYield(ctx, frame, ${valuesOf(s.args)});`, direct: s => `throw Suspend.yield(${valuesOf(s.args)});` }],
    ...["%coroutine-resume", "%coroutine-resume-array"].map((name): [string, ControlAot] => [name, {
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
    // An interrupt check: the count, and only when it runs out, the handler (see VMExecutor.interruptSlow). Heap code
    // counts every check. Direct code counts cheaply, as interrupts only have to come eventually:
    //  - at a loop's back-edge it counts in its local `ic`, taking 256 from the instance's count once every 256 rounds (a
    //    loop there runs within one call of the function)
    //  - at a function's entry it counts only at even depths: a call from an odd depth lands at an even one, so between
    //    counted checks runs at most about one function body (loops aside). A self tail call, which restarts the function
    //    at the same depth, counts in `ic` on its own path (see #selfTailCount); a tail call to another function passes
    //    depth + 1, so the depth alternates, and past the JS depth limit it goes on in heap code
    //  - the slow path is a call of its own (executor.interruptDirect): written into the function, it slows it even
    //    when it never runs
    ["%interrupt", {
        heap: (s, spills) => `if (--executor.interruptLeft <= 0) { frame.ip = ${s.resume}; const res = executor.interruptSlow(ctx); if (res !== undefined) { ${spills} return res.run(ctx, executor, frame, false); } }`,
        // (a pause or stop in direct code throws: nothing comes back to keep)
        direct: s => `if (${s.loopCount ? LOOP_COUNT : "(depth & 1) === 0 && --executor.interruptLeft <= 0"}) { rip = ${s.resume}; executor.interruptDirect(ctx, closure, marks, mframe); }`,
        continues: true,
        setsResume: true,
    }],
    ["%current-stack", {
        heap: s => `ctx.acc = new StackSnapshot(frameInfos(frame, ${s.args.length === 1 ? `stackSkip(${s.args[0]})` : "0"}));`,
        direct: s => `throw Suspend.stack(${s.args.length === 1 ? `stackSkip(${s.args[0]})` : "0"});`,
        continues: true,
    }],
    ...["%apply-array", "%apply-fresh"].map((name): [string, ControlAot] => [name, {
        heap: s => `{ const args = ${applyArgsOf(name, s.args)}; return executor.invoke(ctx, ${s.args[0]}, frame, args, 0, args.length, ${s.isTail}); }`,
        direct: (s, callArray) => `{ const proc = ${s.args[0]}, args = ${applyArgsOf(name, s.args)}; ${callArray} }`,
        tailProc: true,
    }]),
]);

export abstract class FunctionEmitter extends CodeEmitter {
    constructor(
        protected readonly blocks: AotBlock[],
        protected readonly layout: Layout,
        protected readonly numReg: number,
        protected readonly debug: boolean = false,
        // the table the code is bound to: its intrinsics are the hoisted locals I<pos>, their deps D<slot>
        protected readonly table: Intrinsics | null = null,
        // the deps' locals the inline templates used (shared by the emitters of one function)
        readonly usedDeps: Set<string> = new Set(),
        // the code's constants, for the type facts of the ones it loads
        protected readonly constants: readonly any[] = [],
    ) {
        super();
    }

    // what is known of the registers at the instruction being emitted (see facts.ts): set at each block's start
    protected facts: Facts = new Map();
    protected aliases: Aliases = new Map();

    protected startBlock(facts: Facts | undefined): void {
        this.facts = new Map(facts ?? []);
        this.aliases = new Map();
    }

    protected emitInstWithFacts(inst: AotInst): void {
        this.emitInst(inst);
        transfer(inst, this.facts, this.table, this.constants, this.aliases);
    }

    // a branch's condition: a known boolean as it is
    protected truthy(reg: number): string {
        return this.facts.get(reg) === "boolean" ? `r${reg}` : `(r${reg} !== false)`;
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

    // the AOT code of a core control operation a HostCall calls, if it is one
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

    // where the value of the last call is (read by MoveAcc)
    protected abstract readonly accExpr: string;

    // statement recording where to resume before an instruction that may throw (heap mode only)
    protected abstract recordIp(ip: number): string;

    protected abstract readonly endOfCode: string;

    // the check that one more nested direct call is allowed (as `&& ...`)
    protected abstract readonly depthCheck: string;
    // access/assignment to an upvar slot: in heap code reads the local `upvars`; in direct code reads hoisted `uv${idx}`
    protected abstract upvarRef(idx: number): string;
    protected abstract setUpvarExpr(idx: number, val: string): string;

    // where the running function's continuation marks and logical frame are
    protected abstract readonly marksVar: string;
    protected abstract readonly mframeVar: string;

    protected emitSwitchBody(): void {
        for (let i = 0; i < this.blocks.length; i++) {
            const next = i + 1 < this.blocks.length ? this.blocks[i + 1].start : this.layout.size;
            this.emit(`case ${this.blocks[i].start}: {`);
            this.startBlock(undefined);
            for (const inst of this.blocks[i].insts) this.emitInstWithFacts(inst);
            this.emitTerm(this.blocks[i].term, next);
            this.emit(`}`);
        }
    }

    protected argList(start: number, nargs: number): string {
        return windowRegs(start, nargs).map(r => `r${r}`).join(", ");
    }

    protected jump(target: number, next: number): string {
        if (target === next && target < this.layout.size) return "";
        if (target >= this.layout.size) return this.endOfCode;
        return `ip = ${target}; continue top;`;
    }

    protected branch(term: Extract<AotTerm, { k: "Branch" }>, next: number): string {
        if (term.then === next) return `if (!${this.truthy(term.cond)}) { ${this.jump(term.else, -1)} }`;
        return `ip = ${this.truthy(term.cond)} ? ${term.then} : ${term.else}; continue top;`;
    }


    protected directGuard(proc: string, nargs: string): string {
        return `${proc} instanceof Closure && (${proc}.tmpl.code.directArity === ${nargs} || ${proc}.tmpl.code.directPad)${this.depthCheck}`;
    }

    protected restGuard(proc: string, nargs: string): string {
        return `${proc} instanceof Closure && ${proc}.tmpl.code.directRestArity !== -1 && ${nargs} >= ${proc}.tmpl.code.directRestArity${this.depthCheck}`;
    }

    protected selfMoves(term: Extract<AotTerm, { k: "MaybeSelfTailCall" }>): string {
        // as bindArgs, over registers held in js variables: the rest value first, then the positionals, moving down
        // a padded closure's missing parameters are <#void>, its extra arguments dropped unless it has a rest parameter
        const { params: min, rest } = term.arity;
        const restRegs = Array.from({ length: Math.max(term.nargs - min, 0) }, (_, i) => `r${term.start + min + i}`);
        const moves: string[] = [];
        if (rest === "array") moves.push(`const rest = [${restRegs.join(", ")}];`);
        if (rest === "packed") moves.push(`const rest = ${this.intrinsicCall(term.restPos, term.start + min, term.nargs - min)};`);
        for (let i = 0; i < Math.min(min, term.nargs); i++) {
            if (term.start + i !== i) moves.push(`r${i} = r${term.start + i};`);
        }
        for (let i = term.nargs; i < min; i++) moves.push(`r${i} = undefined;`);
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
                return this.emit(`r${inst.dst} = ${this.upvarRef(inst.idx)}${inst.unbox ? ".val" : ""};`);
            case "SetUpvar":
                return this.emit(`${this.setUpvarExpr(inst.idx, inst.box ? `new Box(r${inst.src})` : `r${inst.src}`)};`);
            case "FixUpvar":
                return this.emit(`r${inst.clo}.upvars[${inst.idx}] = r${inst.src};`);
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
                                throw new MissingVarError(CONSTANTS[${inst.sym}]);
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
                const captures = inst.captures.map(c => c.local ? `r${c.index}` : this.upvarRef(c.index)).join(", ");
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
                // an array alone is the argument array itself: intrinsics never write to or keep it
                const entry = this.table!.entries[inst.pos];
                const args = inst.nargs === 1 ? `arrayArg("%apply", r${inst.start})` : `applyArgs([${this.argList(inst.start, inst.nargs)}], 0, ${inst.nargs})`;
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
        const regs = windowRegs(start, nargs);
        const known = regs.map(r => this.facts.get(r));
        // a declared result is also what the slow path gives, said so V8 keeps it unboxed through the template's branches
        const slow = this.windowCall(`RT[${pos}]`, start, nargs, entry.context);
        const result = Intrinsics.resultKind(entry, known);
        const typedSlow = result === undefined ? slow : result === "boolean" ? `!!${slow}` : this.table?.types?.coerce?.(result, slow) ?? slow;
        const inlined = entry.inline(regs.map(r => `r${r}`), typedSlow, "tmp", inlineDeps(entry, this.usedDeps), known);
        return inlined ?? direct;
    }

}

// the frame-based entry the driver loop uses: registers live in locals and are spilled to frame.regs whenever control may leave
export class ResumeEmitter extends FunctionEmitter {
    protected readonly accExpr = "ctx.acc";
    protected readonly endOfCode = "return null;";
    // resume functions run from the driver loop, at the base of the js stack
    protected readonly depthCheck = "";
    protected upvarRef(idx: number): string { return `upvars[${idx}]`; }
    protected setUpvarExpr(idx: number, val: string): string { return `upvars[${idx}] = ${val}`; }
    protected readonly marksVar = "frame.marks";
    protected readonly mframeVar = "frame.mframe";
    readonly #liveness: Liveness;

    constructor(blocks: AotBlock[], layout: Layout, numReg: number, debug: boolean = false, table: Intrinsics | null = null, usedDeps: Set<string> = new Set(), constants: readonly any[] = []) {
        super(blocks, layout, numReg, debug, table, usedDeps, constants);
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
            case "HostCall": {
                const control = this.controlOf(term);
                if (control !== undefined) {
                    const site = { args: windowRegs(term.start, term.nargs).map(r => `r${r}`), isTail: term.isTail, resume: term.resume, loopCount: false };
                    return this.emit(`
                        ${control.setsResume ? "" : `frame.ip = ${term.resume};`}
                        ${term.isTail || control.continues ? "" : this.#spills(live.spillsFor(term.resume))}
                        ${control.heap(site, this.#spills(live.spillsFor(term.resume)))}
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
    // a self tail call restarts the function at the same depth, whose entry check may not count (see %interrupt), so it
    // counts as a loop's back-edge does (a pause resumes the restarted call, whose arguments are in place)
    #selfTailCount(): string {
        if (!(this.table?.interrupts ?? false)) return "";
        return `if (--ic < 0) { ic = 255; if ((executor.interruptLeft -= 256) <= 0) { rip = 0; executor.interruptDirect(ctx, closure, marks, mframe); } }`;
    }

    protected readonly accExpr = "acc";
    protected readonly depthCheck = " && depth < MAX_JS_DEPTH";
    protected upvarRef(idx: number): string { return `uv${idx}`; }
    protected setUpvarExpr(idx: number, val: string): string { return `closure.upvars[${idx}] = uv${idx} = ${val}`; }
    protected readonly marksVar = "marks";
    protected readonly mframeVar = "mframe";
    // this function's own arity, when a call to its own closure can call it by name (no rest parameter)
    #selfArity = -1;
    // it is only entered at its start, so what is known at each block's start holds for the whole function
    #entryFacts: Map<number, Facts> | null = null;
    protected get entryFacts(): Map<number, Facts> {
        return this.#entryFacts ??= blockFacts(this.blocks, this.table, this.constants, this.#seed);
    }
    // in the version for number parameters, what it knows on entry; and the check that picks that version, made again
    // on every self tail call (its new arguments may not be numbers)
    #seed: Facts | null = null;
    #specCheck: string | null = null;

    // the kinds of the positional parameters intrinsics want (`wants`) where they read them (directly, or through the
    // moves a parameter is usually copied by first): a version knowing them can drop their checks, which cost most in hot
    // loops over the floats computed from them. A parameter wanted as two kinds is left out
    #paramKinds(params: number): Map<number, Kind> {
        const wanted = new Map<number, Kind | null>();
        const want = (reg: number, kind: Kind) => wanted.set(reg, wanted.has(reg) && wanted.get(reg) !== kind ? null : kind);
        for (const block of this.blocks) {
            for (const x of block.insts) {
                if (x.k !== "IntCall" && x.k !== "IntApply") continue;
                const kind = this.table?.entries[x.pos]?.wants;
                if (kind !== undefined) for (const r of windowRegs(x.start, x.nargs)) want(r, kind);
            }
        }
        for (let grew = true; grew;) {
            grew = false;
            for (const block of this.blocks) {
                for (const x of block.insts) {
                    const kind = x.k === "Move" ? wanted.get(x.dst) : undefined;
                    if (x.k === "Move" && kind !== undefined && kind !== null && wanted.get(x.src) !== kind) {
                        const before = wanted.get(x.src);
                        want(x.src, kind);
                        grew = wanted.get(x.src) !== before || grew;
                    }
                }
            }
        }
        const out = new Map<number, Kind>();
        for (let i = 0; i < params; i++) {
            const kind = wanted.get(i);
            if (kind !== undefined && kind !== null) out.set(i, kind);
        }
        return out;
    }
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
        this.#selfArity = closureArity.rest === "none" ? closureArity.params : -1;
        const arity = closureArity.params + (closureArity.rest === "none" ? 0 : 1);
        const params = Array.from({ length: arity }, (_, i) => `, a${i}`).join("");
        const locals = Array.from({ length: this.numReg }, (_, i) => i < arity ? `r${i} = a${i}` : `r${i}`);
        // a frame rebuilt from here resumes in heap code, which reads only the registers live where it can resume: reading
        // the others here would make V8 keep every temporary boxed wherever the function could throw (a float loop ran
        // three times slower)
        const resumeLive = new Liveness(this.blocks, this.numReg).entryLive;
        const allRegs = Array.from({ length: this.numReg }, (_, i) => resumeLive.has(i) ? `r${i}` : "undefined").join(", ");
        const usedUpvars = new Set<number>();
        for (const b of this.blocks) {
            for (const inst of b.insts) {
                if (inst.k === "LoadUpvar" || inst.k === "SetUpvar") usedUpvars.add(inst.idx);
                else if (inst.k === "NewClosure") {
                    for (const c of inst.captures) if (!c.local) usedUpvars.add(c.index);
                }
            }
        }
        const uvDefs = usedUpvars.size > 0
            ? `const upvars = closure.upvars;\nlet ${Array.from(usedUpvars).map(idx => `uv${idx} = upvars[${idx}]`).join(", ")};`
            : "";
        this.emit(`
            function direct$(ctx, closure, executor, depth, marks, mframe${params}) {
                let ip = 0, rip = 0, ic = 255, acc, tmp${this.debug ? ", dip = 0" : ""};
                ${locals.length > 0 ? `let ${locals.join(", ")};` : ""}
                ${uvDefs}
        `);
        // a parameter whose kind has no check (guard) the front end can write stays checked in the body
        const types = this.table?.types ?? null;
        const guards = new Map<number, string>();
        const kinds = this.debug || types === null ? new Map<number, Kind>() : this.#paramKinds(closureArity.params);
        for (const [i, kind] of kinds) {
            const test = types!.guard(kind, `r${i}`, inlineDeps({ name: "the type system", deps: this.table!.typeDeps } as Intrinsic, this.usedDeps));
            if (test !== null) guards.set(i, test);
        }
        const numeric = [...guards.keys()];
        this.#specCheck = numeric.length > 0 ? numeric.map(i => `(${guards.get(i)})`).join(" && ") : null;
        const structured = this.#structuredBody();
        const special = structured !== null && this.#specCheck !== null ? this.#structuredBody(new Map(numeric.map(i => [i, kinds.get(i)!]))) : null;
        if (special === null) this.#specCheck = null;
        this.emit(`
                ${special !== null ? `let spec = ${this.#specCheck};` : ""}
                try {
        `);
        if (structured !== null) {
            this.emit(`
                    top: for (;;) {
                        ${special !== null ? `if (spec) {
                            ${special}
                            return undefined;
                        }` : ""}
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
                    // a stop leaves as it is: no frame needs rebuilding, and no handler may see it
                    if (e instanceof InterruptError) throw e;
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

    // direct-entry code never resumes mid-function, so compiled `if`s (If c else ... Else end, else: ... EndIf, end:) can be emitted as nested js if/else
    #structuredBody(seed: Facts | null = null): string | null {
        const body = new DirectEmitter(this.blocks, this.layout, this.numReg, this.debug, this.table, this.usedDeps, this.constants);
        body.#selfArity = this.#selfArity;
        body.#seed = seed;
        body.#specCheck = this.#specCheck;
        const index = new Map(this.blocks.map((b, i) => [b.start, i]));
        try {
            body.#walk(index, 0, this.layout.size);
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

    // whether the else branch of the if ending at endIp starts an elseif If of the same chain (whose then branch ends with
    // Else endIp; a nested if's chain has its own end)
    #hasElseIf(elseIp: number, endIp: number): boolean {
        const { ops, at } = this.layout;
        for (let i = ops.indexOf(at.get(elseIp)!); i >= 0 && i < ops.length && ops[i].ip < endIp - 1; i++) {
            const op = ops[i];
            if (op.k !== "If" || !op.elseif) continue;
            if (this.#elseBefore(op.else) === endIp) return true;
        }
        return false;
    }

    // the end of the if whose then branch an Else right before `ip` closes
    #elseBefore(ip: number): number | undefined {
        const op = this.layout.at.get(ip - OP_SIZE.Else);
        return op?.k === "Else" ? op.end : undefined;
    }

    #walk(index: Map<number, number>, from: number, stop: number): void {
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
        const { blocks } = this;
        let i: number | undefined = first;
        while (i < blocks.length && blocks[i].start < stop) {
            const block = blocks[i];
            const next = i + 1 < blocks.length ? blocks[i + 1].start : this.layout.size;
            this.startBlock(this.entryFacts.get(block.start));
            for (const x of block.insts) this.emitInstWithFacts(x);
            const term = block.term;
            if (term.k === "Branch") {
                const elseIp = term.else;
                const endIp = this.#elseBefore(elseIp);
                if (term.then !== next || endIp === undefined) throw STRUCTURE_MISMATCH;
                if (this.layout.at.get(endIp - OP_SIZE.EndIf)?.k !== "EndIf") throw STRUCTURE_MISMATCH;
                // a later clause of the chain being walked: a sibling of the first, leaving the chain's block when taken
                if (term.elseif) {
                    const chain = this.#chains.get(endIp);
                    if (chain === undefined) throw STRUCTURE_MISMATCH;
                    this.emit(`if (${this.truthy(term.cond)}) {`);
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
                    this.emit(`if (${this.truthy(term.cond)}) {`);
                    this.#walk(index, term.then, elseIp - 2);
                    this.emit(`break ${chain}; }`);
                    this.#walk(index, elseIp, endIp - 1);
                    this.emit(`}`);
                    this.#chains.delete(endIp);
                } else {
                    this.emit(`if (${this.truthy(term.cond)}) {`);
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
    #tailCall(proc: string, start: number, nargs: number, site?: number): string {
        const args = this.argList(start, nargs);
        const cache = site !== undefined ? `CC${site}` : null;
        return `
            rip = -1;
            ${cache !== null ? `if (${proc} instanceof Closure && ${proc}.tmpl === ${cache}.tmpl && ${cache}.tmpl.code.directArity !== -1 && depth < MAX_JS_DEPTH) {
                return ${cache}.directFn(ctx, ${proc}, executor, depth + 1, marks, mframe${nargs > 0 ? ", " + args : ""});
            }` : ""}
            if (${this.directGuard(proc, `${nargs}`)}) {
                ${cache !== null ? `${cache}.tmpl = ${proc}.tmpl; ${cache}.directFn = ${proc}.tmpl.code.directFn;\n` : ""}const val = ${proc}.tmpl.code.directFn(ctx, ${proc}, executor, depth + 1, marks, mframe${nargs > 0 ? ", " + args : ""});
                return val;
            }
            if (${this.restGuard(proc, `${nargs}`)}) {
                const val = executor.callDirectRest(ctx, ${proc}, [${args}], depth + 1, marks, mframe);
                return val;
            }
            if (${proc} instanceof Closure && ${proc}.tmpl.arity.pad) return executor.callPadded(ctx, ${proc}, [${args}], depth + 1, marks, mframe);
            if (${proc} instanceof CaseLambda) {
                const clause = ${proc}.select(${nargs});
                if (${this.directGuard("clause", `${nargs}`)}) return clause.tmpl.code.directFn(ctx, clause, executor, depth + 1, marks, mframe${nargs > 0 ? ", " + args : ""});
                return executor.callCase(ctx, ${proc}, [${args}], depth + 1, marks, mframe);
            }
            return executor.callOther(ctx, ${proc}, [${args}], depth + 1, marks, mframe);
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
            } else if (proc instanceof Closure && proc.tmpl.arity.pad) {
                ${done} executor.callPadded(ctx, proc, args, depth + 1, marks, ${frameArg});
            } else if (proc instanceof CaseLambda) {
                ${done} executor.callCase(ctx, proc, args, depth + 1, marks, ${frameArg});
            } else {
                ${done} executor.callOther(ctx, proc, args, depth + 1, marks, ${frameArg});
            }
        `;
    }

    #call(procReg: number, start: number, nargs: number, resume: number, site?: number): string {
        return `
            {
                const proc = r${procReg};
                rip = ${resume};
                ${this.#callProc(this.argList(start, nargs), nargs, "marks", site)}
            }
        `;
    }

    // calls `proc` (in scope) with `args`, leaving the value in acc
    #callProc(args: string, nargs: number, marksExpr: string = "marks", site?: number): string {
        const cache = site !== undefined ? `CC${site}` : null;
        return `
                ${nargs === this.#selfArity ? `if (proc === closure && depth < MAX_JS_DEPTH) {
                    acc = direct$(ctx, proc, executor, depth + 1, ${marksExpr}, mframe + 1${nargs > 0 ? ", " + args : ""});
                } else ` : ""}${cache !== null ? `if (proc instanceof Closure && proc.tmpl === ${cache}.tmpl && ${cache}.tmpl.code.directArity !== -1 && depth < MAX_JS_DEPTH) {
                    acc = ${cache}.directFn(ctx, proc, executor, depth + 1, ${marksExpr}, mframe + 1${nargs > 0 ? ", " + args : ""});
                } else ` : ""}if (${this.directGuard("proc", `${nargs}`)}) {
                    ${cache !== null ? `${cache}.tmpl = proc.tmpl; ${cache}.directFn = proc.tmpl.code.directFn;\n` : ""}acc = proc.tmpl.code.directFn(ctx, proc, executor, depth + 1, ${marksExpr}, mframe + 1${nargs > 0 ? ", " + args : ""});
                } else if (${this.restGuard("proc", `${nargs}`)}) {
                    acc = executor.callDirectRest(ctx, proc, [${args}], depth + 1, ${marksExpr}, mframe + 1);
                } else if (proc instanceof Closure && proc.tmpl.arity.pad) {
                    acc = executor.callPadded(ctx, proc, [${args}], depth + 1, ${marksExpr}, mframe + 1);
                } else if (proc instanceof CaseLambda) {
                    const clause = proc.select(${nargs});
                    acc = ${this.directGuard("clause", `${nargs}`)}
                        ? clause.tmpl.code.directFn(ctx, clause, executor, depth + 1, ${marksExpr}, mframe + 1${nargs > 0 ? ", " + args : ""})
                        : executor.callCase(ctx, proc, [${args}], depth + 1, ${marksExpr}, mframe + 1);
                } else {
                    acc = executor.callOther(ctx, proc, [${args}], depth + 1, ${marksExpr}, mframe + 1);
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
                    ${this.#call(term.proc, term.start, term.nargs, term.resume, term.at)}
                    ${this.jump(term.resume, next)}
                `);
            case "HostCall": {
                const control = this.controlOf(term);
                if (control !== undefined) {
                    const site = { args: windowRegs(term.start, term.nargs).map(r => `r${r}`), isTail: term.isTail, resume: term.resume, loopCount: this.layout.at.get(term.resume)?.k === "EndLoop" };
                    return this.emit(`
                        ${control.setsResume ? "" : `rip = ${term.isTail ? -1 : term.resume};`}
                        ${control.direct(site, this.#callArray(term.isTail), (args, marks) => this.#callProc(args.join(", "), args.length, marks))}
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
                return this.emit(`{ const proc = r${term.proc}; ${this.#tailCall("proc", term.start, term.nargs, term.at)} }`);
            case "MaybeSelfTailCall":
                return this.emit(`
                    {
                        const proc = r${term.proc};
                        if (proc === closure) {
                            ${this.selfMoves(term)}
                            ${this.#selfTailCount()}
                            ip = 0;
                            ${this.#specCheck !== null ? `spec = ${this.#specCheck};` : ""}
                            continue top;
                        }
                        ${this.#tailCall("proc", term.start, term.nargs, term.at)}
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
