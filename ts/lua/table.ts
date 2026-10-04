// Luau's table (VM/src/ltable.cpp, ported): an array part for keys 1..sizearray and a hash part of 2^k nodes, chained
// with Brent's variation, sized and grown as Luau sizes them (rehash, computesizes, adjustasize), so `#t`, `next` and
// the order of a traversal are Luau's. Keys hash as Luau hashes numbers, strings and booleans; other values (which Luau
// hashes by address) hash by an id of their own. A `Map` beside the nodes finds a key without hashing it.
// Weak tables (`__mode` "k", "v", "kv" on the metatable, read whenever it changes, as Luau reads it every collection):
// a collectable key or value (a table, function, coroutine or other object; strings, numbers and booleans never are) is
// held by a WeakRef, and an entry whose key or value was collected is gone, as Luau clears it. As in Luau, a weak key's
// value is held strongly
import { DATUM, type Datum } from "../common";
import { hostError } from "../errors";

const MAXBITS = 26;
const MAXSIZE = 1 << MAXBITS;
// a node with no key (a free position)
const FREE: unique symbol = Symbol("free");
const DUMMY = -1;

const ceillog2 = (x: number): number => x <= 1 ? 0 : 32 - Math.clz32(x - 1);

// `key` as an int (C's cast), if it is one
const arrayindex = (key: number): number => {
    const i = key | 0;
    return i === key ? i : -1;
};

const isCollectable = (v: any): v is object => (typeof v === "object" && v !== null) || typeof v === "function";

const scratch = new DataView(new ArrayBuffer(8));
const hashnum = (n: number): number => {
    scratch.setFloat64(0, n, true);
    let h1 = scratch.getUint32(0, true);
    // the sign bit masked out, so -0 and 0 hash alike
    let h2 = scratch.getUint32(4, true) & 0x7fffffff;
    const m = 0x5bd1e995;
    h1 ^= h2 >>> 18;
    h1 = Math.imul(h1, m);
    h2 ^= h1 >>> 22;
    h2 = Math.imul(h2, m);
    h1 ^= h2 >>> 17;
    h1 = Math.imul(h1, m);
    h2 ^= h1 >>> 19;
    h2 = Math.imul(h2, m);
    return h2 >>> 0;
};

// luaS_hash over a byte string
export const hashstr = (str: string): number => {
    let len = str.length;
    let a = 0, b = 0, h = len >>> 0, at = 0;
    const rol = (x: number, s: number) => ((x >>> s) | (x << (32 - s))) >>> 0;
    const word = (i: number) => (str.charCodeAt(i) & 0xff | (str.charCodeAt(i + 1) & 0xff) << 8 | (str.charCodeAt(i + 2) & 0xff) << 16 | (str.charCodeAt(i + 3) & 0xff) << 24) >>> 0;
    while (len >= 32) {
        a = (a + word(at)) >>> 0;
        b = (b + word(at + 4)) >>> 0;
        h = (h + word(at + 8)) >>> 0;
        a = (a ^ h) >>> 0; a = (a - rol(h, 14)) >>> 0;
        b = (b ^ a) >>> 0; b = (b - rol(a, 11)) >>> 0;
        h = (h ^ b) >>> 0; h = (h - rol(b, 25)) >>> 0;
        at += 12;
        len -= 12;
    }
    for (let i = len; i > 0; --i) h = (h ^ (((h << 5) >>> 0) + (h >>> 2) + (str.charCodeAt(at + i - 1) & 0xff))) >>> 0;
    return h;
};

const hashpointer = (p: number): number => {
    let h = p >>> 0;
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
};

// an object's stand-in for its address
const ids = new WeakMap<object, number>();
const otherIds = new Map<any, number>();
let nextId = 1;
const idOf = (v: any): number => {
    const map: { get(k: any): number | undefined, set(k: any, v: number): any } = isCollectable(v) ? ids : otherIds;
    let id = map.get(v);
    if (id === undefined) map.set(v, id = (nextId++) * 16);
    return id;
};

const hashOf = (key: any): number => {
    switch (typeof key) {
        case "number": return hashnum(key);
        case "string": return hashstr(key);
        case "boolean": return key ? 1 : 0;
        default: return hashpointer(idOf(key));
    }
};

