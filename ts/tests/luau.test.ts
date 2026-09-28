import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { readFileSync, readdirSync } from 'fs';
import { Lexer, unescapeLong, unescapeQuoted } from '../lua/syntax/lexer';
import { parseLuau } from '../lua/syntax/parser';
import { TOK_TEXT, Tok } from '../lua/syntax/tokens';
import { show } from '../lua/syntax/print';
import { L, isForm, offsetOf, type Comment } from '../lua/syntax/ast';
import type * as C from '../lua/syntax/ast';

const kinds = (src: string) => {
    const lexer = new Lexer(src);
    const out: string[] = [];
    for (lexer.next(); lexer.kind !== Tok.Eof; lexer.next()) {
        const k = lexer.kind;
        out.push(k === Tok.Name || k === Tok.Number || k === Tok.Char ? `${TOK_TEXT[k]}:${lexer.tokenText}` : TOK_TEXT[k]);
    }
    return out.join(" ");
};
const ok = (src: string): C.Block => {
    const r = parseLuau(src);
    expect(r.errors).toEqual([]);
    return r.root;
};
const body = (block: C.Block): any[] => block.slice(1, -1);
const tree = (src: string) => body(ok(src)).map(show).join(" ");
// a form in full, offsets included, with locals numbered as they first appear (so it shows which are the same)
const fingerprint = (root: C.Block): string => {
    const ids = new Map<symbol, number>();
    const write = (v: unknown): string => {
        if (isForm(v)) return `(${v.map(write).join(" ")})`;
        if (Array.isArray(v)) return `[${v.map(write).join(" ")}]`;
        if (typeof v === "symbol" && !Object.values(L).includes(v as any)) {
            if (!ids.has(v)) ids.set(v, ids.size);
            return `$${ids.get(v)}`;
        }
        return typeof v === "symbol" ? v.description! : JSON.stringify(v);
    };
    return write(root);
};
const firstError = (src: string) => {
    const r = parseLuau(src), e = r.errors[0];
    if (e === undefined) return "";
    const at = r.lines.pos(e.from);
    return `(${at.line + 1},${at.column + 1}): ${e.message}`;
};

