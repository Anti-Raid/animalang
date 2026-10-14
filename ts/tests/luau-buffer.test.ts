import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuaBuffer } from '../lua/buffer';
import { num2str } from '../lua/number';

describe("Luau buffers", () => {
    // the expected values are what Luau gives
    it("read and write little-endian, casting numbers as Luau does", () => {
        const b = LuaBuffer.create(8);
        b.writeu32(0, 1e30);
        expect(b.readu32(0)).toBe(4294967295);
        b.writeu32(0, -1);
        expect([b.readu32(0), b.readi32(0), b.readu8(3)]).toEqual([4294967295, -1, 255]);
        b.writei8(0, 300);
        expect(b.readi8(0)).toBe(44);
        b.writeu32(0, NaN);
        expect(b.readu32(0)).toBe(0);
        b.writef32(0, 0.1);
        expect(num2str(b.readf32(0))).toBe("0.10000000149011612");
        b.writef32(0, 1e300);
        expect(b.readf32(0)).toBe(Infinity);
        expect(b.readu8(7.9)).toBe(0);
        expect([LuaBuffer.create(1.9).len, LuaBuffer.fromstring("hi").tostring()]).toEqual([1, "hi"]);
    });

    it("read and write bits, strings, copies and fills", () => {
        const b = LuaBuffer.create(8);
        b.writebits(3, 20, 0xabcde);
        expect([b.readbits(3, 20), b.readbits(7, 8), b.readu32(0)]).toEqual([0xabcde, 0xcd, 0xabcde << 3]);
        b.writebits(0, 32, 2 ** 32 - 1);
        expect(b.readbits(0, 32)).toBe(2 ** 32 - 1);
        b.writestring(2, "hello", 3);
        expect(b.readstring(2, 3)).toBe("hel");
        b.copyFrom(0, b, 2, 3);
        expect(b.readstring(0, 5)).toBe("helel");
        b.fill(4, 0x1ff);
        expect(b.readu32(4)).toBe(0xffffffff);
    });

    it("report Luau's errors", () => {
        const b = LuaBuffer.create(8);
        expect(() => LuaBuffer.create(-1)).toThrow("invalid argument #1 to 'create' (size)");
        expect(() => LuaBuffer.create(2 ** 30 + 1)).toThrow("memory allocation error: block too big");
        expect(() => b.readu8(8)).toThrow("buffer access out of bounds");
        expect(() => b.readu8(-1)).toThrow("buffer access out of bounds");
        expect(() => b.readu8(1e30)).toThrow("buffer access out of bounds");
        expect(() => b.readstring(6, 3)).toThrow("buffer access out of bounds");
        expect(() => b.writestring(0, "abc", 5)).toThrow("string length overflow");
        expect(() => b.readbits(0, 33)).toThrow("bit count is out of range of [0; 32]");
        expect(() => b.readbits(-1, 3)).toThrow("buffer access out of bounds");
        expect(() => b.copyFrom(0, b, 4, -1)).toThrow("buffer access out of bounds");
        expect(() => b.fill(0, 1, 9)).toThrow("buffer access out of bounds");
    });
});

describe.skipIf(!process.env.LUAU)("Luau buffers against Luau", () => {
    it("give what Luau gives for random programs", () => {
        let seed = 7;
        const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return (n > 4096 ? seed : Math.floor(seed / 4096)) % n; };
        const values = [0, 1, -1, 255, 256, 300, -129, 65535, 65536, 2 ** 31, 2 ** 32 - 1, 2 ** 32, -(2 ** 31) - 1, 1e30, -1e30, 2 ** 63, 0.1, 2.9, -2.9, NaN, Infinity, 3.4e38, 1e-40];
        const lit = (n: number) => n !== n ? "0/0" : n === Infinity ? "math.huge" : n === -Infinity ? "-math.huge" : num2str(n);
        const num = () => rand(2) === 0 ? values[rand(values.length)] : rand(5000) - 100;
        type Op = [name: string, args: any[]];
        const programs = Array.from({ length: 300 }, () => {
            const size = rand(20);
            const offset = () => [rand(size + 4) - 1, rand(size + 4) - 1, 0.5 + rand(size + 1), values[rand(values.length)]][rand(4) === 0 ? 1 + rand(3) : 0];
            const ops = Array.from({ length: 1 + rand(40) }, (): Op => {
                const kind = ["i8", "u8", "i16", "u16", "i32", "u32", "f32", "f64"][rand(8)];
                switch (rand(9)) {
                    case 0: case 1: return ["write" + kind, [offset(), num()]];
                    case 2: case 3: return ["read" + kind, [offset()]];
                    case 4: return ["readstring", [offset(), rand(6) - 1]];
                    case 5: return ["writestring", rand(2) ? [offset(), "abcdef".slice(0, rand(7))] : [offset(), "abcdef".slice(0, rand(7)), rand(8) - 1]];
                    case 6: return rand(2) ? ["fill", [offset(), num()]] : ["fill", [offset(), num(), rand(size + 2) - 1]];
                    case 7: return ["copy", [offset(), "b", ...(rand(2) ? [offset(), rand(size + 2) - 1] : rand(2) ? [offset()] : [])]];
                    default: return rand(2) ? ["readbits", [rand(size * 8 + 8) - 2, rand(36) - 1]] : ["writebits", [rand(size * 8 + 8) - 2, rand(36) - 1, num()]];
                }
            });
            return { size, ops };
        });
        const hex = (s: string) => [...s].map(c => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
        const lua = [
            `local function hex(s) return (s:gsub(".", function(c) return string.format("%02x", c:byte()) end)) end`,
            `local function r(ok, v) if not ok then print("error " .. v) elseif type(v) == "string" then print(hex(v)) elseif v == nil then print("ok") else print(tostring(v)) end end`,
            ...programs.flatMap(p => [
                `do local b = buffer.create(${p.size})`,
                ...p.ops.map(([name, args]) => `r(pcall(buffer.${name}, b, ${args.map(a => a === "b" ? "b" : typeof a === "string" ? `"${a}"` : lit(a)).join(", ")}))`),
                `print(hex(buffer.tostring(b))) end`,
            ]),
        ];
        const file = join(mkdtempSync(join(tmpdir(), "luau-")), "buffers.luau");
        writeFileSync(file, lua.join("\n"));
        const expected = execFileSync(process.env.LUAU!, [file], { encoding: "utf8", maxBuffer: 1 << 26 }).split("\n");
        const actual = programs.flatMap(p => {
            const b = LuaBuffer.create(p.size);
            const out = p.ops.map(([name, args]) => {
                try {
                    const v = (b as any)[name === "copy" ? "copyFrom" : name](...args.map(a => a === "b" ? b : a));
                    return typeof v === "string" ? hex(v) : v === undefined ? "ok" : num2str(v);
                } catch (e: any) {
                    return "error " + e.message;
                }
            });
            return [...out, hex(b.tostring())];
        });
        expect(actual).toEqual(expected.slice(0, actual.length));
    });
});
