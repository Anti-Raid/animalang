import { describe, expect, it } from 'vitest';
import { MultipleValues } from '../common';
import { createLuau, luauText, toString } from '../lua';
import { impl } from '../magicvm/meta';
import { comparer, lit } from './luau-compare';

const printed: string[] = [];
const luau = createLuau(impl, { print: line => printed.push(line) });

const run = (src: string): string => {
    try {
        const r = luau.evaluateRaw(luau.compileRaw(src, "t"));
        return (r instanceof MultipleValues ? r.values : [r]).map(toString).join("\t");
    } catch (e: any) {
        return "error: " + e.message;
    }
};

let seed = 4242;
const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 4096) % n; };
const pick = <T,>(xs: readonly T[]): T => xs[rand(xs.length)];

// the expected values are what Luau gives
describe("Luau's tostring, tonumber and print", () => {
    it("writes a value as a string", () => {
        expect(run("return tostring(1), tostring(1.5), tostring(nil), tostring(true), tostring('x'), tostring(-0), tostring(1e100), tostring(0/0), tostring(2^53)"))
            .toBe("1\t1.5\tnil\ttrue\tx\t-0\t1e+100\tnan\t9007199254740992");
        expect(run("return tostring(1, 2), #tostring({}), tostring(print) == tostring(print), tostring({}) == tostring({})")).toBe("1\t25\ttrue\tfalse");
        expect(run("return tostring()")).toBe("error: t:1: missing argument #1");
    });

    it("reads a number in base 10 or another", () => {
        expect(run("return tonumber('10'), tonumber('0x10'), tonumber(' 5 '), tonumber('abc'), tonumber(nil), tonumber(true), tonumber({}), tonumber(5), tonumber('1e2'), tonumber('')"))
            .toBe("10\t16\t5\tnil\tnil\tnil\tnil\t5\t100\tnil");
        expect(run("return tonumber('ff', 16), tonumber('FF', 16), tonumber('zz', 36), tonumber('101', 2), tonumber('8', 8), tonumber(' 12 ', 10), tonumber('-ff', 16), tonumber('0x1f', 16), tonumber('1.5', 16)"))
            .toBe("255\t255\t1295\t5\tnil\t12\t18446744073709552000\t31\tnil");
        expect(run("return tonumber('10', nil), tonumber('10', 10.9), tonumber('7', 8.5), tonumber('10', '16'), tonumber(nil, 10), tonumber(1e30, 10), tonumber({}, 10)")).toBe("10\t10\t7\t16\tnil\t1e+30\tnil");
        // in another base a number is read as it is written
        expect(run("return tonumber(15, 16), tonumber(1.5, 16), tonumber('', 16), tonumber('+f', 16), tonumber('ffffffffffffffffff', 16), tonumber('1 2', 3)")).toBe("21\tnil\tnil\t15\t18446744073709552000\tnil");
        expect(run("return tonumber()")).toBe("error: t:1: missing argument #1");
        expect(run("return tonumber('10', 1)")).toBe("error: t:1: invalid argument #2 to 'tonumber' (base out of range)");
        expect(run("return tonumber('10', 37)")).toBe("error: t:1: invalid argument #2 to 'tonumber' (base out of range)");
        expect(run("return tonumber(nil, 16)")).toBe("error: t:1: invalid argument #1 to 'tonumber' (string expected, got nil)");
        expect(run("return tonumber('10', 'x')")).toBe("error: t:1: invalid argument #2 to 'tonumber' (number expected, got string)");
    });

    it("prints its arguments on a line, to the host", () => {
        printed.length = 0;
        expect(run("return print(), print(1, 'a', nil, true, 1.5), (print('x'))")).toBe("nil\tnil\tnil");
        expect(printed).toEqual(["", "1\ta\tnil\ttrue\t1.5", "x"]);
        printed.length = 0;
        expect(run("local n = 0 for i = 1, 3 do n = n + #{print(i)} end return n")).toBe("0");
        expect(printed).toEqual(["1", "2", "3"]);
        // a string is of bytes: the host reads it as UTF-8
        printed.length = 0;
        run("print('héllo ✓', '\\255')");
        expect(printed[0].length).toBe(12);
        expect(luauText(printed[0])).toBe("héllo ✓\t�");
        expect(luauText("plain")).toBe("plain");
    });
});

