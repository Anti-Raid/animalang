import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuaTable } from '../lua/table';
import { TRY_CALL } from '../common';
import { createNativeScheme } from '../native';
import { impl } from '../magicvm/meta';

const dump = (t: LuaTable) => [...t.entries()].map(([k, v]) => `${k}=${v}`).join(",");

// collects what nothing reaches; WeakRefs made in this job are kept until it ends, so wait for the next one first
const collect = async () => {
    const gc = (globalThis as any).gc;
    if (typeof gc !== "function") throw new Error("run with --expose-gc (see vitest.config.ts)");
    await new Promise(resolve => setTimeout(resolve, 0));
    gc();
};

describe("Luau tables", () => {
    // the expected values are what Luau gives
    it("keep an array part, holes and all, as Luau sizes it", () => {
        const t = new LuaTable();
        t.set(2, "b").set(1, "a").set("k", "v").set(3, "c");
        expect([t.rawlen(), dump(t)]).toEqual([3, "1=a,2=b,3=c,k=v"]);
        t.set(2, undefined);
        expect([t.rawlen(), dump(t)]).toEqual([3, "1=a,3=c,k=v"]);
        t.set(2, "B");
        expect([t.rawlen(), dump(t)]).toEqual([3, "1=a,2=B,3=c,k=v"]);
        const h = new LuaTable(3).set(1, 1).set(3, 3);
        expect([h.rawlen(), dump(h)]).toEqual([3, "1=1,3=3"]);
        const u = new LuaTable();
        for (let i = 1; i <= 10; i++) u.set(i, i);
        u.set(5, undefined).set(10, undefined);
        expect(u.rawlen()).toBe(9);
        const w = new LuaTable().set(3, 1).set(2, 1).set(1, 1);
        expect([w.rawlen(), dump(w)]).toEqual([3, "1=1,2=1,3=1"]);
    });

    it("let a traversal clear what it has passed, and report Luau's errors", () => {
        const d = new LuaTable().set("a", 1).set("b", 2).set("c", 3);
        for (let e = d.next(undefined); e !== undefined; e = d.next(e[0])) d.set(e[0], undefined);
        expect([dump(d), d.next(undefined)]).toEqual(["", undefined]);
        expect(() => new LuaTable().set(undefined, 1)).toThrow("table index is nil");
        expect(() => new LuaTable().set(NaN, 1)).toThrow("table index is NaN");
        expect(() => new LuaTable().freeze().set("a", 1)).toThrow("attempt to modify a readonly table");
        expect(() => new LuaTable().next("missing")).toThrow("invalid key to 'next'");
        // 1.0 and 1 are one key, and so are 0 and -0
        const k = new LuaTable().set(1.0, "one").set(-0, "zero");
        expect([k.get(1), k.get(0)]).toEqual(["one", "zero"]);
    });

    it("clone with the same entries, sizes and order, and clear keeping the sizes", () => {
        const t = new LuaTable();
        for (let i = 1; i <= 5; i++) t.set(i, i * 10);
        t.set("x", 1).set(3, undefined);
        const c = t.clone();
        expect([c.rawlen(), dump(c), c.sizearray, c.sizenode]).toEqual([t.rawlen(), dump(t), t.sizearray, t.sizenode]);
        c.set("y", 2);
        expect(t.has("y")).toBe(false);
        t.clear();
        expect([dump(t), t.rawlen(), t.sizearray > 0]).toEqual(["", 0, true]);
    });

    it("call their metatable's __call, read again whenever it may have changed", () => {
        const f = () => "f", g = () => "g";
        const t = new LuaTable();
        expect(t[TRY_CALL]).toBeUndefined();
        const mt = new LuaTable().set("__call", f);
        t.metatable = mt;
        expect(t[TRY_CALL]).toBe(f);
        mt.set("__call", g);
        expect(t[TRY_CALL]).toBe(g);
        t.metatable = new LuaTable().set("__call", f);
        expect(t[TRY_CALL]).toBe(f);
        t.metatable = mt;
        expect(t[TRY_CALL]).toBe(g);
        mt.clear();
        expect(t[TRY_CALL]).toBeUndefined();
        mt.set("__call", f);
        expect([t[TRY_CALL], t.clone()[TRY_CALL]]).toEqual([f, f]);
    });

    it("are called through the VM as their __call, with the table first", () => {
        const a = createNativeScheme(impl);
        const t = new LuaTable().set("n", 40);
        t.metatable = new LuaTable();
        a.registerIntrinsic("%table", () => t, { args: [0, 0], leaf: true });
        a.registerIntrinsic("%get", (regs, st) => regs[st].get(regs[st + 1]), { args: [2, 2], leaf: true });
        a.registerIntrinsic("%set-call", (regs, st) => { regs[st].metatable.set("__call", regs[st + 1]); return regs[st]; }, { args: [2, 2], leaf: true });
        a.registerIntrinsic("%+", (regs, st) => regs[st] + regs[st + 1], { args: [2, 2], leaf: true });
        const run = (src: string) => a.evaluateRaw(a.compileRaw(src, "t.ns"));
        expect(() => run(`(%call (%intcall %table) 1)`)).toThrow("not a procedure");
        run(`(%intcall %set-call (%intcall %table) (lambda (self x) (%intcall %+ (%intcall %get self "n") x)))`);
        expect(run(`(%call (%intcall %table) 2)`)).toBe(42);
        run(`(%intcall %set-call (%intcall %table) (lambda (self x) x))`);
        expect(run(`(%call (%intcall %table) 7)`)).toBe(7);
    });

    it("hold collectable values weakly with __mode 'v'", async () => {
        const kept = new LuaTable();
        const t = new LuaTable();
        t.metatable = new LuaTable().set("__mode", "v");
        t.set("gone", new LuaTable()).set("kept", kept).set("str", "a string").set(1, new LuaTable()).set(2, 5);
        await collect();
        expect(t.get("gone")).toBeUndefined();
        expect(t.get(1)).toBeUndefined();
        expect([t.get("kept"), t.get("str"), t.get(2)]).toEqual([kept, "a string", 5]);
        expect(dump(t)).not.toContain("gone");
    });

    it("hold collectable keys weakly with __mode 'k', their values strongly", async () => {
        const key = new LuaTable();
        const t = new LuaTable();
        t.metatable = new LuaTable().set("__mode", "k");
        t.set(new LuaTable(), "gone").set(key, "kept").set("s", new LuaTable());
        await collect();
        expect([...t.values()].sort()).toEqual(["kept", expect.any(LuaTable)].sort());
        expect(t.get(key)).toBe("kept");
        // as in Luau (no ephemerons), a value that refers to its key keeps it
        const self = new LuaTable();
        t.set(self, { self });
        await collect();
        expect(t.has(self)).toBe(true);
    });

    it("read __mode whenever the metatable's changes, and hold everything strongly without one", async () => {
        const mt = new LuaTable();
        const t = new LuaTable();
        t.metatable = mt;
        t.set("a", new LuaTable());
        await collect();
        expect(t.has("a")).toBe(true);
        mt.set("__mode", "kv");
        t.set("b", new LuaTable());
        await collect();
        expect([t.has("a"), t.has("b")]).toEqual([false, false]);
        mt.set("__mode", undefined);
        t.set("c", new LuaTable());
        await collect();
        expect(t.has("c")).toBe(true);
    });
});

