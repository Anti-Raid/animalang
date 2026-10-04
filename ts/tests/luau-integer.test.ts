import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { integer, ipow } from '../lua/integer';
import { LuaBuffer } from '../lua/buffer';
import { LuaTable } from '../lua/table';
import { num2str } from '../lua/number';
import { parseLuau } from '../lua/syntax/parser';
import { show as showForm } from '../lua/syntax/print';

const MIN = integer.minsigned, MAX = integer.maxsigned;

describe("Luau integers", () => {
    // the expected values are what Luau gives
    it("wrap around 64 bits and divide as Luau does", () => {
        expect([integer.add(MAX, 1n), integer.neg(MIN), integer.mul(MAX, 2n)]).toEqual([MIN, MIN, -2n]);
        expect([integer.div(-7n, 2n), integer.idiv(-7n, 2n), integer.rem(-7n, 2n), integer.mod(-7n, 2n)]).toEqual([-3n, -4n, -1n, 1n]);
        expect([integer.rem(MIN, -1n), integer.mod(MIN, -1n), integer.udiv(-1n, 2n), integer.urem(-1n, 10n)]).toEqual([0n, 0n, MAX, 5n]);
        expect(() => integer.div(1n, 0n)).toThrow("division by zero");
        expect(() => integer.div(MIN, -1n)).toThrow("integer overflow");
        expect(() => integer.idiv(MIN, -1n)).toThrow("integer overflow");
    });

    it("shift, rotate and count bits as Luau does", () => {
        expect([integer.lshift(1n, 63n), integer.arshift(MIN, 100n), integer.lrotate(1n, -1n), integer.bswap(1n)]).toEqual([MIN, -1n, MIN, 72057594037927936n]);
        expect([integer.rshift(-1n, 60n), integer.lshift(1n, 64n), integer.arshift(-8n, 1n)]).toEqual([15n, 0n, -4n]);
        expect([integer.countlz(1n), integer.countrz(0n), integer.countrz(MIN), integer.extract(-1n, 0n, 64n), integer.replace(0n, 3n, 62n, 2n)]).toEqual([63n, 64n, 63n, -1n, -(1n << 62n)]);
        expect(() => integer.extract(1n, 64n)).toThrow("invalid argument #2 to 'extract' (field cannot be negative)");
        expect(() => integer.extract(1n, 60n, 5n)).toThrow("trying to access non-existent bits");
        expect([integer.band(), integer.bor(), integer.btest(), integer.btest(1n, 2n)]).toEqual([-1n, 0n, true, false]);
    });

    it("raise to powers, wrapping, for ^ (not in Luau)", () => {
        expect([ipow(2n, 10n), ipow(2n, 63n), ipow(2n, 64n), ipow(3n, 0n), ipow(-3n, 3n)]).toEqual([1024n, MIN, 0n, 1n, -27n]);
        expect([ipow(2n, -1n), ipow(1n, -5n), ipow(-1n, -3n), ipow(-1n, -2n)]).toEqual([0n, 1n, -1n, 1n]);
        expect(() => ipow(0n, -1n)).toThrow("division by zero");
        let r = 1n;
        for (let i = 0; i < 100; i++) r = BigInt.asIntN(64, r * 3n);
        expect(ipow(3n, 100n)).toBe(r);
    });

    it("convert from numbers and strings as Luau does", () => {
        expect([integer.create(2 ** 63), integer.create(1.5), integer.create(-(2 ** 63)), integer.create(NaN), integer.create(-0)]).toEqual([undefined, undefined, MIN, undefined, 0n]);
        expect([integer.fromstring("99999999999999999999"), integer.fromstring("-99999999999999999999"), integer.fromstring("99999999999999999999", 16)]).toEqual([MAX, MIN, -1n]);
        expect([integer.fromstring("-1", 2), integer.fromstring("0x10"), integer.fromstring("10", 16), integer.fromstring(" -0x11 ", 10), integer.fromstring("1\0junk")]).toEqual([-1n, 16n, 16n, -17n, 1n]);
        expect([integer.fromstring("0x"), integer.fromstring("1.5"), integer.fromstring(""), integer.fromstring("0b11"), integer.fromstring("1_000")]).toEqual([undefined, undefined, undefined, undefined, undefined]);
        expect(() => integer.fromstring("1", 37)).toThrow("invalid argument #2 to 'fromstring' (base out of range)");
        expect(num2str(integer.tonumber(MAX))).toBe("9223372036854776000");
    });

    it("are table keys apart from numbers, and buffers read and write them", () => {
        const t = new LuaTable().set(1, "num").set(1n, "int");
        expect([t.get(1), t.get(1n), t.rawlen()]).toEqual(["num", "int", 1]);
        const b = LuaBuffer.create(8);
        b.writeinteger(0, -2n);
        expect([b.readinteger(0), b.readu32(0)]).toEqual([-2n, 4294967294]);
        expect(() => b.readinteger(1)).toThrow("buffer access out of bounds");
    });
});

