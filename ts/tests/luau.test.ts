import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { readFileSync, readdirSync } from 'fs';
import { Lexer, unescapeLong, unescapeQuoted } from '../lua/syntax/lexer';
import { parseLuau } from '../lua/syntax/parser';
import { TOK_TEXT, Tok } from '../lua/syntax/tokens';
import { dump } from '../lua/syntax/print';
import { childNodes, type Comment, type ExprFunction, type Node, type Stat, type StatBlock, type StatLocal } from '../lua/syntax/ast';

const kinds = (src: string) => {
    const lexer = new Lexer(src);
    const out: string[] = [];
    for (lexer.next(); lexer.kind !== Tok.Eof; lexer.next()) {
        const k = lexer.kind;
        out.push(k === Tok.Name || k === Tok.Number || k === Tok.Char ? `${TOK_TEXT[k]}:${lexer.tokenText}` : TOK_TEXT[k]);
    }
    return out.join(" ");
};
const ok = (src: string): StatBlock => {
    const r = parseLuau(src);
    expect(r.errors).toEqual([]);
    return r.root;
};
const tree = (src: string) => ok(src).body.map(s => dump(s)).join(" ");
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
        expect(tree("x = 1 + 2 * 3")).toBe('(StatAssign (ExprGlobal name="x") (ExprBinary op="+" (ExprConstantNumber value=1) (ExprBinary op="*" (ExprConstantNumber value=2) (ExprConstantNumber value=3))))');
        // ^ and .. are right associative; unary operators bind looser than ^
        expect(tree("x = 2 ^ 3 ^ 2")).toBe('(StatAssign (ExprGlobal name="x") (ExprBinary op="^" (ExprConstantNumber value=2) (ExprBinary op="^" (ExprConstantNumber value=3) (ExprConstantNumber value=2))))');
        expect(tree("x = -y ^ 2")).toBe('(StatAssign (ExprGlobal name="x") (ExprUnary op="-" (ExprBinary op="^" (ExprGlobal name="y") (ExprConstantNumber value=2))))');
        expect(tree("x = a .. b .. c")).toBe('(StatAssign (ExprGlobal name="x") (ExprBinary op=".." (ExprGlobal name="a") (ExprBinary op=".." (ExprGlobal name="b") (ExprGlobal name="c"))))');
        expect(tree("x = a or b and c == d")).toBe('(StatAssign (ExprGlobal name="x") (ExprBinary op="or" (ExprGlobal name="a") (ExprBinary op="and" (ExprGlobal name="b") (ExprBinary op="==" (ExprGlobal name="c") (ExprGlobal name="d")))))');
        expect(tree("x = not a == b")).toBe('(StatAssign (ExprGlobal name="x") (ExprBinary op="==" (ExprUnary op="not" (ExprGlobal name="a")) (ExprGlobal name="b")))');
        expect(tree("x = a // b % c")).toBe('(StatAssign (ExprGlobal name="x") (ExprBinary op="%" (ExprBinary op="//" (ExprGlobal name="a") (ExprGlobal name="b")) (ExprGlobal name="c")))');
    });

    it("parses calls, indexing and methods", () => {
        expect(tree(`a.b[c]:d("s")`)).toBe('(StatExpr (ExprCall self=true (ExprIndexName index="d" (ExprIndexExpr (ExprIndexName index="b" (ExprGlobal name="a")) (ExprGlobal name="c"))) (ExprConstantString value="s")))');
        expect(tree(`f "s" { 1 } [[r]]`)).toBe('(StatExpr (ExprCall (ExprCall (ExprCall (ExprGlobal name="f") (ExprConstantString value="s")) (ExprTable (ExprConstantNumber value=1))) (ExprConstantString value="r")))');
        expect(tree(`(f)(1)`)).toBe('(StatExpr (ExprCall (ExprGroup (ExprGlobal name="f")) (ExprConstantNumber value=1)))');
        expect(tree(`f<<number, string>>(1)`)).toBe('(StatExpr (ExprCall (ExprGlobal name="f") (ExprConstantNumber value=1)))');
    });

    it("parses tables, functions and the other expressions", () => {
        expect(tree(`t = { 1, k = 2, [3] = 4; f = function() end }`)).toBe('(StatAssign (ExprGlobal name="t") (ExprTable (ExprConstantNumber value=1) (ExprConstantString value="k") (ExprConstantNumber value=2) (ExprGlobal name="k") (ExprConstantNumber value=3) (ExprConstantNumber value=4) (ExprConstantString value="f") (ExprFunction (StatBlock))))'.replace('(ExprGlobal name="k") ', ''));
        const fn = ok(`t = { f = function() end }`).body[0] as any;
        expect((fn.values[0].items[0].value as ExprFunction).debugName).toBe("f");
        expect(tree(`x = if a then 1 elseif b then 2 else 3`)).toBe('(StatAssign (ExprGlobal name="x") (ExprIfElse (ExprGlobal name="a") (ExprConstantNumber value=1) (ExprIfElse (ExprGlobal name="b") (ExprConstantNumber value=2) (ExprConstantNumber value=3))))');
        expect(tree("x = `a{b}c{d}`")).toBe('(StatAssign (ExprGlobal name="x") (ExprInterpString (ExprGlobal name="b") (ExprGlobal name="d")))');
        const interp = (ok("x = `a{b}c{d}e`").body[0] as any).values[0];
        expect(interp.strings).toEqual(["a", "c", "e"]);
        expect(tree(`x = y :: number`)).toBe('(StatAssign (ExprGlobal name="x") (ExprGroup (ExprGlobal name="y")))');
        expect(tree(`x = #t, -1, ..., nil, true`)).toBe('(StatAssign (ExprGlobal name="x") (ExprUnary op="#" (ExprGlobal name="t")) (ExprUnary op="-" (ExprConstantNumber value=1)) (ExprVarargs) (ExprConstantNil) (ExprConstantBool value=true))');
        expect(tree(`x = 0x1F, 0b101, 1_000, .5, 1e3`)).toBe('(StatAssign (ExprGlobal name="x") (ExprConstantNumber value=31) (ExprConstantNumber value=5) (ExprConstantNumber value=1000) (ExprConstantNumber value=0.5) (ExprConstantNumber value=1000))');
    });

    it("parses every statement", () => {
        expect(tree(`local a: number, b = 1, 2`)).toBe('(StatLocal vars=[a b] (ExprConstantNumber value=1) (ExprConstantNumber value=2))');
        expect(tree(`const k = 1`)).toBe('(StatLocal vars=[k] isConst=true (ExprConstantNumber value=1))');
        expect(tree(`a, b.c = 1, 2 x += 1 y ..= "s"`)).toBe('(StatAssign (ExprGlobal name="a") (ExprIndexName index="c" (ExprGlobal name="b")) (ExprConstantNumber value=1) (ExprConstantNumber value=2)) (StatCompoundAssign op="+" (ExprGlobal name="x") (ExprConstantNumber value=1)) (StatCompoundAssign op=".." (ExprGlobal name="y") (ExprConstantString value="s"))');
        expect(tree(`if a then elseif b then else end`)).toBe('(StatIf (ExprGlobal name="a") (StatBlock) (StatIf (ExprGlobal name="b") (StatBlock) (StatBlock)))');
        expect(tree(`while a do break end repeat continue until b`)).toBe('(StatWhile (ExprGlobal name="a") (StatBlock (StatBreak))) (StatRepeat (ExprGlobal name="b") (StatBlock (StatContinue)))');
        expect(tree(`for i = 1, 10, 2 do end for k, v in pairs(t) do end`)).toBe('(StatFor var=i (ExprConstantNumber value=1) (ExprConstantNumber value=10) (ExprConstantNumber value=2) (StatBlock)) (StatForIn vars=[k v] (ExprCall (ExprGlobal name="pairs") (ExprGlobal name="t")) (StatBlock))');
        expect(tree(`do local x end return`)).toBe('(StatBlock (StatLocal vars=[x])) (StatReturn)');
        expect(tree(`function a.b:c(x, ...) end`)).toBe('(StatFunction (ExprIndexName index="c" (ExprIndexName index="b" (ExprGlobal name="a"))) (ExprFunction self=self args=[x] vararg=true (StatBlock)))');
        expect(tree(`local function f<T>(x: T): T return x end`)).toBe('(StatLocalFunction name=f (ExprFunction args=[x] (StatBlock (StatReturn (ExprLocal local=x)))))');
        expect(tree(`@native @checked function f() end`)).toBe('(StatFunction (ExprGlobal name="f") (ExprFunction (StatBlock)))');
        expect(tree(`@[deprecated { use = "g" }] local function f() end`)).toBe('(StatLocalFunction name=f (ExprFunction (StatBlock)))');
        expect(tree(`f(); g()`)).toBe('(StatExpr (ExprCall (ExprGlobal name="f"))) (StatExpr (ExprCall (ExprGlobal name="g")))');
    });

    it("keeps its contextual keywords usable as names", () => {
        expect(tree(`local type = 1 type = 2 continue(type) export = typeof`)).toBe('(StatLocal vars=[type] (ExprConstantNumber value=1)) (StatAssign (ExprLocal local=type) (ExprConstantNumber value=2)) (StatExpr (ExprCall (ExprGlobal name="continue") (ExprLocal local=type))) (StatAssign (ExprGlobal name="export") (ExprGlobal name="typeof"))');
    });

    it("resolves names to the locals they refer to", () => {
        const root = ok(`local x = 1
            local function f() return x end
            local x = x
            repeat local y = 1 until y
            for i = 1, 2 do end
            return x, i`);
        const [first, fn, second, repeat, , ret] = root.body as any[];
        const outer = (first as StatLocal).vars[0];
        const inFn = fn.func.body.body[0].list[0];
        expect(inFn.local).toBe(outer);
        // the new x is in scope after its own declaration, and shadows the first
        expect(second.values[0].local).toBe(outer);
        expect(ret.list[0].local).toBe(second.vars[0]);
        // a repeat's condition sees its body's locals; a for's variable ends with it
        expect(repeat.condition.local).toBe(repeat.body.body[0].vars[0]);
        expect(ret.list[1].kind).toBe("ExprGlobal");
        // a local function sees itself; self is a local of methods
        const rec = ok(`local function f() return f end function t:m() return self end`).body as any[];
        expect(rec[0].func.body.body[0].list[0].local).toBe(rec[0].name);
        expect(rec[1].func.body.body[0].list[0].local).toBe(rec[1].func.self);
    });

    it("checks types but keeps none", () => {
        const types = [
            "string | number?", "A & B", "{ x: number, read y: string, [string]: boolean }", "{ number }",
            "(a: number, string) -> (boolean, ...any)", "<T, U...>(T, U...) -> ()", "typeof(x)", `"lit" | true`,
            "mod.Type<number, (string)>", "(number)",
        ];
        for (const t of types) expect(tree(`type T = ${t} local x: ${t} = 1`), t).toBe('(StatLocal vars=[x] (ExprConstantNumber value=1))');
        expect(tree(`export type P<T = string, U... = ...number> = T; type function f(t) return t end`)).toBe("");
        expect(tree(`local function f<T>(a: T, ...: number): (T, ...number) return a end`)).toBe('(StatLocalFunction name=f (ExprFunction args=[a] vararg=true (StatBlock (StatReturn (ExprLocal local=a)))))');
        expect(tree(`local y = f<<\nnumber>>(1)`)).toBe('(StatLocal vars=[y] (ExprCall (ExprGlobal name="f") (ExprConstantNumber value=1)))');
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
        expect((r.root.body[r.root.body.length - 1] as Stat).kind).toBe("StatLocal");
        const assign = parseLuau(`(a) = 1`).root.body[0] as any;
        expect(assign.vars[0].kind).toBe("ExprError");
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

    it("parses Luau's own conformance scripts as Luau does", () => {
        const dir = new URL("./luau/conformance/", import.meta.url);
        const expected = JSON.parse(readFileSync(new URL("./luau/luau-ast.json", import.meta.url), "utf8"));
        for (const file of readdirSync(dir).sort()) {
            const src = readFileSync(new URL(file, dir), "utf8");
            const r = parseLuau(src);
            expect(r.errors, file).toEqual([]);
            const want = expected[file];
            if (want === undefined) continue;
            const at = (from: number, to: number) => {
                const a = r.lines.pos(from), b = r.lines.pos(to);
                return `${a.line},${a.column} - ${b.line},${b.column}`;
            };
            const got: string[] = [];
            const walk = (n: Node) => {
                got.push(`Ast${n.kind}@${at(n.from, n.to)}`);
                for (const c of childNodes(n)) walk(c);
            };
            walk(r.root);
            got.sort();
            expect(got.length, file).toBe(want.nodes);
            expect(createHash("sha1").update(got.join("\n")).digest("hex"), file).toBe(want.sha1);
        }
    });
});
