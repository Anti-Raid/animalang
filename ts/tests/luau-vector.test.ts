import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MultipleValues } from '../common';
import { createLuau, toString } from '../lua';
import { impl } from '../magicvm/meta';
import { num2str } from '../lua/number';
import { LuaTable } from '../lua/table';
import { LuaVector, vadd, vdiv, vidiv, vmul, vsub, vunm, vector } from '../lua/vector';

const v = (x: number, y: number, z?: number) => new LuaVector(x, y, z);
const luau = createLuau(impl);
const run = (src: string): string => {
    try {
        const r = luau.evaluateRaw(luau.compileRaw(src, "t"));
        return (r instanceof MultipleValues ? r.values : [r]).map(toString).join("\t");
    } catch (e: any) {
        return "error: " + e.message;
    }
};

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
        const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return (n > 4096 ? seed : Math.floor(seed / 4096)) % n; };
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

describe("Luau vector SROA in VM", () => {
    it("handles field accesses on vectors", () => {
        expect(run("local v = vector.create(1, 2, 3); return v.x, v.y, v.z")).toBe("1\t2\t3");
        expect(run("local v = vector.create(4, 5); return v.x, v.y, v.z")).toBe("4\t5\t0");
    });

    it("evaluates vector arithmetic and reduction without boxing", () => {
        expect(run("local a = vector.create(1, 2, 3); local b = vector.create(4, 5, 6); local c = a + b; return c.x, c.y, c.z"))
            .toBe("5\t7\t9");
        expect(run("local a = vector.create(1, 2, 3); local b = vector.create(4, 5, 6); local c = a - b; return c.x, c.y, c.z"))
            .toBe("-3\t-3\t-3");
        expect(run("local a = vector.create(1, -2, 3); local c = -a; return c.x, c.y, c.z"))
            .toBe("-1\t2\t-3");
        expect(run("local a = vector.create(1, 2, 3); local c = a * 2; return c.x, c.y, c.z"))
            .toBe("2\t4\t6");
        expect(run("local a = vector.create(2, 4, 6); local c = a / 2; return c.x, c.y, c.z"))
            .toBe("1\t2\t3");
        expect(run("local a = vector.create(1, 2, 3); local b = vector.create(4, 5, 6); return vector.dot(a, b)"))
            .toBe("32");
        expect(run("local a = vector.create(3, 4, 0); return vector.magnitude(a)"))
            .toBe("5");
    });

    it("computes arithmetic in loops", () => {
        const src = `
            local v = vector.create(0, 0, 0)
            local d = vector.create(1, 2, 3)
            for i = 1, 100 do
                v = v + d
            end
            return v.x, v.y, v.z
        `;
        expect(run(src)).toBe("100\t200\t300");
    });

    it("passes and returns vectors in self-tail-call loops", () => {
        const src = `
            local function loop(n, acc)
                if n <= 0 then return acc end
                return loop(n - 1, acc + vector.create(1, 2, 3))
            end
            local r = loop(5, vector.create(0, 0, 0))
            return r.x, r.y, r.z
        `;
        expect(run(src)).toBe("5\t10\t15");
    });

    it("materializes vectors when stored into tables, closures, or returned as objects", () => {
        const src = `
            local v = vector.create(10, 20, 30)
            local t = { vec = v }
            local function f() return v.x + v.y + v.z end
            return t.vec.x, t.vec.y, t.vec.z, f(), type(v)
        `;
        expect(run(src)).toBe("10\t20\t30\t60\tvector");
    });

    it("handles control flow branches with vectors", () => {
        const src = `
            local function branch(flag)
                local v = vector.create(1, 2, 3)
                if flag then
                    v = v * 2
                else
                    v = v + vector.create(10, 10, 10)
                end
                return v.x, v.y, v.z
            end
            local x1, y1, z1 = branch(true)
            local x2, y2, z2 = branch(false)
            return x1, y1, z1, x2, y2, z2
        `;
        expect(run(src)).toBe("2\t4\t6\t11\t12\t13");
    });

    it("checks the library's arguments as Luau does", () => {
        expect(run("return vector(1, 2, 3)")).toBe("error: t:1: attempt to call a table value");
        expect(run("return vector.create({}, 2)")).toBe("error: t:1: invalid argument #1 to 'create' (number expected, got table)");
        expect(run("return vector.create(5)")).toBe("error: t:1: missing argument #2 to 'create' (number expected)");
        expect(run("local function g(b) return vector.cross(vector.create(1, 0, 0), b) end; g(vector.create(0, 1, 0)); return pcall(g, 5)"))
            .toBe("false\tt:1: invalid argument #2 to 'cross' (vector expected, got number)");
    });

    it("reads a field only by a constant name", () => {
        expect(run("local v = vector.create(1, 2, 3); return v + 'x'")).toBe("error: t:1: attempt to perform arithmetic (add) on vector and string");
        expect(run("local v = vector.create(1, 2, 3); return v .. 'y'")).toBe("error: t:1: attempt to concatenate vector with string");
        expect(run("local v = vector.create(1, 2, 3); return v.X, v.y, v.Z")).toBe("1\t2\t3");
        expect(run("local v = vector.create(1, 2, 3); return v.w")).toBe("error: t:1: attempt to index vector with 'w'");
    });

    it("unboxes the vectors other operations make", () => {
        expect(run("local t = {v = vector.create(3, 4, 0)}; local n = vector.normalize(t.v); return n.x, n")).toBe("0.6000000238418579\t0.6000000238418579, 0.800000011920929, 0");
        expect(run("local t = {v = vector.create(1, 2, 3)}; local a = vector.create(1, 1, 1); for i = 1, 3 do if i == 2 then a = vector.normalize(t.v) else a = a + a end end; return a"))
            .toBe("0.5345224738121033, 1.0690449476242065, 1.603567361831665");
        expect(run("local function step(p, vel, dt) return p + vel * dt end local p, vel = vector.create(0, 0, 0), vector.create(1, 2, 3) for i = 1, 3 do p = step(p, vel, 0.001) end return p"))
            .toBe("0.003000000026077032, 0.006000000052154064, 0.008999999612569809");
        expect(run("local v, w = vector.create(1, 2, 3), vector.create(4, 5, 6); v = vector.cross(v, w); return v")).toBe("-3, 6, -3");
    });

    it("rounds a number to float32 before scaling by it", () => {
        expect(run("local v = vector.create(16777215, 3, 7) return v * 1.0000001, 1.0000001 * v, 3 / v"))
            .toBe("16777216, 3.000000476837158, 7.000000953674316\t16777216, 3.000000476837158, 7.000000953674316\t1.788139485370266e-07, 1, 0.4285714328289032");
    });

    it("unwinds and restores vector registers across coroutine yield/resume", () => {
        const src = `
            local co = coroutine.create(function(start)
                local v = start + vector.create(1, 2, 3)
                coroutine.yield(v.x)
                return v.x, v.y, v.z
            end)
            local ok1, r1 = coroutine.resume(co, vector.create(10, 20, 30))
            local ok2, x, y, z = coroutine.resume(co)
            return ok1, r1, ok2, x, y, z
        `;
        expect(run(src)).toBe("true\t11\ttrue\t11\t22\t33");
    });
});
