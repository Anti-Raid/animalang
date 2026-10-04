import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { num2str, str2integer, str2number } from '../lua/number';

describe("Luau numbers as strings", () => {
    // the expected values are what Luau gives
    it("print the shortest digits, fixed between 1e-5 and 1e21", () => {
        const cases: [number, string][] = [
            [0, "0"], [-0, "-0"], [1, "1"], [-1.5, "-1.5"], [0.1, "0.1"], [1 / 3, "0.3333333333333333"], [100, "100"],
            [1e15, "1000000000000000"], [1e21, "1e+21"], [123456789012345680000, "123456789012345680000"],
            [1e-5, "0.00001"], [1.5e-7, "1.5e-07"], [1e-6, "0.000001"], [1e-7, "1e-07"], [1e100, "1e+100"],
            [2 ** 53, "9007199254740992"], [5e-324, "5e-324"], [1.7976931348623157e308, "1.7976931348623157e+308"],
            [Infinity, "inf"], [-Infinity, "-inf"], [NaN, "nan"], [-NaN, "nan"],
        ];
        expect(cases.map(([n]) => num2str(n))).toEqual(cases.map(([, s]) => s));
    });

    it("read what strtod reads, with space around it", () => {
        const cases: [string, number | undefined][] = [
            ["10", 10], [" 10 ", 10], ["\t-1.5e2\n", -150], [".5", 0.5], ["5.", 5], ["0x10", 16], ["-0x10", -16],
            ["0x1p4", 16], ["0x.8", 0.5], ["0X1.8P1", 3], ["inf", Infinity], ["-Infinity", -Infinity], ["1e", undefined],
            ["0x", undefined], ["", undefined], [" ", undefined], ["12a", undefined], ["0b101", undefined],
            ["1_000", undefined], ["1\0junk", 1], ["1e400", Infinity], [".", undefined], ["+.5e-1", 0.05],
        ];
        expect(cases.map(([s]) => str2number(s))).toEqual(cases.map(([, n]) => n));
        expect(Number.isNaN(str2number("nan"))).toBe(true);
        expect(Number.isNaN(str2number("-nan(123)"))).toBe(true);
    });

    it("read other bases as strtoull does", () => {
        expect([str2integer("ff", 16), str2integer("0xff", 16), str2integer(" 101 ", 2), str2integer("z", 36)]).toEqual([255, 255, 5, 35]);
        expect([str2integer("2", 2), str2integer("", 16), str2integer("1.5", 10)]).toEqual([undefined, undefined, undefined]);
        expect([str2integer("-1", 16), str2integer("ffffffffffffffffffff", 16)]).toEqual([2 ** 64, 2 ** 64]);
    });
});

describe.skipIf(!process.env.LUAU)("Luau numbers as strings against Luau", () => {
    let seed = 7;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return (n > 4096 ? seed : Math.floor(seed / 4096)) % n; };
    const luau = (lines: string[]) => {
        const file = join(mkdtempSync(join(tmpdir(), "luau-")), "numbers.luau");
        writeFileSync(file, lines.join("\n"));
        return execFileSync(process.env.LUAU!, [file], { encoding: "utf8", maxBuffer: 1 << 26 }).split("\n").slice(0, lines.length);
    };
    const quote = (s: string) => `"${s.replace(/[\\"]/g, c => "\\" + c).replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\0/g, "\\000")}"`;

    it("print what Luau prints", () => {
        const view = new DataView(new ArrayBuffer(8));
        const numbers = Array.from({ length: 5000 }, () => {
            const r = rand(4);
            if (r === 0) return rand(2000000) / [1, 10, 100, 1000, 1e6][rand(5)];
            view.setUint32(0, rand(2 ** 31) * 2 + rand(2), true);
            view.setUint32(4, r === 1 ? rand(2 ** 31) * 2 + rand(2) : (0x3a0 + rand(0xc0)) << 20 | rand(1 << 20), true);
            return view.getFloat64(0, true);
        });
        const lines = numbers.map(n => {
            view.setFloat64(0, n, true);
            return `do local b = buffer.create(8) buffer.writeu32(b, 0, ${view.getUint32(0, true)}) buffer.writeu32(b, 4, ${view.getUint32(4, true)}) print(tostring(buffer.readf64(b, 0))) end`;
        });
        expect(numbers.map(num2str)).toEqual(luau(lines));
    });

    it("read what Luau reads", () => {
        const pieces = ["0", "1", "9", "5", ".", "e", "E", "-", "+", "x", "X", "p", "f", "a", " ", "\t", "inf", "nan", "(", ")", "0x", "\0", "z"];
        const strings = Array.from({ length: 5000 }, () => Array.from({ length: 1 + rand(8) }, () => pieces[rand(pieces.length)]).join(""));
        const bases = strings.map(() => [10, 2, 8, 16, 36][rand(5)]);
        const lines = strings.map((s, i) => `print(tostring(tonumber(${quote(s)}${bases[i] === 10 ? "" : `, ${bases[i]}`})))`);
        const ours = strings.map((s, i) => {
            const n = bases[i] === 10 ? str2number(s) : str2integer(s, bases[i]);
            return n === undefined ? "nil" : num2str(n);
        });
        expect(ours).toEqual(luau(lines));
    });
});