describe("Luau lexer", () => {
    it("reads operators, keywords and contextual keywords", () => {
        expect(kinds("a //= b .. c ..= d ... -> :: ~= == <= >= += -= *= /= %= ^= #t ? & |")).toBe(
            "name:a //= name:b .. name:c ..= name:d ... -> :: ~= == <= >= += -= *= /= %= ^= # name:t ? & |");
        expect(kinds("local function continue type export typeof const end")).toBe("local function name:continue name:type name:export name:typeof name:const end");
        expect(kinds("x ! $")).toBe("name:x char:! char:$");
    });

    it("reads numbers as Lua does, leaving their checks to the parser", () => {
        expect(kinds("1 1.5 .5 1e10 1E-3 0x1F 0b101 1_000 12abc 1..2")).toBe(
            "number:1 number:1.5 number:.5 number:1e10 number:1E-3 number:0x1F number:0b101 number:1_000 number:12abc number:1..2");
    });

    it("reads strings, long strings and comments", () => {
        const comments: Comment[] = [];
        const lexer = new Lexer(`'a\\'b' "c" [==[x]]y]==] --[[ block ]] -- line\n--!strict`, { comments });
        const toks = [];
        for (lexer.next(); lexer.kind !== Tok.Eof; lexer.next()) toks.push([TOK_TEXT[lexer.kind], lexer.text, lexer.quote, lexer.depth]);
        expect(toks).toEqual([["string", "a\\'b", "'", 0], ["string", "c", "\"", 0], ["rawString", "x]]y", undefined, 2]]);
        expect(comments.map(c => c.kind)).toEqual(["blockComment", "comment", "comment"]);
        expect(kinds(`"abc\n" [[x`)).toBe("brokenString brokenString");
        expect(kinds(`--[[ open`)).toBe("brokenComment");
    });

    it("tracks lines, columns and offsets", () => {
        const lexer = new Lexer("a\n  bb");
        lexer.next();
        lexer.next();
        expect([lexer.from, lexer.to]).toEqual([4, 6]);
        expect([lexer.lines.pos(lexer.from), lexer.lines.pos(lexer.to)]).toEqual([{ line: 1, column: 2, offset: 4 }, { line: 1, column: 4, offset: 6 }]);
    });

    it("splits interpolated strings, keeping track of braces inside them", () => {
        expect(kinds("`a{x}b{ {1} }c`")).toBe("interpBegin name:x interpMid { number:1 } interpEnd");
        expect(kinds("`plain`")).toBe("interpSimple");
        // `{{` is an error; the backquote after it then starts another string, left unfinished
        expect(kinds("`a{{`")).toBe("brokenInterpDoubleBrace brokenString");
    });

    it("decodes escapes into byte strings", () => {
        expect(unescapeQuoted("a\\n\\t\\\\\\\"")).toBe("a\n\t\\\"");
        expect(unescapeQuoted("\\x41\\65\\0\\255")).toBe("AA\0\xff");
        expect(unescapeQuoted("\\u{48}\\u{e9}\\u{1F600}")).toBe("H\xc3\xa9\xf0\x9f\x98\x80");
        expect(unescapeQuoted("a\\z  \n  b")).toBe("ab");
        expect(unescapeQuoted("é")).toBe("\xc3\xa9");
        expect(unescapeQuoted("\\256")).toBeNull();
        expect(unescapeQuoted("\\xZZ")).toBeNull();
        expect(unescapeQuoted("\\u{}")).toBeNull();
        expect(unescapeLong("\nfirst\r\nsecond")).toBe("first\nsecond");
        // a lone surrogate is a code point of its own (3 bytes), and does not take the character after it
        expect(unescapeLong("a\uD800b")).toBe("a\xed\xa0\x80b");
        expect(unescapeQuoted("a\uD800b")).toBe("a\xed\xa0\x80b");
        expect(unescapeQuoted("\uD83D\uDE00!")).toBe("\xf0\x9f\x98\x80!");
    });
});

