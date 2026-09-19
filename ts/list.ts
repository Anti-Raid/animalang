export class Cons {
    public car: any;
    public cdr: any;

    private _cachedLength: number = -3;

    private static globalEpoch: symbol = Symbol();
    private _lastValidEpoch: symbol = Symbol();

    constructor(car: any, cdr: any) {
        this.car = car;
        this.cdr = cdr;
    }

    public static pair(car: any, cdr: any): Cons {
        return new Cons(car, cdr);
    }

    public setCar(newCar: any): void {
        this.car = newCar;
    }

    public setCdr(newCdr: any): void {
        this.cdr = newCdr;
        // deoptimization note: we need to invalidate all of our lengths due to mutation
        Cons.globalEpoch = Symbol(); 
    }

    // Returns length or -1 for improper list or -2 for cyclic list
    public get length(): number {
        // Fast path: if no set-cdr! has happened anywhere in the VM, return cached
        if (this._lastValidEpoch === Cons.globalEpoch && this._cachedLength !== -3) {
            return this._cachedLength;
        }

        // Slow path: recompute length (O(N)), then cache it
        //
        // We use tortoise-hare cycle detection here to handle cyclic lists caused by use of set-cdr!
        let count = 0;
        let slow: any = this;
        let fast: any = this;

        while (fast instanceof Cons) {
            count++;
            fast = fast.cdr;

            // Move slow once every two iterations
            if ((count & 1) === 0) {
                slow = slow.cdr;
            }

            // Cycle detected
            if (fast === slow) {
                this._cachedLength = -2;
                this._lastValidEpoch = Cons.globalEpoch;
                return this._cachedLength;
            }
        }

        // fast must end in null for a proper list; non-null means improper
        this._cachedLength = (fast === null) ? count : -1;        
        this._lastValidEpoch = Cons.globalEpoch;
        return this._cachedLength;
    }

    public isImproper(): boolean {
        return this.length === -1;
    }

    public isCyclic(): boolean {
        return this.length === -2;
    }

    public toDottedArray(): { elements: any[]; rest: any } {
        if (this.isCyclic()) throw new Error("cannot convert circular list");
        const elements: any[] = [];
        let curr: any = this;
        while (curr instanceof Cons) {
            elements.push(curr.car);
            curr = curr.cdr;
        }
        return { elements, rest: curr };
    }

    public toArray(): any[] {
        if (this.isCyclic()) throw new Error("cannot convert circular list to array");
        const elements: any[] = [];
        let curr: any = this;
        while (curr instanceof Cons) {
            elements.push(curr.car);
            curr = curr.cdr;
        }
        return elements;
    }

    public static list(...items: any[]): Cons | null {
        let tail: any = null;
        for (let i = items.length - 1; i >= 0; i--) {
            tail = new Cons(items[i], tail);
        }
        return tail;
    }

    public static fromArray(arr: any[], offset: number = 0): Cons | null {
        if (offset >= arr.length) return null;
        let tail: any = null;
        for (let i = arr.length - 1; i >= offset; i--) {
            tail = new Cons(arr[i], tail);
        }
        return tail;
    }

    public includes(elem: any): boolean {
        for (const e of this) {
            if (e === elem) {
                return true;
            }
        }
        return false;
    }

    public get(idx: number): any {
        if (idx < 0) return undefined;
        let curr: any = this;
        let i = 0;
        while (curr instanceof Cons) {
            if (i === idx) return curr.car;
            curr = curr.cdr;
            i++;
        }
        return undefined;
    }

    // Iterable support for for..of
    public *[Symbol.iterator](): Generator<any, any, unknown> {
        if (this.isCyclic()) {
            throw new Error("cannot iterate circular list");
        }
        let curr: any = this;
        while (curr instanceof Cons) {
            yield curr.car;
            curr = curr.cdr;
        }
        return curr; // done: true, value: tail (null if proper, atom if improper)
    }
}
