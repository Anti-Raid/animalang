// Luau: an instance whose language is Luau (syntax/ parses it, lower.ts lowers it to core forms, ops.ts has its operators)
import { Anima } from "../anima";
import { CORE_CALL, CORE_IF, CORE_INTCALL, CORE_LAMBDA, CORE_LET, CORE_LETREC, Env } from "../common";
import { ClosureTemplate, intrinsicProcedure, type Closure, type Code } from "../magicvm/code";
import { MATH_CONSTANTS, MATH_LIBRARY } from "./mathlib";
import { TABLE_LIBRARY } from "./tablib";
import { BIT_LIBRARY } from "./bitlib";
import { UTF8_CHARPATTERN, UTF8_LIBRARY } from "./utf8lib";
import { OS_LIBRARY } from "./oslib";
import { BUFFER_LIBRARY, VECTOR_CONSTANTS, VECTOR_LIBRARY } from "./buflib";
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
        next: undefined, pairsNext: undefined, inext: undefined, string: new LuaTable(), pcall: undefined, xpcall: undefined, handler: undefined, error: undefined, utf8Next: undefined,
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
        // (one that is a leaf intrinsic over its arguments and nothing else is made without compiling it)
        if (before.length === 0 && anima.intrinsics.byName(op)?.leaf === true) {
            const made = intrinsicProcedure(anima.intrinsics, op, name, options.debug === true, false);
            made.tmpl.code.internal = true;
            return made;
        }
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
    for (const name of ["tostring", "tonumber", "print", "type", "assert", "select", "setmetatable"]) define(name, library(name, `%luau-fn-${name}`));
    for (const name of Object.keys(STRING_LIBRARY)) iterators.string.set(name, library(name, `%luau-string-${name}`));
    // gmatch gives a function that goes on from where the last match ended
    const [rest, state] = [Symbol("..."), Symbol("state")];
    iterators.string.set("gmatch", procedure("gmatch", [CORE_LAMBDA, null, clause([PAD], [], rest, [
        [CORE_LET, null, [[state, [CORE_INTCALL, null, Symbol.for("%luau-string-gmatch"), rest]]],
            [CORE_LAMBDA, null, clause([PAD], [], null, [[CORE_INTCALL, null, Symbol.for("%luau-gmatch-next"), state]])]]])]));
    define("string", iterators.string);
    const tableOf = (prefix: string, names: readonly string[], constants: Record<string, unknown> = {}): LuaTable => {
        const t = new LuaTable();
        for (const name of names) t.set(name, library(name, `%luau-${prefix}-${name}`));
        for (const [name, value] of Object.entries(constants)) t.set(name, value);
        return t;
    };
    define("math", tableOf("math", Object.keys(MATH_LIBRARY), MATH_CONSTANTS));
    const tables = tableOf("table", Object.keys(TABLE_LIBRARY));
    define("table", tables);
    // (a function of its own, as Luau's is: unpack ~= table.unpack)
    define("unpack", library("unpack", "%luau-table-unpack"));
    for (const name of ["rawequal", "rawget", "rawset", "rawlen", "getmetatable", "typeof"]) define(name, library(name, `%luau-fn-${name}`));
    define("_VERSION", "Luau");
    define("bit32", tableOf("bit32", Object.keys(BIT_LIBRARY)));
    iterators.utf8Next = library("", "%luau-utf8-next");
    define("utf8", tableOf("utf8", [...Object.keys(UTF8_LIBRARY), "codes"], { charpattern: UTF8_CHARPATTERN }));
    define("os", tableOf("os", Object.keys(OS_LIBRARY)));
    define("buffer", tableOf("buffer", Object.keys(BUFFER_LIBRARY)));
    define("vector", tableOf("vector", Object.keys(VECTOR_LIBRARY), VECTOR_CONSTANTS));
    const call = (op: string, ...args: any[]) => [CORE_INTCALL, null, Symbol.for(op), ...args];
    // error raises its value; a string gets where the function that called it (or one further up) was
    define("error", iterators.error = procedure("error", [CORE_LAMBDA, null, clause([PAD], [], rest, [
        call("%raise", [CORE_IF, null, call("%luau-error-far?", rest), call("%luau-error-at", rest, call("%current-stack")), call("%luau-error", rest)])])]));
    // pcall calls its function catching: true and what it returns, or false and the error
    const r = Symbol("r");
    define("pcall", iterators.pcall = procedure("pcall", [CORE_LAMBDA, null, clause([PAD], [], rest, [
        call("%luau-pcall-check", rest),
        [CORE_LET, null, [[r, call("%apply-catching", call("%luau-arg", rest, 0), call("%luau-pcall-args", rest))]],
            [CORE_IF, null, call("%caught?", r),
                call("%values", false, call("%luau-caught", call("%caught-value", r))),
                call("%values-cons", true, r)]]])]));
    // xpcall is pcall whose handler runs where the error is raised, before anything unwinds (the catch's `pre`), and
    // gives what xpcall returns after false: its first value; a handler that fails is "error in error handling"
    const [h, e] = [Symbol("handler"), Symbol("e")];
    iterators.handler = procedure("handler", [CORE_LAMBDA, null, clause([], [h, e], null, [call("%first-value", [CORE_CALL, null, h, call("%luau-caught", e)], undefined)])]);
    define("xpcall", iterators.xpcall = procedure("xpcall", [CORE_LAMBDA, null, clause([PAD], [], rest, [
        call("%luau-xpcall-check", rest),
        [CORE_LET, null, [[h, call("%luau-arg", rest, 1)]],
            [CORE_LET, null, [[r, call("%apply-catching", call("%luau-arg", rest, 0), call("%luau-xpcall-args", rest),
                [CORE_LAMBDA, null, clause([], [e], null, [call("%first-value", [CORE_CALL, null, h, call("%luau-caught", e)], undefined)])], true)]],
                [CORE_IF, null, call("%caught?", r),
                    call("%values", false, call("%luau-xpcall-caught", call("%caught-value", r))),
                    call("%values-cons", true, r)]]]])]));
    // debug.traceback: the frames from the function that called it out (or a thread's), as Luau lists them
    const debug = new LuaTable();
    debug.set("traceback", procedure("traceback", [CORE_LAMBDA, null, clause([PAD], [], rest, [
        call("%luau-fn-traceback", rest, call("%debug-frames", call("%current-stack"), call("%luau-traceback-thread", rest), undefined))])]));
    define("debug", debug);
    // The coroutine library, over the VM's coroutines. A resume is a call that catches (as pcall's): the error a
    // coroutine dies of comes to whatever resumed it
    const [co, args] = [Symbol("co"), Symbol("args")];
    const resumed = (thread: symbol, given: any) => call("%catch-call", [CORE_LAMBDA, null, clause([], [co, args], null, [call("%coroutine-resume-array", co, args)])], thread, given);
    const coroutine = new LuaTable();
    const member = (name: string, ...body: any[]) => coroutine.set(name, procedure(name, [CORE_LAMBDA, null, clause([PAD], [], rest, body)]));
    member("create", call("%coroutine-create", call("%luau-co-function", rest, "create")));
    member("resume", [CORE_LET, null, [[co, call("%luau-co-thread", rest, "resume")]],
        [CORE_IF, null, call("%luau-co-suspended?", co),
            [CORE_LET, null, [[r, resumed(co, call("%luau-pcall-args", rest))]],
                [CORE_IF, null, call("%caught?", r),
                    call("%values", false, call("%luau-co-failed", co, call("%luau-caught", call("%caught-value", r)))),
                    call("%values-cons", true, r)]],
            call("%values", false, call("%luau-co-cannot", co))]]);
    member("wrap", [CORE_LET, null, [[co, call("%coroutine-create", call("%luau-co-function", rest, "wrap"))]],
        [CORE_LAMBDA, null, clause([PAD], [], args, [
            [CORE_IF, null, call("%luau-co-suspended?", co),
                [CORE_LET, null, [[r, resumed(co, args)]],
                    [CORE_IF, null, call("%caught?", r),
                        call("%raise", call("%luau-co-rethrow", call("%luau-co-failed", co, call("%luau-caught", call("%caught-value", r))))),
                        r]],
                call("%raise", call("%luau-co-rethrow", call("%luau-co-cannot", co)))]])]]);
    member("yield", call("%coroutine-yield", call("%luau-varargs", rest)));
    member("running", call("%current-coroutine", undefined));
    member("isyieldable", call("%coroutine-yieldable?"));
    member("close", [CORE_LET, null, [[co, call("%luau-co-closing", rest)]], call("%coroutine-close", co), call("%luau-co-closed", co)]);
    coroutine.set("status", library("status", "%luau-fn-costatus"));
    define("coroutine", coroutine);
    return anima;
};
