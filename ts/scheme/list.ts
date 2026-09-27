import { BSReader, DATUM, type BS, type Datum } from "../common";

// the length of an improper list: negative however many pairs are put in front of it (a small integer, so lengths stay
// unboxed)
export const IMPROPER = -(2 ** 30);

// An immutable pair. It knows its list's length from when it is made: the number of pairs to a () tail, or a negative
// number when the tail is anything else (an improper list). Being immutable, a list is never circular
export class Cons implements Datum {
    public readonly length: number;

    // `length`: given by code that knows it (building a list back to front), so it is not worked out from cdr
    constructor(public readonly car: any, public readonly cdr: any, length?: number) {
        this.length = length !== undefined ? length : cdr === null ? 1 : cdr instanceof Cons ? cdr.length + 1 : IMPROPER;
    }

    // the length a list with `tail` after its pairs adds to their count
    public static lengthOf(tail: any): number {
        return tail === null ? 0 : tail instanceof Cons ? tail.length : IMPROPER;
    }

    public static pair(car: any, cdr: any): Cons {
        return new Cons(car, cdr);
    }

    public isImproper(): boolean {
        return this.length < 0;
    }

    public isCyclic(): boolean {
        return false;
    }

    public toDottedArray(): { elements: any[]; rest: any } {
        const elements: any[] = [];
        let curr: any = this;
        for (; curr instanceof Cons; curr = curr.cdr) elements.push(curr.car);
        return { elements, rest: curr };
    }

    public toArray(): any[] {
        if (this.length < 0) return this.toDottedArray().elements;
        const elements = new Array(this.length);
        let curr: any = this;
        for (let i = 0; i < elements.length; i++, curr = curr.cdr) elements[i] = curr.car;
        return elements;
    }

    // a copy of the proper list `lst` in front of `tail`, made front to back in one pass: each pair is linked to the next
    // before the list is returned, so it is never seen incomplete
    public static copyOnto(lst: Cons, tail: any): Cons {
        const rest = tail === null ? 0 : tail instanceof Cons ? tail.length : IMPROPER;
        let remaining = lst.length;
        const head: any = new Cons(lst.car, null, remaining + rest);
        let last = head;
        for (let p = lst.cdr; p instanceof Cons; p = p.cdr) {
            const cell: any = new Cons(p.car, null, --remaining + rest);
            last.cdr = cell;
            last = cell;
        }
        last.cdr = tail;
        return head;
    }

    // the proper list `lst` reversed; each pair's length is known from the count, so it is set rather than computed
    public static reverse(lst: Cons): Cons {
        let out: any = null;
        let n = 0;
        for (let p: any = lst; p instanceof Cons; p = p.cdr) out = new Cons(p.car, out, ++n);
        return out;
    }

    public static list(...items: any[]): Cons | null {
        return Cons.fromArray(items);
    }

    public static fromArray(arr: any[], offset: number = 0): Cons | null {
        let tail: any = null;
        for (let i = arr.length - 1; i >= offset; i--) tail = new Cons(arr[i], tail, arr.length - i);
        return tail;
    }

    public includes(elem: any): boolean {
        for (let curr: any = this; curr instanceof Cons; curr = curr.cdr) if (curr.car === elem) return true;
        return false;
    }

    public get(idx: number): any {
        if (idx < 0) return undefined;
        let curr: any = this;
        for (let i = 0; curr instanceof Cons; curr = curr.cdr, i++) if (i === idx) return curr.car;
        return undefined;
    }

    // the elements, then (as the iterator's return value) the tail: () for a proper list
    public *[Symbol.iterator](): Generator<any, any, unknown> {
        let curr: any = this;
        for (; curr instanceof Cons; curr = curr.cdr) yield curr.car;
        return curr;
    }

    get [DATUM](): true {
        return true;
    }

    get bsid() {
        return "Cons";
    }

    dump(w: BS): void {
        let count = 0;
        for (let curr: any = this; curr instanceof Cons; curr = curr.cdr) count++;
        w.writeU32(count);
        let curr: any = this;
        for (; curr instanceof Cons; curr = curr.cdr) w.writeValue(curr.car);
        w.writeValue(curr);
    }

    equals(other: any, equal: (a: any, b: any) => boolean): boolean {
        if (!(other instanceof Cons) || other.length !== this.length) return false;
        let pa: any = this, pb: any = other;
        for (; pa instanceof Cons && pb instanceof Cons; pa = pa.cdr, pb = pb.cdr) {
            if (!equal(pa.car, pb.car)) return false;
        }
        return equal(pa, pb);
    }

    stringify(stringify: (v: any) => string): string {
        const parts: string[] = [];
        let curr: any = this;
        for (; curr instanceof Cons; curr = curr.cdr) parts.push(stringify(curr.car));
        if (curr !== null) parts.push(".", stringify(curr));
        return `(${parts.join(" ")})`;
    }

    copy(copy: (v: any) => any): Cons {
        const { elements, rest } = this.toDottedArray();
        let tail = copy(rest);
        for (let i = elements.length - 1; i >= 0; i--) tail = new Cons(copy(elements[i]), tail);
        return tail;
    }
}

BSReader.registerType("Cons", r => {
    const count = r.readU32();
    const cars = new Array(count);
    for (let i = 0; i < count; i++) cars[i] = r.read();
    let tail: any = r.read();
    for (let i = count - 1; i >= 0; i--) tail = new Cons(cars[i], tail);
    return tail;
});

// the pairs being printed or compared right now: mutable pairs can be circular
const PRINTING = new Set<MCons>();
const COMPARING = new Map<MCons, Set<MCons>>();

// A mutable pair (Racket's mcons): not a list, and never a constant
export class MCons implements Datum {
    constructor(public car: any, public cdr: any) {}

    get [DATUM](): true {
        return true;
    }

    get bsid() {
        return "MCons";
    }

    dump(): void {
        throw new Error("a mutable pair cannot be serialized");
    }

    // equal contents; a pair of pairs met again while comparing them is taken as equal (so circular ones compare)
    equals(other: any, equal: (a: any, b: any) => boolean): boolean {
        if (!(other instanceof MCons)) return false;
        let seen = COMPARING.get(this);
        if (seen?.has(other)) return true;
        if (seen === undefined) COMPARING.set(this, seen = new Set());
        seen.add(other);
        try {
            return equal(this.car, other.car) && equal(this.cdr, other.cdr);
        } finally {
            seen.delete(other);
            if (seen.size === 0) COMPARING.delete(this);
        }
    }

    stringify(stringify: (v: any) => string): string {
        if (PRINTING.has(this)) return "#<cycle>";
        PRINTING.add(this);
        try {
            return `(mcons ${stringify(this.car)} ${stringify(this.cdr)})`;
        } finally {
            PRINTING.delete(this);
        }
    }

    copy(): MCons {
        return this;
    }
}