describe.skipIf(!process.env.LUAU)("Luau integers against Luau", () => {
    let seed = 7;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const luau = (lines: string[]) => {
        const file = join(mkdtempSync(join(tmpdir(), "luau-")), "integers.luau");
        writeFileSync(file, lines.join("\n"));
        return execFileSync(process.env.LUAU!, [file], { encoding: "utf8", maxBuffer: 1 << 26 }).split("\n").slice(0, lines.length);
    };
    const lit = (v: bigint) => v === MIN ? "integer.minsigned" : v < 0n ? `-${-v}i` : `${v}i`;
    const show = (r: any) => typeof r === "bigint" ? String(r) : r === undefined ? "nil" : String(r);
    const quote = (s: string) => `"${s.replace(/\t/g, "\\t").replace(/\0/g, "\\000")}"`;

    it("compute what Luau computes", () => {
        const edges = [0n, 1n, -1n, 2n, -2n, 7n, 63n, 64n, -63n, -64n, 100n, MAX, MIN, MAX - 1n, MIN + 1n, 1n << 32n, (1n << 32n) - 1n, -(1n << 32n)];
        const int = () => {
            if (rand(3) === 0) return edges[rand(edges.length)];
            const n = BigInt(rand(2 ** 31)) << BigInt(rand(40)) | BigInt(rand(2 ** 20));
            return BigInt.asIntN(64, rand(2) ? n : -n);
        };
        const small = () => BigInt(rand(140) - 70);
        const binary = ["add", "sub", "mul", "div", "idiv", "rem", "mod", "udiv", "urem", "lt", "le", "gt", "ge", "ult", "ule", "ugt", "uge", "band", "bor", "bxor", "btest", "min", "max"] as const;
        const shifts = ["lshift", "rshift", "arshift", "lrotate", "rrotate"] as const;
        const cases: [string, bigint[]][] = Array.from({ length: 6000 }, () => {
            const r = rand(10);
            if (r < 5) {
                const name = binary[rand(binary.length)];
                const b = rand(4) === 0 ? edges[rand(6)] : int();
                return [name, [int(), b]];
            }
            if (r < 7) return [shifts[rand(shifts.length)], [int(), rand(3) === 0 ? int() : small()]];
            if (r < 8) return [["neg", "bnot", "countlz", "countrz", "bswap", "tonumber"][rand(6)], [int()]];
            if (r < 9) return ["extract", [int(), small(), BigInt(rand(70) - 2)]];
            return [rand(2) ? "replace" : "clamp", rand(2) ? [int(), int(), small(), BigInt(rand(70) - 2)] : [int(), int(), int()]];
        });
        const fixed = cases.map(([name, args]) => name === "clamp" ? [name, args.slice(0, 3)] as [string, bigint[]] : [name, args] as [string, bigint[]]);
        const expected = luau(fixed.map(([name, args]) => `print(pcall(function() return tostring(integer.${name}(${args.map(lit).join(", ")})) end))`))
            .map(l => l.replace(/^false\t.*:\d+: /, "false\t"));
        const actual = fixed.map(([name, args]) => {
            try {
                const r = (integer as any)[name](...args);
                return "true\t" + (typeof r === "number" ? num2str(r) : show(r));
            } catch (e: any) {
                return "false\t" + e.message;
            }
        });
        expect(actual).toEqual(expected);
    });

    it("parse integer literals as Luau does", () => {
        const pieces = ["0", "1", "9", "f", "F", "_", "x", "b", "0x", "0b", "7fffffffffffffff", "8000000000000000", "9223372036854775807", "9223372036854775808", "ffffffffffffffff", "1".repeat(64), ".", "e"];
        const literals = Array.from({ length: 3000 }, () => (rand(4) === 0 ? "" : ["0x", "0b", "0X", ""][rand(4)]) + Array.from({ length: 1 + rand(3) }, () => pieces[rand(pieces.length)]).join("") + "i")
            .filter(l => /^[0-9]/.test(l));
        const expected = luau(literals.map(l => `do local f, e = loadstring("return ${l}") if f then print(tostring(f())) else print((e:gsub("^.-:%d+: ", ""))) end end`));
        const actual = literals.map(l => {
            const r = parseLuau(`return ${l}`);
            if (r.errors.length > 0) return r.errors[0].message;
            const v = (r.root[1] as any[])[1];
            return typeof v === "bigint" ? String(v) : showForm(v);
        });
        expect(actual).toEqual(expected);
    });

    it("read strings and numbers as Luau does", () => {
        const pieces = ["0", "1", "7", "9", "f", "z", "x", "-", "+", " ", "\t", "0x", "99999999999", "\0", ".", "_"];
        const strings = Array.from({ length: 4000 }, () => Array.from({ length: 1 + rand(6) }, () => pieces[rand(pieces.length)]).join(""));
        const bases = strings.map(() => [10, 2, 8, 16, 36, 0][rand(6)]);
        const numbers = Array.from({ length: 1000 }, () => [0.5, -0, 2 ** 63, -(2 ** 63), 2 ** 53 + 2, 1e300, -7, NaN, Infinity][rand(9)] * (rand(2) ? 1 : 1));
        const lua = [
            ...strings.map((s, i) => `print(tostring(integer.fromstring(${quote(s)}${bases[i] === 0 ? "" : `, ${bases[i]}`})))`),
            ...numbers.map(n => `print(tostring(integer.create(${n !== n ? "0/0" : n === Infinity ? "math.huge" : num2str(n)})))`),
        ];
        const ours = [
            ...strings.map((s, i) => show(bases[i] === 0 ? integer.fromstring(s) : integer.fromstring(s, bases[i]))),
            ...numbers.map(n => show(integer.create(n))),
        ];
        expect(ours).toEqual(luau(lua));
    });
});
