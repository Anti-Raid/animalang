import type { UpVarLoc } from "./exec";

export type Resolve = { type: "Global" } | { type: "Local", index: number } | { type: "Upvar", index: number }

export class VariableMetadata {
    // only an assigned variable can need a box: a closure sharing it must see the assignments (one that is never assigned
    // is copied into the closure instead), and so must continuations, which restore a frame's registers when re-entered;
    // that is only visible if it is read after a call (where one may be captured) before being assigned again
    get isBoxed() { return this.mutable && (this.isCaptured || this.liveAcrossCall) }

    // set by AstAnalysis's second pass
    liveAcrossCall: boolean = false

    // a lambda's rest parameter, and whether it is read anywhere but spread as the last argument of an %apply
    isRestParam: boolean = false
    readOutsideApply: boolean = false

    // a rest parameter only ever spread back into a call is never packed: the closure receives its rest arguments as a
    // plain array instead, which only %apply ever sees
    get forwardsRest() { return this.isRestParam && !this.mutable && !this.isCaptured && !this.readOutsideApply }

    // `scope`: the scope it is defined in
    constructor(public mutable: boolean = false, public isCaptured: boolean = false, readonly scope: AnalysisScope | null = null) {}
}

// the most scopes a name is looked for in one by one, innermost first: one not found by then is looked up where the
// whole tree of scopes keeps what is bound where, so a name bound thousands of scopes out, or nowhere, costs no walk
const NEAR = 4;

// a scope inside others, which can say whether another is around it without walking out to it
class Nested<S extends Nested<S>> {
    readonly depth: number;
    // a scope further out, the scope around this one at any depth being a few of these steps away: found when first
    // asked for, as few scopes are ever asked
    #jump: Nested<S> | null = null;

    constructor(readonly outer: S | null) {
        this.depth = outer === null ? 0 : outer.depth + 1;
    }

