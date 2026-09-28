import { BSReader, DATUM, type BS, type Datum } from "../common";
import { hostError } from "../errors";

// Scheme's table: a mutable map from any key (compared as JS Map keys) to a value. Storing <#void> removes a key
export class Table implements Datum, Iterable<[any, any]> {
    #map = new Map<any, any>();

    constructor(public frozen: boolean = false) {}

    get size(): number {
        return this.#map.size;
    }

    lookup(key: any, missing: any): any {
        const val = this.#map.get(key);
        return val === undefined ? missing : val;
    }

    get(key: any): any {
        return this.#map.get(key);
    }

    has(key: any): boolean {
        return this.#map.has(key);
    }

    set(key: any, val: any): this {
        if (this.frozen) throw hostError("Cannot modify a frozen Table");
        if (val === undefined) this.#map.delete(key);
        else this.#map.set(key, val);
        return this;
    }

    delete(key: any): boolean {
        if (this.frozen) throw hostError("Cannot modify a frozen Table");
        return this.#map.delete(key);
    }

    clear(): void {
        if (this.frozen) throw hostError("Cannot modify a frozen Table");
        this.#map.clear();
    }

    entries(): IterableIterator<[any, any]> {
        return this.#map.entries();
    }

    keys(): IterableIterator<any> {
        return this.#map.keys();
    }

    values(): IterableIterator<any> {
        return this.#map.values();
    }

    [Symbol.iterator](): IterableIterator<[any, any]> {
        return this.#map.entries();
    }

    clone(): Table {
        const out = new Table();
        for (const [k, v] of this.#map) out.#map.set(k, v);
        return out;
    }

    get [DATUM](): true {
        return true;
    }

    get bsid() {
        return "Table";
    }

    dump(w: BS): void {
        w.writeU32(this.frozen ? 1 : 0);
        w.writeU32(this.#map.size);
        for (const [k, v] of this.#map) {
            w.writeValue(k);
            w.writeValue(v);
        }
    }

    equals(other: any, equal: (a: any, b: any) => boolean): boolean {
        if (!(other instanceof Table) || other.size !== this.size) return false;
        for (const [k, v] of this.#map) {
            if (!other.#map.has(k) || !equal(v, other.#map.get(k))) return false;
        }
        return true;
    }

    stringify(stringify: (v: any) => string): string {
        const parts: string[] = [];
        for (const [k, v] of this.#map) parts.push(`${stringify(k)} ${stringify(v)}`);
        return `{${parts.join(" ")}}`;
    }

    copy(): Table {
        return this;
    }
}

BSReader.registerType("Table", r => {
    const frozen = r.readU32() === 1;
    const size = r.readU32();
    const t = new Table();
    for (let i = 0; i < size; i++) t.set(r.read(), r.read());
    t.frozen = frozen;
    return t;
});