describe("Luau's error and pcall", () => {
    it("gives true and the results, or false and the error", () => {
        expect(run("return pcall(function() return 1, 2, 3 end)")).toBe("true\t1\t2\t3");
        expect(run("return pcall(function(a, b) return a + b end, 3, 4)")).toBe("true\t7");
        expect(run("return pcall(function(...) return ... end, 1, nil, 3)")).toBe("true\t1\tnil\t3");
        expect(run("return pcall(string.rep, 'ab', 2)")).toBe("true\tabab");
        expect(run("return pcall(function() local x = nil; return x.y end)")).toBe("false\tt:1: attempt to index nil with 'y'");
        expect(run("return pcall(function()\n  return 1 + {}\nend)")).toBe("false\tt:2: attempt to perform arithmetic (add) on number and table");
        expect(run("return pcall(pcall, function() error('in') end)")).toBe("true\tfalse\tt:1: in");
        expect(run("local n = 0 for i = 1, 100 do if pcall(function() if i % 2 == 0 then error('x') end end) then n = n + 1 end end return n")).toBe("50");
    });

    it("raises a string with where the caller was, and anything else as it is", () => {
        expect(run("return pcall(function()\n  error('boom')\nend)")).toBe("false\tt:2: boom");
        expect(run("return pcall(function() error('boom', 0) end)")).toBe("false\tboom");
        expect(run("return pcall(function() error(42) end)")).toBe("false\tt:1: 42");
        expect(run("return pcall(function() error() end)")).toBe("false\tnil");
        expect(run("local t = {} local ok, e = pcall(function() error(t) end) return ok, e == t")).toBe("false\ttrue");
        expect(run("local ok, e = pcall(function() local _, inner = pcall(error, 'inner', 0) error(inner .. '!', 0) end) return ok, e")).toBe("false\tinner!");
        // level 2 is the caller of the function that called error; past the stack there is no position
        expect(run("local function f()\n  error('boom', 2)\nend\nreturn pcall(function()\n  f()\nend)")).toBe("false\tt:5: boom");
        expect(run("local function f() error('deep', 3) end\nlocal function g() f() end\nreturn pcall(function()\n  g()\nend)")).toBe("false\tt:4: deep");
        expect(run("return pcall(function() error('boom', 50) end)")).toBe("false\tboom");
        expect(run("error('top')")).toBe("error: t:1: top");
        expect(run("error('top', 0)")).toBe("error: top");
        expect(run("return pcall(function() error('x', 'y') end)")).toBe("false\tt:1: invalid argument #2 to 'error' (number expected, got string)");
    });

    it("gives an error raised by a function pcall called itself no position", () => {
        expect(run("return pcall(error, 'msg')")).toBe("false\tmsg");
        expect(run("return pcall(string.rep)")).toBe("false\tmissing argument #1 to 'rep' (string expected)");
        expect(run("return pcall(5)")).toBe("false\tattempt to call a number value");
        expect(run("return pcall(pcall)")).toBe("false\tmissing argument #1");
        expect(run("return pcall()")).toBe("error: t:1: missing argument #1");
    });

    it("keeps reporting where an error was after many were caught", () => {
        expect(run("local function h() return tostring() end\nlocal n = 0\nfor i = 1, 40 do local ok, e = pcall(h) n = n + #e end\nreturn n, pcall(h)")).toBe("960\tfalse\tt:1: missing argument #1");
        expect(run("local function f() error('boom', 2) end\nfor i = 1, 40 do pcall(function() f() end) end\nreturn pcall(function()\n  return tostring()\nend)")).toBe("false\tt:4: missing argument #1");
        expect(run("return pcall()")).toBe("error: t:1: missing argument #1");
    });
});

