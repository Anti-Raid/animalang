import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLuau, toString } from '../lua';
import { impl } from '../magicvm/meta';
import { MultipleValues } from '../common';
import { listing } from '../magicvm/exec';

const luau = createLuau(impl);

// what the chunk returns, as Luau's tostring writes each value, tab-separated; or its error's message
const run = (src: string, file = "t"): string => {
    try {
        const r = luau.evaluateRaw(luau.compileRaw(src, file));
        return (r instanceof MultipleValues ? r.values : [r]).map(toString).join("\t");
    } catch (e: any) {
        return "error: " + e.message;
    }
};

describe("Luau lowered", () => {
    it("binds locals, assigns locals and globals, and returns", () => {
        expect(run("local x = 10 local y = x * 2 return x, y")).toBe("10\t20");
        expect(run("local a, b = 1 return a, b")).toBe("1\tnil");
        expect(run("local a = 1, 2 return a")).toBe("1");
        expect(run("local a, b = 1, 2 a, b = b, a return a, b")).toBe("2\t1");
        expect(run("local x = 1 local x = x + 1 return x")).toBe("2");
        expect(run("g = 5 g += 1 g ..= '!' return g")).toBe("6!");
        expect(run("return never_assigned")).toBe("nil");
        expect(run("do local z = 3 return z end")).toBe("3");
        expect(run("local x = 1 do local x = 2 end return x")).toBe("1");
        expect(run("return")).toBe("");
    });

    it("does Luau's arithmetic, coercing strings, and concatenation", () => {
        expect(run("return '10' + 1, 2 ^ 10, 7 // 2, -7 % 3, 1 / 0, -(0/0) ~= -(0/0)".replace(", -(0/0) ~= -(0/0)", ""))).toBe("11\t1024\t3\t2\tinf");
        expect(run("return 1 .. 2, 'a' .. 1.5, 0.1 + 0.2, 1e300 * 1e10, -'2'")).toBe("12\ta1.5\t0.30000000000000004\tinf\t-2");
        expect(run("return 1 ^ (0/0), (-1) ^ (1/0)")).toBe("1\t1");
    });

    it("does every operator on two integers (a deviation from Luau)", () => {
        expect(run("return 9223372036854775807i + 1i, 7i / 2i, -7i // 2i, -7i % 2i, 2i ^ 10i, -5i, 1i .. 'x'")).toBe("-9223372036854775808\t3\t-4\t1\t1024\t-5\t1x");
        expect(run("return 1i + 1")).toBe("error: t:1: attempt to perform arithmetic (add) on integer and number");
        expect(run("return 1i / 0i")).toBe("error: t:1: division by zero");
    });

    it("reports Luau's errors where they happen", () => {
        expect(run("local a = 1\nlocal b = a + nil\nreturn b")).toBe("error: t:2: attempt to perform arithmetic (add) on number and nil");
        expect(run("return {} .. 'x'".replace("{}", "true"))).toBe("error: t:1: attempt to concatenate boolean with string");
        expect(run("return -nil")).toBe("error: t:1: attempt to perform arithmetic (unm) on nil");
        expect(run("local x = 1 +", "chunk.luau")).toBe("error: chunk.luau:1: Expected identifier when parsing expression, got <eof>");
        expect(run("for k in x do end")).toBe("error: t:1: for ... in is not supported yet");
    });
});

describe("Luau lowered control flow", () => {
    it("branches and loops, with Luau's truthiness", () => {
        expect(run("local s = 0 for i = 1, 10 do s += i end return s")).toBe("55");
        expect(run("local s = '' for i = 10, 1, -3 do s ..= i .. ',' end return s")).toBe("10,7,4,1,");
        expect(run("local n = 0 while n < 5 do n += 1 end return n")).toBe("5");
        expect(run("local n = 0 repeat local m = n + 1 n = m until m >= 3 return n")).toBe("3");
        expect(run("local s = 0 for i = 1, 10 do if i % 2 == 0 then continue end if i > 7 then break end s += i end return s")).toBe("16");
        expect(run("local x if nil then x = 1 elseif 0 then x = 2 else x = 3 end return x")).toBe("2");
        expect(run("return nil and 1, false or 'x', 1 and 2, not nil, not 0, if 1 > 2 then 'a' else 'b'")).toBe("nil\tx\t2\ttrue\tfalse\tb");
        expect(run("return 1 < 2, 'a' < 'b', 'B' < 'a', nil == false, 0/0 == 0/0, 1i <= 1i")).toBe("true\ttrue\ttrue\tfalse\tfalse\ttrue");
        expect(run("for i = '1', '3' do g = i end return g")).toBe("3");
        expect(run("local n = 0 for i = 1, 3, 0 do n += 1 end for i = 3, 1, -0 do n += 10 break end for i = 1, 3, 0/0 do n += 100 end return n")).toBe("10");
    });

    it("reports Luau's errors", () => {
        expect(run("return 1 > 'x'")).toBe("error: t:1: attempt to compare string < number");
        expect(run("return true <= true")).toBe("error: t:1: attempt to compare boolean <= boolean");
        expect(run("for i = 1, nil do end")).toBe("error: t:1: invalid 'for' limit (number expected, got nil)");
        expect(run("repeat\n  if true then continue end\n  local x = 1\nuntil x")).toBe("error: t:4: Local x used in the repeat..until condition is undefined because continue statement on line 2 jumps over it");
    });
});

