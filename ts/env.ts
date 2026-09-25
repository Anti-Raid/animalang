// a global environment: a map of global bindings chained to a parent environment (e.g. user globals over the builtins)
export class Env {
    #map: Map<symbol, any> = new Map();
    #parent: Env | null;
    #frozen: boolean;

    constructor(parent: Env | null = null, frozen: boolean = false) {
        this.#parent = parent;
        this.#frozen = frozen;
    }

    get parent(): Env | null {
        return this.#parent;
    }

    chained(frozen: boolean = false): Env {
        return new Env(this, frozen);
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
            const val = curr.#map.get(key);
            if (val !== undefined || curr.#map.has(key)) return val;
            curr = curr.#parent;
        }
        return missing;
    }

    // host convenience; `lookup` tells a missing binding apart from one bound to undefined
    get(key: symbol): any {
        return this.lookup(key, undefined);
    }

    has(key: symbol): boolean {
        for (let curr: Env | null = this; curr !== null; curr = curr.#parent) {
            if (curr.#map.has(key)) return true;
        }
        return false;
    }

    // bumped whenever an environment compiled code has looked globals up in changes, so cached lookups refetch
    static globalsVersion: number = 0;
    #watched: boolean = false;

    watch(): void {
        for (let curr: Env | null = this; curr !== null && !curr.#watched; curr = curr.#parent) curr.#watched = true;
    }

    set(key: symbol, val: any): this {
        if (this.#frozen) throw new Error("Cannot modify a frozen environment");
        this.#map.set(key, val);
        if (this.#watched) Env.globalsVersion++;
        return this;
    }

    delete(key: symbol): boolean {
        if (this.#frozen) throw new Error("Cannot modify a frozen environment");
        if (this.#watched) Env.globalsVersion++;
        return this.#map.delete(key);
    }

    // this environment's own bindings (not its parents')
    ownEntries(): IterableIterator<[symbol, any]> {
        return this.#map.entries();
    }
}
