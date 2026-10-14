// Luau's table library (VM/src/ltablib.cpp), over a function's arguments (an array). A function that calls one it is
// given (sort with an order function, foreach, foreachi) gives the call back to the VM (hostCall) and goes on from its
// value
import { IProcedure, MultipleValues } from "../common";
import { hostCall } from "../magicvm/exec";
import { argError, argInvalid, integerArg, optInteger, stringArg, tableArg, type Args } from "./args";
import { NOWHERE, luauError } from "./errors";
import { typeName } from "./messages";
import { num2str } from "./number";
import { LuaTable } from "./table";

const NONE = new MultipleValues([]);
const INT_MAX = 2147483647;
// lua_checkstack's limit (LUAI_MAXCSTACK): what a function's arguments and results may take together
const MAXCSTACK = 8000;

// what the library needs of the operators (ops.ts): `<` and raw equality
export type TableOps = { lessThan(a: any, b: any): boolean, rawequal(a: any, b: any): boolean };

// an error of the VM's own raised inside a library function (a readonly table, values that do not compare): Luau gives
// it no position, the function being no Luau code
const unplaced = <T>(run: () => T): T => {
    try {
        return run();
    } catch (e: any) {
        if (e !== null && typeof e === "object") e.at = NOWHERE;
        throw e;
    }
};
const readonlyError = (): Error => {
    const e: any = luauError("attempt to modify a readonly table");
    e.at = NOWHERE;
    return e;
};

const functionArg = (a: Args, n: number, name: string): IProcedure => {
    if (!(a[n - 1] instanceof IProcedure)) throw argError(a, n, name, "function");
    return a[n - 1];
};

const protectedMetatable = (t: LuaTable): boolean => t.metatable !== null && t.metatable.rawget("__metatable") !== undefined;

// moveelements: src[f .. e] to dst[t ...], in the order that copies each before it is written over
const moveElements = (src: LuaTable, dst: LuaTable, f: number, e: number, t: number): void => {
    if (dst.frozen) throw readonlyError();
    const n = e - f + 1;
    unplaced(() => {
        if (t > e || t <= f || dst !== src) for (let i = 0; i < n; i++) dst.rawset(t + i, src.rawget(f + i));
        else for (let i = n - 1; i >= 0; i--) dst.rawset(t + i, src.rawget(f + i));
    });
};

// The sort (sort_rec, sort_heap), as a walk that asks for each comparison (the values to compare) and is given its
// answer: the order function is the program's, called by the VM. Positions are from 0, as the C's
type Sorting = Generator<[any, any], void, boolean>;

function* less(t: LuaTable, i: number, j: number): Generator<[any, any], boolean, boolean> {
    const n = t.sizearray;
    const res = yield [t.rawget(i + 1), t.rawget(j + 1)];
    if (t.sizearray !== n) throw luauError("table modified during sorting");
    return res;
}

const swap = (t: LuaTable, i: number, j: number): void => {
    const temp = t.rawget(i + 1);
    t.rawset(i + 1, t.rawget(j + 1));
    t.rawset(j + 1, temp);
};

function* siftHeap(t: LuaTable, l: number, u: number, root: number): Sorting {
    const count = u - l + 1;
    while (root * 2 + 2 < count) {
        const left = root * 2 + 1, right = root * 2 + 2;
        let next = root;
        next = (yield* less(t, l + next, l + left)) ? left : next;
        next = (yield* less(t, l + next, l + right)) ? right : next;
        if (next === root) break;
        swap(t, l + root, l + next);
        root = next;
    }
    const lastleft = root * 2 + 1;
    if (lastleft === count - 1 && (yield* less(t, l + root, l + lastleft))) swap(t, l + root, l + lastleft);
}

function* sortHeap(t: LuaTable, l: number, u: number): Sorting {
    const count = u - l + 1;
    for (let i = (count >> 1) - 1; i >= 0; --i) yield* siftHeap(t, l, u, i);
    for (let i = count - 1; i > 0; --i) {
        swap(t, l, l + i);
        yield* siftHeap(t, l, l + i - 1, 0);
    }
}