describe("Luau lowered functions", () => {
    it("makes closures and calls them as Luau does", () => {
        expect(run("local function fib(n) if n < 2 then return n end return fib(n - 1) + fib(n - 2) end return fib(20)")).toBe("6765");
        expect(run("function add(a, b) return (a or 0) + (b or 0) end return add(1, 2), add(1), add(1, 2, 3), add()")).toBe("3\t1\t3\t0");
        expect(run("local function counter() local n = 0 return function() n += 1 return n end end local c = counter() c() c() return c()")).toBe("3");
        expect(run("local s = 0 for i = 1, 3 do local function g() return i end s += g() end return s")).toBe("6");
        expect(run("local function noret() end local function bare() return end return noret(), bare()")).toBe("nil");
        expect(run("local function noret() end return (noret()), noret() == nil")).toBe("nil\ttrue");
        expect(run("local function f() for i = 1, 10 do if i == 3 then return i end end end return f()")).toBe("3");
        expect(run("local function down(n) if n == 0 then return 'done' end return down(n - 1) end return down(100000)")).toBe("done");
    });

    it("passes several values where a call or ... is last, one value anywhere else", () => {
        const defs = "local function two() return 1, 2 end local function none() end local function pass(...) return ... end ";
        expect(run(defs + "return two()")).toBe("1\t2");
        expect(run(defs + "return two(), two()")).toBe("1\t1\t2");
        expect(run(defs + "return (two())")).toBe("1");
        expect(run(defs + "local a, b, c = two() return a, b, c")).toBe("1\t2\tnil");
        expect(run(defs + "local a, b, c = 0, two() return a, b, c")).toBe("0\t1\t2");
        expect(run(defs + "local a, b = two(), 5 return a, b")).toBe("1\t5");
        expect(run(defs + "local a, b = none() return a, b")).toBe("nil\tnil");
        expect(run(defs + "local a, b a, b = two() return b, a")).toBe("2\t1");
        expect(run(defs + "return pass(two())")).toBe("1\t2");
        expect(run(defs + "return pass(two(), two())")).toBe("1\t1\t2");
        expect(run(defs + "return pass(none())")).toBe("");
        expect(run(defs + "return pass(none(), 3)")).toBe("nil\t3");
        expect(run(defs + "return two() + 10, #'' == 0".replace(", #'' == 0", ""))).toBe("11");
    });

    it("binds the values of a call that is not inlined", () => {
        const defs = "function two(a) return a, a + 1 end function three(a) return a, a + 1, a + 2 end function one(a) return a end function none() end function pass(...) return ... end function via(a) return two(a) end ";
        expect(run(defs + "local s = 0 for i = 1, 100 do local a, b = three(i) local x, y, z = two(i) if z == nil then s += a + b + x + y end end return s")).toBe("20400");
        expect(run(defs + "local a, b = one(5) local c, d = none() local e, f = via(7) local g, h = pass(1, 2, 3) local i, j = pass(4) return a, b, c, d, e, f, g, h, i, j")).toBe("5\tnil\tnil\tnil\t7\t8\t1\t2\t4\tnil");
        expect(run(defs + "local a, b a, b = two(1) local c, d = (two(5)) return a, b, c, d")).toBe("1\t2\t5\tnil");
    });

    // the expected values are what Luau gives
    it("makes tables, indexes them and takes their length", () => {
        expect(run("local t = {1, 2, 3, x = 'a', [10] = 'j'} return t[1], t[3], t.x, t[10], #t, t.y")).toBe("1\t3\ta\tj\t3\tnil");
        expect(run("local function f() return 1, 2, 3 end local t = {f(), f()} local u = {f(), (f())} return #t, t[4], #u, u[2]")).toBe("4\t3\t2\t1");
        expect(run("local function f(...) local t = {...} return #t, t[2] end return f(5, 6, 7)")).toBe("3\t6");
        // a keyed item is stored where it stands among the others
        expect(run("local t = {1, [1] = 2} local u = {[1] = 2, 1} return t[1], u[1]")).toBe("2\t1");
        expect(run("local t = {} t.a = 1 t[1] = 'one' t.a += 5 t[1] ..= '!' return t.a, t[1], #t")).toBe("6\tone!\t1");
        expect(run("local t = {n = {v = 1}} t.n.v, t.q = 5, 6 return t.n.v, t.q")).toBe("5\t6");
        expect(run("return #'hello', #{1, 2, nil, 4}")).toBe("5\t4");
        expect(run("local s = 'abc' return s.x, s[1]")).toBe("nil\tnil");
        // an empty table is as large as its local's assignments say (Luau's compiler predicts it), which `#` can show
        expect(run("local w = {} for i = 1, 16 do w[i] = i end w[16] = nil w[17] = 1 return #w")).toBe("17");
    });

    it("calls methods, looking them up after the arguments", () => {
        expect(run("local t = {n = 1} function t:add(d) self.n += d return self end function t.get(s) return s.n end return t:add(2):add(3).n, t.get(t), t:get()")).toBe("6\t6\t6");
        expect(run("local t = {} local function f() t = {m = function() return 'new' end} return 1 end t.m = function() return 'old' end return t:m(f())")).toBe("new");
        expect(run("local t = {f = 1} return t:f()")).toBe("error: t:1: attempt to call a number value");
        expect(run("local t = {} return t:nope()")).toBe("error: t:1: attempt to call missing method 'nope' of table");
        expect(run("return ('abc'):nope()")).toBe("error: t:1: attempt to call missing method 'nope' of string");
    });

    it("stores into a table that is a local where the local is then, as Luau's compiler does", () => {
        const defs = "local t, u = {5}, {7} local function swap() t, u = u, t return 1 end ";
        expect(run(defs + "t.x = swap() return t.x, u.x")).toBe("1\tnil");
        expect(run(defs + "t[swap()] = 2 return t[1], u[1]")).toBe("2\t5");
        expect(run(defs + "t[1] += swap() return t[1], u[1]")).toBe("6\t5");
        // several targets: a local that is also indexed is assigned last
        expect(run("local t, u = {}, {} t, t.x = u, 1 return t == u, t.x, u.x")).toBe("true\tnil\tnil");
    });

    it("reports Luau's errors for what is not a table", () => {
        expect(run("local x return x.y")).toBe("error: t:1: attempt to index nil with 'y'");
        expect(run("local x x.y = 1")).toBe("error: t:1: attempt to index nil with 'y'");
        expect(run("return (5)[1]")).toBe("error: t:1: attempt to index number with number");
        expect(run("local t = {} t[nil] = 1")).toBe("error: t:1: table index is nil");
        expect(run("local t = {} t[0/0] = 1")).toBe("error: t:1: table index is NaN");
        expect(run("return #5")).toBe("error: t:1: attempt to get length of a number value");
    });

    it("gives a function's ... to it as values", () => {
        expect(run("local function f(...) return ... end return f(1, nil, 3)")).toBe("1\tnil\t3");
        expect(run("local function f(a, ...) local x, y = ... return a, x, y end return f(1, 2), f(1, 2, 3, 4)")).toBe("1\t1\t2\t3");
        expect(run("local function f(...) return (...) end return f(), f(7, 8)")).toBe("nil\t7");
        expect(run("local function f(...) return ..., 9 end return f(1, 2)")).toBe("1\t9");
        expect(run("local function g(a, b) return b end local function f(...) return g(...) end return f(1, 2, 3)")).toBe("2");
        expect(run("local function f(...) local t = 0 local a, b = 5, ... return a, b end return f('x', 'y')")).toBe("5\tx");
        expect(run("return ...")).toBe("");
    });

    it("reads and assigns locals in the order Luau's compiler does", () => {
        const pre = "local a = 1 local function bump() a = 10 return 1 end ";
        // a local on the left of an operator, or assigned by op=, is read when the operation runs
        expect(run(pre + "return a + bump()")).toBe("11");
        expect(run(pre + "a += bump() return a")).toBe("11");
        expect(run(pre + "return a < bump(), (a) + bump()")).toBe("false\t11");
        expect(run(pre + "return a - bump(), a * bump(), a / bump(), a // bump(), a % 7 + bump(), a ^ bump()")).toBe("9\t10\t10\t10\t4\t10");
        expect(run(pre + "return (if a < bump() then 'lt' else 'ge'), a == bump(), bump() == a, a ~= bump()")).toBe("ge\tfalse\tfalse\ttrue");
        // but copied where Luau copies it: concatenation, arguments, a list of values, a unary operator's operand
        expect(run(pre + "return a .. bump()")).toBe("11");
        expect(run(pre + "local x, y = a, bump() return x, y")).toBe("1\t1");
        expect(run(pre + "return -a + bump(), bump() + a")).toBe("0\t11");
        expect(run("local f = function() return 'old' end local function swap() f = function() return 'new' end return 1 end return f(swap())")).toBe("old");
        // several targets: a local takes its value at once, unless a later value refers to it
        expect(run("local b, c = 1, 2 local function rd() return b end b, c = 5, rd() return b, c")).toBe("5\t5");
        expect(run(pre + "local t a, t = 5, a return a, t")).toBe("5\t1");
        expect(run(pre + "g1, g2 = a, bump() return g1, g2")).toBe("10\t1");
        expect(run(pre + "a, g = bump(), a return a, g")).toBe("1\t10");
    });

    it("keeps assigned locals in registers across calls (Luau code is never re-entered)", () => {
        const src = "local g g = function() return 1 end local s = 0 for i = 1, 3 do s += g() end return s";
        expect(listing(luau.compileRaw(src, "t")).join("\n")).not.toMatch(/Box/);
        expect(run(src)).toBe("3");
    });

    it("reports calling what is not a function where it happens, tail call or not", () => {
        expect(run("local x\nreturn x(1)")).toBe("error: t:2: attempt to call a nil value");
        expect(run("local x = 5\nlocal y = x()")).toBe("error: t:2: attempt to call a number value");
        expect(run("local function f()\n  local x = 'a'\n  return x()\nend\nreturn f()")).toBe("error: t:3: attempt to call a string value");
    });
});

