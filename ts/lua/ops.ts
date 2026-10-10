// Luau's operators (VM/src/lvmutils.cpp), as intrinsics: numbers, strings that read as numbers, vectors, and (a
// deviation from Luau) integers with integers
import { ErrorObject, IProcedure, MultipleValues, TRY_CALL } from "../common";
import { severalValues } from "../magicvm/coreops";
import { argError, argInvalid, optInteger, stringArg, tableArg, type Args } from "./args";
import { NOWHERE, luauError } from "./errors";
import type { ArgKinds, InlineFn, Intrinsics, Returns, TypeSystem } from "../magicvm/intrinsics";
import { integer, ipow } from "./integer";
import { toString, typeName } from "./messages";
import { cstring, num2str, str2integer, str2number } from "./number";
import { STRING_LIBRARY, gmatchNext, gmatchState } from "./strlib";
import { LuaTable, type SlotCache } from "./table";
import { LuaVector, vadd, vdiv, vidiv, vmul, vsub, vunm } from "./vector";

export type ArithOp = "add" | "sub" | "mul" | "div" | "idiv" | "mod" | "pow" | "unm";

// C's pow, where it differs from JS's **
export const luaPow = (a: number, b: number): number => a === 1 || (a === -1 && (b === Infinity || b === -Infinity)) ? 1 : a ** b;

const numeric = (op: ArithOp, a: number, b: number): number => {
    switch (op) {
        case "add": return a + b;
        case "sub": return a - b;
        case "mul": return a * b;
        case "div": return a / b;
        case "idiv": return Math.floor(a / b);
        case "mod": return a - Math.floor(a / b) * b;
        case "pow": return luaPow(a, b);
        case "unm": return -a;
    }
};

const integral = (op: ArithOp, a: bigint, b: bigint): bigint => {
    switch (op) {
        case "add": return integer.add(a, b);
        case "sub": return integer.sub(a, b);
        case "mul": return integer.mul(a, b);
        case "div": return integer.div(a, b);
        case "idiv": return integer.idiv(a, b);
        case "mod": return integer.mod(a, b);
        case "pow": return ipow(a, b);
        case "unm": return integer.neg(a);
    }
};

// luaV_tonumber: a number, or a string that reads as one
const tonumber = (v: any): number | undefined => typeof v === "number" ? v : typeof v === "string" ? str2number(v) : undefined;

const arithError = (op: ArithOp, a: any, b: any): Error => {
    const t1 = typeName(a), t2 = typeName(b);
    return luauError(t1 === t2 ? `attempt to perform arithmetic (${op}) on ${t1}` : `attempt to perform arithmetic (${op}) on ${t1} and ${t2}`);
};

// luaV_doarith: `b` is `a` for unm
export const arith = (op: ArithOp, a: any, b: any): any => {
    if (typeof a === "bigint" && typeof b === "bigint") return integral(op, a, b);
    const va = a instanceof LuaVector, vb = b instanceof LuaVector;
    if (va && vb) {
        switch (op) {
            case "add": return vadd(a, b);
            case "sub": return vsub(a, b);
            case "mul": return vmul(a, b);
            case "div": return vdiv(a, b);
            case "idiv": return vidiv(a, b);
            case "unm": return vunm(a);
        }
    } else if (va || vb) {
        const n = tonumber(va ? b : a);
        if (n !== undefined) {
            const [x, y] = va ? [a, n] : [n, b];
            switch (op) {
                case "mul": return vmul(x, y);
                case "div": return vdiv(x, y);
                case "idiv": return vidiv(x, y);
            }
        }
    }
    const na = tonumber(a), nb = tonumber(b);
    if (na !== undefined && nb !== undefined) return numeric(op, na, nb);
    throw arithError(op, a, b);
};

// luaV_concat of two values: strings, numbers and (a deviation from Luau) integers
const concatable = (v: any): boolean => typeof v === "string" || typeof v === "number" || typeof v === "bigint";

