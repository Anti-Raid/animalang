// What the resume entry and the direct entry of a compiled function share (FunctionEmitter)
import { Liveness, windowRegs } from "./liveness";
import { transfer, type Facts, type Aliases } from "./facts";
import { capturesOf, type AotBlock, type AotInst, type AotTerm } from "./types";
import type { Arity } from "../arity";
import { CORE_COUNT } from "../coreops";
import { Intrinsics } from "../intrinsics";
import { UNPACK_REST } from "../ops";
import { MultipleValues } from "../../common";
import type { Structure } from "./structure";
import { CodeEmitter, inlineDeps } from "./code-emitter";
import { CONTROL_AOT, type ControlAot } from "./control";


// a constant as js source, when it has a literal (the others are read from the code's constants)
const literal = (v: unknown): string | null => {
    switch (typeof v) {
        case "string": return JSON.stringify(v);
        case "number": return Object.is(v, -0) ? "-0" : String(v);
        case "bigint": return `${v}n`;
        case "boolean": case "undefined": return String(v);
    }
    return v === null ? "null" : null;
};

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
        protected readonly reentrant: boolean = true,
    ) {
        super();
    }

    // what is known of the registers at the instruction being emitted (see facts.ts): set at each block's start
    protected facts: Facts = new Map();
    protected aliases: Aliases = new Map();

    // the registers that hold one value (not multiple values) at the instruction being emitted, as far as the block
    // shows; `oneValueRegs` is those that do wherever they are read
    protected one = new Set<number>();
    #plain: Set<number> | null = null;

    // Direct code (`substitutes`) does not move a constant, or another register, into a register there and then: where
    // the register is read, the constant or the other register's variable is written in its place (`#atoms`). Its own
    // variable is assigned only if a later block reads it, or before the variable it stands for is assigned. Heap code
    // keeps every move: its registers are also read from the frame
    protected readonly substitutes: boolean = false;
    readonly #atoms = new Map<number, string>();

    protected startBlock(facts: Facts | undefined): void {
        this.facts = new Map(facts ?? []);
        this.aliases = new Map();
        this.one = new Set();
        this.#atoms.clear();
    }

    // the js of register `reg` where it is read
    protected use(reg: number): string {
        return this.#atoms.get(reg) ?? `r${reg}`;
    }

    // the same, where a property of it is read or it goes into an intrinsic's template: a number is in parentheses
    protected operand(reg: number): string {
        const atom = this.#atoms.get(reg);
        return atom === undefined ? `r${reg}` : /^[-\d]/.test(atom) ? `(${atom})` : atom;
    }

    // what `inst` moves into its register, when that is a constant or another register
    #atomOf(inst: AotInst): string | null {
        switch (inst.k) {
            case "Move": return this.use(inst.src);
            case "LoadInt": return literal(inst.value);
            case "LoadConst": return literal(this.constants[inst.idx]) ?? `CONSTANTS[${inst.idx}]`;
            default: return null;
        }
    }

    // `reg` is about to change (its variable assigned, or itself made to stand for something): the registers that
    // stand for its variable take its value first. So a register never stands for one that stands for something
    #beforeWrite(reg: number): void {
        for (const [other, atom] of [...this.#atoms]) if (atom === `r${reg}`) this.#materialise(other);
    }

    #materialise(reg: number): void {
        const atom = this.#atoms.get(reg);
        if (atom === undefined) return;
        this.#atoms.delete(reg);
        this.emit(`r${reg} = ${atom};`);
    }

    // a block's instructions. `fused` may emit some of them together itself, from `index` on: it says how many
    protected emitInsts(block: AotBlock): void {
        for (let i = 0; i < block.insts.length;) {
            const fused = this.fused(block, i);
            if (fused === 0) {
                const inst = block.insts[i];
                const atom = this.substitutes ? this.#atomOf(inst) : null;
                if (atom !== null) {
                    const dst = (inst as { dst: number }).dst;
                    this.#beforeWrite(dst);
                    if (atom === `r${dst}`) this.#atoms.delete(dst);
                    else this.#atoms.set(dst, atom);
                } else {
                    const defs = Liveness.defs(inst);
                    for (const reg of defs) this.#beforeWrite(reg);
                    this.emitInst(inst);
                    for (const reg of defs) this.#atoms.delete(reg);
                }
            }
            for (const end = i + Math.max(fused, 1); i < end; i++) {
                const inst = block.insts[i];
                if (fused !== 0) for (const reg of Liveness.defs(inst)) this.#atoms.delete(reg);
                transfer(inst, this.facts, this.table, this.constants, this.aliases);
                for (const [reg, isOne] of this.#defines(inst, r => this.one.has(r))) {
                    if (isOne) this.one.add(reg);
                    else this.one.delete(reg);
                }
            }
        }
        // what later blocks read is in its variable from here on; a self tail call moves registers about, so all are
        const term = block.term;
        const live = this.liveness.liveOut(term);
        for (const reg of [...this.#atoms.keys()]) if (term.k === "MaybeSelfTailCall" || live.has(reg)) this.#materialise(reg);
    }

    // whether a call that asks for several values may get them in VB (see Code.entry)
    protected readonly buffered: boolean = false;

    protected fused(_block: AotBlock, _index: number): number {
        return 0;
    }

    // the registers `inst` sets, and whether each then holds one value (`moved`: whether a register it copies does).
    // Multiple values come from a call that did not ask for one, and from an intrinsic that does not say what it
    // returns; a variable holds one value where the front end says its variables do (TypeSystem.oneValueVariables)
    #defines(inst: AotInst, moved: (reg: number) => boolean): [number, boolean][] {
        const variables = this.table?.types?.oneValueVariables === true;
        switch (inst.k) {
            case "LoadInt": case "NewClosure": case "CurMarks": case "Box": return [[inst.dst, true]];
            case "LoadConst": return [[inst.dst, !(this.constants[inst.idx] instanceof MultipleValues)]];
            case "LoadUpvar": case "LoadGlobal": case "Unbox": return [[inst.dst, variables]];
            case "Move": return [[inst.dst, moved(inst.src)]];
            case "MoveAcc": return [[inst.dst, inst.one === true]];
            case "IntCall": case "IntApply": {
                const entry = this.table!.entries[inst.pos];
                return [[inst.dst, entry.oneValue || typeof entry.returns === "string"]];
            }
            case "Unpack": return Array.from({ length: inst.count + ((inst.flags & UNPACK_REST) !== 0 ? 1 : 0) }, (_, i): [number, boolean] => [inst.start + i, true]);
            default: return [];
        }
    }

    // whether `reg` holds one value where a block ends: it does where the block shows it, or if nothing in the function
    // ever puts multiple values in it (`params`: the registers the arguments come in, which a caller may pass anything)
    protected holdsOne(reg: number, params: number): boolean {
        if (this.one.has(reg)) return true;
        if (this.#plain === null) {
            const variables = this.table?.types?.oneValueVariables === true;
            const multi = new Set<number>(variables ? [] : Array.from({ length: params }, (_, i) => i));
            for (let grew = true; grew;) {
                grew = false;
                for (const block of this.blocks) {
                    for (const inst of block.insts) {
                        for (const [reg, isOne] of this.#defines(inst, r => !multi.has(r))) {
                            if (!isOne && !multi.has(reg)) {
                                multi.add(reg);
                                grew = true;
                            }
                        }
                    }
                }
            }
            this.#plain = new Set(Array.from({ length: this.numReg }, (_, i) => i).filter(r => !multi.has(r)));
        }
        return this.#plain.has(reg);
    }

    // the js of the one value of `expr` (a variable), which may be multiple values
    protected oneOf(expr: string): string {
        return `(${expr}?.constructor === MultipleValues ? (${expr}.values.length > 0 ? ${expr}.values[0] : undefined) : ${expr})`;
    }

    // a branch's condition: a known boolean as it is
    protected truthy(reg: number): string {
        return this.facts.get(reg) === "boolean" ? this.use(reg) : `(${this.use(reg)} !== false)`;
    }

    // debug code only: statement recording the exact position of the op about to run
    protected abstract debugPos(ip: number): string;

    protected debugHooks(at: number | undefined, tailProc?: string): string {
        if (!this.debug || at === undefined) return "";
        return `${this.debugPos(at + 1)}${tailProc !== undefined ? ` ${this.marksVar} = recordTailMark(${this.marksVar}, ${this.mframeVar}, tailName(${tailProc}));` : ""}`;
    }

    // debug code only: records a control request made in tail position as the tail call, as debugHooks does for a call
    protected tailMark(req: string): string {
        if (!this.debug) return "";
        return `if (${req}.tailProc !== undefined) ${this.marksVar} = recordTailMark(${this.marksVar}, ${this.mframeVar}, tailName(${req}.tailProc));`;
    }

    // the AOT code of a core control operation a HostCall calls, if it is one
    // the test that what a host intrinsic returned is a request (`cls`: ControlRequest, or HostTail): only an object
    // can be, and most results are not objects, which `typeof` tells without looking at a prototype chain
    protected isRequest(v: string, cls: string): string {
        return `typeof ${v} === "object" && ${v} !== null && ${v} instanceof ${cls}`;
    }

    protected controlOf(term: Extract<AotTerm, { k: "HostCall" }>): ControlAot | undefined {
        return term.pos < CORE_COUNT ? CONTROL_AOT.get(this.table!.entries[term.pos].name) : undefined;
    }

    protected tailProcOf(term: AotTerm): string | undefined {
        if (term.k === "HostCall" && term.isTail && this.controlOf(term)?.tailProc) return this.use(term.start);
        switch (term.k) {
            case "TailCall": case "MaybeSelfTailCall": return this.use(term.proc);
            default: return undefined;
        }
    }

    abstract emitFunction(arity: Arity): void;

    // a (regs, start, nargs)-style call of `fn` over the register window; runtime functions also take (ctx, executor) first
    // a call of `fn` over the register window (followed by ctx and executor for an intrinsic that takes the context)
    protected abstract windowCall(fn: string, start: number, nargs: number, withContext?: boolean): string;
    // non-debug code: statements recording that the error `err` was raised by the op at `at` (debug code records every
    // op's position as it goes)
    protected abstract errorSite(at: number, err: string): string;

    // the inlined procedure the code is running (see Frame.isite)
    protected abstract readonly siteVar: string;

    // the value of the last call that wanted one value (read by MoveAcc): direct code's call gives it; heap code takes the
    // first of what the call returned
    protected abstract readonly accOne: string;
    // where the value of the last call is (read by MoveAcc)
    protected abstract readonly accExpr: string;

    // statement recording where to resume before an instruction that may throw (heap mode only)
    protected abstract recordIp(ip: number): string;

    protected abstract readonly endOfCode: string;

    // access/assignment to an upvar slot: in heap code reads the local `upvars`; in direct code reads hoisted `uv${idx}`
    protected abstract upvarRef(idx: number): string;
    protected abstract setUpvarExpr(idx: number, val: string): string;

    // where the running function's continuation marks and logical frame are
    protected abstract readonly marksVar: string;
    protected abstract readonly mframeVar: string;

    protected argList(start: number, nargs: number): string {
        return windowRegs(start, nargs).map(r => this.use(r)).join(", ");
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
        if (this.debug) this.emit(this.debugHooks(inst.ip));
        switch (inst.k) {
            case "LoadConst":
                return this.emit(`r${inst.dst} = ${literal(this.constants[inst.idx]) ?? `CONSTANTS[${inst.idx}]`};`);
            case "LoadInt":
                return this.emit(`r${inst.dst} = ${inst.value};`);
            case "LoadUpvar":
                return this.emit(`r${inst.dst} = ${this.upvarRef(inst.idx)}${inst.unbox ? ".val" : ""};`);
            case "SetUpvar":
                return this.emit(`${this.setUpvarExpr(inst.idx, inst.box ? `new Box(${this.use(inst.src)})` : this.use(inst.src))};`);
            case "FixUpvar":
                return this.emit(`${this.operand(inst.clo)}.upvars[${inst.idx}] = ${this.use(inst.src)};`);
            case "LoadGlobal":
                return this.emit(`
                    {
                        const cache = GC${inst.ip};
                        if (cache.scope === ctx.scope && cache.version === Env.globalsVersion) {
                            r${inst.dst} = cache.value;
                        } else {
                            const cell = ctx.scope.cell(CONSTANTS[${inst.sym}], ctx.scope.unbound);
                            if (cell.v === Env.ERROR) {
                                ${this.recordIp(inst.ip)}
                                const err = new MissingVarError(CONSTANTS[${inst.sym}]);
                                ${this.debug ? "" : this.errorSite(inst.ip, "err")}
                                throw err;
                            }
                            ctx.scope.watch();
                            r${inst.dst} = Env.remember(cache, ctx.scope, cell);
                        }
                    }
                `);
            case "SetGlobal":
                return this.emit(`ctx.scope.set(CONSTANTS[${inst.sym}], ${this.use(inst.src)});`);
            case "Move":
                return this.emit(`r${inst.dst} = ${this.use(inst.src)};`);
            case "Box":
                return this.emit(`r${inst.dst} = new Box(${this.use(inst.src)});`);
            case "Unbox":
                return this.emit(`r${inst.dst} = ${this.operand(inst.src)}.val;`);
            case "SetBox":
                return this.emit(`${this.operand(inst.dst)}.val = ${this.use(inst.src)};`);
            case "NewClosure": {
                const captures = capturesOf(inst, this.constants).map(c => c.local ? this.use(c.index) : this.upvarRef(c.index)).join(", ");
                return this.emit(`r${inst.dst} = new Closure(CONSTANTS[${inst.tmpl}], [${captures}]);`);
            }
            case "MoveAcc":
                return this.emit(`r${inst.dst} = ${inst.one ? this.accOne : this.accExpr};`);
            case "SetMark":
                return this.emit(`${this.marksVar} = markSet(${this.marksVar}, ${this.mframeVar}, ${this.use(inst.key)}, ${this.use(inst.val)});`);
            case "MarkSave":
                return this.emit(`r${inst.reg} = ${this.marksVar}; r${inst.reg + 1} = ${this.mframeVar}; ${this.mframeVar}++;`);
            case "MarkRestore":
                return this.emit(`${this.marksVar} = ${this.use(inst.reg)}; ${this.mframeVar} = ${this.use(inst.reg + 1)};`);
            case "CurMarks":
                return this.emit(`r${inst.dst} = new ContinuationMarkSet(${this.marksVar});`);
            case "InlineSite":
                return this.emit(`${this.siteVar} = ${inst.site};`);
            case "Unpack": {
                // (%let-values of formals with no rest, not strict: one value, or the values of several, with no call)
                if (inst.flags === 0) {
                    const regs = Array.from({ length: inst.count }, (_, i) => `r${inst.start + i}`);
                    // the call asked for them: they are in VB, or it is one value
                    if (inst.many && this.buffered) return this.emit(`tmp = ${this.use(inst.src)}; if (tmp === MULTI) { ${regs.map((r, i) => `${r} = VB[${i}];`).join(" ")} ${regs.map((_, i) => `VB[${i}] = `).join("")}undefined; } else { ${regs.map((r, i) => `${r} = ${i === 0 ? "tmp" : "undefined"};`).join(" ")} }`);
                    return this.emit(`tmp = ${this.use(inst.src)}; if (tmp?.constructor === MultipleValues) { tmp = tmp.values; ${regs.map((r, i) => `${r} = tmp[${i}];`).join(" ")} } else { ${regs.map((r, i) => `${r} = ${i === 0 ? "tmp" : "undefined"};`).join(" ")} }`);
                }
                const moves = Array.from({ length: inst.count }, (_, i) => `r${inst.start + i} = tmp[${i}];`);
                if ((inst.flags & UNPACK_REST) !== 0) moves.push(`r${inst.start + inst.count} = restValues(tmp, ${inst.count});`);
                return this.emit(`tmp = unpackForBinding(${this.use(inst.src)}, ${inst.count}, ${inst.flags}); ${moves.join(" ")}`);
            }
            case "IntCall":
                // non-debug code does not record where each operation is: an error the intrinsic raises gets the position here
                // (an inlined template that never calls the intrinsic cannot raise its errors, so needs none)
                const call = this.intrinsicCall(inst.pos, inst.start, inst.nargs, inst.ip);
                if (this.debug || !this.#callsIntrinsic(inst.pos, call)) return this.emit(`r${inst.dst} = ${call};`);
                return this.emit(`try { r${inst.dst} = ${call}; } catch (e) { ${this.errorSite(inst.ip, "e")} throw e; }`);
            case "IntApply": {
                // an array alone is the argument array itself: intrinsics never write to or keep it
                const entry = this.table!.entries[inst.pos];
                const args = inst.nargs === 1 ? `arrayArg("%apply", ${this.use(inst.start)})` : `applyArgs([${this.argList(inst.start, inst.nargs)}], 0, ${inst.nargs})`;
                const call = `r${inst.dst} = applyIntrinsic(I${inst.pos}, ${JSON.stringify(entry.name)}, ${entry.min}, ${entry.max}, ${args}, ctx, executor);`;
                if (this.debug) return this.emit(call);
                return this.emit(`try { ${call} } catch (e) { ${this.errorSite(inst.ip, "e")} throw e; }`);
            }
            default: {
                const _: never = inst;
            }
        }
    }

    #callsIntrinsic(pos: number, expr: string): boolean {
        return expr.includes(`RT[${pos}]`) || expr.includes(`I${pos}(`);
    }

    // an expression calling the intrinsic at `pos`: its inline template, whose fallback is a call of its function over the
    // register window. A call that is the fast path goes through the hoisted local I<pos>, which V8 may inline; a template's
    // fallback goes through RT[pos], so V8 does not inline the function into the cold path (which slows the hot one)
    // `at`: where the call is, for one that has state of its own there (SC<ip>, see IntrinsicOptions.site)
    protected intrinsicCall(pos: number, start: number, nargs: number, at?: number): string {
        const entry = this.table!.entries[pos];
        const direct = this.windowCall(`I${pos}`, start, nargs, entry.context);
        if (entry.inline === undefined) return direct;
        const regs = windowRegs(start, nargs);
        const known = regs.map(r => this.facts.get(r));
        // a declared result is also what the slow path gives, said so V8 keeps it unboxed through the template's branches
        const slow = this.windowCall(`RT[${pos}]`, start, nargs, entry.context);
        const result = Intrinsics.resultKind(entry, known);
        const typedSlow = result === undefined ? slow : result === "boolean" ? `!!${slow}` : this.table?.types?.coerce?.(result, slow) ?? slow;
        const site = entry.site !== undefined && at !== undefined ? `SC${at}` : undefined;
        const inlined = entry.inline(regs.map(r => this.operand(r)), typedSlow, "tmp", inlineDeps(entry, this.usedDeps), known, site);
        return inlined ?? direct;
    }

}