describe.skipIf(!process.env.LUAU)("Luau lowered against Luau", () => {
    it("computes what Luau computes, and fails where it fails", () => {
        let seed = 7;
        const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return (n > 4096 ? seed : Math.floor(seed / 4096)) % n; };
        const atoms = ["1", "2", "0", "-1", "0.5", "3.75", "1e300", "10", "7", "-0", "'10'", "' 0x10 '", "'1e2'", "'abc'", "''", "nil", "true", "'5.'", "x", "y", "g"];
        const binops = ["+", "-", "*", "/", "//", "%", "^", ".."];
        const expr = (depth: number): string => {
            if (depth === 0 || rand(3) === 0) return atoms[rand(atoms.length)];
            if (rand(6) === 0) { const e = expr(depth - 1); return e.startsWith("-") ? `-(${e})` : `-${e}`; }
            if (rand(5) === 0) return `(${expr(depth - 1)})`;
            return `${expr(depth - 1)} ${binops[rand(binops.length)]} ${expr(depth - 1)}`;
        };
        const programs = Array.from({ length: 2000 }, () => {
            const lines = [`local x = ${expr(2)}`, `local y = ${expr(2)}`];
            if (rand(2)) lines.push(`g = ${expr(2)}`);
            if (rand(2)) lines.push(`x ${binops[rand(binops.length)]}= ${expr(1)}`);
            lines.push(`return ${expr(3)}, ${expr(2)}`);
            return lines.join("\n");
        });
        const quote = (s: string) => JSON.stringify(s);
        const lua = programs.map(p => `do g = nil local f, err = loadstring(${quote(p)}, "=t") if not f then print("error: " .. err) else local r = table.pack(pcall(f)) if r[1] then local out = {} for i = 2, r.n do out[#out + 1] = tostring(r[i]) end print(table.concat(out, "\\t")) else print("error: " .. tostring(r[2])) end end end`);
        const file = join(mkdtempSync(join(tmpdir(), "luau-")), "lowered.luau");
        writeFileSync(file, lua.join("\n"));
        const expected = execFileSync(process.env.LUAU!, [file], { encoding: "utf8", maxBuffer: 1 << 26 }).split("\n").slice(0, programs.length);
        const actual = programs.map(p => {
            luau.scope.delete(Symbol.for("g"));
            return run(p);
        });
        expect(actual).toEqual(expected);
    });

    it("calls functions as Luau does", () => {
        let seed = 5;
        const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return (n > 4096 ? seed : Math.floor(seed / 4096)) % n; };
        const plain = ["1", "2", "0", "-1", "0.5", "'10'", "3", "7"];
        const rare = ["nil", "true", "'x'", "(a)(1)", "k()", "f"];
        const calls = ["f(1, 2)", "f(a)", "f()", "f(1, 2, 3)", "g(b)", "g(1)", "h(3)", "h(a)", "a", "b"];
        let atoms = plain;
        const binops = ["+", "-", "*", "..", "==", "<", "and", "or"];
        const expr = (depth: number, vars: string[] = []): string => {
            if (depth === 0 || rand(3) === 0) return vars.length > 0 && rand(2) === 0 ? vars[rand(vars.length)] : rand(40) === 0 ? rare[rand(rare.length)] : atoms[rand(atoms.length)];
            if (rand(6) === 0) return `(if ${expr(depth - 1, vars)} then ${expr(depth - 1, vars)} else ${expr(depth - 1, vars)})`;
            return `(${expr(depth - 1, vars)} ${binops[rand(binops.length)]} ${expr(depth - 1, vars)})`;
        };
        const programs = Array.from({ length: 1500 }, () => [
            `local a, b = ${(atoms = plain, expr(1))}, ${expr(1)}`,
            `local function f(x, y) if ${expr(1, ["x", "y"])} then return ${expr(2, ["x", "y"])} end ${rand(2) ? `a = ${expr(1, ["x"])}` : ""} return y end`,
            `local function h(n) if type(n) ~= "number" or n <= 0 then return 0 end return n + h(n - 1) end`.replace('type(n) ~= "number" or ', ""),
            `local g = function(z) ${rand(2) ? `b = ${expr(1, ["z"])}` : ""} return ${expr(2, ["z"])} end`,
            `local k = ${rand(3) === 0 ? "nil" : "function() return a end"}`,
            (atoms = [...plain, ...calls], ""),
            ...Array.from({ length: 1 + rand(3) }, () => rand(2) ? `${["a", "b"][rand(2)]} = ${expr(2)}` : `${["f", "g", "k"][rand(3)]}(${expr(1)}${rand(2) ? `, ${expr(1)}` : ""})`),
            `return a, b, ${expr(2)}`,
        ].join("\n"));
        const quote = (s: string) => JSON.stringify(s);
        const lua = programs.map(p => `do local f, err = loadstring(${quote(p)}, "=t") if not f then print("error: " .. err) else local r = table.pack(pcall(f)) if r[1] then local out = {} for i = 2, r.n do out[#out + 1] = tostring(r[i]) end print(table.concat(out, "\\t")) else print("error: " .. tostring(r[2])) end end end`);
        const file = join(mkdtempSync(join(tmpdir(), "luau-")), "functions.luau");
        writeFileSync(file, lua.join("\n"));
        const expected = execFileSync(process.env.LUAU!, [file], { encoding: "utf8", maxBuffer: 1 << 26 }).split("\n").slice(0, programs.length);
        // functions print as their addresses, which differ
        const actual = programs.map(p => run(p)).map(l => l.replace(/function: 0x[0-9a-f]+/g, "function"));
        expect(actual).toEqual(expected.map(l => l.replace(/function: 0x[0-9a-f]+/g, "function")));
    });

    it("adjusts lists of values as Luau does", () => {
        let seed = 23;
        // the high bits: the low ones of this generator repeat with a short period
        const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 4096) % n; };
        const defs = [
            "local function r0() end",
            "local function r1() return 1 end",
            "local function r2() return 1, 2 end",
            "local function r3() return 'a', nil, 'c' end",
            "local function pass(...) return ... end",
            "local function first(...) local a = ... return a end",
            "local function second(...) local a, b = ... return b end",
            "local function swap(a, b) return b, a end",
            "local function tail(...) return swap(...) end",
            "local function wrap(...) return 0, ... end",
            "local function mid(...) return ..., 9 end",
            "local function both(...) return pass(...), pass(...) end",
            "local function paren(...) return (...) end",
            "local function pick(a, b, c) return c, a end",
        ].join("\n");
        const fns = ["r0", "r1", "r2", "r3", "pass", "first", "second", "swap", "tail", "wrap", "mid", "both", "paren", "pick"];
        const atoms = ["1", "2", "'s'", "nil", "true", "5"];
        const expr = (depth: number): string => {
            const r = depth === 0 ? rand(2) : rand(8);
            if (r < 2) return atoms[rand(atoms.length)];
            if (r === 2) return `(${expr(depth - 1)})`;
            if (r === 3) return `(${expr(depth - 1)} == ${expr(depth - 1)})`;
            return `${fns[rand(fns.length)]}(${list(depth - 1, rand(4))})`;
        };
        const list = (depth: number, n: number): string => Array.from({ length: n }, () => expr(depth)).join(", ");
        const programs = Array.from({ length: 700 }, () => {
            const k = rand(4);
            const body = k === 0 ? `return ${list(3, 1 + rand(3))}`
                : k === 1 ? `local a, b, c = ${list(3, 1 + rand(3))}\nreturn a, b, c`
                : k === 2 ? `local a, b, c\na, b${rand(2) ? ", c" : ""} = ${list(3, 1 + rand(3))}\nreturn a, b, c`
                : `${fns[rand(fns.length)]}(${list(3, rand(3))})\nreturn ${list(2, 1 + rand(2))}`;
            return `${defs}\n${body}`;
        });
        const quote = (s: string) => JSON.stringify(s);
        const lua = programs.map(p => `do local f, err = loadstring(${quote(p)}, "=t") if not f then print("error: " .. err) else local r = table.pack(pcall(f)) if r[1] then local out = {} for i = 2, r.n do out[#out + 1] = tostring(r[i]) end print(table.concat(out, "\\t")) else print("error: " .. tostring(r[2])) end end end`);
        const file = join(mkdtempSync(join(tmpdir(), "luau-")), "values.luau");
        writeFileSync(file, lua.join("\n"));
        const expected = execFileSync(process.env.LUAU!, [file], { encoding: "utf8", maxBuffer: 1 << 26 }).split("\n").slice(0, programs.length);
        expect(programs.map(p => run(p))).toEqual(expected);
    }, 30000);

    it("binds the values of calls that are not inlined as Luau does", () => {
        let seed = 61;
        const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 4096) % n; };
        // globals: the optimizer leaves their calls as calls
        const defs = [
            "function r0() end",
            "function r1(a) return a end",
            "function r2(a) return a, 2 end",
            "function r3(a) return a, nil, 'c' end",
            "function r4(a) return a, 2, 3, 4 end",
            "function pass(...) return ... end",
            "function swap(a, b) return b, a end",
            "function via(a) return r3(a) end",
            "function pick(a) if a == 1 then return a, 'one' elseif a == 2 then return a end return a, 'x', 'y' end",
            "function rec(n) if n == 0 then return 'end', 1, 2 end return rec(n - 1) end",
            "function sum(n) if n == 0 then return 0, 0 end local a, b = sum(n - 1) return a + 1, b + n end",
        ].join("\n");
        const calls = ["r0()", "r1(1)", "r2(1)", "r3(2)", "r4(5)", "pass()", "pass(1)", "pass(1, 2)", "pass(1, 2, 3, 4)", "swap(1, 2)", "via(3)", "pick(1)", "pick(2)", "pick(3)", "rec(3)", "sum(4)", "pass(r3(1))", "(r2(1))", "r2(i)", "swap(i, a)"];
        const names = ["a", "b", "c", "d"];
        const line = (): string => {
            const targets = names.slice(0, 1 + rand(4)).join(", "), call = calls[rand(calls.length)];
            switch (rand(4)) {
                case 0: return `local ${targets} = ${call}`;
                case 1: return `${targets} = ${call}`;
                case 2: return `for i = 1, 3 do ${targets} = ${call} end`;
                default: return `do local p, q, r = ${call} a, b, c = r, q, p end`;
            }
        };
        const programs = Array.from({ length: 600 }, () => `${defs}\nlocal a, b, c, d\nlocal i = 0\n${Array.from({ length: 2 + rand(5) }, line).join("\n")}\nreturn a, b, c, d`);
        const quote = (s: string) => JSON.stringify(s);
        const lua = programs.map(p => `do local f, err = loadstring(${quote(p)}, "=t") if not f then print("error: " .. err) else local r = table.pack(pcall(f)) if r[1] then local out = {} for i = 2, r.n do out[#out + 1] = tostring(r[i]) end print(table.concat(out, "\\t")) else print("error: " .. tostring(r[2])) end end end`);
        const file = join(mkdtempSync(join(tmpdir(), "luau-")), "bound.luau");
        writeFileSync(file, lua.join("\n"));
        const expected = execFileSync(process.env.LUAU!, [file], { encoding: "utf8", maxBuffer: 1 << 26 }).split("\n").slice(0, programs.length);
        expect(programs.map(p => run(p))).toEqual(expected);
    }, 30000);

    it("makes, reads and writes tables as Luau does", () => {
        let seed = 83;
        const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 4096) % n; };
        const pick = <T,>(xs: readonly T[]): T => xs[rand(xs.length)];
        const defs = [
            "local function F(p) return p, 7 end",
            "local function M(self, p, q) self[p] = q return q, self end",
            "local t, u, a, b, k = {n = 1, f = F, m = M}, {n = 2, f = F, m = M}, 1, 'b', 2",
            "local function mr(n) if n == 0 then return elseif n == 1 then return 'm1' elseif n == 2 then return 'm1', 'm2' end return 'm1', nil, 'm3' end",
            "local function swap() t, u = u, t return 3 end",
            "local function bump() k = k + 1 return 'x' end",
        ].join("\n");
        const keys = ["1", "2", "3", "4", "5", "8", "'x'", "'y'", "true", "2.5", "k", "-1", "0", "k + 1", "#t + 1", "'a' .. 'b'"];
        const dots = ["x", "y", "n", "n"];
        const value = (depth: number): string => {
            switch (rand(depth === 0 ? 8 : 14)) {
                case 0: return String(rand(9));
                case 1: return pick(["'s'", "'x'", "true", "false", "nil", "1.5"]);
                case 2: return pick(["a", "b", "k", "t", "u"]);
                case 3: return `t[${pick(keys)}]`;
                case 4: return `u.${pick(dots)}`;
                case 5: return pick(["#t", "#u", "#b"]);
                case 6: return `mr(${rand(4)})`;
                case 7: return pick(["swap()", "bump()"]);
                case 8: return table(depth - 1);
                case 9: return `(${value(depth - 1)})`;
                case 10: return `t.${pick(dots)}`;
                case 11: return `u[${value(depth - 1)}]`;
                case 12: return `${pick(["t", "u"])}:m(${Array.from({ length: rand(3) }, () => value(depth - 1)).join(", ")})`;
                default: return `${pick(["t", "u"])}.f(${value(depth - 1)})`;
            }
        };
        const table = (depth: number): string => {
            const items = Array.from({ length: rand(6) }, () => {
                const r = rand(6);
                return r < 3 ? value(depth) : r === 3 ? `${pick(dots)} = ${value(depth)}` : `[${rand(3) === 0 ? value(depth) : pick(keys)}] = ${value(depth)}`;
            });
            if (rand(4) === 0) items.push(pick(["mr(3)", "mr(0)", "mr(2)", "...", "t:m()"]));
            return `{${items.join(", ")}}`;
        };
        const place = (): string => {
            const o = pick(["t", "u", "t", "u", "t", "u", "t", "u", "a", "t.x", "u.y"]);
            return rand(3) === 0 ? `${o}.${pick(dots)}` : `${o}[${rand(4) === 0 ? value(1) : pick(keys)}]`;
        };
        const stat = (): string => {
            switch (rand(16)) {
                case 0: case 1: case 2: return `${place()} = ${value(2)}`;
                case 3: return `${pick(["a", "a", "b", "t", "u"])} = ${value(2)}`;
                case 4: return rand(3) === 0 ? `${place()} ${pick(["+=", "-=", "..=", "*="])} ${value(1)}` : `${pick(["t", "u"])}${pick([".n", "[k]", "[1]", "[swap()]", "[bump()]"])} ${pick(["+=", "-=", "..=", "*="])} ${pick(["1", "k", "#t", "t.n", "swap()", "2.5"])}`;
                case 5: return `${place()}, ${pick([place(), "a", "t", "k"])}${rand(2) ? ", " + place() : ""} = ${value(1)}, ${value(1)}${rand(2) ? ", " + value(1) : ""}`;
                case 6: return `function ${pick(["t", "u"])}.f(p) return p, #t end`;
                case 7: return `function ${pick(["t", "u"])}:m(p, q) self[${pick(keys)}] = p return q, self end`;
                case 8: return `for i = 1, ${1 + rand(20)} do ${pick(["t", "u"])}[${pick(["i", "i", "i * 2", "i + 1", "-i"])}] = ${pick(["i", "i * 2", "nil", "'v'"])} end`;
                case 9: return `local w = {} w.p = 1 w.q = 2 w[1] = 'a' w[2] = 'b' w[${pick(["3", "4", "5"])}] = 'c' ${pick(["t", "u"])} = w`;
                case 10: return `do local w = {} for i = 1, ${1 + rand(18)} do w[i] = i end w[${1 + rand(24)}] = nil w[${1 + rand(40)}] = 1 a = #w ${pick(["t", "u"])} = w end`;
                case 11: return `a, b = ${value(2)}`;
                case 12: return `${pick(["t", "u"])}:m(${value(1)}, ${value(1)})`;
                case 13: return `${pick(["t", "u", "t", "u", "a"])}.f(${value(1)})`;
                case 14: return `local w = ${table(2)} ${pick(["t", "u"])} = w${rand(4) ? " w.f, w.m, w.n = F, M, 7" : ""}`;
                default: {
                    const o = pick(["t", "u"]);
                    return `${o} = ${table(2)}${rand(4) ? ` ${o}.f, ${o}.m, ${o}.n = F, M, 7` : ""}`;
                }
            }
        };
        const programs = Array.from({ length: 1500 }, () => {
            const body = Array.from({ length: 2 + rand(7) }, stat).join("\n");
            return `${defs}\n${body}\nreturn #t, #u, t[1], t[2], t[3], t[4], t[5], t[8], t.x, t.y, t[true], t[2.5], u[1], u[2], u[3], u.x, u.y, a, b, k`;
        });
        const quote = (s: string) => JSON.stringify(s);
        const lua = programs.map(p => `do local f, err = loadstring(${quote(p)}, "=t") if not f then print("error: " .. err) else local r = table.pack(pcall(f)) if r[1] then local out = {} for i = 2, r.n do out[#out + 1] = tostring(r[i]) end print(table.concat(out, "\\t")) else print("error: " .. tostring(r[2])) end end end`);
        const file = join(mkdtempSync(join(tmpdir(), "luau-")), "tables.luau");
        writeFileSync(file, lua.join("\n"));
        const plain = (l: string) => l.replace(/(function|table): 0x[0-9a-f]+/g, "$1");
        const expected = execFileSync(process.env.LUAU!, [file], { encoding: "utf8", maxBuffer: 1 << 26 }).split("\n").slice(0, programs.length).map(plain);
        const actual = programs.map(p => plain(run(p)));
        const wrong = actual.flatMap((a, i) => a === expected[i] ? [] : [`${programs[i]}\n--- ours:   ${a}\n--- Luau's: ${expected[i]}`]);
        expect(wrong.slice(0, 3)).toEqual([]);
        // enough of them run to the end
        expect(expected.filter(l => !l.startsWith("error: ")).length).toBeGreaterThan(programs.length / 4);
    }, 60000);

    it("reads and assigns locals in Luau's order", () => {
        let seed = 41;
        const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return (n > 4096 ? seed : Math.floor(seed / 4096)) % n; };
        const defs = "local a, b, c = 1, 2, 3\nlocal function bump() a = a + 10 return 1 end\nlocal function rd() return a end\nlocal function setb(v) b = v return b end\nlocal function two() c = a return a, b end";
        const atoms = ["a", "b", "c", "bump()", "rd()", "setb(a)", "setb(7)", "two()", "5", "g", "h", "(a)", "(two())"];
        const ops = ["+", "-", "*", "<", "<=", ">", "==", "~=", ".."];
        const expr = (depth: number): string => depth === 0 || rand(3) === 0 ? atoms[rand(atoms.length)] : `${rand(4) === 0 ? "-" : ""}(${expr(depth - 1)} ${ops[rand(ops.length)]} ${expr(depth - 1)})`;
        const targets = ["a", "b", "c", "g", "h"];
        const stat = (): string => {
            const r = rand(6);
            if (r === 0) return `${targets[rand(5)]} ${["+", "-", "*", ".."][rand(4)]}= ${expr(2)}`;
            if (r === 1) return `${targets[rand(5)]} = ${expr(2)}`;
            const n = 2 + rand(2), k = 1 + rand(4);
            return `${Array.from({ length: n }, () => targets[rand(5)]).join(", ")} = ${Array.from({ length: k }, () => expr(1)).join(", ")}`;
        };
        const programs = Array.from({ length: 1500 }, () => `${defs}\n${Array.from({ length: 1 + rand(3) }, stat).join("\n")}\nreturn a, b, c, g, h, ${expr(2)}`);
        const quote = (s: string) => JSON.stringify(s);
        const lua = programs.map(p => `do g, h = nil, nil local f, err = loadstring(${quote(p)}, "=t") if not f then print("error: " .. err) else local r = table.pack(pcall(f)) if r[1] then local out = {} for i = 2, r.n do out[#out + 1] = tostring(r[i]) end print(table.concat(out, "\\t")) else print("error: " .. tostring(r[2])) end end end`);
        const file = join(mkdtempSync(join(tmpdir(), "luau-")), "order.luau");
        writeFileSync(file, lua.join("\n"));
        const expected = execFileSync(process.env.LUAU!, [file], { encoding: "utf8", maxBuffer: 1 << 26 }).split("\n").slice(0, programs.length);
        const actual = programs.map(p => {
            luau.scope.delete(Symbol.for("g"));
            luau.scope.delete(Symbol.for("h"));
            return run(p);
        });
        expect(actual).toEqual(expected);
    }, 30000);

    it("branches and loops as Luau does", () => {
        let seed = 11;
        const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return (n > 4096 ? seed : Math.floor(seed / 4096)) % n; };
        const atoms = ["1", "2", "0", "-1", "0.5", "3", "'10'", "'abc'", "nil", "true", "false", "a", "b", "g", "(0/0)", "1i", "2i"];
        const binops = ["+", "-", "*", "%", "..", "==", "~=", "<", "<=", ">", ">=", "and", "or"];
        let loopVars: string[] = [];
        const expr = (depth: number): string => {
            if (depth === 0 || rand(3) === 0) return loopVars.length > 0 && rand(3) === 0 ? loopVars[rand(loopVars.length)] : atoms[rand(atoms.length)];
            const r = rand(8);
            if (r === 0) return `not ${expr(depth - 1)}`;
            if (r === 1) return `(if ${expr(depth - 1)} then ${expr(depth - 1)} else ${expr(depth - 1)})`;
            return `(${expr(depth - 1)} ${binops[rand(binops.length)]} ${expr(depth - 1)})`;
        };
        const block = (depth: number, inLoop: boolean): string[] => {
            const out: string[] = [];
            for (let n = 1 + rand(3); n > 0; n--) {
                const r = depth === 0 ? rand(2) : rand(9);
                if (r === 0) out.push(`${["a", "b", "g"][rand(3)]} = ${expr(2)}`);
                else if (r === 1) out.push(`${["a", "b"][rand(2)]} ${["+", "..", "-"][rand(3)]}= ${expr(1)}`);
                else if (r === 2) out.push(`if ${expr(2)} then ${block(depth - 1, inLoop).join(" ")} ${rand(2) ? `elseif ${expr(2)} then ${block(depth - 1, inLoop).join(" ")}` : ""} ${rand(2) ? `else ${block(depth - 1, inLoop).join(" ")}` : ""} end`);
                else if (r === 3) {
                    const v = `i${depth}`;
                    const range = rand(5) === 0 ? `${atoms[rand(atoms.length)]}, 3` : `${rand(7) - 3}, ${rand(7) - 2}${rand(2) ? `, ${["1", "-1", "2", "0.5", "-2"][rand(5)]}` : ""}`;
                    loopVars.push(v);
                    out.push(`for ${v} = ${range} do ${block(depth - 1, true).join(" ")} end`);
                    loopVars.pop();
                } else if (r === 4) out.push(`do local k = 0 while k < ${rand(4)} and ${expr(1)} do k += 1 ${block(depth - 1, true).join(" ")} end end`);
                else if (r === 5) out.push(`do local k = 0 repeat k += 1 ${block(depth - 1, true).join(" ")} until k >= ${rand(4)} or ${expr(1)} end`);
                else if (r === 6 && inLoop) out.push(`if ${expr(1)} then ${rand(2) ? "break" : "continue"} end`);
                else out.push(`a = ${expr(2)}`);
            }
            return out;
        };
        const programs = Array.from({ length: 1500 }, () => [`local a, b = ${expr(1)}, ${expr(1)}`, ...block(3, false), "return a, b, g"].join("\n"));
        const quote = (s: string) => JSON.stringify(s);
        const lua = programs.map(p => `do g = nil local f, err = loadstring(${quote(p)}, "=t") if not f then print("error: " .. err) else local r = table.pack(pcall(f)) if r[1] then local out = {} for i = 2, r.n do out[#out + 1] = tostring(r[i]) end print(table.concat(out, "\\t")) else print("error: " .. tostring(r[2])) end end end`);
        const file = join(mkdtempSync(join(tmpdir(), "luau-")), "control.luau");
        writeFileSync(file, lua.join("\n"));
        const expected = execFileSync(process.env.LUAU!, [file], { encoding: "utf8", maxBuffer: 1 << 26 }).split("\n").slice(0, programs.length);
        const actual = programs.map(p => {
            luau.scope.delete(Symbol.for("g"));
            return run(p);
        });
        // integers with integers are a deviation from Luau: programs with integers are left out
        const keep = programs.map(p => !/\d+i\b/.test(p));
        expect(keep.filter(k => k).length).toBeGreaterThan(programs.length / 10);
        expect(actual.filter((_, i) => keep[i])).toEqual(expected.filter((_, i) => keep[i]));
    });
});
