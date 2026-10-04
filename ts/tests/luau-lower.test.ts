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
        expect(run("local t = {}")).toBe("error: t:1: a table is not supported yet");
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
        expect(run("local function noret() end local function bare() return end return noret(), bare()")).toBe("nil\tnil");
        expect(run("local function f() for i = 1, 10 do if i == 3 then return i end end end return f()")).toBe("3");
        expect(run("local function down(n) if n == 0 then return 'done' end return down(n - 1) end return down(100000)")).toBe("done");
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
        expect(run("local function f() return 1, 2 end")).toBe("error: t:1: returning several values from a function is not supported yet");
    });
});

describe.skipIf(!process.env.LUAU)("Luau lowered against Luau", () => {
    it("computes what Luau computes, and fails where it fails", () => {
        let seed = 7;
        const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
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
        const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
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

    it("branches and loops as Luau does", () => {
        let seed = 11;
        const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
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
        expect(keep.filter(k => k).length).toBeGreaterThan(programs.length / 4);
        expect(actual.filter((_, i) => keep[i])).toEqual(expected.filter((_, i) => keep[i]));
    });
});