export class LuaTable implements Datum, Iterable<[any, any]> {
    #array: any[] = [];
    #sizearray = 0;
    #lsizenode = 0;
    #dummy = true;
    #nodeKey: any[] = [];
    #nodeVal: any[] = [];
    #nodeNext: number[] = [];
    // as Luau's union: the free positions are before it, or (when it is negative) the negated boundary of the array part
    #lastfree = 0;
    // where each key's node is: strong keys in `#index`, collectable keys of a weak-key table in `#weakIndex`
    #index = new Map<any, number>();
    #weakIndex = new WeakMap<object, number>();
    #readonly = false;
    #metatable: LuaTable | null = null;
    // the weak mode the storage is in, and the metatable's mode stamp it was read at
    #weakKeys = false;
    #weakValues = false;
    #modeStamp = -1;
    // bumped when this table's __mode changes, for the tables it is the metatable of
    #modeVersion = 0;

    // luaH_new: room for `narray` array slots and `nhash` nodes
    constructor(narray: number = 0, nhash: number = 0) {
        if (narray > 0) this.#setarrayvector(narray);
        if (nhash > 0) this.#setnodevector(nhash);
    }

    get sizearray(): number {
        return this.#sizearray;
    }

    get sizenode(): number {
        return this.#dummy ? 0 : 1 << this.#lsizenode;
    }

    // --- weak mode ---

    get metatable(): LuaTable | null {
        return this.#metatable;
    }

    set metatable(mt: LuaTable | null) {
        this.#metatable = mt;
        this.#modeStamp = -1;
        this.#syncMode();
    }