describe("Luau parser", () => {
    it("parses operators by Luau's priorities", () => {
        expect(tree("x = 1 + 2 * 3")).toBe('(assign [(global "x")] [(+ 1 (* 2 3))])');
        // ^ and .. are right associative; unary operators bind looser than ^
        expect(tree("x = 2 ^ 3 ^ 2")).toBe('(assign [(global "x")] [(^ 2 (^ 3 2))])');
        expect(tree("x = -y ^ 2")).toBe('(assign [(global "x")] [(neg (^ (global "y") 2))])');
        expect(tree("x = a .. b .. c")).toBe('(assign [(global "x")] [(.. (global "a") (.. (global "b") (global "c")))])');
        expect(tree("x = a or b and c == d")).toBe('(assign [(global "x")] [(or (global "a") (and (global "b") (== (global "c") (global "d"))))])');
        expect(tree("x = not a == b")).toBe('(assign [(global "x")] [(== (not (global "a")) (global "b"))])');
        expect(tree("x = a // b % c")).toBe('(assign [(global "x")] [(% (// (global "a") (global "b")) (global "c"))])');
    });

    it("parses calls, indexing and methods", () => {
        expect(tree(`a.b[c]:d("s")`)).toBe('(method (index (index (global "a") "b") (global "c")) "d" "s")');
        expect(tree(`f "s" { 1 } [[r]]`)).toBe('(call (call (call (global "f") "s") (table 1)) "r")');
        expect(tree(`(f)(1)`)).toBe('(call (one (global "f")) 1)');
        expect(tree(`f<<number, string>>(1)`)).toBe('(call (global "f") 1)');
    });

    it("parses tables, functions and the other expressions", () => {
        expect(tree(`t = { 1, k = 2, [3] = 4; f = function() end }`)).toBe('(assign [(global "t")] [(table 1 (field "k" 2) (pair 3 4) (field "f" (function [] false (block) "f")))])');
        expect(tree(`x = if a then 1 elseif b then 2 else 3`)).toBe('(assign [(global "x")] [(ifx (global "a") 1 (ifx (global "b") 2 3))])');
        expect(tree("x = `a{b}c{d}e`")).toBe('(assign [(global "x")] [(interp "a" (global "b") "c" (global "d") "e")])');
        expect(tree(`x = y :: number`)).toBe('(assign [(global "x")] [(one (global "y"))])');
        expect(tree(`x = #t, -1, ..., nil, true`)).toBe('(assign [(global "x")] [(# (global "t")) (neg 1) (...) nil true])');
        expect(tree(`x = 0x1F, 0b101, 1_000, .5, 1e3`)).toBe('(assign [(global "x")] [31 5 1000 0.5 1000])');
    });

    it("parses every statement", () => {
        expect(tree(`local a: number, b = 1, 2`)).toBe('(local [a b] [1 2])');
        expect(tree(`const k = 1`)).toBe('(local [k] [1])');
        expect(tree(`a, b.c = 1, 2 x += 1 y ..= "s"`)).toBe('(assign [(global "a") (index (global "b") "c")] [1 2]) (opset + (global "x") 1) (opset .. (global "y") "s")');
        expect(tree(`if a then elseif b then else end`)).toBe('(if (global "a") (block) (if (global "b") (block) (block)))');
        expect(tree(`while a do break end repeat continue until b`)).toBe('(while (global "a") (block (break))) (repeat (block (continue)) (global "b"))');
        expect(tree(`for i = 1, 10, 2 do end for k, v in pairs(t) do end`)).toBe('(for i 1 10 2 (block)) (forin [k v] [(call (global "pairs") (global "t"))] (block))');
        expect(tree(`do local x end return`)).toBe('(block (local [x] [])) (return)');
        expect(tree(`function a.b:c(x, ...) end`)).toBe('(assign [(index (index (global "a") "b") "c")] [(function [self x] true (block) "c")])');
        expect(tree(`local function f<T>(x: T): T return x end`)).toBe('(localfn f (function [x] false (block (return x)) "f"))');
        expect(tree(`@native @checked function f() end`)).toBe('(assign [(global "f")] [(function [] false (block) "f")])');
        expect(tree(`@[deprecated { use = "g" }] local function f() end`)).toBe('(localfn f (function [] false (block) "f"))');
        expect(tree(`f(); g()`)).toBe('(call (global "f")) (call (global "g"))');
    });

    it("ends every form with where it starts", () => {
        const [local, call] = body(ok(`local a = 1
  print(a + 2)`));
        expect(offsetOf(local as C.Form)).toBe(0);
        const [, , sum] = call as C.Call;
        expect(offsetOf(call as C.Form)).toBe(14);
        expect(offsetOf(sum as C.Form)).toBe(20);
    });

    it("keeps its contextual keywords usable as names", () => {
        expect(tree(`local type = 1 type = 2 continue(type) export = typeof`)).toBe('(local [type] [1]) (assign [type] [2]) (call (global "continue") type) (assign [(global "export")] [(global "typeof")])');
    });

    it("resolves names to the locals they refer to", () => {
        const root = ok(`local x = 1
            local function f() return x end
            local x = x
            repeat local y = 1 until y
            for i = 1, 2 do end
            return x, i`);
        const [first, fn, second, repeat, , ret] = body(root) as any[];
        const outer = first[1][0];
        expect(typeof outer).toBe("symbol");
        // f's body returns the outer x
        expect(body(fn[2][3])[0][1]).toBe(outer);
        // the new x is in scope after its own declaration, and shadows the first
        expect(second[2][0]).toBe(outer);
        expect(second[1][0]).not.toBe(outer);
        expect(ret[1]).toBe(second[1][0]);
        // a repeat's condition sees its body's locals; a for's variable ends with it
        expect(repeat[2]).toBe(body(repeat[1])[0][1][0]);
        expect(ret[2][0]).toBe(L.GLOBAL);
        // a local function sees itself; self is a method's first parameter
        const [rec, method] = body(ok(`local function f() return f end function t:m() return self end`)) as any[];
        expect(body(rec[2][3])[0][1]).toBe(rec[1]);
        expect(body(method[2][0][3])[0][1]).toBe(method[2][0][1][0]);
    });

    it("checks types but keeps none", () => {
        const types = [
            "string | number?", "A & B", "{ x: number, read y: string, [string]: boolean }", "{ number }",
            "(a: number, string) -> (boolean, ...any)", "<T, U...>(T, U...) -> ()", "typeof(x)", `"lit" | true`,
            "mod.Type<number, (string)>", "(number)",
        ];
        for (const t of types) expect(tree(`type T = ${t} local x: ${t} = 1`), t).toBe('(local [x] [1])');
        expect(tree(`export type P<T = string, U... = ...number> = T; type function f(t) return t end`)).toBe("");
        expect(tree(`local function f<T>(a: T, ...: number): (T, ...number) return a end`)).toBe('(localfn f (function [a] true (block (return a)) "f"))');
        expect(tree(`local y = f<<\nnumber>>(1)`)).toBe('(local [y] [(call (global "f") 1)])');
    });

    it("reports the errors Luau does, where it does", () => {
        // what luau-analyze 0.740 reports for each (the first error)
        const cases: [string, string][] = [
        ["local function f()\n  return 1\n", "(3,1): Expected 'end' (to close 'function' at line 1), got <eof>"],
        ["if x then\n  print(1)\n", "(3,1): Expected 'end' (to close 'then' at line 1), got <eof>"],
        ["if x print(1) end", "(1,6): Expected 'then' when parsing if statement, got 'print'"],
        ["local x = (1 + 2\nprint(x)", "(2,1): Expected ')' (to close '(' at line 1), got 'print'"],
        ["local t = {a = 1 b = 2}", "(1,18): Expected ',' after table constructor element"],
        ["print(x)\n(f)()", "(2,1): Ambiguous syntax: this looks like an argument list for a function call, but could also be a start of new statement; use ';' to separate statements"],
        ["local a = b\n(c or d)()", "(2,1): Ambiguous syntax: this looks like an argument list for a function call, but could also be a start of new statement; use ';' to separate statements"],
        ["if a != b then end", "(1,6): Unexpected '!='; did you mean '~='?"],
        ["if a && b then end", "(1,6): Unexpected '&&'; did you mean 'and'?"],
        ["if a || b then end", "(1,6): Unexpected '||'; did you mean 'or'?"],
        ["local y = !x", "(1,11): Unexpected '!'; did you mean 'not'?"],
        ["function f() return ... end", "(1,21): Cannot use '...' outside of a vararg function"],
        ["print(...)", ""],
        ["break", "(1,1): break statement must be inside a loop"],
        ["local x = 1\ncontinue", "(2,1): continue statement must be inside a loop"],
        ["const c = 1\nc = 2", "(2,1): Variable 'c' is constant and may not be reassigned"],
        ["f() = 1", "(1,5): Expected identifier when parsing expression, got '='"],
        ["local n = 0x", "(1,11): Malformed number"],
        ["local n = 1..2", "(1,11): Malformed number"],
        ["local n = 12abc", "(1,11): Malformed number"],
        ["local s = \"abc", "(1,11): Malformed string; did you forget to finish it?"],
        ["local s = \"\\q\\400\"", "(1,11): String literal contains malformed escape sequence"],
        ["local s = `abc {x`", "(1,18): Malformed interpolated string; did you forget to add a '}'?"],
        ["local s = `abc {x} {{`", "(1,11): Double braces are not permitted within interpolated strings; did you mean '\\{'?"],
        ["type T = string | number & boolean", "(1,10): Mixing union and intersection types is not allowed; consider wrapping in parentheses."],
        ["const k", "(1,1): Missing initializer in const declaration"],
        ["const a, b = 1", "(1,1): Missing initializer in const declaration"],
        ["@foo function f() end", "(1,1): Invalid attribute '@foo'"],
        ["@[] function f() end", "(1,1): Attribute list cannot be empty"],
        ["local x: = 1", "(1,9): Expected type, got '='"],
        ["local x = function(a b) end", "(1,22): Expected ')' (to close '(' at column 19), got 'b'"],
        ["for i = 1 do end", "(1,11): Expected ',' when parsing index range, got 'do'"],
        ["for a, b of t do end", "(1,10): Expected 'in' when parsing for loop, got 'of'"],
        ["return 1\nprint(2)", "(2,1): Expected <eof>, got 'print'"],
        ["local t = {[1] 2}", "(1,16): Expected '=' when parsing table field, got '2'"],
        ["x = 1 +", "(1,8): Expected identifier when parsing expression, got <eof>"],
        ["local x <const> = 1", "(1,9): Expected identifier when parsing expression, got '<'"],
        ["type T<A..., B> = A", "(1,15): Generic types come before generic type packs"],
        ["local x = a.b.", "(1,15): Expected identifier, got <eof>"],
        ["while true do local x = 1", "(1,26): Expected 'end' (to close 'do' at column 12), got <eof>"],
        ["local x = 1\ntype function f(t) return x end", "(2,29): Type function cannot reference outer local 'x'"],
        ];
        for (const [src, expected] of cases) expect(firstError(src), src).toBe(expected);
    });

    it("recovers from errors and keeps going", () => {
        const r = parseLuau(`local x = (1 +\nprint("next")\nlocal y = 2`);
        expect(r.errors.length).toBeGreaterThan(0);
        expect(body(r.root).at(-1)![0]).toBe(L.LOCAL);
        const [assign] = body(parseLuau(`(a) = 1`).root) as any[];
        expect(assign[1][0][0]).toBe(L.ERROR);
    });

    it("stops at 100 errors unless told not to", () => {
        const src = Array.from({ length: 150 }, () => "local = 1").join("\n");
        const limited = parseLuau(src).errors;
        expect(limited.length).toBe(101);
        expect(limited[100].message).toBe("Reached error limit (100)");
        expect(parseLuau(src, { noErrorLimit: true }).errors.length).toBeGreaterThan(101);
    });

    it("turns nesting too deep for the js stack into an error", () => {
        const r = parseLuau(`x = ${"(".repeat(200000)}1${")".repeat(200000)}`);
        expect(r.errors[r.errors.length - 1].message).toMatch(/nested too deeply/);
    });

    it("collects comments and hot comments", () => {
        const r = parseLuau(`--!strict\n-- note\nlocal x --[[ inline ]] = 1 --!nolint`, { comments: true });
        expect(r.comments.map(c => c.kind)).toEqual(["comment", "comment", "blockComment", "comment"]);
        expect(r.hotComments.map(h => [h.content, h.header])).toEqual([["strict", true], ["nolint", false]]);
        expect(r.lineCount).toBe(3);
    });

    it("parses Luau's own conformance scripts as it always has", () => {
        const dir = new URL("./luau/conformance/", import.meta.url);
        const expected = JSON.parse(readFileSync(new URL("./luau/forms.json", import.meta.url), "utf8"));
        for (const file of readdirSync(dir).sort()) {
            const r = parseLuau(readFileSync(new URL(file, dir), "utf8"));
            expect(r.errors, file).toEqual([]);
            expect(createHash("sha1").update(fingerprint(r.root)).digest("hex"), file).toBe(expected[file]);
        }
    });
});
