// Luau: an instance whose language is Luau (syntax/ parses it, lower.ts lowers it to core forms, ops.ts has its operators)
import { Anima } from "../anima";
import { CORE_IF, CORE_INTCALL, CORE_LAMBDA, CORE_LET, CORE_LETREC, Env } from "../common";
import { ClosureTemplate, type Closure, type Code } from "../magicvm/code";
import { PAD, clause } from "../magicvm/lambda";
import type { AnimaOptions } from "../magicvm/meta";
import { LuauSyntaxError, lowerLuau } from "./lower";
import { luauFormat } from "./messages";
import { LUAU_TYPES, registerLuauOps, type LuauLibrary } from "./ops";
import { STRING_LIBRARY } from "./strlib";
import { LuaTable, RecordShape } from "./table";
import { registerDatumSerializer } from "../magicvm/aot/serializer";
import { registerDatumDeserializer } from "../magicvm/loader";
import { parseLuau } from "./syntax/parser";
import type { ParseResult } from "./syntax/ast";

export { LuauSyntaxError } from "./lower";
export { luauFormat, toString, typeName } from "./messages";

// a Luau string is of bytes: its text, read as UTF-8
const decoder = new TextDecoder();
export const luauText = (s: string): string => /[\x80-\xff]/.test(s) ? decoder.decode(Uint8Array.from(s, c => c.charCodeAt(0))) : s;

// what the host gives a Luau instance. `print` gets each line print writes (a Luau string, without its newline)
export type LuauHost = { readonly print?: (line: string) => void };

// what Luau's compiled code holds besides plain values, for pre-compiled execution units: a record constructor's keys
registerDatumSerializer("luau-record-shape", v => v instanceof RecordShape, v => ({ keys: v.keys }));
registerDatumDeserializer("luau-record-shape", d => new RecordShape(d.keys));

// what the front end reads: a parsed chunk, or (for the library's own functions) core forms as they are
type Read = { parsed: ParseResult, file: string, source: string } | { core: any };

export const createLuau = (options: AnimaOptions, host: LuauHost = {}): Anima => {
    // Luau has no re-entrant continuations (coroutines resume their one suspended frame)
    const anima = new Anima({ ...options, reentrant: false });
    const iterators: LuauLibrary = {
        next: undefined, pairsNext: undefined, inext: undefined, string: new LuaTable(),
        print: host.print ?? (line => console.log(luauText(line))),
    };
    anima.intrinsics.setFormatter(luauFormat);
    anima.intrinsics.setTypes(LUAU_TYPES);
    registerLuauOps(anima.intrinsics, iterators);
    anima.attachFrontEnd({
        read: (source: string, file: string = "chunk"): Read => {
            const parsed = parseLuau(source);
            const error = parsed.errors[0];
            if (error !== undefined) {
                const { line, column } = parsed.lines.pos(error.from);
                throw new LuauSyntaxError({ file, line: line + 1, col: column + 1 }, error.message);
            }
            return { parsed, file, source };
        },
        transform: (read: Read) => "core" in read ? read.core : lowerLuau(read.parsed, read.file, read.source),
        lambda: () => { throw new Error("Luau has no procedure syntax for the host to compile"); },
    }, new Env(null, false, { unbound: undefined }));

    // a library function: a procedure of any number of arguments whose body is the intrinsic `op` over them (an array,
    // after `before`). Its code is the VM's own, so an error in it is where it was called, as Luau reports a C function's
    const library = (name: string, op: string, ...before: any[]): Closure => {
        const rest = Symbol("...");
        return procedure(name, [CORE_LAMBDA, null, clause([PAD], [], rest, [[CORE_INTCALL, null, Symbol.for(op), ...before, rest]])]);
    };
    const procedure = (name: string, lambda: any): Closure => {
        const self = Symbol(name);
        const made: Closure = anima.evaluateRaw(anima.compileRawAst({ core: [CORE_LETREC, null, [[self, lambda]], self] }));
        own(made.tmpl.code);
        return made;
    };
    // the code of a library function, and of the functions it makes
    const own = (code: Code): void => {
        code.internal = true;
        for (const c of code.constants) if (c instanceof ClosureTemplate) own(c.code);
    };
    const define = (name: string, value: unknown) => anima.scope.set(Symbol.for(name), value);
    define("next", iterators.next = library("next", "%luau-fn-next", "next"));
    iterators.pairsNext = library("pairs", "%luau-fn-next", undefined);
    iterators.inext = library("ipairs", "%luau-fn-inext");
    define("pairs", library("pairs", "%luau-fn-pairs"));
    define("ipairs", library("ipairs", "%luau-fn-ipairs"));
    for (const name of ["tostring", "tonumber", "print"]) define(name, library(name, `%luau-fn-${name}`));
    for (const name of Object.keys(STRING_LIBRARY)) iterators.string.set(name, library(name, `%luau-string-${name}`));
    // gmatch gives a function that goes on from where the last match ended
    const [rest, state] = [Symbol("..."), Symbol("state")];
    iterators.string.set("gmatch", procedure("gmatch", [CORE_LAMBDA, null, clause([PAD], [], rest, [
        [CORE_LET, null, [[state, [CORE_INTCALL, null, Symbol.for("%luau-string-gmatch"), rest]]],
            [CORE_LAMBDA, null, clause([PAD], [], null, [[CORE_INTCALL, null, Symbol.for("%luau-gmatch-next"), state]])]]])]));
    define("string", iterators.string);
    const call = (op: string, ...args: any[]) => [CORE_INTCALL, null, Symbol.for(op), ...args];
    // error raises its value; a string gets where the function that called it (or one further up) was
    define("error", procedure("error", [CORE_LAMBDA, null, clause([PAD], [], rest, [
        call("%raise", [CORE_IF, null, call("%luau-error-far?", rest), call("%luau-error-at", rest, call("%current-stack")), call("%luau-error", rest)])])]));
    // pcall calls its function catching: true and what it returns, or false and the error
    const r = Symbol("r");
    define("pcall", procedure("pcall", [CORE_LAMBDA, null, clause([PAD], [], rest, [
        call("%luau-pcall-check", rest),
        [CORE_LET, null, [[r, call("%apply-catching", call("%luau-arg", rest, 0), call("%luau-pcall-args", rest))]],
            [CORE_IF, null, call("%caught?", r),
                call("%values", false, call("%luau-caught", call("%caught-value", r))),
                call("%values-cons", true, r)]]])]));
    return anima;
};
