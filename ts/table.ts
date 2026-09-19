export class Table implements Iterable<[any, any]> {
    #map: Map<any, any>;
    #frozen: boolean;

    constructor(entries?: Iterable<[any, any]> | null, frozen: boolean = false) {
        this.#map = new Map(entries ?? undefined);
        this.#frozen = frozen;
    }

    get size(): number {
        return this.#map.size;
    }

    get isFrozen(): boolean {
        return this.#frozen;
    }

    get frozen(): boolean {
        return this.#frozen;
    }

    freeze(): this {
        this.#frozen = true;
        return this;
    }

    freezeDeep(): this {
        this.#frozen = true;
        for (const val of this.#map.values()) {
            if (val instanceof Table && !val.isFrozen) {
                val.freezeDeep();
            }
        }
        return this;
    }

    get(key: any): any {
        return this.#map.get(key);
    }

    has(key: any): boolean {
        return this.#map.has(key);
    }

    set(key: any, val: any): this {
        if (this.#frozen) throw new Error("Cannot modify a frozen Table");
        this.#map.set(key, val);
        return this;
    }

    delete(key: any): boolean {
        if (this.#frozen) throw new Error("Cannot modify a frozen Table");
        return this.#map.delete(key);
    }

    clear(): void {
        if (this.#frozen) throw new Error("Cannot modify a frozen Table");
        this.#map.clear();
    }

    keys(): IterableIterator<any> {
        return this.#map.keys();
    }

    values(): IterableIterator<any> {
        return this.#map.values();
    }

    entries(): IterableIterator<[any, any]> {
        return this.#map.entries();
    }

    [Symbol.iterator](): IterableIterator<[any, any]> {
        return this.#map[Symbol.iterator]();
    }

    copy(): Table {
        return new Table(this.#map.entries(), false);
    }

    toObject(deep: boolean = true): Record<string, any> {
        const obj: Record<string, any> = {};
        for (const [k, v] of this.#map.entries()) {
            const keyStr = typeof k === "symbol" ? (k.description || Symbol.keyFor(k) || String(k)) : String(k);
            obj[keyStr] = (deep && v instanceof Table) ? v.toObject(true) : v;
        }
        return obj;
    }

    static fromObject(obj: Record<string, any>, deep: boolean = true): Table {
        const tbl = new Table();
        for (const [k, v] of Object.entries(obj)) {
            const val = (deep && typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Table))
                ? Table.fromObject(v, true)
                : v;
            tbl.set(k, val);
        }
        return tbl;
    }

    toJSON(): Record<string, any> {
        return this.toObject(true);
    }
}
