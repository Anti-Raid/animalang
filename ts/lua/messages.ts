// Luau's names of values (type, tostring) and how Luau words the VM's and the compiler's messages (see Msg)
import { ErrorObject, IProcedure, Msg, formatPos, type Formatter, type SourcePos } from "../common";
import { Coroutine } from "../magicvm/exec";
import { LuaBuffer } from "./buffer";
import { NOWHERE } from "./errors";
import { num2str } from "./number";
import { LuaTable } from "./table";
import { LuaVector } from "./vector";

// type(v)
export const typeName = (v: any): string => {
    switch (typeof v) {
        case "undefined": return "nil";
        case "boolean": return "boolean";
        case "number": return "number";
        case "string": return "string";
        case "bigint": return "integer";
    }
    if (v instanceof LuaTable) return "table";
    if (v instanceof LuaVector) return "vector";
    if (v instanceof LuaBuffer) return "buffer";
    if (v instanceof IProcedure) return "function";
    if (v instanceof Coroutine) return "thread";
    return "userdata";
};

// what Luau prints as an object's address: one per object, as long as it lives
const addresses = new WeakMap<object, string>();
let nextAddress = 0x1000;
const addressOf = (o: object): string => {
    let a = addresses.get(o);
    if (a === undefined) {
        a = "0x" + (nextAddress += 0x40).toString(16).padStart(16, "0");
        addresses.set(o, a);
    }
    return a;
};

// tostring(v), without metamethods
export const toString = (v: any): string => {
    switch (typeof v) {
        case "undefined": return "nil";
        case "boolean": return v ? "true" : "false";
        case "number": return num2str(v);
        case "string": return v;
        case "bigint": return String(v);
    }
    if (v instanceof LuaVector) return v.tostring();
    return `${typeName(v)}: ${addressOf(v)}`;
};

const errorText = (x: any): string => x instanceof Error ? x.message : x instanceof ErrorObject ? errorText(x.error) : toString(x);

const word = (op: Msg, a: readonly any[], fmt: Formatter, at: SourcePos | null): string => {
    switch (op) {
        case Msg.Text: return a[0];
        case Msg.NotReentrant: return `cannot re-enter a continuation through function ${a[0]}`;
        case Msg.MissingVar: return `unbound global '${String(a[0].description ?? a[0])}'`;
        case Msg.NonProcedure: case Msg.NonProcedureWind: return `attempt to call a ${typeName(a[0])} value`;
        case Msg.ErrorInHandler: return `error in error handling: ${errorText(a[0])}`;
        default: return `internal error: ${Msg[op]}${a.length > 0 ? ` (${a.map(x => typeof x === "symbol" ? x.description : fmt(Msg.Value, [x], fmt, at)).join(", ")})` : ""}`;
    }
};

// messages are prefixed with where they happened, as Luau's runtime errors are ("file:line: ")
export const luauFormat: Formatter = (op, a, fmt, at) => {
    switch (op) {
        case Msg.Value: return toString(a[0]);
        case Msg.Unhandled: return errorText(a[0]);
        case Msg.TracebackHeader: return `${a[0] !== undefined ? String(a[0]) + "\n" : ""}stack traceback:`;
        case Msg.TracebackFrame: return `${formatPos(a[1])} function ${a[0]}`;
    }
    const text = word(op, a, fmt, at);
    return at === null || at === NOWHERE ? text : `${at.file}:${at.line}: ${text}`;
};