export const concat = (a: any, b: any): string => {
    if (typeof a === "string" && typeof b === "string") return a + b;
    if (!concatable(a) || !concatable(b)) throw luauError(`attempt to concatenate ${typeName(a)} with ${typeName(b)}`);
    return (typeof a === "number" ? num2str(a) : String(a)) + (typeof b === "number" ? num2str(b) : String(b));
};

// raw equality: the same value, or equal vectors (metamethods come later)
export const rawequal = (a: any, b: any): boolean => a === b || (a instanceof LuaVector && a.equals(b));

// luaV_lessthan / luaV_lessequal: numbers, strings (by bytes) and (a deviation from Luau) integers
const ordered = (a: any, b: any): boolean => {
    const t = typeof a;
    return t === typeof b && (t === "number" || t === "string" || t === "bigint");
};

export const lessThan = (a: any, b: any): boolean => {
    if (ordered(a, b)) return a < b;
    throw luauError(`attempt to compare ${typeName(a)} < ${typeName(b)}`);
};

export const lessEqual = (a: any, b: any): boolean => {
    if (ordered(a, b)) return a <= b;
    throw luauError(`attempt to compare ${typeName(a)} <= ${typeName(b)}`);
};

// luaV_prepareFORN: a numeric for's initial value, limit or step, as a number
export const forNumber = (v: any, what: string): number => {
    const n = tonumber(v);
    if (n === undefined) throw luauError(`invalid 'for' ${what} (number expected, got ${typeName(v)})`);
    return n;
};

// luaG_indexerror (a long key is not quoted, and C prints a string up to its first NUL)
const indexError = (t: any, key: any): Error =>
    luauError(typeof key === "string" && key.length <= 64 ? `attempt to index ${typeName(t)} with '${cstring(key)}'` : `attempt to index ${typeName(t)} with ${typeName(key)}`);

// luaV_gettable, without metamethods (they come later): a table's entry, a string's entry in the string library
// (`strings`, its metatable's __index), a vector's component
export const index = (strings: LuaTable, t: any, key: any): any => {
    if (t instanceof LuaTable) return t.rawget(key);
    if (typeof t === "string") return strings.rawget(key);
    if (t instanceof LuaVector && typeof key === "string" && key.length === 1) {
        const c = (key.charCodeAt(0) | 32) - 120;
        if (c >= 0 && c < 3) return c === 0 ? t.x : c === 1 ? t.y : t.z;
    }
    throw indexError(t, key);
};

// luaV_settable, without metamethods
export const setindex = (t: any, key: any, value: any): void => {
    if (!(t instanceof LuaTable)) throw indexError(t, key);
    t.rawset(key, value);
};

// luaV_dolen: #v
export const len = (v: any): number => {
    if (typeof v === "string") return v.length;
    if (v instanceof LuaTable) return v.rawlen();
    throw luauError(`attempt to get length of a ${typeName(v)} value`);
};

// what obj:name(...) calls (LOP_NAMECALL)
export const method = (strings: LuaTable, obj: any, name: string): any => {
    const m = index(strings, obj, name);
    if (m === undefined) throw luauError(`attempt to call missing method '${cstring(name)}' of ${typeName(obj)}`);
    return m;
};

// the functions a generic for knows (see forPrep): `next` and the ones pairs and ipairs return, set once they are made
export type LuauIterators = { next: unknown, pairsNext: unknown, inext: unknown };
// what of the library the operators use: those, the string library (a string is indexed through it), and where print
// writes a line
export type LuauLibrary = LuauIterators & { readonly string: LuaTable, readonly print: (line: string) => void };

// luaB_tonumber
const tonumberOf = (a: Args): number | undefined => {
    const base = optInteger(a, 2, "tonumber", 10);
    if (base === 10) {
        const n = tonumber(a[0]);
        if (n === undefined && a.length < 1) throw luauError("missing argument #1");
        return n;
    }
    const s = stringArg(a, 1, "tonumber");
    if (base < 2 || base > 36) throw argInvalid(2, "tonumber", "base out of range");
    return str2integer(s, base);
};

