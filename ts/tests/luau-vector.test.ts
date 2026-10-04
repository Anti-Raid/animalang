import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { num2str } from '../lua/number';
import { LuaTable } from '../lua/table';
import { LuaVector, vadd, vdiv, vidiv, vmul, vsub, vunm, vector } from '../lua/vector';

const v = (x: number, y: number, z?: number) => new LuaVector(x, y, z);

describe("Luau vectors", () => {
    // the expected values are what Luau gives
    it("hold float32 components and print them as Luau does", () => {
        expect([v(1, 2.5, 3).tostring(), v(0.1, -0, 1e39).tostring(), v(1, 2).tostring()]).toEqual(["1, 2.5, 3", "0.10000000149011612, -0, inf", "1, 2, 0"]);
        expect([v(1, 2, 3).index("x"), v(1, 2, 3).index("Z")]).toEqual([1, 3]);
        expect(() => v(1, 2, 3).index("w")).toThrow("attempt to index vector with 'w'");
        expect(() => v(1, 2, 3).index("xy")).toThrow("attempt to index vector with 'xy'");
    });

    it("do Luau's arithmetic", () => {
        expect(vadd(v(1, 2, 3), v(0.1, 0.2, 0.3)).tostring()).toBe("1.100000023841858, 2.200000047683716, 3.299999952316284");
        expect([vsub(v(1, 2, 3), v(1, 1, 1)), vunm(v(1, -2, 0)), vmul(2, v(1, 2, 3)), vmul(v(1, 2, 3), v(2, 2, 2))].map(r => r.tostring()))
            .toEqual(["0, 1, 2", "-1, 2, -0", "2, 4, 6", "2, 4, 6"]);
        expect([vdiv(v(1, 2, 3), 0).tostring(), vidiv(v(7, -7, 1), 2).tostring()]).toEqual(["inf, inf, inf", "3, -4, 0"]);
        expect([num2str(vector.magnitude(v(3, 4, 0))), vector.normalize(v(3, 4, 0)).tostring(), vector.cross(v(1, 0, 0), v(0, 1, 0)).tostring()])
            .toEqual(["5", "0.6000000238418579, 0.800000011920929, 0", "0, 0, 1"]);
        expect(() => vector.clamp(v(1, 1, 1), v(0, 2, 0), v(1, 1, 1))).toThrow("invalid argument #3 to 'clamp' (max.y must be greater than or equal to min.y)");
    });

    it("are table keys by value, -0 and 0 alike, and never weak", () => {
        const t = new LuaTable();
        t.set(v(1, 2, 3), "a").set(v(0, 0, 0), "zero");
        expect([t.get(v(1, 2, 3)), t.get(v(-0, 0, -0)), t.get(v(1, 2, 4))]).toEqual(["a", "zero", undefined]);
        t.set(v(-0, 0, 0), "z");
        expect([t.size, t.get(v(0, 0, 0)), t.next(v(1, 2, 3))?.[1]]).toEqual([2, "z", "z"]);
        for (let i = 0; i < 100; i++) t.set(v(i, i, i), i);
        expect([t.get(v(50, 50, 50)), t.get(v(1, 2, 3))]).toEqual([50, "a"]);
        expect(() => t.set(v(NaN, 0, 0), 1)).toThrow("table index contains NaN");
        expect(t.get(v(NaN, 0, 0))).toBeUndefined();
        const w = new LuaTable();
        w.metatable = new LuaTable().set("__mode", "kv");
        w.set(v(1, 1, 1), v(2, 2, 2));
        expect(w.get(v(1, 1, 1))).toEqual(v(2, 2, 2));
    });
});