// what the tables give against what Luau gives, for random writes: run with LUAU set to a Luau binary
describe.skipIf(!process.env.LUAU)("Luau tables against Luau", () => {
    it("give Luau's lengths after every write and the traversal order Luau guarantees", () => {
        let seed = 7;
        const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return (n > 4096 ? seed : Math.floor(seed / 4096)) % n; };
        const strings = ["a", "b", "cc", "name", "x", "a key string that is longer than thirty-two bytes", "another quite long string key used for hashing tests!!"];
        const text = (k: any) => typeof k === "string" ? JSON.stringify(k) : Object.is(k, -0) ? "-0" : String(k);
        const progs = Array.from({ length: 1000 }, () => ({
            narray: rand(3) === 0 ? rand(8) : 0,
            ops: Array.from({ length: 1 + rand(150) }, (): [any, any] => {
                if (rand(80) === 0) return ["CLEAR", 0];
                const r = rand(20);
                const key = r < 12 ? 1 + rand(200) : r < 16 ? strings[rand(strings.length)] : r < 18 ? [0.5 + rand(5), -rand(10), 0, 2147483648 + rand(3), -0.25][rand(5)] : r < 19 ? "s" + rand(300) : rand(2) === 0;
                return [key, rand(4) === 0 ? undefined : rand(100)];
            }),
        }));
        const lua = progs.map(p => [
            `do local t = table.create(${p.narray}) local out = ""`,
            ...p.ops.map(([k, v]) => k === "CLEAR" ? `table.clear(t) out ..= #t .. " "` : `t[${text(k)}] = ${v === undefined ? "nil" : v} out ..= #t .. " "`),
            `print(out) local parts = {} for k, v in pairs(t) do parts[#parts + 1] = tostring(k) .. "=" .. tostring(v) end print(table.concat(parts, ",")) end`,
        ].join("\n"));
        const file = join(mkdtempSync(join(tmpdir(), "luau-")), "tables.luau");
        writeFileSync(file, lua.join("\n"));
        const expected = execFileSync(process.env.LUAU!, [file], { encoding: "utf8", maxBuffer: 1 << 26 }).split("\n");
        const actual = progs.flatMap(p => {
            const t = new LuaTable(p.narray);
            const lens = p.ops.map(([k, v]) => { if (k === "CLEAR") t.clear(); else t.set(k, v); return t.rawlen(); });
            return [lens.join(" ") + " ", [...t.entries()].map(([k, v]) => `${text(k)}=${v}`).join(",").replace(/"/g, "")];
        });
        // Luau guarantees only the order of keys 1..k (up to the first nil); the rest is compared as a set
        const prefix = (line: string) => { const out = []; for (const e of line.split(",")) { if (e !== `${out.length + 1}=${e.split("=")[1]}`) break; out.push(e); } return out; };
        const shape = (line: string, i: number) => i % 2 === 0 ? line : [prefix(line), line.split(",").sort()];
        expect(actual.map(shape)).toEqual(expected.slice(0, actual.length).map(shape));
    });
});
