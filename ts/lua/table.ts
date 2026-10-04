// Luau's table: an array part for keys 1..sizearray (holes allowed), sized and grown as Luau sizes it (VM/src/ltable.cpp:
// rehash, computesizes, adjustasize, getn), and a hash part. So `#t`, and the order Luau guarantees for a traversal
// (keys 1..k in order, up to the first nil; Luau's generalized iteration RFC) are Luau's. The rest of the order is
// unspecified in Luau, so the hash part is slots in insertion order with a `Map` to find a key's slot, not Luau's nodes:
// its capacity is Luau's (2^k slots, counting keys whose value is nil, as Luau's nodes do), so the table resizes when
// Luau's would, but for those Luau's hash collisions make earlier.
// Weak tables (`__mode` "k", "v", "kv" on the metatable, read whenever it changes, as Luau reads it every collection):
// a collectable key or value (a table, function, coroutine or other object; strings, numbers and booleans never are) is
// held by a WeakRef, and an entry whose key or value was collected is gone, as Luau clears it. As in Luau, a weak key's
// value is held strongly
import { DATUM, TRY_CALL, type Datum } from "../common";
import { luauError } from "./errors";
import { LuaVector } from "./vector";

const MAXBITS = 26;
const MAXSIZE = 1 << MAXBITS;

const ceillog2 = (x: number): number => x <= 1 ? 0 : 32 - Math.clz32(x - 1);

// `key` as an int (C's cast), if it is one
const arrayindex = (key: number): number => {
    const i = key | 0;
    return i === key ? i : -1;
};

const isCollectable = (v: any): v is object => (typeof v === "object" && v !== null && !(v instanceof LuaVector)) || typeof v === "function";

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const bits = (c: number): number => {
    f32[0] = c;
    const i = u32[0] === 0x80000000 ? 0 : u32[0];
    return i ^ (i >>> 17);
};
const hashvec = (v: LuaVector): number => Math.imul(bits(v.x), 73856093) ^ Math.imul(bits(v.y), 19349663) ^ Math.imul(bits(v.z), 83492791);

export class LuaTable implements Datum, Iterable<[any, any]> {
    #array: any[] = [];
    #sizearray = 0;
    // the hash part: its capacity (0, or 2^k), and its slots, keys whose values are nil included
    #capacity = 0;
    #keys: any[] = [];
    #vals: any[] = [];
    // each key's slot: strong keys in `#index`, collectable keys of a weak-key table in `#weakIndex`
    #index = new Map<any, number>();
    #weakIndex = new WeakMap<object, number>();
    // the vector each vector key is stored as (equal vectors being one key), by hash
    #vectors: Map<number, LuaVector[]> | null = null;
    // as Luau's union: room left in the hash part, or (when it is negative) the negated boundary of the array part, which
    // `rawlen` caches while there is no hash part
    #lastfree = 0;
    #readonly = false;
    #metatable: LuaTable | null = null;
    // the weak mode the storage is in, and the metatable's mode stamp it was read at
    #weakKeys = false;
    #weakValues = false;
    #modeStamp = -1;
    // the metatable's __call, and the metatable's version it was read at
    #call: any = undefined;
    #callStamp = -1;
    // bumped when this table's __mode or __call may have changed, for the tables it is the metatable of
    #metaVersion = 0;

    // luaH_new: room for `narray` array slots and `nhash` hash slots
    constructor(narray: number = 0, nhash: number = 0) {
        if (narray > 0) this.#setarrayvector(narray);
        if (nhash > 0) this.#sethashvector(nhash);
    }

    get sizearray(): number {
        return this.#sizearray;
    }

    get sizenode(): number {
        return this.#capacity;
    }

    // --- weak mode ---

    get metatable(): LuaTable | null {
        return this.#metatable;
    }

    set metatable(mt: LuaTable | null) {
        this.#metatable = mt;
        this.#modeStamp = -1;
        this.#callStamp = -1;
        this.#syncMode();
    }