describe.skipIf(!process.env.LUAU)("Luau vectors against Luau", () => {
    it("compute what Luau computes", () => {
        let seed = 7;
        const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
        const comps = [0, -0, 1, -1, 0.1, 2.5, -3.75, 1e-3, 123456.789, 1e30, 3e38, 1e-40, NaN, Infinity, -Infinity, 7, 1 / 3];
        const comp = () => rand(3) === 0 ? comps[rand(comps.length)] : (rand(2000000) - 1000000) / [1, 7, 1000, 3][rand(4)];
        const lit = (n: number) => n !== n ? "0/0" : n === Infinity ? "math.huge" : n === -Infinity ? "-math.huge" : num2str(n);
        type Arg = LuaVector | number;
        const vec = () => v(comp(), comp(), comp());
        const ops: [string, (...a: any[]) => any, () => Arg[]][] = [
            ["a + b", vadd, () => [vec(), vec()]], ["a - b", vsub, () => [vec(), vec()]], ["-a", vunm, () => [vec()]],
            ["a * b", vmul, () => [vec(), rand(2) ? vec() : comp()]], ["a * b", vmul, () => [comp(), vec()]],
            ["a / b", vdiv, () => [vec(), rand(2) ? vec() : comp()]], ["a / b", vdiv, () => [comp(), vec()]],
            ["a // b", vidiv, () => [vec(), rand(2) ? vec() : comp()]], ["a // b", vidiv, () => [comp(), vec()]],
            ...(["magnitude", "normalize", "floor", "ceil", "abs", "sign"] as const).map((name): [string, (...a: any[]) => any, () => Arg[]] => [`vector.${name}(a)`, vector[name], () => [vec()]]),
            ...(["cross", "dot", "angle", "max", "min"] as const).map((name): [string, (...a: any[]) => any, () => Arg[]] => [`vector.${name}(a, b)`, vector[name], () => [vec(), vec()]]),
            ["vector.angle(a, b, c)", vector.angle, () => [vec(), vec(), vec()]], ["vector.max(a, b, c)", vector.max, () => [vec(), vec(), vec()]],
            ["vector.lerp(a, b, c)", vector.lerp, () => [vec(), vec(), [0, 1, 0.5, 0.3, 2, -1][rand(6)]]],
            ["vector.clamp(a, b, c)", vector.clamp, () => [vec(), vec(), vec()]],
            ["a == b", (a: LuaVector, b: LuaVector) => a.equals(b), () => { const a = vec(); return [a, rand(2) ? a : vec()]; }],
        ];
        // Luau's arm64 builds fuse the multiply-adds of these (clang's FMA contraction), so they differ there in the last
        // bit from the source's float32 expressions, which x86-64 builds and these vectors compute
        const fused = /magnitude|normalize|cross|dot|angle|lerp/;
        const exact = process.arch === "arm64" ? ops.filter(([expr]) => !fused.test(expr)) : ops;
        const cases = Array.from({ length: 5000 }, () => {
            const [expr, fn, args] = exact[rand(exact.length)];
            return { expr, fn, args: args() };
        });
        const arg = (a: Arg) => typeof a === "number" ? lit(a) : `vector.create(${lit(a.x)}, ${lit(a.y)}, ${lit(a.z)})`;
        const lua = cases.map(({ expr, args }) => `do local a, b, c = ${args.map(arg).join(", ")} print(pcall(function() return tostring(${expr}) end)) end`);
        const file = join(mkdtempSync(join(tmpdir(), "luau-")), "vectors.luau");
        writeFileSync(file, lua.join("\n"));
        const expected = execFileSync(process.env.LUAU!, [file], { encoding: "utf8", maxBuffer: 1 << 26 }).split("\n").map(l => l.replace(/^false\t.*:\d+: /, "false\t"));
        const actual = cases.map(({ fn, args }) => {
            try {
                const r = fn(...args);
                return "true\t" + (r instanceof LuaVector ? r.tostring() : typeof r === "boolean" ? String(r) : num2str(r));
            } catch (e: any) {
                return "false\t" + e.message;
            }
        });
        expect(actual).toEqual(expected.slice(0, actual.length));
    });
});
