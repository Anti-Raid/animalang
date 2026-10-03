// Compiled code: Code (instructions, constants, the intrinsics it is bound to) and closures
import { IProcedure, Msg, vmError } from "../common";
import type { SourcePos } from "../common";
import { closureArity } from "./arity";
import type { Arity, RestKind } from "./arity";
import type { VMExecutor } from "./executor";
import { Intrinsics, type Intrinsic, type IntrinsicFn } from "./intrinsics";
import type { ExecutionContext, Frame } from "./values";
import type { Op } from "./ops";

// what the executor needs of the VM it runs for (AnimaVM)
export type VMHost = { readonly intrinsics: Intrinsics, print(v: any): string, message<E>(err: E, at?: SourcePos | null): E };

export type ResumeFn = (ctx: ExecutionContext, frame: Frame, executor: VMExecutor) => Frame | null;

// `depth` counts nested direct calls on the js stack; past MAX_JS_DEPTH calls go through heap frames instead. `marks` is
// the continuation's mark list and `mframe` the logical frame the function runs in (a tail call keeps its caller's)
export type DirectFn = (ctx: ExecutionContext, closure: Closure, executor: VMExecutor, depth: number, marks: any, mframe: number, ...args: any[]) => any;

// an intrinsic some code uses: its position in the table the code is bound to, and what it was compiled as
export type UsedIntrinsic = { readonly pos: number, readonly name: string, readonly leaf: boolean };

// a procedure the optimizer inlined: its body is the code in [start, end), called at `at` (in tail position if `tail`)
// from the code around it, which is the site `parent` (an index into Code.inlines) or the function itself (-1)
export type InlineSite = { start: number, end: number, readonly name: string, readonly at: SourcePos | null, readonly tail: boolean, readonly parent: number };

// instruction lists that several Code copies run (see Code.fresh)
export const SHARED_OPS = new WeakSet<readonly Op[]>();

export class Code {
    public resumeFn: ResumeFn | null = null;
    public directFn: DirectFn | null = null;
    public directArity: number = -1;
    public directRestArity: number = -1;
    // a padded closure with no rest parameter: its direct entry takes any count (JS fills missing arguments with
    // undefined, <#void>, and ignores extra ones)
    public directPad: boolean = false;
    // how often a direct call of this function ended in a suspend for call/cc, a continuation, a yield or a resume (see
    // resumeSuspend)
    public controlSuspends: number = 0;
    // how often direct code of this function resumed a coroutine in a nested driver loop: past a few, it suspends to heap
    // frames instead, where resuming is a cheap switch inside one loop
    public nestedResumes: number = 0;
    // the VM's own helper code (see helperClosure), left out of tracebacks and frame lists
    public internal: boolean = false;
    // how often a tail call from this function's heap code into a direct entry came back as a Suspend (e.g. a long chain
    // of tail calls reaching the depth limit): past a few, its heap code tail calls through heap frames, which run such
    // chains in constant space without unwinding the js stack
    public tailSuspends: number = 0;
    // the pack intrinsic a packed rest parameter is made with (see RestKind), or -1
    public restPos: number = -1;
    // compiled with interrupt checks (see Intrinsics.setInterruptHandler)
    public interrupts: boolean = false;
    // the procedures inlined into this code, for tracebacks (see inlinedAt)
    public inlines: readonly InlineSite[] = [];

    // lineTable holds (ip, fileIdx, line, col) entries sorted by ip; each covers the code up to the next entry
    constructor(
        public constants: any[],
        public ops: readonly Op[],
        public numReg: number,
        public lineTable: Uint32Array = new Uint32Array(0),
        public files: string[] = [],
        // compiled in debug mode: records tail calls and exact error positions (never mixed with non-debug code)
        public debug: boolean = false,
        // the intrinsics the instructions' `pos` are positions in; null when `intrinsics` is empty
        public table: Intrinsics | null = null,
        // metadata: the intrinsics the code uses, by name (for binding to another table)
        public intrinsics: readonly UsedIntrinsic[] = []
    ) {}

    get pack(): IntrinsicFn | null {
        return this.restPos === -1 ? null : this.table!.fns[this.restPos];
    }

