// What the resume entry and the direct entry of a compiled function share (FunctionEmitter)
import { Liveness, windowRegs } from "./liveness";
import { transfer, successors, type Facts, type Aliases } from "./facts";
import { capturesOf, type AotBlock, type AotInst, type AotTerm } from "./types";
import type { Arity } from "../arity";
import { CORE_COUNT } from "../coreops";
import { Intrinsics, type AggregateDescriptor, type Intrinsic } from "../intrinsics";
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
    // the register each register that stands for another's variable stands for, and the registers that stand for each;
    // `#since` is the order the registers came to stand for something
    readonly #source = new Map<number, number>();
    readonly #readers = new Map<number, Set<number>>();
    readonly #since = new Map<number, number>();
    #stamp = 0;

    protected get entryFacts(): Map<number, Facts> { return new Map(); }
    protected readonly constRegs = new Map<number, any>();

    protected aggregateOf(reg: number): AggregateDescriptor | undefined {
        if (!this.substitutes) return undefined;
        const kind = this.facts.get(reg);
        if (kind === undefined) return undefined;
        return this.table?.types?.aggregates?.[kind];
    }

    protected materializeAggregate(reg: number): string {
        const desc = this.aggregateOf(reg);
        if (desc === undefined) return this.operand(reg);
        const d = inlineDeps({ name: "the aggregate", deps: this.table!.typeDeps } as Intrinsic, this.usedDeps);
        const boxed = desc.box(desc.fields.map(f => `r${reg}_${f}`), d);
        return `(r${reg}_${desc.fields[0]} !== undefined ? ${boxed} : ${this.operand(reg)})`;
    }

    protected startBlock(facts: Facts | undefined): void {
        this.facts = new Map(facts ?? []);
        this.aliases = new Map();
        this.one = new Set();
        this.#atoms.clear();
        this.#source.clear();
        this.#readers.clear();
        this.#since.clear();
        this.constRegs.clear();
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
        if (inst.k === "Move" && this.aggregateOf(inst.src) !== undefined) return null;
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
        const readers = this.#readers.get(reg);
        if (readers === undefined || readers.size === 0) return;
        const since = this.#since;
        for (const other of [...readers].sort((a, b) => since.get(a)! - since.get(b)!)) this.#materialise(other);
    }

    #materialise(reg: number): void {
        const atom = this.#atoms.get(reg);
        if (atom === undefined) return;
        this.#forget(reg);
        this.emit(`r${reg} = ${atom};`);
    }

    // `reg` stands for `atom` from here: the variable of register `of`, or (-1) a constant
    #standFor(reg: number, atom: string, of: number): void {
        if (this.#atoms.has(reg)) this.#unlink(reg);
        else this.#since.set(reg, this.#stamp++);
        this.#atoms.set(reg, atom);
        if (of === -1) return;
        this.#source.set(reg, of);
        const readers = this.#readers.get(of);
        if (readers === undefined) this.#readers.set(of, new Set([reg]));
        else readers.add(reg);
    }

    #unlink(reg: number): void {
        const of = this.#source.get(reg);
        if (of === undefined) return;
        this.#source.delete(reg);
        this.#readers.get(of)!.delete(reg);
    }

    #forget(reg: number): void {
        if (!this.#atoms.delete(reg)) return;
        this.#unlink(reg);
        this.#since.delete(reg);
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
                    // (a moved register that itself stands for something: that, which is never a register that does)
                    const of = inst.k !== "Move" ? -1 : this.#source.get(inst.src) ?? (this.#atoms.has(inst.src) ? -1 : inst.src);
                    this.#beforeWrite(dst);
                    if (of === dst) this.#forget(dst);
                    else this.#standFor(dst, atom, of);
                } else {
                    const defs = Liveness.defs(inst);
                    for (const reg of defs) this.#beforeWrite(reg);
                    this.emitInst(inst);
                    for (const reg of defs) this.#forget(reg);
                }
            }
            for (const end = i + Math.max(fused, 1); i < end; i++) {
                const inst = block.insts[i];
                if (fused !== 0) for (const reg of Liveness.defs(inst)) this.#forget(reg);
                transfer(inst, this.facts, this.table, this.constants, this.aliases);
                for (const [reg, isOne] of this.#defines(inst, r => this.one.has(r))) {
                    if (isOne) this.one.add(reg);
                    else this.one.delete(reg);
                }
                if (inst.k === "LoadConst") this.constRegs.set(inst.dst, this.constants[inst.idx]);
                else if (inst.k === "LoadInt") this.constRegs.set(inst.dst, inst.value);
                else if (inst.k === "Move") {
                    if (this.constRegs.has(inst.src)) this.constRegs.set(inst.dst, this.constRegs.get(inst.src));
                    else this.constRegs.delete(inst.dst);
                } else {
                    for (const r of Liveness.defs(inst)) this.constRegs.delete(r);
                }
            }
        }
        // what later blocks read is in its variable from here on; a self tail call moves registers about, so all are
        const term = block.term;
        const live = this.liveness.liveOut(term);
        for (const reg of [...this.#atoms.keys()]) if (term.k === "MaybeSelfTailCall" || live.has(reg)) this.#materialise(reg);
        if (this.substitutes && this.table?.types?.aggregates !== undefined) {
            const succs = successors(term);
            if (succs.length > 0) {
                for (const reg of live) {
                    const agg = this.aggregateOf(reg);
                    if (agg !== undefined) {
                        const allSuccKnow = succs.every(target => this.entryFacts.get(target)?.get(reg) === agg.kind);
                        if (!allSuccKnow) {
                            this.emit(`r${reg} = ${this.materializeAggregate(reg)};`);
                        }
                    }
                }
            }
        }
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
            case "LoadUpvar": case "LoadGlobal": case "LoadImport": case "ImportRef": case "Unbox": return [[inst.dst, variables]];
            case "ImportGlobals": return [[inst.dst, true]];
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
        return windowRegs(start, nargs).map(r => this.materializeAggregate(r)).join(", ");
    }


    protected selfMoves(term: Extract<AotTerm, { k: "MaybeSelfTailCall" }>): string {
        // as bindArgs, over registers held in js variables: the rest value first, then the positionals, moving down
        // a padded closure's missing parameters are <#void>, its extra arguments dropped unless it has a rest parameter
        const { params: min, rest } = term.arity;
        const restRegs = Array.from({ length: Math.max(term.nargs - min, 0) }, (_, i) => this.materializeAggregate(term.start + min + i));
        const moves: string[] = [];
        if (rest === "array") moves.push(`const rest = [${restRegs.join(", ")}];`);
        if (rest === "packed") moves.push(`const rest = ${this.intrinsicCall(term.restPos, term.start + min, term.nargs - min)};`);
        for (let i = 0; i < Math.min(min, term.nargs); i++) {
            const src = term.start + i;
            if (src !== i) {
                const srcAgg = this.aggregateOf(src);
                const dstKind = this.entryFacts.get(0)?.get(i);
                const dstAgg = dstKind !== undefined && this.table?.types?.aggregates !== undefined ? this.table.types.aggregates[dstKind] : undefined;
                if (srcAgg !== undefined && dstAgg !== undefined) {
                    for (const f of srcAgg.fields) moves.push(`r${i}_${f} = r${src}_${f};`);
                    moves.push(`r${i} = r${src};`);
                } else if (dstAgg !== undefined) {
                    const d = inlineDeps({ name: "the aggregate", deps: this.table!.typeDeps } as Intrinsic, this.usedDeps);
                    const unboxed = dstAgg.unbox(`r${src}`, d);
                    for (const f of dstAgg.fields) moves.push(`r${i}_${f} = ${unboxed[f]};`);
                    moves.push(`r${i} = r${src};`);
                } else if (srcAgg !== undefined) {
                    moves.push(`r${i} = ${this.materializeAggregate(src)};`);
                } else {
                    moves.push(`r${i} = r${src};`);
                }
            }
        }
        for (let i = term.nargs; i < min; i++) moves.push(`r${i} = undefined;`);
        if (rest !== "none") moves.push(`r${min} = rest;`);
        return moves.join("\n");
    }

    // the unit's imports for a function that uses them, bound where the function starts: `iv` is the values of the
    // scope it runs in
    protected importsDef(): string {
        for (const block of this.blocks) {
            for (const inst of block.insts) {
                if (inst.k === "LoadImport" || inst.k === "ImportRef" || inst.k === "ImportSet" || inst.k === "ImportGlobals") {
                    return `const IM = CONSTANTS[${inst.imp}]; let iv = IM.scope === ctx.scope ? IM.values : IM.none;`;
                }
            }
        }
        return "";
    }

    #loadGlobal(inst: { ip: number, dst: number, sym: number }): string {
        return `
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
        `;
    }

    protected emitAggregateIntCall(inst: { pos: number; dst: number; start: number; nargs: number }): boolean {
        if (!this.substitutes || this.table?.types?.aggregates === undefined) return false;
        const entry = this.table.entries[inst.pos];
        if (entry === undefined) return false;

        if (inst.nargs === 2) {
            const objAgg = this.aggregateOf(inst.start);
            if (objAgg !== undefined) {
                const key = this.constRegs.get(inst.start + 1);
                if (typeof key === "string" && key.length === 1) {
                    const k = key.toLowerCase();
                    if (objAgg.fields.includes(k)) {
                        this.emit(`r${inst.dst} = r${inst.start}_${k};`);
                        return true;
                    }
                }
            }
        }

        const rule = entry.aggregate;
        if (rule === undefined) return false;
        const desc = this.table.types.aggregates[rule.kind];
        if (desc === undefined) return false;

        const regs = windowRegs(inst.start, inst.nargs);
        const kinds = regs.map(r => this.facts.get(r));
        const d = inlineDeps(entry, this.usedDeps);

        switch (rule.type) {
            case "constructor": {
                if (inst.nargs < desc.fields.length - 1) return false;
                const argOperands = regs.map(r => this.operand(r));
                const exprs = rule.emit !== undefined
                    ? rule.emit(argOperands, d)
                    : desc.fields.map((_, i) => i < argOperands.length ? argOperands[i] : "0");
                for (let i = 0; i < desc.fields.length; i++) {
                    this.emit(`r${inst.dst}_${desc.fields[i]} = ${exprs[i]};`);
                }
                return true;
            }
            case "getter": {
                const objAgg = this.aggregateOf(inst.start);
                if (objAgg !== undefined && objAgg.fields.includes(rule.field)) {
                    this.emit(`r${inst.dst} = r${inst.start}_${rule.field};`);
                    return true;
                }
                return false;
            }
            case "component-wise": {
                if (rule.applies !== undefined && !rule.applies(kinds)) return false;
                if (regs.every(r => this.aggregateOf(r) === undefined)) return false;
                const argComponents = regs.map(r => {
                    const agg = this.aggregateOf(r);
                    return agg !== undefined ? agg.fields.map(f => `r${r}_${f}`) : [this.operand(r)];
                });
                const exprs = rule.emit(argComponents, d, kinds);
                for (let i = 0; i < desc.fields.length; i++) {
                    this.emit(`r${inst.dst}_${desc.fields[i]} = ${exprs[i]};`);
                }
                return true;
            }
            case "reduction": {
                if (rule.applies !== undefined && !rule.applies(kinds)) return false;
                if (regs.every(r => this.aggregateOf(r) === undefined)) return false;
                const argComponents = regs.map(r => {
                    const agg = this.aggregateOf(r);
                    return agg !== undefined ? agg.fields.map(f => `r${r}_${f}`) : [this.operand(r)];
                });
                const expr = rule.emit(argComponents, d, kinds);
                this.emit(`r${inst.dst} = ${expr};`);
                return true;
            }
        }
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
                return this.emit(`${this.setUpvarExpr(inst.idx, inst.box ? `new Box(${this.materializeAggregate(inst.src)})` : this.materializeAggregate(inst.src))};`);
            case "FixUpvar":
                return this.emit(`${this.operand(inst.clo)}.upvars[${inst.idx}] = ${this.materializeAggregate(inst.src)};`);
            case "LoadGlobal":
                return this.emit(this.#loadGlobal(inst));
            case "LoadImport":
                return this.emit(`
                    {
                        const read = iv[${inst.slot}];
                        if (read !== undefined) r${inst.dst} = read;
                        else ${this.#loadGlobal(inst)}
                    }
                `);
            case "ImportGlobals":
                return this.emit(`r${inst.dst} = executor.importGlobals(ctx, IM, CONSTANTS[${inst.syms}]); iv = IM.values;`);
            case "ImportRef":
                return this.emit(`r${inst.dst} = iv[${inst.slot}];`);
            case "ImportSet":
                return this.emit(`if (IM.scope === ctx.scope) IM.values[${inst.slot}] = ${this.materializeAggregate(inst.src)};`);
            case "SetGlobal":
                return this.emit(`ctx.scope.set(CONSTANTS[${inst.sym}], ${this.materializeAggregate(inst.src)});`);
            case "Move": {
                const agg = this.aggregateOf(inst.src);
                if (agg !== undefined) {
                    for (const f of agg.fields) this.emit(`r${inst.dst}_${f} = r${inst.src}_${f};`);
                    return;
                }
                return this.emit(`r${inst.dst} = ${this.use(inst.src)};`);
            }
            case "Box":
                return this.emit(`r${inst.dst} = new Box(${this.materializeAggregate(inst.src)});`);
            case "Unbox":
                return this.emit(`r${inst.dst} = ${this.operand(inst.src)}.val;`);
            case "SetBox":
                return this.emit(`${this.operand(inst.dst)}.val = ${this.materializeAggregate(inst.src)};`);
            case "NewClosure": {
                const captures = capturesOf(inst, this.constants).map(c => c.local ? this.materializeAggregate(c.index) : this.upvarRef(c.index)).join(", ");
                return this.emit(`r${inst.dst} = new Closure(CONSTANTS[${inst.tmpl}], [${captures}]);`);
            }
            case "MoveAcc":
                return this.emit(`r${inst.dst} = ${inst.one ? this.accOne : this.accExpr};`);
            case "SetMark":
                return this.emit(`${this.marksVar} = markSet(${this.marksVar}, ${this.mframeVar}, ${this.use(inst.key)}, ${this.materializeAggregate(inst.val)});`);
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
                if (this.emitAggregateIntCall(inst)) return;
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
        const inlined = entry.inline(regs.map(r => this.materializeAggregate(r)), typedSlow, "tmp", inlineDeps(entry, this.usedDeps), known, site);
        return inlined ?? direct;
    }

}