    // what calling the table calls instead, with the table first: its metatable's __call
    get [TRY_CALL](): any {
        const mt = this.#metatable;
        if (mt === null) return undefined;
        if (this.#callStamp !== mt.#metaVersion) {
            this.#call = mt.rawget("__call");
            this.#callStamp = mt.#metaVersion;
        }
        return this.#call;
    }

    #syncMode(): void {
        const mt = this.#metatable;
        const stamp = mt === null ? 0 : mt.#metaVersion + 1;
        if (stamp === this.#modeStamp) return;
        this.#modeStamp = stamp;
        const mode = mt === null ? undefined : mt.#get("__mode");
        const weakKeys = typeof mode === "string" && mode.includes("k");
        const weakValues = typeof mode === "string" && mode.includes("v");
        if (weakKeys === this.#weakKeys && weakValues === this.#weakValues) return;
        // the same entries, held the new way
        const array = this.#array.map(v => this.#unwrap(v));
        const keys = this.#keys.map(k => this.#unwrapKey(k));
        const vals = this.#vals.map(v => this.#unwrap(v));
        this.#weakKeys = weakKeys;
        this.#weakValues = weakValues;
        this.#array = array.map(v => this.#wrap(v));
        this.#vals = vals.map(v => this.#wrap(v));
        this.#index = new Map();
        this.#weakIndex = new WeakMap();
        this.#keys = keys.map((k, i) => {
            if (k !== undefined) this.#indexSet(k, i);
            return this.#wrapKey(k);
        });
    }

    #wrap(v: any): any {
        return this.#weakValues && isCollectable(v) ? new WeakRef(v) : v;
    }

    #unwrap(v: any): any {
        return v instanceof WeakRef ? v.deref() : v;
    }

    #wrapKey(k: any): any {
        return this.#weakKeys && isCollectable(k) ? new WeakRef(k) : k;
    }

    // a slot's key, or undefined if it was collected
    #unwrapKey(k: any): any {
        return k instanceof WeakRef ? k.deref() : k;
    }

    #indexGet(k: any): number | undefined {
        return this.#weakKeys && isCollectable(k) ? this.#weakIndex.get(k) : this.#index.get(k);
    }

    #indexSet(k: any, i: number): void {
        if (this.#weakKeys && isCollectable(k)) this.#weakIndex.set(k, i);
        else this.#index.set(k, i);
    }

    // a slot's value, nil when its key or value was collected
    #slotValue(i: number): any {
        const v = this.#unwrap(this.#vals[i]);
        if (v !== undefined && this.#weakKeys && this.#unwrapKey(this.#keys[i]) === undefined) return undefined;
        return v;
    }

    #vectorKey(v: LuaVector): LuaVector | undefined {
        return this.#vectors?.get(hashvec(v))?.find(k => k.equals(v));
    }

    #addVector(v: LuaVector): void {
        this.#vectors ??= new Map();
        const h = hashvec(v);
        const bucket = this.#vectors.get(h);
        if (bucket === undefined) this.#vectors.set(h, [v]);
        else bucket.push(v);
    }

    // --- lookup ---

    // luaH_get: the value of `key`, or undefined (nil)
    #get(key: any): any {
        if (typeof key === "number") {
            const k = arrayindex(key);
            if (k >= 1 && k <= this.#sizearray) return this.#unwrap(this.#array[k - 1]);
        }
        const i = this.#indexGet(key);
        return i === undefined ? undefined : this.#slotValue(i);
    }

    #getnum(k: number): any {
        if (k >= 1 && k <= this.#sizearray) return this.#unwrap(this.#array[k - 1]);
        const i = this.#indexGet(k);
        return i === undefined ? undefined : this.#slotValue(i);
    }

    rawget(key: any): any {
        if (this.#metatable !== null) this.#syncMode();
        if (key instanceof LuaVector) {
            key = this.#vectorKey(key);
            if (key === undefined) return undefined;
        }
        return this.#get(key);
    }

    // --- insertion (newkey_DEPRECATED, rehash_DEPRECATED, resize) ---

    // the slot `key` will be stored in: a hash slot (its index), or, when it lands in the array part, -(index + 2)
    #newkey(key: any): number {
        // enforce the boundary invariant, and make room when the hash part is full
        if ((typeof key === "number" && key === this.#sizearray + 1) || this.#keys.length >= this.#capacity) {
            this.#rehash(key);
            return this.#arrayornewkey(key);
        }
        const i = this.#keys.length;
        if (key instanceof LuaVector) this.#addVector(key);
        this.#keys.push(this.#wrapKey(key));
        this.#vals.push(undefined);
        this.#indexSet(key, i);
        return i;
    }

    #arrayornewkey(key: any): number {
        if (typeof key === "number") {
            const k = arrayindex(key);
            if (k >= 1 && k <= this.#sizearray) return -(k - 1) - 2;
        }
        return this.#newkey(key);
    }

    #store(slot: number, val: any): void {
        if (slot <= -2) this.#array[-slot - 2] = this.#wrap(val);
        else this.#vals[slot] = this.#wrap(val);
    }

    #computesizes(nums: number[], narray: number): [na: number, n: number] {
        let a = 0, na = 0, n = 0;
        for (let i = 0, twotoi = 1; Math.floor(twotoi / 2) < narray; i++, twotoi *= 2) {
            if (nums[i] > 0) {
                a += nums[i];
                if (a > Math.floor(twotoi / 2)) {
                    n = twotoi;
                    na = a;
                }
            }
            if (a === narray) break;
        }
        return [na, n];
    }

    #countint(key: number, nums: number[]): number {
        const k = arrayindex(key);
        if (k > 0 && k <= MAXSIZE) {
            nums[ceillog2(k)]++;
            return 1;
        }
        return 0;
    }

    #numusearray(nums: number[]): number {
        let ause = 0, i = 1;
        for (let lg = 0, ttlg = 1; lg <= MAXBITS; lg++, ttlg *= 2) {
            let lc = 0, lim = ttlg;
            if (lim > this.#sizearray) {
                lim = this.#sizearray;
                if (i > lim) break;
            }
            for (; i <= lim; i++) if (this.#unwrap(this.#array[i - 1]) !== undefined) lc++;
            nums[lg] += lc;
            ause += lc;
        }
        return ause;
    }

    // [all keys in use in the hash part, those that are array indexes]
    #numusehash(nums: number[]): [number, number] {
        let totaluse = 0, ause = 0;
        for (let i = 0; i < this.#keys.length; i++) {
            if (this.#slotValue(i) !== undefined) {
                const k = this.#unwrapKey(this.#keys[i]);
                if (typeof k === "number") ause += this.#countint(k, nums);
                totaluse++;
            }
        }
        return [totaluse, ause];
    }

    #adjustasize(size: number, ek: any): number {
        const tbound = this.#capacity !== 0 || size < this.#sizearray;
        const ekindex = typeof ek === "number" ? arrayindex(ek) : -1;
        while (size + 1 === ekindex || (tbound && this.#getnum(size + 1) !== undefined)) size++;
        return size;
    }

    #rehash(ek: any): void {
        const nums = new Array(MAXBITS + 1).fill(0);
        let nasize = this.#numusearray(nums);
        let totaluse = nasize;
        const [hashuse, hashints] = this.#numusehash(nums);
        totaluse += hashuse;
        nasize += hashints;
        if (typeof ek === "number") nasize += this.#countint(ek, nums);
        totaluse++;
        const [na, n] = this.#computesizes(nums, nasize);
        nasize = n;
        let nh = totaluse - na;
        const nadjusted = this.#adjustasize(nasize, ek);
        const aextra = nadjusted - nasize;
        if (aextra !== 0) {
            nh -= aextra;
            nasize = this.#adjustasize(nadjusted + aextra, ek);
        }
        this.#resize(nasize, nh);
    }

    #setarrayvector(size: number): void {
        if (size > MAXSIZE) throw luauError("table overflow");
        for (let i = this.#sizearray; i < size; i++) this.#array[i] = undefined;
        this.#sizearray = size;
    }

    #sethashvector(size: number): void {
        if (size !== 0) {
            const lsize = ceillog2(size);
            if (lsize > MAXBITS) throw luauError("table overflow");
            size = 1 << lsize;
        }
        this.#capacity = size;
        this.#keys = [];
        this.#vals = [];
        this.#index = new Map();
        this.#weakIndex = new WeakMap();
        this.#vectors = null;
        this.#lastfree = size;
    }

    #resize(nasize: number, nhsize: number): void {
        if (nasize > MAXSIZE || nhsize > MAXSIZE) throw luauError("table overflow");
        const oldasize = this.#sizearray;
        const oldKeys = this.#keys, oldVals = this.#vals;
        if (nasize > oldasize) this.#setarrayvector(nasize);
        this.#sethashvector(nhsize);
        if (nasize < oldasize) {
            const vanishing = this.#array.slice(nasize, oldasize);
            this.#sizearray = nasize;
            this.#array.length = nasize;
            vanishing.forEach((v, i) => {
                const val = this.#unwrap(v);
                if (val !== undefined) this.#store(this.#newkey(nasize + i + 1), val);
            });
        }
        for (let i = 0; i < oldKeys.length; i++) {
            const val = this.#unwrap(oldVals[i]);
            const key = this.#unwrapKey(oldKeys[i]);
            if (val !== undefined && key !== undefined) this.#store(this.#arrayornewkey(key), val);
        }
    }

    // luaH_set: `key` set to `val` (nil included: a new key takes a slot even then, as it takes a node in Luau)
    rawset(key: any, val: any): this {
        if (this.#readonly) throw luauError("attempt to modify a readonly table");
        if (key === undefined) throw luauError("table index is nil");
        if (typeof key === "number" && Number.isNaN(key)) throw luauError("table index is NaN");
        if (this.#metatable !== null) this.#syncMode();
        if (key instanceof LuaVector) {
            if (key.hasNaN) throw luauError("table index contains NaN");
            key = this.#vectorKey(key) ?? key;
        }
        if (key === "__mode" || key === "__call") this.#metaVersion++;
        if (typeof key === "number") {
            const k = arrayindex(key);
            if (k >= 1 && k <= this.#sizearray) {
                this.#array[k - 1] = this.#wrap(val);
                return this;
            }
        }
        const i = this.#indexGet(key);
        if (i !== undefined) {
            this.#vals[i] = this.#wrap(val);
            return this;
        }
        this.#store(this.#newkey(key), val);
        return this;
    }

    // --- length and traversal ---

    #maybesetaboundary(boundary: number): void {
        if (this.#lastfree <= 0) this.#lastfree = -boundary;
    }

    #getaboundary(): number {
        return this.#lastfree < 0 ? -this.#lastfree : this.#sizearray;
    }

    #updateaboundary(boundary: number): number {
        const arr = (i: number) => this.#unwrap(this.#array[i]);
        if (boundary < this.#sizearray && arr(boundary - 1) === undefined) {
            if (boundary >= 2 && arr(boundary - 2) !== undefined) {
                this.#maybesetaboundary(boundary - 1);
                return boundary - 1;
            }
        } else if (boundary + 1 < this.#sizearray && arr(boundary) !== undefined && arr(boundary + 1) === undefined) {
            this.#maybesetaboundary(boundary + 1);
            return boundary + 1;
        }
        return 0;
    }

    // luaH_getn: #t
    rawlen(): number {
        if (this.#metatable !== null) this.#syncMode();
        const arr = (i: number) => this.#unwrap(this.#array[i]);
        const size = this.#sizearray;
        const boundary = this.#getaboundary();
        if (boundary > 0) {
            if (arr(size - 1) !== undefined && this.#capacity === 0) return size;
            if (boundary < size && arr(boundary - 1) !== undefined && arr(boundary) === undefined) return boundary;
            const found = this.#updateaboundary(boundary);
            if (found > 0) return found;
        }
        if (size > 0 && arr(size - 1) === undefined) {
            let base = 0, rest = size;
            for (let half = rest >> 1; half !== 0; half = rest >> 1) {
                if (arr(base + half) !== undefined) base += half;
                rest -= half;
            }
            const found = (arr(base) !== undefined ? 1 : 0) + base;
            this.#maybesetaboundary(found);
            return found;
        }
        return size;
    }

    // luaH_next: the entry after `key` (undefined, nil, to start), or undefined at the end: the array part in order,
    // then the hash part in the order its keys came
    next(key: any): [any, any] | undefined {
        if (this.#metatable !== null) this.#syncMode();
        let i: number;
        if (key === undefined) i = -1;
        else {
            const k = typeof key === "number" ? arrayindex(key) : -1;
            if (k > 0 && k <= this.#sizearray) i = k - 1;
            else {
                const n = this.#indexGet(key instanceof LuaVector ? this.#vectorKey(key) : key);
                if (n === undefined) throw luauError("invalid key to 'next'");
                i = n + this.#sizearray;
            }
        }
        for (i++; i < this.#sizearray; i++) {
            const v = this.#unwrap(this.#array[i]);
            if (v !== undefined) return [i + 1, v];
        }
        for (i -= this.#sizearray; i < this.#keys.length; i++) {
            const v = this.#slotValue(i);
            if (v !== undefined) return [this.#unwrapKey(this.#keys[i]), v];
        }
        return undefined;
    }

    // --- the rest of Luau's table operations ---

    get frozen(): boolean {
        return this.#readonly;
    }

    set frozen(readonly: boolean) {
        this.#readonly = Boolean(readonly);
    }

    freeze(): this {
        this.#readonly = true;
        return this;
    }

    // luaH_clear: every entry gone, the sizes kept
    clear(): void {
        if (this.#readonly) throw luauError("attempt to modify a readonly table");
        this.#metaVersion++;
        for (let i = 0; i < this.#sizearray; i++) this.#array[i] = undefined;
        this.#maybesetaboundary(0);
        if (this.#capacity !== 0) {
            this.#keys = [];
            this.#vals = [];
            this.#index = new Map();
            this.#weakIndex = new WeakMap();
            this.#vectors = null;
            this.#lastfree = this.#capacity;
        }
    }

    // luaH_clone: the same entries, sizes and order, and the same metatable; not readonly
    clone(): LuaTable {
        const t = new LuaTable();
        t.#array = [...this.#array];
        t.#sizearray = this.#sizearray;
        t.#capacity = this.#capacity;
        t.#keys = [...this.#keys];
        t.#vals = [...this.#vals];
        t.#lastfree = this.#lastfree;
        t.#weakKeys = this.#weakKeys;
        t.#weakValues = this.#weakValues;
        t.#metatable = this.#metatable;
        t.#modeStamp = this.#modeStamp;
        this.#keys.forEach((k, i) => {
            const key = this.#unwrapKey(k);
            if (key !== undefined) t.#indexSet(key, i);
            if (key instanceof LuaVector) t.#addVector(key);
        });
        return t;
    }

    // --- host conveniences ---

    // how many entries (keys with a value)
    get size(): number {
        let n = 0;
        for (let e = this.next(undefined); e !== undefined; e = this.next(e[0])) n++;
        return n;
    }

    lookup(key: any, missing: any): any {
        const v = this.rawget(key);
        return v === undefined ? missing : v;
    }

    get(key: any): any {
        return this.rawget(key);
    }

    has(key: any): boolean {
        return this.rawget(key) !== undefined;
    }

    set(key: any, val: any): this {
        return this.rawset(key, val);
    }

    delete(key: any): boolean {
        const had = this.has(key);
        if (had) this.rawset(key, undefined);
        return had;
    }

    *entries(): IterableIterator<[any, any]> {
        for (let e = this.next(undefined); e !== undefined; e = this.next(e[0])) yield e;
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

    get [DATUM](): true {
        return true;
    }

    equals(other: any, equal: (a: any, b: any) => boolean): boolean {
        if (!(other instanceof LuaTable) || other.size !== this.size) return false;
        for (const [k, v] of this.entries()) {
            const o = other.rawget(k);
            if (o === undefined || !equal(v, o)) return false;
        }
        return true;
    }

    stringify(stringify: (v: any) => string): string {
        const parts: string[] = [];
        for (const [k, v] of this.entries()) parts.push(`${stringify(k)} ${stringify(v)}`);
        return `{${parts.join(" ")}}`;
    }

    copy(): LuaTable {
        return this;
    }
}