function* sortRec(t: LuaTable, l: number, u: number, limit: number): Sorting {
    while (l < u) {
        if (limit === 0) return yield* sortHeap(t, l, u);
        if (yield* less(t, u, l)) swap(t, u, l);
        if (u - l === 1) break;
        const m = l + ((u - l) >> 1);
        if (yield* less(t, m, l)) swap(t, m, l);
        else if (yield* less(t, u, m)) swap(t, m, u);
        if (u - l === 2) break;
        const p = u - 1;
        swap(t, m, u - 1);
        let i = l, j = u - 1;
        for (;;) {
            while (yield* less(t, ++i, p)) if (i >= u) throw luauError("invalid order function for sorting");
            while (yield* less(t, p, --j)) if (j <= l) throw luauError("invalid order function for sorting");
            if (j < i) break;
            swap(t, i, j);
        }
        swap(t, p, i);
        limit = (limit >> 1) + (limit >> 2);
        if (i - l < u - i) {
            yield* sortRec(t, l, i - 1, limit);
            l = i + 1;
        } else {
            yield* sortRec(t, i + 1, u, limit);
            u = i - 1;
        }
    }
}

// tconcat's addfield
const field = (t: LuaTable, i: number): string => {
    const v = t.rawget(i);
    if (typeof v === "string") return v;
    if (typeof v === "number") return num2str(v);
    throw luauError(`invalid value (${typeName(v)}) at index ${i} in table for 'concat'`);
};

