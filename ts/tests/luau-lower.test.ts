import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLuau, toString } from '../lua';
import { impl } from '../magicvm/meta';
import { MultipleValues } from '../common';

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
        expect(run("if x then end")).toBe("error: t:1: if is not supported yet");
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
});