// LOP_FORGPREP and its _NEXT and _INEXT forms, of `for ... in f, s, c`: how the loop goes on. 0: it calls f(s, c). 1: f
// is ipairs's function over a table from index 0, so it walks the array part. 2: f is next over a table from nil, or f
// is itself a table (which is not called): it walks the table by position, as Luau does
export const forPrep = (its: LuauIterators, f: any, s: any, c: any): number => {
    if (f instanceof IProcedure) {
        if (!(s instanceof LuaTable)) return 0;
        return f === its.inext && c === 0 ? 1 : (f === its.next || f === its.pairsNext) && c === undefined ? 2 : 0;
    }
    if (f instanceof LuaTable) return f[TRY_CALL] !== undefined ? 0 : 2;
    throw luauError(`attempt to iterate over a ${typeName(f)} value`);
};

// luaB_next (`name`: next, or null for the one pairs returns)
export const nextOf = (name: string | null, args: readonly any[]): any => {
    const t = tableArg(args, 1, name);
    let entry;
    try {
        entry = t.next(args[1]);
    } catch (e: any) {
        // (an error of the table's, not of the arguments: Luau gives it no position)
        e.at = NOWHERE;
        throw e;
    }
    return entry === undefined ? undefined : new MultipleValues(entry);
};

// luaB_inext, what ipairs returns: (i + 1, t[i + 1]), or nothing when that is nil
export const inextOf = (args: readonly any[]): any => {
    const n = tonumber(args[1]);
    if (n === undefined) throw argError(args, 2, null, "number");
    const i = Math.trunc(n) + 1;
    const v = tableArg(args, 1, null).rawget(i);
    return new MultipleValues(v === undefined ? [] : [i, v]);
};

// what a field access keeps where it is compiled: the slot its name was last found in (Luau's predicted slot)
const slotCache = (): SlotCache => ({ slot: 0 });

// Luau's kinds: numbers, integers (bigints), strings and tables
export const LUAU_TYPES: TypeSystem = {
    ofConstant: v => typeof v === "number" ? "number" : typeof v === "bigint" ? "integer" : typeof v === "string" ? "string" : undefined,
    guard: (kind, e) => kind === "number" ? `typeof ${e} === "number"` : kind === "integer" ? `typeof ${e} === "bigint"` : kind === "string" ? `typeof ${e} === "string"` : null,
    coerce: (kind, e) => kind === "number" ? `+${e}` : null,
    // the lowering takes one value of a call before it binds or assigns it (a call it keeps whole is never returned
    // from a variable)
    oneValueVariables: true,
};

const sameKind: Returns = (kinds: ArgKinds) => kinds.every(k => k === "number") ? "number" : kinds.every(k => k === "integer") ? "integer" : undefined;

// the js of `op` on numbers and on integers, given the arguments' expressions, the deps' names
const NUMBER_JS: Record<ArithOp, (a: string, b: string, d: Readonly<Record<string, string>>) => string> = {
    add: (a, b) => `${a} + ${b}`,
    sub: (a, b) => `${a} - ${b}`,
    mul: (a, b) => `${a} * ${b}`,
    div: (a, b) => `${a} / ${b}`,
    idiv: (a, b) => `Math.floor(${a} / ${b})`,
    mod: (a, b) => `${a} - Math.floor(${a} / ${b}) * ${b}`,
    pow: (a, b, d) => `${d.luaPow}(${a}, ${b})`,
    unm: a => `-${a}`,
};
const INTEGER_JS: Partial<Record<ArithOp, (a: string, b: string) => string>> = {
    add: (a, b) => `BigInt.asIntN(64, ${a} + ${b})`,
    sub: (a, b) => `BigInt.asIntN(64, ${a} - ${b})`,
    mul: (a, b) => `BigInt.asIntN(64, ${a} * ${b})`,
    unm: a => `BigInt.asIntN(64, -${a})`,
};

const arithInline = (op: ArithOp): InlineFn => (args, slow, _tmp, d, known) => {
    const [a, b] = op === "unm" ? [args[0], args[0]] : args;
    const ints = INTEGER_JS[op];
    if (ints !== undefined && known.length > 0 && known.every(k => k === "integer")) return `(${ints(a, b)})`;
    const checks = [...new Set(args.filter((_, i) => known[i] !== "number"))].map(x => `typeof ${x} === "number"`);
    const value = NUMBER_JS[op](a, b, d);
    return checks.length === 0 ? `(${value})` : `(${checks.join(" && ")} ? ${value} : ${slow})`;
};

