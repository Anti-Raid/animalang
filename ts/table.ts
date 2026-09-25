const isArrayKey = (key: any): key is number => typeof key === "number" && Number.isInteger(key) && key >= 1;

// Anima's (and transpiled Luau's) table: keys 1..n live densely in an array part, everything else in a hash part.
// Storing <#void> (undefined) removes a key, so no key maps to void.
export class Table implements Iterable<[any, any]> {
    #arr: any[] = [];
    #hash: Map<any, any> = new Map();
    #frozen: boolean;

    constructor(frozen: boolean = false) {
        this.#frozen = frozen;
    }

    get size(): number {
        return this.#arr.length + this.#hash.size;
    }

    // Lua's #t: a border, i.e. an n where t[n] is set (or n is 0) and t[n + 1] is not. The array part holds exactly the
    // keys 1..n and the hash part never holds n + 1, so this is the length of the sequence 1..n
    border(): number {
        return this.#arr.length;
    }

    get frozen(): boolean {
        return this.#frozen;
    }

    set frozen(val: boolean) {
        this.#frozen = Boolean(val);
    }

    lookup(key: any, missing: any): any {
        if (typeof key === "number" && isArrayKey(key) && key <= this.#arr.length) return this.#arr[key - 1];
        const val = this.#hash.get(key);
        return val === undefined ? missing : val;
    }

    // host convenience: undefined when missing
    get(key: any): any {
        return this.lookup(key, undefined);
    }

    has(key: any): boolean {
        return this.lookup(key, undefined) !== undefined;
    }

    set(key: any, val: any): this {
        if (val === undefined) {
            this.delete(key);
            return this;
        }
        if (this.#frozen) throw new Error("Cannot modify a frozen Table");
        if (key === undefined) throw new Error("table key cannot be <#void>");
        if (typeof key === "number" && Number.isNaN(key)) throw new Error("table key cannot be NaN");

        const arr = this.#arr;
        if (isArrayKey(key) && key <= arr.length + 1) {
            if (key <= arr.length) {
                arr[key - 1] = val;
                return this;
            }
            arr.push(val);
            // keys that were past the end of the array part may now continue it
            const hash = this.#hash;
            if (hash.size > 0) {
                for (let next = hash.get(arr.length + 1); next !== undefined; next = hash.get(arr.length + 1)) {
                    hash.delete(arr.length + 1);
                    arr.push(next);
                }
            }
            return this;
        }
        this.#hash.set(key, val);
        return this;
    }

    delete(key: any): boolean {
        if (this.#frozen) throw new Error("Cannot modify a frozen Table");
        const arr = this.#arr;
        if (isArrayKey(key) && key <= arr.length) {
            // keep the array part dense: whatever followed the removed key moves to the hash part
            if (key < arr.length) {
                for (let i = key; i < arr.length; i++) this.#hash.set(i + 1, arr[i]);
            }
            arr.length = key - 1;
            return true;
        }
        return this.#hash.delete(key);
    }

    clear(): void {
        if (this.#frozen) throw new Error("Cannot modify a frozen Table");
        this.#arr = [];
        this.#hash.clear();
    }

    *entries(): IterableIterator<[any, any]> {
        const arr = this.#arr;
        for (let i = 0; i < arr.length; i++) yield [i + 1, arr[i]];
        yield* this.#hash.entries();
    }

    *keys(): IterableIterator<any> {
        for (const [key] of this.entries()) yield key;
    }

    *values(): IterableIterator<any> {
        for (const [, val] of this.entries()) yield val;
    }

    [Symbol.iterator](): IterableIterator<[any, any]> {
        return this.entries();
    }

    copy(): Table {
        const copyTbl = new Table();
        for (const [k, v] of this.entries()) copyTbl.set(k, v);
        return copyTbl;
    }
}