    #syncMode(): void {
        const mt = this.#metatable;
        const stamp = mt === null ? 0 : mt.#modeVersion + 1;
        if (stamp === this.#modeStamp) return;
        this.#modeStamp = stamp;
        const mode = mt === null ? undefined : mt.#get("__mode");
        const weakKeys = typeof mode === "string" && mode.includes("k");
        const weakValues = typeof mode === "string" && mode.includes("v");
        if (weakKeys === this.#weakKeys && weakValues === this.#weakValues) return;
        // the same entries, held the new way
        const array = this.#array.map(v => this.#unwrap(v));
        const keys = this.#nodeKey.map(k => this.#unwrapKey(k));
        const vals = this.#nodeVal.map(v => this.#unwrap(v));
        this.#weakKeys = weakKeys;
        this.#weakValues = weakValues;
        this.#array = array.map(v => this.#wrap(v));
        this.#nodeVal = vals.map(v => this.#wrap(v));
        this.#index = new Map();
        this.#weakIndex = new WeakMap();
        this.#nodeKey = keys.map((k, i) => {
            if (k === FREE || k === undefined) return FREE;
            this.#indexSet(k, i);
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

    // a node's key, or undefined if it was collected
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

    #indexDelete(k: any): void {
        if (this.#weakKeys && isCollectable(k)) this.#weakIndex.delete(k);
        else this.#index.delete(k);
    }

    // a node's value, nil when its key or value was collected
    #nodeValue(i: number): any {
        const v = this.#unwrap(this.#nodeVal[i]);
        if (v !== undefined && this.#weakKeys && this.#unwrapKey(this.#nodeKey[i]) === undefined) return undefined;
        return v;
    }

    // --- lookup ---

    // luaH_get: the value of `key`, or undefined (nil)
    #get(key: any): any {
        if (typeof key === "number") {
            const k = arrayindex(key);
            if (k >= 1 && k <= this.#sizearray) return this.#unwrap(this.#array[k - 1]);
        }
        const i = this.#indexGet(key);
        return i === undefined ? undefined : this.#nodeValue(i);
    }

    #getnum(k: number): any {
        if (k >= 1 && k <= this.#sizearray) return this.#unwrap(this.#array[k - 1]);
        const i = this.#indexGet(k);
        return i === undefined ? undefined : this.#nodeValue(i);
    }

    rawget(key: any): any {
        if (this.#metatable !== null) this.#syncMode();
        return this.#get(key);
    }

    // --- insertion (newkey_DEPRECATED, getfreepos, rehash_DEPRECATED, resize) ---

    #mainposition(key: any): number {
        return this.#dummy ? DUMMY : hashOf(key) & ((1 << this.#lsizenode) - 1);
    }

    #getfreepos(): number {
        while (this.#lastfree > 0) {
            this.#lastfree--;
            if (this.#nodeKey[this.#lastfree] === FREE) return this.#lastfree;
        }
        return -1;
    }

    // the slot `key` will be stored in: a node (its index), or, when it lands in the array part, -(index + 2)
    #newkey(key: any): number {
        // enforce the boundary invariant
        if (typeof key === "number" && key === this.#sizearray + 1) {
            this.#rehash(key);
            return this.#arrayornewkey(key);
        }
        let mp = this.#mainposition(key);
        if (mp === DUMMY || this.#nodeValue(mp) !== undefined) {
            const n = this.#getfreepos();
            if (n === -1) {
                this.#rehash(key);
                return this.#arrayornewkey(key);
            }
            const mk = this.#unwrapKey(this.#nodeKey[mp]);
            const othern0 = mk === undefined ? mp : this.#mainposition(mk);
            if (othern0 !== mp) {
                // the colliding node is out of its main position: it moves to the free one
                let othern = othern0;
                while (othern + this.#nodeNext[othern] !== mp) othern += this.#nodeNext[othern];
                this.#nodeNext[othern] = n - othern;
                this.#nodeKey[n] = this.#nodeKey[mp];
                this.#nodeVal[n] = this.#nodeVal[mp];
                this.#nodeNext[n] = this.#nodeNext[mp];
                if (mk !== undefined) this.#indexSet(mk, n);
                if (this.#nodeNext[mp] !== 0) {
                    this.#nodeNext[n] += mp - n;
                    this.#nodeNext[mp] = 0;
                }
                this.#nodeVal[mp] = undefined;
            } else {
                // the colliding node is in its own main position: the new key goes to the free one
                if (this.#nodeNext[mp] !== 0) this.#nodeNext[n] = (mp + this.#nodeNext[mp]) - n;
                this.#nodeNext[mp] = n - mp;
                mp = n;
            }
        }
        // a key with a nil value whose node is taken over is gone
        const old = this.#unwrapKey(this.#nodeKey[mp]);
        if (old !== undefined && old !== FREE && this.#indexGet(old) === mp) this.#indexDelete(old);
        this.#nodeKey[mp] = this.#wrapKey(key);
        this.#nodeVal[mp] = undefined;
        this.#indexSet(key, mp);
        return mp;
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
        else this.#nodeVal[slot] = this.#wrap(val);
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
        for (let i = this.sizenode - 1; i >= 0; i--) {
            if (this.#nodeValue(i) !== undefined) {
                const k = this.#unwrapKey(this.#nodeKey[i]);
                if (typeof k === "number") ause += this.#countint(k, nums);
                totaluse++;
            }
        }
        return [totaluse, ause];
    }

    #adjustasize(size: number, ek: any): number {
        const tbound = !this.#dummy || size < this.#sizearray;
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
        if (size > MAXSIZE) throw hostError("table overflow");
        for (let i = this.#sizearray; i < size; i++) this.#array[i] = undefined;
        this.#sizearray = size;
    }

    #setnodevector(size: number): void {
        if (size === 0) {
            this.#dummy = true;
            this.#lsizenode = 0;
            this.#nodeKey = [];
            this.#nodeVal = [];
            this.#nodeNext = [];
        } else {
            const lsize = ceillog2(size);
            if (lsize > MAXBITS) throw hostError("table overflow");
            size = 1 << lsize;
            this.#dummy = false;
            this.#lsizenode = lsize;
            this.#nodeKey = new Array(size).fill(FREE);
            this.#nodeVal = new Array(size).fill(undefined);
            this.#nodeNext = new Array(size).fill(0);
        }
        this.#index = new Map();
        this.#weakIndex = new WeakMap();
        this.#lastfree = size;
    }

    #resize(nasize: number, nhsize: number): void {
        if (nasize > MAXSIZE || nhsize > MAXSIZE) throw hostError("table overflow");
        const oldasize = this.#sizearray;
        const oldKeys = this.#nodeKey, oldVals = this.#nodeVal, oldsize = this.sizenode;
        if (nasize > oldasize) this.#setarrayvector(nasize);
        this.#setnodevector(nhsize);
        if (nasize < oldasize) {
            const vanishing = this.#array.slice(nasize, oldasize);
            this.#sizearray = nasize;
            this.#array.length = nasize;
            vanishing.forEach((v, i) => {
                const val = this.#unwrap(v);
                if (val !== undefined) this.#store(this.#newkey(nasize + i + 1), val);
            });
        }
        for (let i = oldsize - 1; i >= 0; i--) {
            const val = this.#unwrap(oldVals[i]);
            const key = this.#unwrapKey(oldKeys[i]);
            if (val !== undefined && key !== undefined && key !== FREE) this.#store(this.#arrayornewkey(key), val);
        }
    }

    // luaH_set: `key` set to `val` (nil included: a new key gets a node even then, as in Luau)
    rawset(key: any, val: any): this {
        if (this.#readonly) throw hostError("attempt to modify a readonly table");
        if (key === undefined) throw hostError("table index is nil");
        if (typeof key === "number" && Number.isNaN(key)) throw hostError("table index is NaN");
        if (this.#metatable !== null) this.#syncMode();
        if (key === "__mode") this.#modeVersion++;
        if (typeof key === "number") {
            const k = arrayindex(key);
            if (k >= 1 && k <= this.#sizearray) {
                this.#array[k - 1] = this.#wrap(val);
                return this;
            }
        }
        const i = this.#indexGet(key);
        if (i !== undefined && this.#unwrapKey(this.#nodeKey[i]) !== undefined) {
            this.#nodeVal[i] = this.#wrap(val);
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
            if (arr(size - 1) !== undefined && this.#dummy) return size;
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

    // luaH_next: the entry after `key` (undefined, nil, to start), or undefined at the end
    next(key: any): [any, any] | undefined {
        if (this.#metatable !== null) this.#syncMode();
        let i: number;
        if (key === undefined) i = -1;
        else {
            const k = typeof key === "number" ? arrayindex(key) : -1;
            if (k > 0 && k <= this.#sizearray) i = k - 1;
            else {
                const n = this.#indexGet(key);
                if (n === undefined) throw hostError("invalid key to 'next'");
                i = n + this.#sizearray;
            }
        }
        for (i++; i < this.#sizearray; i++) {
            const v = this.#unwrap(this.#array[i]);
            if (v !== undefined) return [i + 1, v];
        }
        for (i -= this.#sizearray; i < this.sizenode; i++) {
            const v = this.#nodeValue(i);
            if (v !== undefined) return [this.#unwrapKey(this.#nodeKey[i]), v];
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
        if (this.#readonly) throw hostError("attempt to modify a readonly table");
        for (let i = 0; i < this.#sizearray; i++) this.#array[i] = undefined;
        this.#maybesetaboundary(0);
        if (!this.#dummy) {
            const size = this.sizenode;
            this.#lastfree = size;
            this.#nodeKey.fill(FREE);
            this.#nodeVal.fill(undefined);
            this.#nodeNext.fill(0);
            this.#index = new Map();
            this.#weakIndex = new WeakMap();
        }
    }

    // luaH_clone: the same entries, sizes and order, and the same metatable; not readonly
    clone(): LuaTable {
        const t = new LuaTable();
        t.#array = [...this.#array];
        t.#sizearray = this.#sizearray;
        t.#lsizenode = this.#lsizenode;
        t.#dummy = this.#dummy;
        t.#nodeKey = [...this.#nodeKey];
        t.#nodeVal = [...this.#nodeVal];
        t.#nodeNext = [...this.#nodeNext];
        t.#lastfree = this.#lastfree;
        t.#weakKeys = this.#weakKeys;
        t.#weakValues = this.#weakValues;
        t.#metatable = this.#metatable;
        t.#modeStamp = this.#modeStamp;
        this.#nodeKey.forEach((k, i) => {
            const key = this.#unwrapKey(k);
            if (key !== undefined && key !== FREE) t.#indexSet(key, i);
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
