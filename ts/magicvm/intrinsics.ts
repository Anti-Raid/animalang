import { Msg, opName, type Formatter } from "../common";
// AOT inlining: given the js expressions of the arguments and of a call to the operation itself (the fallback, which
// reports errors), returns a js expression computing the result, or null to always make the call. `tmp` names a scratch
// variable the expression may assign; `d` maps each declared dep to the local variable holding it
// Kinds of values, for the AOT compiler's type facts (see aot/facts.ts): names a front end chooses and gives meaning
// (TypeSystem), except "boolean", which the VM knows (it decides truthiness)
export type Kind = string;
export type ArgKinds = readonly (Kind | undefined)[];

// what an intrinsic returns (or else it throws): always a kind, or a kind given what is known of its arguments' kinds
export type Returns = Kind | ((kinds: ArgKinds) => Kind | undefined);

// A front end's kinds: `ofConstant` gives a literal's kind; `guard` a js test that `expr` is of `kind` (a version of a
// function for parameters of that kind checks them with it), or null; `coerce` wraps an expression known to give a
// value of `kind` so V8 sees that kind too (a template's slow path), or null. `deps`: values `guard` refers to, as ${d.name}
export type TypeSystem = {
    ofConstant(value: any): Kind | undefined,
    guard(kind: Kind, expr: string, d: Readonly<Record<string, string>>): string | null,
    coerce?(kind: Kind, expr: string): string | null,
    deps?: Record<string, unknown>,
    // the front end's code never keeps multiple values in a variable (a parameter, a local, a global): what it reads
    // from one is one value, which a procedure entered for one value may return as it is (see Code.oneFn)
    oneValueVariables?: boolean,
};

// `known`: for each argument, its kind when certain (see aot/facts.ts), so the template may skip checking it
export type InlineFn = (args: string[], slow: string, tmp: string, d: Readonly<Record<string, string>>, known: ArgKinds) => string | null;

// Reads only regs[start .. start+nargs), and never writes to regs or keeps it: in heap code it is the caller's frame's
// registers. A non-leaf may return hostTail(proc, ...args) instead of a value. `ctx` and `executor` (the running
// ExecutionContext and VMExecutor) are only passed to an intrinsic registered with `context` (the core operations)
export type IntrinsicFn = (regs: any[], start: number, nargs: number, ctx?: any, executor?: any) => any

export type IntrinsicOptions = {
    // [min, max] argument counts, checked at compile time
    args?: [number, number],
    // never calls back into the VM (never returns a tail request): an IntCall, and not a call for the boxing analysis
    leaf?: boolean,
    // AOT template: (argument expressions, the direct call, a scratch variable, the deps' local names) => js expression,
    // or null to make the direct call. Argument expressions are plain variables, so they may be repeated. Its code outside
    // the direct call must not throw: errors are the function's (an expression that never makes the call needs no
    // handler for where they happened)
    inline?: InlineFn,
    // values the inline template refers to, by name: the template reads them as ${d.name}
    deps?: Record<string, unknown>,
    // needs the execution context: called with (regs, start, nargs, ctx, executor), and its inline template may
    // use `ctx` and `executor`. Only for the VM's core operations: they are the same in every table, so code compiled
    // against one calls them the same way in any other
    context?: boolean,
    // a call in tail position is a tail call (the default): its value is the caller's. false for the control operations
    // whose value is that of the call itself (yielding, raising), which are then compiled as a call and a return
    tail?: boolean,
    // the table's sequences, which are arrays unless a front end has its own: "pack" makes one of its argument window
    // (a rest parameter's value), "spread" makes an array of one (what %apply takes last). Each at most once per table
    sequence?: "pack" | "spread",
    // returns a new array nothing else holds, which %apply may then call with as it is (as a spread intrinsic does)
    fresh?: boolean,
    // what it returns, for the AOT compiler's type facts
    returns?: Returns,
    // the kind its fast path wants its arguments to be: a version of a function for parameters of that kind reads it
    wants?: Kind,
    // given known argument kinds, what they are known to hold if the intrinsic completes without throwing
    refineArgs?: (known: ArgKinds) => ArgKinds,
    // when a branch tests this intrinsic's result, what its arguments are known to hold on then/else edges
    branchNarrow?: (known: ArgKinds) => { then?: ArgKinds, else?: ArgKinds },
    // marks logical negation (e.g. %not) so a branch testing it transposes then and else
    invertBranch?: boolean,
    // for the optimizer (passes/cp0.ts), of a leaf that takes no context. `foldable`: a call of it on constants may run
    // when compiling, its value used in its place: it has no effect, its value depends only on its arguments, and it is
    // never a new object (a number, string, boolean, or one of its arguments or a part of one). A call that throws is
    // left to run. `effectFree`: a call whose value is not used may be dropped: it has no effect and never throws
    foldable?: boolean,
    effectFree?: boolean,
    // it never returns multiple values (as one that declares the kind it returns does not either)
    oneValue?: boolean,
}