export const ARITH_OPS: readonly ArithOp[] = ["add", "sub", "mul", "div", "idiv", "mod", "pow", "unm"];

export const registerLuauOps = (table: Intrinsics, library: LuauLibrary): void => {
    for (const op of ARITH_OPS) {
        const unary = op === "unm";
        table.register(`%luau-${op}`, unary ? (regs, s) => arith(op, regs[s], regs[s]) : (regs, s) => arith(op, regs[s], regs[s + 1]), {
            args: unary ? [1, 1] : [2, 2], leaf: true, foldable: true, oneValue: true,
            inline: arithInline(op), deps: { luaPow }, returns: sameKind, wants: "number",
        });
    }
    table.register("%luau-concat", (regs, s) => concat(regs[s], regs[s + 1]), {
        args: [2, 2], leaf: true, foldable: true, returns: "string",
        inline: (args, slow, _tmp, _d, known) => {
            const checks = args.filter((_, i) => known[i] !== "string").map(x => `typeof ${x} === "string"`);
            return checks.length === 0 ? `(${args[0]} + ${args[1]})` : `(${checks.join(" && ")} ? ${args[0]} + ${args[1]} : ${slow})`;
        },
    });
    const bool = { leaf: true, foldable: true, returns: "boolean" } as const;
    table.register("%luau-truthy", (regs, s) => regs[s] !== undefined && regs[s] !== false, {
        ...bool, args: [1, 1], effectFree: true, inline: ([a]) => `(${a} !== undefined && ${a} !== false)`,
    });
    table.register("%luau-not", (regs, s) => regs[s] === undefined || regs[s] === false, {
        ...bool, args: [1, 1], effectFree: true, inline: ([a]) => `(${a} === undefined || ${a} === false)`,
    });
    // only two vectors are equal other than by ===
    const eqInline = (negate: boolean): InlineFn => ([a, b], slow, _tmp, _d, known) =>
        known.some(k => k !== undefined) ? `(${a} ${negate ? "!==" : "==="} ${b})`
            : `(${a} === ${b} ? ${!negate} : typeof ${a} === "object" && ${a} !== null ? ${slow} : ${negate})`;
    table.register("%luau-eq", (regs, s) => rawequal(regs[s], regs[s + 1]), { ...bool, args: [2, 2], effectFree: true, inline: eqInline(false) });
    table.register("%luau-ne", (regs, s) => !rawequal(regs[s], regs[s + 1]), { ...bool, args: [2, 2], effectFree: true, inline: eqInline(true) });
    // a > b and a >= b are b < a and b <= a, as Luau compiles them (its messages say so)
    const compare = (name: string, op: string, fn: (a: any, b: any) => boolean, swap: boolean) => {
        table.register(name, swap ? (regs, s) => fn(regs[s + 1], regs[s]) : (regs, s) => fn(regs[s], regs[s + 1]), {
            ...bool, args: [2, 2], wants: "number",
            inline: (args, slow, _tmp, _d, known) => {
                const [a, b] = swap ? [args[1], args[0]] : args;
                const checks = [...new Set(args.filter((_, i) => known[i] !== "number"))].map(x => `typeof ${x} === "number"`);
                return checks.length === 0 ? `(${a} ${op} ${b})` : `(${checks.join(" && ")} ? ${a} ${op} ${b} : ${slow})`;
            },
        });
    };
    compare("%luau-lt", "<", lessThan, false);
    compare("%luau-le", "<=", lessEqual, false);
    compare("%luau-gt", "<", lessThan, true);
    compare("%luau-ge", "<=", lessEqual, true);
    table.register("%luau-for-number", (regs, s) => forNumber(regs[s], regs[s + 1]), {
        args: [2, 2], leaf: true, returns: "number",
        inline: ([v], slow) => `(typeof ${v} === "number" ? ${v} : ${slow})`,
    });
    // whether a numeric for goes on: the same test entering and looping, so NaNs behave alike
    table.register("%luau-for-test", (regs, s) => regs[s + 2] > 0 ? regs[s] <= regs[s + 1] : regs[s + 1] <= regs[s], {
        ...bool, args: [3, 3], effectFree: true,
        inline: ([i, limit, step]) => `(${step} > 0 ? ${i} <= ${limit} : ${limit} <= ${i})`,
    });
    // an element of `...` (an array), nil past its end
    table.register("%luau-arg", (regs, s) => regs[s][regs[s + 1]], { args: [2, 2], leaf: true, effectFree: true, oneValue: true, inline: ([a, i]) => `${a}[${i}]` });
    // all of `...` as values (the array is never changed, so several values keep it)
    table.register("%luau-varargs", (regs, s) => regs[s].length === 1 ? regs[s][0] : new MultipleValues(regs[s]), {
        args: [1, 1], leaf: true, effectFree: true, deps: { MultipleValues },
        inline: ([a], _slow, _tmp, d) => `(${a}.length === 1 ? ${a}[0] : new ${d.MultipleValues}(${a}))`,
    });
    // whether a call gave other than one value
    table.register("%luau-several?", (regs, s) => regs[s] instanceof MultipleValues, {
        ...bool, foldable: false, args: [1, 1], effectFree: true, inline: ([v], _slow, _tmp, d) => `(${severalValues(v, d)})`, deps: { MultipleValues },
    });
    table.register("%luau-tostring", (regs, s) => toString(regs[s]), { args: [1, 1], leaf: true, oneValue: true });

    // the string library, which a string is indexed through
    const strings = library.string;
    for (const [name, fn] of Object.entries(STRING_LIBRARY)) {
        // (gsub may call a function for each match)
        table.register(`%luau-string-${name}`, (regs, s) => fn(regs[s]), { args: [1, 1], leaf: name !== "gsub" });
    }
    table.register("%luau-string-gmatch", (regs, s) => gmatchState(regs[s]), { args: [1, 1], leaf: true, oneValue: true });
    table.register("%luau-gmatch-next", (regs, s) => gmatchNext(regs[s]), { args: [1, 1], leaf: true });

    // a generic for (see forPrep and LuaTable's traversal by position), and the functions it knows
    const its = library;
    table.register("%luau-for-prep", (regs, s) => forPrep(its, regs[s], regs[s + 1], regs[s + 2]), { args: [3, 3], leaf: true, returns: "number" });
    table.register("%luau-for-table", (regs, s) => regs[s] instanceof LuaTable ? regs[s] : regs[s + 1], { args: [2, 2], leaf: true, effectFree: true, oneValue: true });
    table.register("%luau-nil?", (regs, s) => regs[s] === undefined, { ...bool, args: [1, 1], effectFree: true, inline: ([v]) => `(${v} === undefined)` });
    table.register("%luau-array-at", (regs, s) => regs[s].arrayAt(regs[s + 1]), { args: [2, 2], leaf: true, oneValue: true, inline: ([t, i]) => `${t}.arrayAt(${i})` });
    table.register("%luau-next-pos", (regs, s) => regs[s].nextPos(regs[s + 1]), { args: [2, 2], leaf: true, returns: "number", inline: ([t, p]) => `${t}.nextPos(${p})` });
    table.register("%luau-key-at", (regs, s) => regs[s].keyAt(regs[s + 1]), { args: [2, 2], leaf: true, oneValue: true, inline: ([t, p]) => `${t}.keyAt(${p})` });
    table.register("%luau-value-at", (regs, s) => regs[s].valueAt(regs[s + 1]), { args: [2, 2], leaf: true, oneValue: true, inline: ([t, p]) => `${t}.valueAt(${p})` });
    // the library's next, pairs and ipairs, over their arguments (an array)
    table.register("%luau-fn-next", (regs, s) => nextOf(regs[s] ?? null, regs[s + 1]), { args: [2, 2], leaf: true });
    table.register("%luau-fn-inext", (regs, s) => inextOf(regs[s]), { args: [1, 1], leaf: true });
    table.register("%luau-fn-pairs", (regs, s) => new MultipleValues([its.pairsNext, tableArg(regs[s], 1, "pairs"), undefined]), { args: [1, 1], leaf: true });
    // luaB_error. A string (or a number) is raised with where the function `level` calls up was, 1 being the one that
    // called error: (%luau-error args) raises it so for level 1, as an error of the library's own is, and gives what is
    // raised as it is otherwise; (%luau-error-at args stack) gives it for a level further up, from the stack
    const errorLevel = (a: Args): number => typeof a[0] === "string" || typeof a[0] === "number" ? optInteger(a, 2, "error", 1) : (optInteger(a, 2, "error", 1), 0);
    table.register("%luau-error-far?", (regs, s) => errorLevel(regs[s]) > 1, { args: [1, 1], leaf: true, returns: "boolean" });
    table.register("%luau-error", (regs, s) => {
        const v = regs[s][0];
        if (errorLevel(regs[s]) > 0) throw luauError(toString(v));
        return v;
    }, { args: [1, 1], leaf: true, oneValue: true });
    table.register("%luau-error-at", (regs, s) => {
        const at = regs[s + 1].frames[errorLevel(regs[s]) - 1]?.pos ?? null;
        return (at === null ? "" : `${at.file}:${at.line}: `) + toString(regs[s][0]);
    }, { args: [2, 2], leaf: true, oneValue: true });
    // luaB_pcall: the arguments for the function (the first of pcall's), and what a caught error is to Luau (an error
    // of the VM or the library is its message)
    table.register("%luau-pcall-check", (regs, s) => {
        if (regs[s].length < 1) throw luauError("missing argument #1");
    }, { args: [1, 1], leaf: true, oneValue: true, inline: ([a], slow) => `(${a}.length < 1 ? ${slow} : undefined)` });
    table.register("%luau-pcall-args", (regs, s) => regs[s].slice(1), {
        args: [1, 1], leaf: true, oneValue: true, fresh: true, effectFree: true, inline: ([a]) => `${a}.slice(1)`,
    });
    table.register("%luau-caught", (regs, s) => {
        const e = regs[s] instanceof ErrorObject ? regs[s].error : regs[s];
        return e instanceof Error ? e.message : e;
    }, { args: [1, 1], leaf: true, oneValue: true });
    table.register("%luau-fn-tostring", (regs, s) => {
        if (regs[s].length < 1) throw luauError("missing argument #1");
        return toString(regs[s][0]);
    }, { args: [1, 1], leaf: true, oneValue: true });
    table.register("%luau-fn-tonumber", (regs, s) => tonumberOf(regs[s]), { args: [1, 1], leaf: true, oneValue: true });
    table.register("%luau-fn-print", (regs, s) => {
        let line = "";
        for (let i = 0; i < regs[s].length; i++) line += (i > 0 ? "\t" : "") + toString(regs[s][i]);
        library.print(line);
        return new MultipleValues([]);
    }, { args: [1, 1], leaf: true });
    table.register("%luau-fn-ipairs", (regs, s) => new MultipleValues([its.inext, tableArg(regs[s], 1, "ipairs"), 0]), { args: [1, 1], leaf: true });
    const isTable = (v: string, d: Readonly<Record<string, string>>) => `${v}?.constructor === ${d.LuaTable}`;
    // (narray nhash value ...): a constructor's table, with the items before its first keyed one
    table.register("%luau-table", (regs, s, n) => LuaTable.of(regs.slice(s + 2, s + n), regs[s], regs[s + 1]), {
        args: [2, Infinity], leaf: true, returns: "table", deps: { LuaTable },
        inline: ([narray, nhash, ...values], _slow, _tmp, d) => values.length === 0 ? `new ${d.LuaTable}(${narray}, ${nhash})` : `${d.LuaTable}.of([${values.join(", ")}], ${narray}, ${nhash})`,
    });
    // (table index value): a constructor's item that has no key, after one that has (the array part may have shrunk)
    table.register("%luau-seti", (regs, s) => regs[s].seti(regs[s + 1], regs[s + 2]), { args: [3, 3], leaf: true, oneValue: true });
    // (table start array): the values of a constructor's last item, a call or `...`
    table.register("%luau-setlist", (regs, s) => regs[s].setlist(regs[s + 1], regs[s + 2]), { args: [3, 3], leaf: true, oneValue: true });
    table.register("%luau-index", (regs, s) => index(strings, regs[s], regs[s + 1]), {
        args: [2, 2], leaf: true, oneValue: true, deps: { LuaTable },
        inline: ([t, k], slow, _tmp, d, known) => known[0] === "table" ? `${t}.rawget(${k})` : `(${isTable(t, d)} ? ${t}.rawget(${k}) : ${slow})`,
    });
    table.register("%luau-setindex", (regs, s) => setindex(regs[s], regs[s + 1], regs[s + 2]), {
        args: [3, 3], leaf: true, oneValue: true, deps: { LuaTable },
        // (its errors are the table's own too: the slow path is in the expression, so they get where they happened)
        inline: ([t, k, v], slow, _tmp, d) => `(${isTable(t, d)} ? ${t}.rawset(${k}, ${v}) : ${slow})`,
    });
    // (shape value ...): a table of fields only, each name once (LOP_DUPTABLE and its stores)
    table.register("%luau-record", (regs, s, n) => LuaTable.record(regs[s], regs.slice(s + 1, s + n)), {
        args: [1, Infinity], leaf: true, returns: "table", deps: { LuaTable },
        inline: ([shape, ...values], _slow, _tmp, d) => `${d.LuaTable}.record(${shape}, [${values.join(", ")}])`,
    });
    // t.name and t.name = v (LOP_GETTABLEKS, LOP_SETTABLEKS): %luau-index and %luau-setindex of a name, which a table
    // looks for first where the same code last found it
    table.register("%luau-field", (regs, s) => index(strings, regs[s], regs[s + 1]), {
        args: [2, 2], leaf: true, oneValue: true, deps: { LuaTable }, site: slotCache,
        inline: ([t, k], slow, _tmp, d, known, site) => {
            const get = site === undefined ? `${t}.rawget(${k})` : `${t}.getfield(${k}, ${site})`;
            return known[0] === "table" ? get : `(${isTable(t, d)} ? ${get} : ${slow})`;
        },
    });
    table.register("%luau-setfield", (regs, s) => setindex(regs[s], regs[s + 1], regs[s + 2]), {
        args: [3, 3], leaf: true, oneValue: true, deps: { LuaTable }, site: slotCache,
        inline: ([t, k, v], slow, _tmp, d, _known, site) => `(${isTable(t, d)} ? ${site === undefined ? `${t}.rawset(${k}, ${v})` : `${t}.setfield(${k}, ${v}, ${site})`} : ${slow})`,
    });
    table.register("%luau-len", (regs, s) => len(regs[s]), {
        args: [1, 1], leaf: true, returns: "number", deps: { LuaTable },
        inline: ([v], slow, _tmp, d, known) => known[0] === "table" ? `${v}.rawlen()` : known[0] === "string" ? `${v}.length`
            : `(typeof ${v} === "string" ? ${v}.length : ${isTable(v, d)} ? ${v}.rawlen() : ${slow})`,
    });
    table.register("%luau-method", (regs, s) => method(strings, regs[s], regs[s + 1]), {
        args: [2, 2], leaf: true, oneValue: true, deps: { LuaTable, strings }, site: slotCache,
        inline: ([o, name], slow, tmp, d, known, site) => {
            const get = (t: string) => site === undefined ? `${t}.rawget(${name})` : `${t}.getfield(${name}, ${site})`;
            const found = known[0] === "string" ? get(d.strings) : `${isTable(o, d)} ? ${get(o)} : typeof ${o} === "string" ? ${get(d.strings)} : undefined`;
            return `((${tmp} = ${found}) !== undefined ? ${tmp} : ${slow})`;
        },
    });
};
