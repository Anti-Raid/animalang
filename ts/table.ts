export class Table implements Iterable<[any, any]> {
    #map: Map<any, any>;
    #parent: Table | null;
    #frozen: boolean;

    constructor(parent: Table | null = null, frozen: boolean = false) {
        this.#map = new Map();
        this.#parent = parent;
        this.#frozen = frozen;
    }

    get parent(): Table | null {
        return this.#parent;
    }

    chained(frozen: boolean = false): Table {
        return new Table(this, frozen);
    }

    get size(): number {
        return this.#map.size + (this.#parent ? this.#parent.size : 0);
    }

    get frozen(): boolean {
        return this.#frozen;
    }

    set frozen(val: boolean) {
        this.#frozen = Boolean(val);
    }

    get(key: any): any {
        let curr: Table | null = this;
        while (curr !== null) {
            if (curr.#map.has(key)) {
                return curr.#map.get(key);
            }
            curr = curr.#parent;
        }
        return undefined;
    }

    has(key: any): boolean {
        let curr: Table | null = this;
        while (curr !== null) {
            if (curr.#map.has(key)) {
                return true;
            }
            curr = curr.#parent;
        }
        return false;
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

    *keys(): IterableIterator<any> {
        yield* this.#map.keys();
        if (this.#parent) {
            yield* this.#parent.keys();
        }
    }

    *values(): IterableIterator<any> {
        yield* this.#map.values();
        if (this.#parent) {
            yield* this.#parent.values();
        }
    }

    *entries(): IterableIterator<[any, any]> {
        yield* this.#map.entries();
        if (this.#parent) {
            yield* this.#parent.entries();
        }
    }

    currentEntries(): IterableIterator<[any, any]> {
        return this.#map.entries();
    }

    [Symbol.iterator](): IterableIterator<[any, any]> {
        return this.entries();
    }

    copy(): Table {
        const copyTbl = new Table(null, false);
        for (const [k, v] of this.entries()) {
            copyTbl.set(k, v);
        }
        return copyTbl;
    }
}