export type Intrinsic = {
    readonly name: string,
    readonly pos: number,
    readonly fn: IntrinsicFn,
    readonly min: number,
    readonly max: number,
    readonly leaf: boolean,
    readonly context: boolean,
    readonly tail: boolean,
    readonly fresh: boolean,
    readonly returns: Returns | undefined,
    readonly wants: Kind | undefined,
    readonly inline: InlineFn | undefined,
    // the local variable holding each dep in generated code (D<slot> for DEPS[slot])
    readonly deps: Readonly<Record<string, string>>,
    readonly refineArgs?: (known: ArgKinds) => ArgKinds,
    readonly branchNarrow?: (known: ArgKinds) => { then?: ArgKinds, else?: ArgKinds },
    readonly invertBranch?: boolean,
    readonly foldable: boolean,
    readonly effectFree: boolean,
    readonly oneValue: boolean,
}

// The intrinsics a compiler and VM are extended with: host functions called over a register window, inlined by AOT
// code when they have a template. Positions only ever grow at the end, so code compiled earlier stays valid; freeze()
// stops further registrations. `taken` tells which names the compiler already defines. Every table the compiler and VM
// use starts from CORE_INTRINSICS (exec.ts), the VM's own operations, so those are at the same positions in all of them
// (see newIntrinsics in core.ts)
export type FactRules = Pick<Intrinsic, "returns" | "wants" | "refineArgs" | "branchNarrow" | "invertBranch">;

export class Intrinsics {
    readonly entries: Intrinsic[] = []
    // entries[i].fn, by position: what instructions' `pos` index
    readonly fns: IntrinsicFn[] = []
    // every dep value, once: generated code reads DEPS[slot]
    readonly deps: unknown[] = []
    readonly #bySym = new Map<symbol, number>()
    #frozen = false
    // names code compiled with this table cannot bind, besides the intrinsics: a front end's keywords ("special form")
    // and the procedures it provides ("builtin")
    readonly reserved = new Map<symbol, "special form" | "builtin">()
    // globals whose definitions the optimizer may inline where they are called (see defineKnown)
    readonly known = new Map<symbol, { readonly lambda: any, readonly name: string }>()
    #pack: Intrinsic | undefined
    #spread: Intrinsic | undefined
    // how the VM's and the compiler's messages are worded (see Msg): the front end's formatter, if it sets one
    #format: Formatter = opName
    #types: TypeSystem | null = null
    // the interrupt handler's position, or -1 (see setInterruptHandler)
    #interruptHandler: number = -1
    // the locals of the type system's deps in generated code, by name
    #typeDeps: Record<string, string> = {}

    // `base`: a table to start from (its entries at the same positions, and its reserved names)
    // made from a base table (every table but the core operations' own)
    readonly #derived: boolean

