// A library function's arguments, checked as Luau's auxiliary library checks them (VM/src/laux.cpp): the arguments are
// an array, `n` counts from 1, and `name` is the function's name in messages (null: it has none)
import { luauError } from "./errors";
import { typeName } from "./messages";
import { num2str, str2number } from "./number";
import { LuaTable } from "./table";

export type Args = readonly any[];

// luaL_typeerror
export const argError = (args: Args, n: number, name: string | null, type: string): Error => {
    const to = name === null ? "" : ` to '${name}'`;
    return luauError(args.length < n ? `missing argument #${n}${to} (${type} expected)` : `invalid argument #${n}${to} (${type} expected, got ${typeName(args[n - 1])})`);
};

// luaL_argerror
export const argInvalid = (n: number, name: string, why: string): Error => luauError(`invalid argument #${n} to '${name}' (${why})`);

export const tableArg = (args: Args, n: number, name: string | null): LuaTable => {
    if (!(args[n - 1] instanceof LuaTable)) throw argError(args, n, name, "table");
    return args[n - 1];
};

// luaL_checklstring: a string, or a number as it is written
export const stringArg = (args: Args, n: number, name: string | null): string => {
    const v = args[n - 1];
    if (typeof v === "string") return v;
    if (typeof v === "number") return num2str(v);
    throw argError(args, n, name, "string");
};

// luaL_checknumber: a number, or a string that reads as one
export const numberArg = (args: Args, n: number, name: string | null): number => {
    const v = args[n - 1];
    if (typeof v === "number") return v;
    const read = typeof v === "string" ? str2number(v) : undefined;
    if (read === undefined) throw argError(args, n, name, "number");
    return read;
};

// C's (int) of a number: toward zero, and (as arm64 does it) the nearest int for one out of range, 0 for a NaN
export const toInt = (d: number): number => d !== d ? 0 : d >= 2147483647 ? 2147483647 : d <= -2147483648 ? -2147483648 : Math.trunc(d);

// luaL_checkinteger, luaL_optinteger
export const integerArg = (args: Args, n: number, name: string | null): number => toInt(numberArg(args, n, name));
export const optInteger = (args: Args, n: number, name: string | null, otherwise: number): number =>
    args[n - 1] === undefined ? otherwise : integerArg(args, n, name);
