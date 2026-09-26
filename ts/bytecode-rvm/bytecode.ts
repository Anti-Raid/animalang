// Compiled code: ByteCode (instructions, constants, the intrinsics it is bound to, serialization) and closures
import { IProcedure } from "../common";
import type { BS, BSReader, SerializableBytecode, SourcePos } from "../common";
import { closureArity } from "./arity";
import type { Arity } from "./arity";
import { CORE_INTRINSICS } from "./coreops";
import type { VMExecutor } from "./executor";
import type { OpCode } from "./interpreter";
import type { Intrinsic, Intrinsics } from "./intrinsics";
import { INSTRUCTION_LENGTHS, INTRINSIC_OPERANDS } from "./opcodes";
import type { ExecutionContext, Frame } from "./values";
export type ExecutionMode = "interp" | "aot";

// what the executor needs of the VM it runs for (AnimaVM)
export type VMHost = { readonly mode: ExecutionMode };

export type ResumeFn = (ctx: ExecutionContext, frame: Frame, executor: VMExecutor) => Frame | null;

// `depth` counts nested direct calls on the js stack; past MAX_JS_DEPTH calls go through heap frames instead. `marks` is
// the continuation's mark list and `mframe` the logical frame the function runs in (a tail call keeps its caller's)
export type DirectFn = (ctx: ExecutionContext, closure: Closure, executor: VMExecutor, depth: number, marks: any, mframe: number, ...args: any[]) => any;

// an intrinsic some code uses: its position in the table the code is bound to, and what it was compiled as
export type UsedIntrinsic = { readonly pos: number, readonly name: string, readonly leaf: boolean };

// instruction arrays that several ByteCode copies run (see ByteCode.fresh)
export const SHARED_INSTS = new WeakSet<Uint32Array>();

export class ByteCode implements SerializableBytecode {
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

    // lineTable holds (ip, fileIdx, line, col) entries sorted by ip; each covers the code up to the next entry
    constructor(
        public constants: any[],
        public inst: Uint32Array,
        public numReg: number,
        public lineTable: Uint32Array = new Uint32Array(0),
        public files: string[] = [],
        // compiled in debug mode: records tail calls and exact error positions (never mixed with non-debug code)
        public debug: boolean = false,
        // the intrinsics CALLINT/CALLHOST operands are positions in; null when `intrinsics` is empty (or before loading binds it)
        public table: Intrinsics | null = null,
        // metadata: the intrinsics the code uses, by name (for binding to another table, serialization and disassembly)
        public intrinsics: readonly UsedIntrinsic[] = []
    ) {}

    // Makes the operands positions in `table`, by name: an error if an intrinsic is missing or its leaf flag differs from
    // the one the code was compiled for (either way). Rewrites the instructions (copying them if other code runs them)
    // only when a position moves. Binding to null leaves the code unbound (a cached copy): it runs once bound again
    bind(table: Intrinsics | null): void {
        if (this.intrinsics.length === 0 || table === this.table) return;
        if (table === null) {
            this.table = null;
            return;
        }
        const moved = new Map<number, number>();
        const bound = this.intrinsics.map(used => {
            const entry = table.byName(used.name);
            if (entry === undefined) throw new Error(`bytecode uses the intrinsic '${used.name}', which is not registered`);
            if (entry.leaf !== used.leaf) {
                throw new Error(`bytecode was compiled with '${used.name}' as ${used.leaf ? "a leaf" : "not a leaf"}, but it is registered as ${entry.leaf ? "a leaf" : "not a leaf"}`);
            }
            if (entry.pos !== used.pos) moved.set(used.pos, entry.pos);
            return { pos: entry.pos, name: used.name, leaf: used.leaf };
        });
        if (moved.size > 0) {
            const inst = SHARED_INSTS.has(this.inst) ? this.inst.slice() : this.inst;
            for (let ip = 0; ip < inst.length; ip += INSTRUCTION_LENGTHS[inst[ip] as OpCode]) {
                for (const off of INTRINSIC_OPERANDS[inst[ip]]) inst[ip + off] = moved.get(inst[ip + off]) ?? inst[ip + off];
            }
            this.inst = inst;
        }
        this.intrinsics = bound;
        this.table = table;
    }

