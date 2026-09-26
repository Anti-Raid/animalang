// AOT inlining: given the js expressions of the arguments and of a call to the operation itself (the fallback, which
// reports errors), returns a js expression computing the result, or null to always make the call. `tmp` names a scratch
// variable the expression may assign; `d` maps each declared dep to the local variable holding it
export type InlineFn = (args: string[], slow: string, tmp: string, d: Readonly<Record<string, string>>) => string | null;

// Reads only regs[start .. start+nargs), and never writes to regs or keeps it: in the interpreter it is the caller's live
// register file. A non-leaf may return hostTail(proc, ...args) instead of a value
export type IntrinsicFn = (regs: any[], start: number, nargs: number) => any

export type IntrinsicOptions = {
    // [min, max] argument counts, checked at compile time
    args?: [number, number],
    // never calls back into the VM (never returns a tail request): CALLINT, and not a call for the boxing analysis
    leaf?: boolean,
    // AOT template: (argument expressions, the direct call, a scratch variable, the deps' local names) => js expression,
    // or null to make the direct call. Argument expressions are plain variables, so they may be repeated
    inline?: InlineFn,
    // values the inline template refers to, by name: the template reads them as ${d.name}
    deps?: Record<string, unknown>,
}

export type Intrinsic = {
    readonly name: string,
    readonly pos: number,
    readonly fn: IntrinsicFn,
    readonly min: number,
    readonly max: number,
    readonly leaf: boolean,
    readonly inline: InlineFn | undefined,
    // the local variable holding each dep in generated code (D<slot> for DEPS[slot])
    readonly deps: Readonly<Record<string, string>>,
}

// The intrinsics a compiler and VM are extended with: host functions called over a register window, inlined by AOT
// code when they have a template. Positions only ever grow at the end, so code compiled earlier stays valid; freeze()
// stops further registrations. `taken` tells which names the compiler already defines
export class Intrinsics {
    readonly entries: Intrinsic[] = []
    // entries[i].fn, by position: what CALLINT/CALLHOST operands index
    readonly fns: IntrinsicFn[] = []
    // every dep value, once: generated code reads DEPS[slot]
    readonly deps: unknown[] = []
    readonly #bySym = new Map<symbol, number>()
    #frozen = false

    constructor(private readonly taken: (sym: symbol) => boolean = () => false) {}

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
        const sym = Symbol.for(name)
        if (this.taken(sym) || this.#bySym.has(sym)) throw new Error(`'${name}' is already defined`)
        const [min, max] = options.args ?? [0, Infinity]
        if (!(Number.isInteger(min) && min >= 0 && (max === Infinity || Number.isInteger(max)) && max >= min)) {
            throw new Error(`the intrinsic '${name}' has a bad argument count range [${min}, ${max}]`)
        }
        const deps: Record<string, string> = {}
        for (const [dep, value] of Object.entries(options.deps ?? {})) {
            let slot = this.deps.indexOf(value)
            if (slot === -1) slot = this.deps.push(value) - 1
            deps[dep] = `D${slot}`
        }
        const entry: Intrinsic = Object.freeze({
            name, pos: this.entries.length, fn, min, max, leaf: options.leaf ?? false, inline: options.inline, deps: Object.freeze(deps),
        })
        this.entries.push(entry)
        this.fns.push(fn)
        this.#bySym.set(sym, entry.pos)
        return entry
    }

    get(sym: symbol): Intrinsic | undefined {
        const pos = this.#bySym.get(sym)
        return pos === undefined ? undefined : this.entries[pos]
    }

    byName(name: string): Intrinsic | undefined {
        return this.get(Symbol.for(name))
    }
}
