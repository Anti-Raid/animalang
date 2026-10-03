// What the resume entry and the direct entry of a compiled function share (FunctionEmitter)
import { windowRegs, type Liveness } from "./liveness";
import { transfer, type Facts, type Aliases } from "./facts";
import type { AotBlock, AotInst, AotTerm } from "./types";
import type { Arity } from "../arity";
import { CORE_COUNT } from "../coreops";
import { Intrinsics } from "../intrinsics";
import { UNPACK_REST } from "../ops";
import type { Structure } from "./structure";
import { CodeEmitter, inlineDeps } from "./code-emitter";
import { CONTROL_AOT, type ControlAot } from "./control";


// emits one entry point of a compiled function; subclasses decide how registers reach callees, how values come back and
// how control leaves
export abstract class FunctionEmitter extends CodeEmitter {
    constructor(
        protected readonly blocks: AotBlock[],
        protected readonly structure: Structure,
        // which registers are live where (see liveness.ts), computed once for both entries
        protected readonly liveness: Liveness,
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
            const next = i + 1 < this.blocks.length ? this.blocks[i + 1].start : this.structure.size;
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
        if (target === next && target < this.structure.size) return "";
        if (target >= this.structure.size) return this.endOfCode;
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