    constructor(private readonly taken: (sym: symbol) => boolean = () => false, base?: Intrinsics) {
        this.#derived = base !== undefined
        if (base === undefined) return
        this.entries.push(...base.entries)
        this.fns.push(...base.fns)
        this.deps.push(...base.deps)
        for (const [sym, pos] of base.#bySym) this.#bySym.set(sym, pos)
        for (const [sym, kind] of base.reserved) this.reserved.set(sym, kind)
        for (const [sym, def] of base.known) this.known.set(sym, def)
        this.#pack = base.#pack
        this.#spread = base.#spread
        this.#format = base.#format
        this.#types = base.#types
        this.#typeDeps = base.#typeDeps
        this.#interruptHandler = base.#interruptHandler
    }

    get frozen(): boolean {
        return this.#frozen
    }

    freeze(): this {
        this.#frozen = true
        return this
    }

    register(name: string, fn: IntrinsicFn, options: IntrinsicOptions = {}): Intrinsic {
        if (this.#frozen) throw new Error(`cannot register '${name}': the intrinsics are frozen`)
        if (typeof name !== "string" || !name.startsWith("%") || name.length === 1) throw new Error(`intrinsic names start with '%', but got '${String(name)}'`)
        if (typeof fn !== "function") throw new Error(`the intrinsic '${name}' must be a function`)
        if (options.context && this.#derived) throw new Error(`the intrinsic '${name}' cannot take the context: only the VM's core operations do`)
        const sym = Symbol.for(name)
        if (this.taken(sym) || this.#bySym.has(sym)) throw new Error(`'${name}' is already defined`)
        const [min, max] = options.args ?? [0, Infinity]
        if (!(Number.isInteger(min) && min >= 0 && (max === Infinity || Number.isInteger(max)) && max >= min)) {
            throw new Error(`the intrinsic '${name}' has a bad argument count range [${min}, ${max}]`)
        }
        if (options.sequence !== undefined && this[options.sequence] !== undefined) throw new Error(`the table already has a sequence ${options.sequence} intrinsic`)
        if (options.sequence !== undefined && !(options.leaf ?? false)) throw new Error(`the sequence ${options.sequence} intrinsic '${name}' must be a leaf`)
        if ((options.foldable || options.effectFree) && (!(options.leaf ?? false) || options.context)) throw new Error(`the intrinsic '${name}' is foldable or effect-free, so must be a leaf that takes no context`)
        const deps: Record<string, string> = {}
        for (const [dep, value] of Object.entries(options.deps ?? {})) {
            let slot = this.deps.indexOf(value)
            if (slot === -1) slot = this.deps.push(value) - 1
            deps[dep] = `D${slot}`
        }
        const entry: Intrinsic = Object.freeze({
            name, pos: this.entries.length, fn, min, max, leaf: options.leaf ?? false, context: options.context ?? false, tail: options.tail ?? true, fresh: (options.fresh ?? false) || options.sequence === "spread", returns: options.returns, wants: options.wants, inline: options.inline, deps: Object.freeze(deps),
            refineArgs: options.refineArgs, branchNarrow: options.branchNarrow, invertBranch: options.invertBranch,
            foldable: options.foldable ?? false, effectFree: options.effectFree ?? false, oneValue: options.oneValue ?? false,
        })
        this.entries.push(entry)
        this.fns.push(fn)
        this.#bySym.set(sym, entry.pos)
        if (options.sequence === "pack") this.#pack = entry
        if (options.sequence === "spread") this.#spread = entry
        return entry
    }

    get format(): Formatter {
        return this.#format
    }

    print(v: any): string {
        return this.#format(Msg.Value, [v], this.#format, null)
    }

    setFormatter(format: Formatter): this {
        if (this.#frozen) throw new Error("cannot set the formatter: the intrinsics are frozen")
        this.#format = format
        return this
    }

    get types(): TypeSystem | null {
        return this.#types
    }

    get typeDeps(): Readonly<Record<string, string>> {
        return this.#typeDeps
    }

    setTypes(types: TypeSystem): this {
        if (this.#frozen) throw new Error("cannot set the type system: the intrinsics are frozen")
        const deps: Record<string, string> = {}
        for (const [dep, value] of Object.entries(types.deps ?? {})) {
            let slot = this.deps.indexOf(value)
            if (slot === -1) slot = this.deps.push(value) - 1
            deps[dep] = `D${slot}`
        }
        this.#types = types
        this.#typeDeps = Object.freeze(deps)
        return this
    }

    // whether code compiled with this table checks for interrupts
    get interrupts(): boolean {
        return this.#interruptHandler !== -1
    }

    get interruptHandler(): number {
        return this.#interruptHandler
    }

    // Code compiled with this table from now on checks for interrupts, and while it runs the VM calls the intrinsic
    // `name` (registered already) eventually and again and again, whenever it chooses: no count or interval is promised.
    // The handler continues by returning a value, pauses the running coroutine with hostYield, or stops with
    // hostInterruptError. Turning interrupts on needs a table that is not frozen; the handler can be swapped at any time
    setInterruptHandler(name: string): this {
        if (this.#frozen && this.#interruptHandler === -1) throw new Error("cannot turn interrupts on: the intrinsics are frozen")
        const entry = this.byName(name)
        if (entry === undefined) throw new Error(`the interrupt handler '${name}' is not registered`)
        this.#interruptHandler = entry.pos
        return this
    }

    // whether two entries give the type facts (aot/facts.ts) the same rules
    static sameFacts(a: FactRules, b: FactRules): boolean {
        return a.returns === b.returns && a.wants === b.wants && a.refineArgs === b.refineArgs && a.branchNarrow === b.branchNarrow && a.invertBranch === b.invertBranch;
    }

    // what an intrinsic returns given its arguments' kinds, if certain
    static resultKind(entry: Intrinsic, kinds: ArgKinds | null): Kind | undefined {
        const returns = entry.returns
        if (typeof returns !== "function") return returns
        return kinds === null ? undefined : returns(kinds)
    }

    // The global `sym` is the procedure `lambda` (a one-clause %lambda core form that refers to nothing but intrinsics and
    // its own variables, its forms carrying their positions), shown in tracebacks as `name`: code compiled while this
    // holds may run its body where it calls `sym` (see passes/cp0.ts). A front end forgets it (forgetKnown) when a program
    // may change the global
    defineKnown(sym: symbol, lambda: any, name: string): void {
        this.known.set(sym, Object.freeze({ lambda, name }))
    }

    forgetKnown(sym: symbol): void {
        this.known.delete(sym)
    }

    get pack(): Intrinsic | undefined {
        return this.#pack
    }

    get spread(): Intrinsic | undefined {
        return this.#spread
    }

    get(sym: symbol): Intrinsic | undefined {
        const pos = this.#bySym.get(sym)
        return pos === undefined ? undefined : this.entries[pos]
    }

    byName(name: string): Intrinsic | undefined {
        return this.get(Symbol.for(name))
    }
}