export const TABLE_LIBRARY: Record<string, (a: Args, ops: TableOps) => any> = {
    concat: a => {
        const sep = a[1] === undefined ? "" : stringArg(a, 2, "concat");
        const t = tableArg(a, 1, "concat");
        let i = optInteger(a, 3, "concat", 1);
        const last = a[3] === undefined ? t.rawlen() : integerArg(a, 4, "concat");
        const parts: string[] = [];
        for (; i < last; i++) parts.push(field(t, i), sep);
        if (i === last) parts.push(field(t, i));
        return parts.join("");
    },
    foreach: a => {
        const t = tableArg(a, 1, "foreach"), f = functionArg(a, 2, "foreach");
        const from = (key: any): any => {
            const entry = unplaced(() => t.next(key));
            if (entry === undefined) return NONE;
            return hostCall(f, [entry[0], entry[1]], r => {
                const first = r instanceof MultipleValues ? r.values[0] : r;
                return first !== undefined ? first : from(entry[0]);
            });
        };
        return from(undefined);
    },
    foreachi: a => {
        const t = tableArg(a, 1, "foreachi"), f = functionArg(a, 2, "foreachi"), n = t.rawlen();
        const from = (i: number): any => i > n ? NONE : hostCall(f, [i, t.rawget(i)], r => {
            const first = r instanceof MultipleValues ? r.values[0] : r;
            return first !== undefined ? first : from(i + 1);
        });
        return from(1);
    },
    getn: a => tableArg(a, 1, "getn").rawlen(),
    maxn: a => {
        let max = 0;
        for (const [k] of tableArg(a, 1, "maxn")) if (typeof k === "number" && k > max) max = k;
        return max;
    },
    insert: a => {
        const t = tableArg(a, 1, "insert"), n = t.rawlen();
        let pos: number;
        if (a.length === 2) pos = n + 1;
        else if (a.length === 3) {
            pos = integerArg(a, 2, "insert");
            if (1 <= pos && pos <= n) moveElements(t, t, pos, n, pos + 1);
        } else throw luauError("wrong number of arguments to 'insert'");
        unplaced(() => t.rawset(pos, a[a.length - 1]));
        return NONE;
    },
    remove: a => {
        const t = tableArg(a, 1, "remove"), n = t.rawlen();
        const pos = optInteger(a, 2, "remove", n);
        if (!(1 <= pos && pos <= n)) return NONE;
        const result = t.rawget(pos);
        moveElements(t, t, pos + 1, n, pos);
        unplaced(() => t.rawset(n, undefined));
        return result;
    },
    sort: (a, ops) => {
        const t = tableArg(a, 1, "sort"), n = t.rawlen();
        if (t.frozen) throw readonlyError();
        const f = a[1] === undefined ? null : functionArg(a, 2, "sort");
        if (n <= 0) return NONE;
        const walk = sortRec(t, 0, n - 1, n);
        if (f === null) {
            for (let r = walk.next(); !r.done;) {
                const [x, y] = r.value;
                r = walk.next(unplaced(() => ops.lessThan(x, y)));
            }
            return NONE;
        }
        const go = (r: IteratorResult<[any, any], void>): any => r.done ? NONE : hostCall(f, r.value, v => {
            const first = v instanceof MultipleValues ? v.values[0] : v;
            return go(walk.next(first !== undefined && first !== false));
        });
        return go(walk.next());
    },
    pack: a => {
        const t = LuaTable.of(a.slice(), a.length, 1);
        t.rawset("n", a.length);
        return t;
    },
    unpack: a => {
        const t = tableArg(a, 1, "unpack");
        const i = optInteger(a, 2, "unpack", 1);
        const e = a[2] === undefined ? t.rawlen() : integerArg(a, 3, "unpack");
        if (i > e) return NONE;
        const n = e - i + 1;
        if (n - 1 >= INT_MAX || a.length + n > MAXCSTACK) throw luauError("too many results to unpack");
        const values = new Array(n);
        for (let k = 0; k < n; k++) values[k] = t.rawget(i + k);
        return n === 1 ? values[0] : new MultipleValues(values);
    },
    move: a => {
        const src = tableArg(a, 1, "move");
        const f = integerArg(a, 2, "move"), e = integerArg(a, 3, "move"), t = integerArg(a, 4, "move");
        const dst = a[4] === undefined ? src : tableArg(a, 5, "move");
        if (e >= f) {
            if (!(f > 0 || e < INT_MAX + f)) throw argInvalid(3, "move", "too many elements to move");
            const n = e - f + 1;
            if (!(t <= INT_MAX - n + 1)) throw argInvalid(4, "move", "destination wrap around");
            if (dst.frozen) throw readonlyError();
            if (t > 0 && t - 1 <= dst.sizearray && t - 1 + n > dst.sizearray) dst.resizeArray(t - 1 + n);
            moveElements(src, dst, f, e, t);
        }
        return dst;
    },
    create: a => {
        const size = integerArg(a, 1, "create");
        if (size < 0) throw argInvalid(1, "create", "size out of range");
        return a[1] === undefined ? new LuaTable(size, 0) : LuaTable.of(new Array(size).fill(a[1]), size, 0);
    },
    find: (a, ops) => {
        const t = tableArg(a, 1, "find");
        if (a.length < 2) throw luauError("missing argument #2");
        const init = optInteger(a, 3, "find", 1);
        if (init < 1) throw argInvalid(3, "find", "index out of range");
        for (let i = init; ; i++) {
            const e = t.rawget(i);
            if (e === undefined) return undefined;
            if (ops.rawequal(a[1], e)) return i;
        }
    },
    clear: a => {
        const t = tableArg(a, 1, "clear");
        if (t.frozen) throw readonlyError();
        t.clear();
        return NONE;
    },
    freeze: a => {
        const t = tableArg(a, 1, "freeze");
        if (t.frozen) throw argInvalid(1, "freeze", "table is already frozen");
        if (protectedMetatable(t)) throw argInvalid(1, "freeze", "table has a protected metatable");
        return t.freeze();
    },
    isfrozen: a => tableArg(a, 1, "isfrozen").frozen,
    clone: a => {
        const t = tableArg(a, 1, "clone");
        if (protectedMetatable(t)) throw argInvalid(1, "clone", "table has a protected metatable");
        return t.clone();
    },
};

// the functions that may call one they are given
export const TABLE_CALLERS: ReadonlySet<string> = new Set(["sort", "foreach", "foreachi"]);