    #jumpFrom(): Nested<S> {
        if (this.#jump !== null) return this.#jump;
        const without: Nested<S>[] = [];
        let scope: Nested<S> = this;
        for (; scope.#jump === null && scope.outer !== null; scope = scope.outer) without.push(scope);
        if (scope.#jump === null) scope.#jump = scope;
        for (let i = without.length - 1; i >= 0; i--) {
            const outer = without[i].outer!, jump = outer.#jump!;
            without[i].#jump = outer.depth - jump.depth === jump.depth - jump.#jump!.depth ? jump.#jump : outer;
        }
        return this.#jump!;
    }

    // whether `scope` is this one or around it
    isWithin(scope: S): boolean {
        let at: Nested<S> = this;
        while (at.depth > scope.depth) {
            const jump = at.#jumpFrom();
            at = jump.depth >= scope.depth ? jump : at.outer!;
        }
        return at === scope;
    }
}

// a scope with what it binds names to, over those of the scopes around it
export class Scope<V> extends Nested<Scope<V>> {
    readonly #own = new Map<symbol, V>();
    // the one scope each name is bound in, or null for a name bound in several (which the walk finds)
    readonly #homes: Map<symbol, Scope<V> | null>;

    constructor(outer: Scope<V> | null = null) {
        super(outer);
        this.#homes = outer === null ? new Map() : outer.#homes;
    }

    set(sym: symbol, value: V): void {
        const own = this.#own, homes = this.#homes, before = own.size, known = homes.size;
        own.set(sym, value);
        // (bound here already: its home is as it was)
        if (own.size === before) return;
        homes.set(sym, this);
        if (homes.size === known) homes.set(sym, null);
    }

    // what `sym` is bound to here: in the innermost scope, from this one out, that binds it
    get(sym: symbol): V | undefined {
        let scope: Scope<V> | null = this;
        for (let i = 0; i < NEAR && scope !== null; i++, scope = scope.outer) {
            const value = scope.#own.get(sym);
            if (value !== undefined) return value;
        }
        if (scope === null) return undefined;
        const home = this.#homes.get(sym);
        if (home === undefined) return undefined;
        if (home !== null) return scope.isWithin(home) ? home.#own.get(sym) : undefined;
        for (; scope !== null; scope = scope.outer) {
            const value = scope.#own.get(sym);
            if (value !== undefined) return value;
        }
        return undefined;
    }
}

// a function body (%lambda, or the top level) or a block inside one (%let); only function boundaries capture
export class AnalysisScope extends Nested<AnalysisScope> {
    #vals = new Map<symbol, VariableMetadata>()
    // every variable defined in this scope and the scopes inside it, by name (locals have names of their own, see
    // passes/rename.ts)
    readonly variables: Map<symbol, VariableMetadata>;
    // the names defined more than once (code generation rejects one bound twice in a group, so rename leaves it)
    readonly #repeated: Set<symbol>;
    // how deep the function this scope is in is
    readonly #function: number;

    constructor(outer: AnalysisScope | null, readonly isFunction: boolean = true) {
        super(outer);
        this.variables = outer?.variables ?? new Map();
        this.#repeated = outer === null ? new Set() : outer.#repeated;
        this.#function = isFunction || outer === null ? this.depth : outer.#function;
    }

    dbgPrint() {
        for(const [sym, md] of this.#vals.entries()) {
            console.debug(JSON.stringify({sym: sym.description, md: { ...md, scope: undefined }}))
        }
    }

    define(sym: symbol) {
        const meta = new VariableMetadata(false, false, this);
        const variables = this.variables, known = variables.size;
        this.#vals.set(sym, meta);
        variables.set(sym, meta);
        if (variables.size === known) this.#repeated.add(sym);
    }

    getVarinfo(sym: symbol): VariableMetadata | null {
        let scope: AnalysisScope | null = this;
        for (let i = 0; i < NEAR && scope !== null; i++, scope = scope.outer) {
            const meta = scope.#vals.get(sym);
            if (meta !== undefined) return meta;
        }
        return scope === null ? null : scope.#far(sym, false);
    }

    // the variable's metadata, marked captured if a function boundary lies between here and its definition
    #use(sym: symbol): VariableMetadata | null {
        let crossedFunction = false;
        let scope: AnalysisScope | null = this;
        for (let i = 0; i < NEAR && scope !== null; i++, scope = scope.outer) {
            const meta = scope.#vals.get(sym);
            if (meta !== undefined) {
                if (crossedFunction) meta.isCaptured = true;
                return meta;
            }
            if (scope.isFunction) crossedFunction = true;
        }
        return scope === null ? null : scope.#far(sym, crossedFunction, true);
    }

    // the same from here out, for a variable not found further in: `crossedFunction` as #use has it so far, and `mark`
    // whether to mark the variable captured
    #far(sym: symbol, crossedFunction: boolean, mark: boolean = false): VariableMetadata | null {
        const meta = this.variables.get(sym);
        if (meta === undefined) return null;
        if (this.#repeated.size === 0 || !this.#repeated.has(sym)) {
            // defined once: here, if its scope is around this one
            const home = meta.scope!;
            if (!this.isWithin(home)) return null;
            if (mark && (crossedFunction || this.#function > home.depth)) meta.isCaptured = true;
            return meta;
        }
        for (let scope: AnalysisScope | null = this; scope !== null; scope = scope.outer) {
            const found = scope.#vals.get(sym);
            if (found !== undefined) {
                if (mark && crossedFunction) found.isCaptured = true;
                return found;
            }
            if (scope.isFunction) crossedFunction = true;
        }
        return null;
    }

    readVar(sym: symbol): boolean {
        const meta = this.#use(sym);
        if (meta !== null) meta.readOutsideApply = true;
        return meta !== null;
    }

    // a read spread as the last argument of an %apply, which a forwarded rest parameter allows
    readApplyList(sym: symbol) {
        this.#use(sym);
    }

    markMutable(sym: symbol) {
        const meta = this.#use(sym);
        if (meta !== null) meta.mutable = true;
    }
}

/** 
 * Tracks/'simulates' block-level variable shadowing (within a function) at compile-time 
 * 
 * Used internally for optimizing out IIFE's etc.
*/
export class Block {
    #allocatedRegs = new Map<number, symbol>();
    // the registers of the variables further out that this block's variables hide
    #hidden: Map<symbol, number> | null = null;
    parent: Block | null;

    constructor(parent: Block | null = null) {
        this.parent = parent;
    }

    // `regs`: the register of each variable in the function's open blocks, which now has this one
    bind(sym: symbol, reg: number, regs: Map<symbol, number>) {
        const before = regs.get(sym);
        // (one of this block's own: the name is bound twice here, and hides nothing further out)
        if (before !== undefined && !this.#allocatedRegs.has(before)) (this.#hidden ??= new Map()).set(sym, before);
        this.#allocatedRegs.set(reg, sym)
        regs.set(sym, reg);
    }

    // the block ends: `regs` is as it was before it
    unbind(regs: Map<symbol, number>) {
        for (const sym of this.#allocatedRegs.values()) {
            const before = this.#hidden?.get(sym);
            if (before === undefined) regs.delete(sym);
            else regs.set(sym, before);
        }
    }

    getBoundRegs() {
        return this.#allocatedRegs.keys()
    }
}

/** Helper utility for keeping track of variable scoping */
export class CompilerScope {
    // Keeps track of variables that have been shadowed etc.
    currBlock: Block = new Block();
    regAlloc: RegAlloc = new RegAlloc();
    // the register of each variable of the open blocks (of the innermost, for a name several bind)
    readonly #regs = new Map<symbol, number>();

    outer: CompilerScope | null;
    // the variables a lambda captures, in upvar order (see passes/closures.ts)
    readonly captures: readonly symbol[];

    constructor(outer: CompilerScope | null, captures: readonly symbol[] = []) {
        this.outer = outer;
        this.captures = captures;
    }

    // where the closure finds each captured variable when it is made: a register of the function around it, or one of
    // that function's own upvars
    get upvars(): UpVarLoc[] {
        return this.captures.map(sym => {
            const at = this.outer!.resolve(sym);
            if (at.type === "Global") throw new Error(`internal error: captured ${String(sym.description)} is not a variable around the lambda`);
            return { local: at.type === "Local", index: at.index };
        });
    }

    get numRegs() {
        return this.regAlloc.total
    }

    enterBlock() {
        this.currBlock = new Block(this.currBlock);
    }

    exitBlock() {
        for (const reg of this.currBlock.getBoundRegs()) {
            this.regAlloc.free(reg);
        }
        this.currBlock.unbind(this.#regs);

        if (this.currBlock.parent) {
            this.currBlock = this.currBlock.parent;
        } else {
            throw new Error("internal error: cannot exit root block of CompilerScope.");
        }
    }
    
    // Returns the register the variable will be at
    addLocal(sym: symbol) {
        const reg = this.regAlloc.alloc();
        this.currBlock.bind(sym, reg, this.#regs);
        this.regAlloc.hold(reg);
        return reg;
    }

    allocTemp(): number {
        return this.regAlloc.alloc();
    }

    freeTemp(reg: number) {
        // If its not allocated on the block, then we can free it, otherwise, we cant
        if (!this.regAlloc.isHeld(reg)) {
            this.regAlloc.free(reg);
        }
    }

    // Returns the result of resolving
    resolve(sym: symbol): Resolve {
        const index = this.#regs.get(sym)
        if (index !== undefined) return { type: 'Local', index }
        if (!this.outer) return { type: "Global" }
        const upvar = this.captures.indexOf(sym)
        if (upvar !== -1) return { type: "Upvar", index: upvar }
        for (let scope: CompilerScope | null = this.outer; scope !== null; scope = scope.outer) {
            if (scope.#regs.has(sym) || (scope.outer !== null && scope.captures.includes(sym))) {
                throw new Error(`internal error: ${String(sym.description)} is used but not captured`)
            }
        }
        return { type: "Global" }
    }
}

// the most registers a free one is looked for among by reading them all: past that, the free ones are kept listed
const MAX_SCANNED = 256;

export class RegAlloc {
    // per register: 0 free, 1 in use, 2 in use by a variable of an open block (held)
    used: Uint8Array = new Uint8Array(64); 
    nreg: number = 0;
    // once there are more than MAX_SCANNED: the free registers below nreg, as runs [start, end) in order, no run
    // touching the next
    #starts: number[] | null = null;
    #ends: number[] = [];

    alloc(): number {
        // Look for a reg we can reuse
        if (this.#starts !== null) {
            if (this.#starts.length > 0) return this.#take(0, 1);
        } else {
            for (let i = 0; i < this.nreg; i++) {
                if (this.used[i] === 0) {
                    this.used[i] = 1;
                    return i;
                }
            }
        }
        // Worst case: expand the nregs
        return this.#expandAndClaim(1);
    }

    allocBlock(n: number): number {
        // Look for a consecutive block of reg's we can reuse
        const starts = this.#starts;
        if (starts !== null) {
            const ends = this.#ends;
            for (let i = 0; n > 0 && i < starts.length; i++) {
                if (ends[i] - starts[i] >= n) return this.#take(i, n);
            }
        } else {
            let consecutive = 0;
            let start = -1;
            for (let i = 0; i < this.nreg; i++) {
                if (this.used[i] === 0) {
                    if (consecutive === 0) start = i;
                    consecutive++;

                    if (consecutive === n) {
                        this.used.fill(1, start, start + n);
                        return start;
                    }
                } else {
                    consecutive = 0;
                }
            }
        }
        // Worst case: expand the nregs
        return this.#expandAndClaim(n);
    }

    // the first `n` registers of free run `i`
    #take(i: number, n: number): number {
        const starts = this.#starts!, start = starts[i];
        this.used.fill(1, start, start + n);
        if (start + n === this.#ends[i]) {
            starts.splice(i, 1);
            this.#ends.splice(i, 1);
        } else starts[i] = start + n;
        return start;
    }

    free(reg: number) {
        if (this.#starts === null) this.used[reg] = 0;
        else if (this.used[reg] !== 0) {
            this.used[reg] = 0;
            this.#release(reg);
        }
    }

    freeBlock(start: number, n: number) {
        if (this.#starts === null) this.used.fill(0, start, start + n);
        else for (let reg = start; reg < start + n; reg++) this.free(reg);
    }

    // a variable is in `reg` until its block ends
    hold(reg: number) {
        this.used[reg] = 2;
    }

    isHeld(reg: number): boolean {
        return this.used[reg] === 2;
    }

    // `reg`, now free, goes into the runs
    #release(reg: number) {
        const starts = this.#starts!, ends = this.#ends;
        // the first run after `reg`
        let at = 0;
        for (let end = starts.length; at < end;) {
            const mid = (at + end) >> 1;
            if (starts[mid] < reg) at = mid + 1;
            else end = mid;
        }
        const before = at > 0 && ends[at - 1] === reg, after = at < starts.length && starts[at] === reg + 1;
        if (before && after) {
            ends[at - 1] = ends[at];
            starts.splice(at, 1);
            ends.splice(at, 1);
        } else if (before) ends[at - 1] = reg + 1;
        else if (after) starts[at] = reg;
        else {
            starts.splice(at, 0, reg);
            ends.splice(at, 0, reg + 1);
        }
    }

    #expandAndClaim(n: number): number {
        const start = this.nreg;
        this.nreg += n;
    
        // Resize the used array
        if (this.nreg > this.used.length) {
            const newArray = new Uint8Array(Math.max(this.nreg, this.used.length * 2));
            newArray.set(this.used);
            this.used = newArray;
        }
        
        this.used.fill(1, start, start + n);
        if (this.#starts === null && this.nreg > MAX_SCANNED) {
            this.#starts = [];
            for (let reg = 0; reg < start; reg++) if (this.used[reg] === 0) this.#release(reg);
        }
        return start;
    }

    get total() { return this.nreg; }
}