    // Makes the instructions' intrinsic positions positions in `table`, by name: an error if an intrinsic is missing or its
    // leaf flag differs from the one the code was compiled for (either way). Copies the instructions only when a position
    // moves. Binding to null leaves the code unbound (a cached copy): it runs once bound again
    bind(table: Intrinsics | null): void {
        if (this.intrinsics.length === 0 || table === this.table) return;
        if (table === null) {
            this.table = null;
            return;
        }
        const moved = new Map<number, number>();
        const bound = this.intrinsics.map(used => {
            const entry = table.byName(used.name);
            if (entry === undefined) throw new Error(`code uses the intrinsic '${used.name}', which is not registered`);
            if (entry.leaf !== used.leaf) {
                throw new Error(`code was compiled with '${used.name}' as ${used.leaf ? "a leaf" : "not a leaf"}, but it is registered as ${entry.leaf ? "a leaf" : "not a leaf"}`);
            }
            if (entry.pos !== used.pos) moved.set(used.pos, entry.pos);
            return { pos: entry.pos, name: used.name, leaf: used.leaf };
        });
        if (moved.size > 0) {
            this.ops = this.ops.map(op => {
                if (op.k !== "HostCall" && op.k !== "IntCall" && op.k !== "IntApply") return op;
                const pos = moved.get(op.pos);
                return pos === undefined ? op : { ...op, pos };
            });
            this.restPos = moved.get(this.restPos) ?? this.restPos;
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
        if (table === null || own === null || table.types !== own.types) return false;
        for (const { pos } of this.intrinsics) {
            const mine: Intrinsic = own.entries[pos];
            const theirs: Intrinsic | undefined = table.entries[pos];
            // a table copied from this code's (or from the same base) holds the very same entry
            if (theirs !== mine) {
                if (theirs === undefined || theirs.name !== mine.name || theirs.fn !== mine.fn || theirs.leaf !== mine.leaf || theirs.inline !== mine.inline || !Intrinsics.sameFacts(theirs, mine)) return false;
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
    fresh(copies: Map<Code, Code> = new Map(), table: Intrinsics | null = this.table): Code {
        const known = copies.get(this);
        if (known !== undefined) return known;
        const copy = new Code([], this.ops, this.numReg, this.lineTable, this.files, this.debug, this.table, this.intrinsics);
        copies.set(this, copy);
        copy.restPos = this.restPos;
        copy.interrupts = this.interrupts;
        copy.inlines = this.inlines;
        SHARED_OPS.add(this.ops);
        copy.bind(table);
        copy.constants = this.constants.map(c => {
            if (c instanceof ClosureTemplate) return c.withCode(c.code.fresh(copies, table));
            // a closure with no upvars (made once, when compiled) is shared by the copies, unless it must be bound. Its code's
            // adaptive counters and compiled functions are then shared too: deliberately, as they only choose how the same
            // code runs, and a copy per instance would compile every prelude function for each one (see the README)
            if (c instanceof Closure && !c.tmpl.code.runsWith(table)) {
                return Closure.fromTemplate(c.tmpl.withCode(c.tmpl.code.fresh(copies, table)), c.debugName);
            }
            return c;
        });
        return copy;
    }

    // the inlined procedure a frame is running given its Frame.isite, and where in it, its last call being at `ip`: as
    // for a frame of its own, the call it is in, the start of the procedure if it has made none, or the call of a
    // procedure it inlined when that is the last call it made (or has just returned from)
    frameAt(isite: number, ip: number): { site: number, pos: SourcePos | null } {
        if (isite >= -1) return { site: isite, pos: this.positionIn(isite, ip) };
        const from = this.inlines[-isite - 2];
        return { site: from.parent, pos: ip < from.end ? from.at : this.positionIn(from.parent, ip) };
    }

    positionIn(site: number, ip: number): SourcePos | null {
        if (site === -1) return this.inlines.length === 0 ? this.positionAt(ip) : this.#outside(-1, ip);
        const s = this.inlines[site];
        if (ip < s.start || ip >= s.end) return this.positionAt(Math.min(s.start + 1, s.end));
        return this.#outside(site, ip);
    }

    // the position of `ip` in the code of `site`, outside the procedures inlined into it
    #outside(site: number, ip: number): SourcePos | null {
        let inner = -1;
        this.inlines.forEach((s, i) => { if (s.start <= ip && ip < s.end && i > site && (inner === -1 || s.start >= this.inlines[inner].start)) inner = i; });
        while (inner !== -1 && this.inlines[inner].parent !== site) inner = this.inlines[inner].parent;
        return inner === -1 ? this.positionAt(ip) : this.inlines[inner].at;
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
}

export type UpVarLoc = { index: number; local: boolean };

/** A template for a closure that can then be bound to a scope */
export class ClosureTemplate {
    params: symbol[]; // base (individual param binds)
    remParams: symbol | null; // where the remaining params should be bound too (if any). This implicitly makes a closure variadic as well
    code: Code;
    upvarLocs: UpVarLoc[]; // what upvars do we need to capture

    // how it binds its arguments: every call binds them through this (see bindArgs)
    readonly arity: Arity;

    constructor(params: symbol[], remParams: symbol | null, code: Code, upvarLocs: UpVarLoc[], public name: string | null = null, public rest: RestKind = "array", public pad: boolean = false) {
        this.params = params;
        this.remParams = remParams;
        this.code = code;
        this.upvarLocs = upvarLocs;
        this.arity = closureArity(params.length, remParams === null ? "none" : rest, pad);
    }

    // the same template running other code
    withCode(code: Code): ClosureTemplate {
        return new ClosureTemplate(this.params, this.remParams, code, this.upvarLocs, this.name, this.rest, this.pad);
    }
}

/** An actual anima closure bound to a scope */
export class Closure extends IProcedure {
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
}

// what a %lambda of several clauses makes: a call runs the first clause whose arity fits
export class CaseLambda extends IProcedure {
    constructor(readonly clauses: readonly Closure[], debugName: string = clauses[0]?.debugName ?? "case-lambda") {
        super(debugName);
    }

    select(nargs: number): Closure {
        for (const clause of this.clauses) {
            const arity = clause.tmpl.arity;
            if (nargs >= arity.min && nargs <= arity.max) return clause;
        }
        throw vmError(Msg.NoClause, this.debugName, nargs);
    }
}

export const createRegs = (numRegs: number) => {
    const regs: any[] = [];
    for (let i = 0; i < numRegs; i++) regs.push(undefined);
    return regs;
};