describe.skipIf(!process.env.LUAU)("Luau's tostring and tonumber against Luau", () => {
    const compare = comparer(luau);

    it("raises and catches errors as Luau does", () => {
        const value = () => pick(["'msg'", "'msg'", "42", "nil", "true", "{}", "'a' .. 1"]);
        const others = ["tostring()", "string.rep()", "('x'):rep()", "nothere()", "pcall()", "tonumber('1', 99)", "string.format('%d', 'x')"];
        const programs = Array.from({ length: 3000 }, () => {
            const depth = 1 + rand(3);
            // a level further up than the caller is counted in frames: Luau keeps the frame of a call in tail position
            // and counts pcall's, so those are tried without either (see the README)
            const far = rand(5) === 0 ? pick([2, 3, 9].filter(l => l <= depth + 1 || l === 9)) : 0;
            const tail = () => far === 0 && rand(3) === 0 ? "return " : "";
            const raise = far > 0 ? `error(${value()}, ${far})` : rand(2) ? `error(${value()}${pick(["", "", ", 0", ", 1"])})` : pick(others);
            const lines = [`local function f1()\n  ${far === 0 && rand(4) === 0 ? pick(["local x = nil\n  x = x.y", "local t = {} + 1", "local s = 'a' .. nil"]) : tail() + raise}\nend`];
            for (let d = 2; d <= depth; d++) lines.push(`local function f${d}()\n  ${tail()}f${d - 1}()\nend`);
            const f = `f${depth}`;
            if (rand(4) === 0) lines.push(`for i = 1, 12 do pcall(${f}) end`);
            const inside = `return pcall(function()\n  ${f}()\nend)`;
            const last = far > 0 ? inside : pick([`return pcall(${f})`, inside, `local ok, e = pcall(${f})\nreturn ok, e`, `return pcall(pcall, ${f})`, `return pcall(function()\n  local ok, e = pcall(${f})\n  error(e, 0)\nend)`, `${f}()`]);
            lines.push(last);
            // (an error that is a table and is not caught is written with its address)
            return last === `${f}()` ? lines.join("\n").replace("{}", "true") : lines.join("\n");
        });
        expect(compare(programs).slice(0, 6)).toEqual([]);
    }, 120000);

    it("reads numbers as Luau does", () => {
        const pieces = ["0", "1", "7", "9", "10", "f", "F", "z", "Z", "a", " ", "\t", "-", "+", "0x", "0X", ".", "e", "e5", "_", "\0", "1e", "inf", "nan", "ffffffffffffffff", "\n"];
        const bases = ["2", "8", "10", "16", "36", "3", "1", "37", "0", "-1", "2.9", "'16'", "nil", "1e10", "'x'", "true"];
        const programs = Array.from({ length: 4000 }, () => {
            const s = Array.from({ length: rand(5) }, () => pick(pieces)).join("");
            const first = rand(15) === 0 ? pick(["12", "1.5", "nil", "true", "{}", "255"]) : lit(s);
            return rand(3) === 0 ? `return tonumber(${first})` : `return tonumber(${first}, ${pick(bases)})`;
        });
        expect(compare(programs).slice(0, 3)).toEqual([]);
    }, 60000);

    it("writes numbers as Luau does", () => {
        const programs = Array.from({ length: 4000 }, () => {
            const digits = Array.from({ length: 1 + rand(17) }, () => rand(10)).join("");
            const n = `${rand(2) ? "-" : ""}${digits[0]}.${digits.slice(1)}0e${rand(50) - 25}`;
            return rand(4) === 0 ? `return tostring(${n}), tonumber(tostring(${n})) == ${n}` : `return tostring(${n})`;
        });
        programs.push("return tostring(1e-5), tostring(9.999e-6), tostring(1e21), tostring(999999999999999900000), tostring(0.00001234), tostring(-1e-5), tostring(123456789012345680000)");
        expect(compare(programs).slice(0, 3)).toEqual([]);
    }, 60000);
});
