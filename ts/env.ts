import { hostError } from "./errors";

// a binding: its value, and the caches of the reads in compiled code that found it since the bindings last changed
// (`epoch`: Env.globalsVersion then), which setting the binding writes the value to, so that those reads go on reading
// their caches. The caches listed before that are all being looked up again, so the list starts over
export type Cell = { v: any, readers: GlobalCache[], epoch: number };
const cellOf = (v: any): Cell => ({ v, readers: [], epoch: -1 });

// most caches a cell lists: past it the bindings count as changed, so that the lists start over (code that was
// dropped stays listed until then)
const MAX_READERS = 1024;

// what a read of a global in compiled code keeps: the value it found for `scope`, good while no environment's
// bindings have changed since (`version`: Env.globalsVersion then), and the cell that lists it (since `epoch`)
export type GlobalCache = { scope: Env | null, version: number, value: any, cell: Cell | null, epoch: number };
export const newGlobalCache = (): GlobalCache => ({ scope: null, version: -1, value: undefined, cell: null, epoch: -1 });

// a global environment: a map of global bindings chained to a parent environment (e.g. user globals over the builtins)
export class Env {
    // bound to a name that is declared but not defined yet: lookups treat it as missing, and do not look further out
    static readonly UNDEFINED: unique symbol = Symbol("undefined");
    // as `unbound`: reading an unbound global is an error
    static readonly ERROR: unique symbol = Symbol("error");

    #map: Map<symbol, Cell> = new Map();
    #parent: Env | null;
    #frozen: boolean;
    // what code reading an unbound global gets (e.g. Luau's nil), or Env.ERROR
    readonly unbound: any;

    constructor(parent: Env | null = null, frozen: boolean = false, options: { unbound?: any } = {}) {
        this.#parent = parent;
        this.#frozen = frozen;
        this.unbound = "unbound" in options ? options.unbound : Env.ERROR;
    }

    get parent(): Env | null {
        return this.#parent;
    }

    chained(frozen: boolean = false): Env {
        return new Env(this, frozen, { unbound: this.unbound });
    }

    get frozen(): boolean {
        return this.#frozen;
    }

    set frozen(val: boolean) {
        this.#frozen = Boolean(val);
    }

    lookup(key: symbol, missing: any): any {
        let curr: Env | null = this;
        while (curr !== null) {
            const cell = curr.#map.get(key);
            if (cell !== undefined) return cell.v === Env.UNDEFINED ? missing : cell.v;
            curr = curr.#parent;
        }
        return missing;
    }

    // the cell of the binding `key` is looked up to, or one holding `missing` when it has none (or is declared but
    // not defined): a new cell then, which no binding ever changes
    cell(key: symbol, missing: any): Cell {
        for (let curr: Env | null = this; curr !== null; curr = curr.#parent) {
            const cell = curr.#map.get(key);
            if (cell !== undefined) return cell.v === Env.UNDEFINED ? cellOf(missing) : cell;
        }
        return cellOf(missing);
    }

    // host convenience; `lookup` tells a missing binding apart from one bound to undefined
    get(key: symbol): any {
        return this.lookup(key, undefined);
    }

    has(key: symbol): boolean {
        for (let curr: Env | null = this; curr !== null; curr = curr.#parent) {
            const cell = curr.#map.get(key);
            if (cell !== undefined) return cell.v !== Env.UNDEFINED;
        }
        return false;
    }

    // a read in compiled code found `cell` for `scope`: its cache holds the value from now on, and the cell knows it
    static remember(cache: GlobalCache, scope: Env, cell: Cell): any {
        const version = Env.globalsVersion;
        cache.scope = scope;
        cache.version = version;
        cache.value = cell.v;
        if (cell.epoch !== version) {
            cell.readers = [];
            cell.epoch = version;
        }
        if (cache.cell !== cell || cache.epoch !== version) {
            cache.cell = cell;
            cache.epoch = version;
            if (cell.readers.push(cache) > MAX_READERS) Env.globalsVersion++;
        }
        return cell.v;
    }

    // bumped whenever the bindings of an environment compiled code has looked globals up in change (a name is added or
    // removed, defined or left undefined), so cached lookups look again. Setting a binding that is there writes the
    // value to the caches that hold it instead
    static globalsVersion: number = 0;
    #watched: boolean = false;

    watch(): void {
        for (let curr: Env | null = this; curr !== null && !curr.#watched; curr = curr.#parent) curr.#watched = true;
    }

    set(key: symbol, val: any): this {
        if (this.#frozen) throw hostError("Cannot modify a frozen environment");
        const cell = this.#map.get(key);
        if (cell !== undefined && cell.v !== Env.UNDEFINED && val !== Env.UNDEFINED) {
            cell.v = val;
            // (a list from before the bindings last changed is of caches that are no longer good)
            if (cell.epoch === Env.globalsVersion) {
                const readers = cell.readers;
                for (let i = 0; i < readers.length; i++) if (readers[i].cell === cell) readers[i].value = val;
            }
            return this;
        }
        if (cell !== undefined) cell.v = val;
        else this.#map.set(key, cellOf(val));
        if (this.#watched) Env.globalsVersion++;
        return this;
    }

    delete(key: symbol): boolean {
        if (this.#frozen) throw hostError("Cannot modify a frozen environment");
        if (this.#watched) Env.globalsVersion++;
        return this.#map.delete(key);
    }

    // this environment's own bindings (not its parents')
    *ownEntries(): IterableIterator<[symbol, any]> {
        for (const [key, cell] of this.#map) yield [key, cell.v];
    }
}