    // whether this code or any code it contains uses intrinsics
    #usesIntrinsics: boolean | null = null;
    get usesIntrinsics(): boolean {
        return this.#usesIntrinsics ??= this.intrinsics.length > 0 || this.constants.some(c =>
            (c instanceof ClosureTemplate && c.code.usesIntrinsics) || (c instanceof Closure && c.tmpl.code.usesIntrinsics));
    }

    // whether this code (and all it contains) would call the same thing through `table` as through its own: every
    // intrinsic it uses is there at the same position, with the same function, template and deps
    runsWith(table: Intrinsics | null): boolean {
        if (table === this.table || !this.usesIntrinsics) return true;
        const own = this.table;
        if (table === null || own === null) return false;
        for (const { pos } of this.intrinsics) {
            const mine: Intrinsic = own.entries[pos];
            const theirs: Intrinsic | undefined = table.entries[pos];
            // a table copied from this code's (or from the same base) holds the very same entry
            if (theirs !== mine) {
                if (theirs === undefined || theirs.name !== mine.name || theirs.fn !== mine.fn || theirs.leaf !== mine.leaf || theirs.inline !== mine.inline) return false;
                for (const dep in mine.deps) if (theirs.deps[dep] !== mine.deps[dep]) return false;
                for (const dep in theirs.deps) if (!(dep in mine.deps)) return false;
            }
            for (const dep in mine.deps) {
                const slot = +mine.deps[dep].substring(1);
                if (table.deps[slot] !== own.deps[slot]) return false;
            }
        }
        return this.constants.every(c => !(c instanceof ClosureTemplate || c instanceof Closure) || (c instanceof Closure ? c.tmpl.code : c.code).runsWith(table));
    }

    // a copy with its own runtime state, bound to `table`; copies share instructions unless binding moves positions
    fresh(copies: Map<ByteCode, ByteCode> = new Map(), table: Intrinsics | null = this.table): ByteCode {
        const known = copies.get(this);
        if (known !== undefined) return known;
        const copy = new ByteCode([], this.inst, this.numReg, this.lineTable, this.files, this.debug, this.table, this.intrinsics);
        copies.set(this, copy);
        SHARED_INSTS.add(this.inst);
        copy.bind(table);
        copy.constants = this.constants.map(c => {
            if (c instanceof ClosureTemplate) return c.withCode(c.code.fresh(copies, table));
            // a closure with no upvars (made once, when compiled) is shared by the copies, unless it must be bound
            if (c instanceof Closure && !c.tmpl.code.runsWith(table)) {
                return Closure.fromTemplate(c.tmpl.withCode(c.tmpl.code.fresh(copies, table)), c.debugName);
            }
            return c;
        });
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
        bs.writeArray(this.intrinsics.flatMap(({ pos, name, leaf }) => [pos, name, leaf]));
    }

    // loaded code is bound to `table`, by name; without one, to the core operations (code that uses others needs a table)
    static register(bsr: BSReader, table: Intrinsics | null = null) {
        bsr.registerFactory("ByteCode", (bsr) => {
            const inst = bsr.readU32Arr();
            const constants = bsr.readArray();
            const numReg = bsr.readU32();
            const lineTable = bsr.readU32Arr();
            const files = bsr.readArray() as string[];
            const debug = bsr.read() as boolean;
            const flat = bsr.readArray();
            const intrinsics: UsedIntrinsic[] = [];
            for (let i = 0; i < flat.length; i += 3) intrinsics.push({ pos: flat[i], name: flat[i + 1], leaf: flat[i + 2] });
            if (table === null && intrinsics.some(used => CORE_INTRINSICS.byName(used.name) === undefined)) {
                throw new Error("bytecode that uses intrinsics needs an intrinsics table to load");
            }
            const code = new ByteCode(constants, inst, numReg, lineTable, files, debug, null, intrinsics);
            code.bind(table ?? CORE_INTRINSICS);
            return code;
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

    // how it binds its arguments: every call binds them through this (see bindArgs)
    readonly arity: Arity;

    // `restArray`: the rest parameter is only ever spread back into a call (the compiler's analysis proves it), so it is
    // bound to a plain array of the rest arguments rather than a list, and only APPLY / APPLYINTR ever read it
    constructor(params: symbol[], remParams: symbol | null, code: ByteCode, upvarLocs: UpVarLoc[], public name: string | null = null, public restArray: boolean = false) {
        this.params = params;
        this.remParams = remParams;
        this.code = code;
        this.upvarLocs = upvarLocs;
        this.arity = closureArity(params.length, remParams === null ? "none" : restArray ? "array" : "list");
    }

    // the same template running other code
    withCode(code: ByteCode): ClosureTemplate {
        return new ClosureTemplate(this.params, this.remParams, code, this.upvarLocs, this.name, this.restArray);
    }

    dump(bs: BS) {
        bs.writeValue(this.params);
        bs.writeValue(this.remParams);
        bs.writeValue(this.code);
        bs.writeValue(this.upvarLocs);
        bs.writeValue(this.name);
        bs.writeValue(this.restArray);
    }

    static register(bsr: BSReader) {
        bsr.registerFactory("ClosureTemplate", (bsr) => {
            const params = bsr.read() as symbol[];
            const remParams = bsr.read() as symbol | null;
            const code = bsr.readSerializable<ByteCode>("ByteCode");
            const upvarLocs = bsr.readArray() as UpVarLoc[];
            const name = bsr.read() as string | null;
            const restArray = bsr.read() as boolean;
            return new ClosureTemplate(params, remParams, code, upvarLocs, name, restArray);
        });
    }
}

/** An actual anima closure bound to a scope */
export class Closure extends IProcedure implements SerializableBytecode {
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
