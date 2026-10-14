import { describe, expect, it } from 'vitest';
import { createLuau, toString } from '../lua';
import { impl, implDebug } from '../magicvm/meta';
import { MultipleValues } from '../common';
import { comparer } from './luau-compare';

const luau = createLuau(impl);

const run = (src: string): string => {
    try {
        const r = luau.evaluateRaw(luau.compileRaw(src, "t"));
        return (r instanceof MultipleValues ? r.values : [r]).map(toString).join("\t");
    } catch (e: any) {
        return "error: " + e.message;
    }
};

// the values here are what Luau's own binary gives (see the comparisons below)
describe("Luau's libraries", () => {
    it("math: what C's library computes, Luau's generator and its noise", () => {
        expect(run(`math.randomseed(42) return string.format("%.17g %.17g", math.random(), math.random()), math.random(10), math.random(10), math.random(-5, 5), math.random(1, 1000000)`))
            .toBe("0.22072993115387124 0.92027372378942629\t6\t8\t1\t523561");
        expect(run(`return string.format("%.17g %.17g %.17g", math.noise(1.3, 2.7, 0.5), math.noise(0.1), math.noise(-10.25, 3.5))`)).toBe("0.53305137157440186 0.091439999639987946 -0.09912109375");
        expect(run("return math.frexp(10)")).toBe("0.625\t4");
        expect(run("return math.ldexp(0.625, 4), math.modf(-3.7)")).toBe("10\t-3\t-0.7000000000000002");
        expect(run("return math.round(-2.5), math.round(2.5), math.fmod(-7, 3), math.sign(-0.1), math.clamp(5, 1, 3), math.log(8, 2)")).toBe("-3\t3\t-1\t-1\t3\t3");
        expect(run("return math.pi, math.huge, math.max(1, 5, 3), math.min('2', 7), math.floor(-0.5), math.abs(-3)")).toBe("3.141592653589793\tinf\t5\t2\t-1\t3");
        expect(run("return pcall(math.floor, 'x')")).toBe("false\tinvalid argument #1 to 'floor' (number expected, got string)");
        expect(run("return pcall(math.clamp, 1, 3, 1)")).toBe("false\tinvalid argument #3 to 'clamp' (max must be greater than or equal to min)");
        expect(run("local ok, e = pcall(function() return math.random(0) end) return e")).toBe("t:1: invalid argument #1 to 'random' (interval is empty)");
    });

    it("table: insert, remove, concat, sort, find, move and the rest", () => {
        expect(run("local t = {5, 2, 8, 1, 9, 3} table.sort(t) return table.concat(t, ','), table.find(t, 8), #table.create(3, 0), table.unpack({1, 2, 3}, 2)")).toBe("1,2,3,5,8,9\t5\t3\t2\t3");
        expect(run("local t = {'b', 'a', 'c'} table.sort(t, function(x, y) return x > y end) table.insert(t, 'z') table.insert(t, 1, 'first') return table.concat(t, ' '), table.remove(t), table.remove(t, 1), #t")).toBe("first c b a z\tz\tfirst\t3");
        expect(run("local t = table.pack(1, nil, 3) return t.n, #t, select('#', unpack(t, 1, t.n))")).toBe("3\t3\t3");
        expect(run("local t = table.move({1, 2, 3}, 1, 3, 2) return table.concat(t, ','), table.maxn({[10] = 1, 2}), table.getn({1, 2})")).toBe("1,1,2,3\t10\t2");
        expect(run("local t = table.freeze({1}) return table.isfrozen(t), pcall(table.insert, t, 2)")).toBe("true\tfalse\tattempt to modify a readonly table");
        expect(run("local c = table.clone({1, x = 2}) table.clear(c) return #c, c.x, unpack == table.unpack")).toBe("0\tnil\tfalse");
        expect(run("return pcall(table.sort, {3, 'a', 1})")).toBe("false\tattempt to compare string < number");
        expect(run("return pcall(table.sort, {1, 2, 3, 4, 5}, function() return true end)")).toBe("false\tinvalid order function for sorting");
        expect(run("return pcall(table.concat, {1, {}, 3})")).toBe("false\tinvalid value (table) at index 2 in table for 'concat'");
        expect(run("local out = '' table.foreachi({'a', 'b'}, function(i, v) out = out .. i .. v end) return out, table.foreach({5}, function(k, v) return v * 2 end)")).toBe("1a2b\t10");
        expect(run("return rawget({7}, 1), rawlen({1, 2}), rawlen('abc'), rawequal('a', 'a'), rawset({}, 1, 2)[1], typeof(1), _VERSION, getmetatable('').__index == string")).toBe("7\t2\t3\ttrue\t2\tnumber\tLuau\ttrue");
        expect(run("return getmetatable(setmetatable({}, {__metatable = 'locked'})), pcall(rawset, table.freeze({}), 1, 2)")).toBe("locked\tfalse\tattempt to modify a readonly table");
    });

    it("bit32, utf8 and os", () => {
        expect(run("return bit32.band(0xff00, 0x0ff0), bit32.arshift(0x80000000, 4), bit32.lrotate(0x80000001, 1), bit32.extract(0xabcd, 4, 8), bit32.replace(0, 0xff, 8, 4), bit32.countlz(1), bit32.byteswap(0x11223344)"))
            .toBe("3840\t4160749568\t3\t188\t3840\t31\t1144201745");
        expect(run("return bit32.bnot(0), bit32.bor(1, 2, 4), bit32.bxor(5, 1), bit32.btest(6, 1), bit32.lshift(1, 31), bit32.rshift(-1, 28), bit32.countrz(8)")).toBe("4294967295\t7\t4\tfalse\t2147483648\t15\t3");
        expect(run("return pcall(bit32.extract, 1, 30, 5)")).toBe("false\ttrying to access non-existent bits");
        expect(run(`return utf8.char(72, 228, 8364, 128512) == "H\\195\\164\\226\\130\\172\\240\\159\\152\\128", utf8.len("h\\195\\169llo"), utf8.codepoint("\\226\\130\\172", 1), utf8.offset("a\\195\\169b", 3), utf8.len("\\255")`)).toBe("true\t5\t8364\t4\tnil\t1");
        expect(run(`local out = '' for p, c in utf8.codes("a\\195\\169\\226\\130\\172") do out = out .. p .. ':' .. c .. ' ' end return out, #utf8.charpattern`)).toBe("1:97 2:233 4:8364 \t14");
        expect(run(`return pcall(utf8.codepoint, "\\195")`)).toBe("false\tinvalid UTF-8 code");
        expect(run("return os.time({year = 2024, month = 2, day = 29, hour = 0}), os.date('!%Y-%m-%d %H:%M:%S %a %j', 1709164800), os.date('!%c', 0), os.difftime(10, 4)"))
            .toBe("1709164800\t2024-02-29 00:00:00 Thu 060\tThu Jan  1 00:00:00 1970\t6");
        expect(run("local t = os.date('!*t', 86400 * 365) return t.year, t.month, t.day, t.wday, t.yday, t.isdst, type(os.clock()), type(os.time())")).toBe("1971\t1\t1\t6\t1\tfalse\tnumber\tnumber");
        expect(run("return pcall(os.time, {year = 2024})")).toBe("false\tfield 'day' missing in date table");
    });

    it("coroutine: create, resume, yield, wrap, status and close", () => {
        expect(run("local co = coroutine.create(function(a) local b = coroutine.yield(a + 1) error('boom ' .. b) end) local r = {coroutine.resume(co, 1)} local s = coroutine.status(co) local ok, e = coroutine.resume(co, 'x') return r[1], r[2], s, ok, e, coroutine.status(co), coroutine.resume(co)"))
            .toBe("true\t2\tsuspended\tfalse\tt:1: boom x\tdead\tfalse\tcannot resume dead coroutine");
        expect(run("local gen = coroutine.wrap(function() for i = 1, 3 do coroutine.yield(i, i * i) end return 'end' end) local out = '' for i = 1, 4 do out = out .. tostring((gen())) .. ' ' end return out, pcall(gen)")).toBe("1 2 3 end \tfalse\tcannot resume dead coroutine");
        expect(run("local t = 0 for v in coroutine.wrap(function() for i = 1, 10 do coroutine.yield(i) end end) do t = t + v end return t, coroutine.running(), coroutine.isyieldable()")).toBe("55\tnil\tfalse");
        expect(run("local c c = coroutine.create(function() return coroutine.status(c), coroutine.running() == c, coroutine.isyieldable(), (coroutine.resume(c)) end) return coroutine.resume(c)")).toBe("true\trunning\ttrue\ttrue\tfalse");
        expect(run("local co = coroutine.create(function() error({code = 7}) end) local ok, e = coroutine.resume(co) local closed, why = coroutine.close(co) return ok, e.code, closed, why == e, coroutine.close(co)")).toBe("false\t7\tfalse\ttrue\ttrue");
        expect(run("local co = coroutine.create(function() local ok, e = pcall(function() coroutine.yield('in pcall') error('after') end) return ok, e end) return coroutine.resume(co), select(2, coroutine.resume(co))")).toBe("true\tfalse\tt:1: after");
        expect(run("return pcall(coroutine.resume, 5)")).toBe("false\tinvalid argument #1 to 'resume' (thread expected, got number)");
        expect(run("local ok, e = pcall(function() local v = coroutine.yield(1) return v end) return ok, e")).toBe("false\tt:1: attempt to yield across metamethod/C-call boundary");
        expect(run("local w = coroutine.wrap(function() error('inner') end) local ok, e = pcall(function()\n local v = w()\n return v end) return e")).toBe("t:2: t:1: inner");
    });

    it("buffer and vector", () => {
        expect(run("local b = buffer.create(8) buffer.writei32(b, 0, -2) buffer.writef32(b, 4, 1.5) return buffer.readu32(b, 0), buffer.readi16(b, 0), buffer.readf32(b, 4), buffer.len(b), buffer.readbits(b, 28, 8)")).toBe("4294967294\t-2\t1.5\t8\t15");
        expect(run("local b = buffer.fromstring('hello') buffer.fill(b, 1, 120, 2) buffer.writestring(b, 3, 'XY') return buffer.tostring(b), buffer.readstring(b, 0, 2), typeof(b)")).toBe("hxxXY\thx\tbuffer");
        expect(run("return pcall(buffer.readi32, buffer.create(3), 0)")).toBe("false\tbuffer access out of bounds");
        expect(run("return pcall(buffer.len, 'x')")).toBe("false\tinvalid argument #1 to 'len' (buffer expected, got string)");
        expect(run("local V = vector.create return vector.cross(V(1, 2, 3), V(4, 5, 6)), vector.dot(V(1, 2, 3), V(4, 5, 6)), vector.magnitude(V(3, 4, 0)), vector.lerp(vector.zero, vector.one, 0.25)")).toBe("-3, 6, -3\t32\t5\t0.25, 0.25, 0.25");
        expect(run("return pcall(vector.dot, vector.one, 1)")).toBe("false\tinvalid argument #2 to 'dot' (vector expected, got number)");
    });

    it("are made without compiling each function, and compiled when first called", () => {
        const a = createLuau(impl);
        const floor = (a.scope.get(Symbol.for("math")) as any).get("floor");
        expect(floor.tmpl.code.resumeFn).toBeNull();
        expect(a.evaluateRaw(a.compileRaw("local function f(x) return math.floor(x) end return f(2.5)", "t"))).toBe(2);
        expect(floor.tmpl.code.resumeFn).not.toBeNull();
        // a tail call of one that fails on its first call is placed where the call is
        const b = createLuau(impl);
        const failing = "local function f()\n  return math.abs()\nend\nlocal ok, e = pcall(f) return e";
        expect(toString(b.evaluateRaw(b.compileRaw(failing, "t")))).toBe("t:2: missing argument #1 to 'abs' (number expected)");
    });
});

describe.skipIf(!process.env.LUAU)("Luau's libraries against Luau", () => {
    let seed = 20261014;
    const rand = (n: number) => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
    const pick = <T,>(xs: readonly T[]): T => xs[rand(xs.length)];
    const uniform = (scale: number) => ((rand(2000001) - 1000000) / 1000000 * scale).toString();
    const shower = (number: string) => `local function s(...) local r = '' for i = 1, select('#', ...) do local v = (select(i, ...)) r = r .. (type(v) == 'number' and string.format('${number}', v) or type(v) == 'string' and string.format('%q', v) or type(v) == 'vector' and string.format('<%.9g %.9g %.9g>', v.x, v.y, v.z) or type(v) == 'buffer' and ('buf' .. string.format('%q', buffer.tostring(v))) or type(v) == 'table' and 'table' or type(v) == 'function' and 'function' or type(v) == 'thread' and 'thread' or tostring(v)) .. ' ' end return r end `;
    const EXACT = shower("%.17g"), CLOSE = shower("%.13g"), SINGLE = shower("%.9g");
    // each call as one program: what it returns, or the error it raises
    const calls = (show: string, list: readonly string[], before = "") => list.map(c => `${show}${before}return s(pcall(function() return ${c} end))`);
    // both ways the code is compiled
    const check = (programs: string[]) => {
        for (const options of [impl, implDebug]) expect(comparer(createLuau(options))(programs).slice(0, 3)).toEqual([]);
    };
    const NUMBERS = ["0", "-0", "1", "-1", "0.5", "-0.5", "1.5", "2.5", "-2.5", "3.7", "-3.7", "1e308", "-1e308", "5e-324", "2.2250738585072014e-308", "1e-310", "math.huge", "-math.huge", "0/0", "2^53", "-2^53+1",
        "123456789.123", "'12'", "'0x10'", "' 3.5 '", "1e15+0.5", "0.49999999999999994", "-0.49999999999999994", "4503599627370497.5", "255", "256", "1024", "3", "10", "100", "7.5", "-7.5"];
    const PAIRS = [["7", "3"], ["-7", "3"], ["7", "-3"], ["-7", "-3"], ["5.5", "2"], ["-5.5", "2"], ["1", "0"], ["0", "0"], ["math.huge", "1"], ["1", "math.huge"], ["0/0", "1"], ["2", "10"], ["2", "0.5"], ["-8", "1/3"],
        ["1", "0/0"], ["-1", "math.huge"], ["0", "-1"], ["-0", "-1"], ["2", "1024"], ["2", "-1075"], ["10", "2"], ["8", "2"], ["100", "10"], ["3", "'2'"], ["1e300", "1e10"]];

    it("computes what Luau's math library does", () => {
        const programs = [
            ...["abs", "ceil", "floor", "sqrt", "sign", "round", "deg", "rad", "isnan", "isinf", "isfinite", "modf", "frexp"].flatMap(fn => calls(EXACT, NUMBERS.map(v => `math.${fn}(${v})`))),
            // (sin, exp, log and the like are the engine's: equal to thirteen digits)
            ...["sin", "cos", "tan", "asin", "acos", "atan", "sinh", "cosh", "tanh", "exp", "log", "log10"].flatMap(fn => calls(CLOSE, NUMBERS.map(v => `math.${fn}(${v})`))),
            ...["fmod", "min", "max"].flatMap(fn => calls(EXACT, PAIRS.map(([a, b]) => `math.${fn}(${a}, ${b})`))),
            ...["pow", "atan2", "log"].flatMap(fn => calls(CLOSE, PAIRS.map(([a, b]) => `math.${fn}(${a}, ${b})`))),
            ...calls(EXACT, ["1", "0.5", "-3", "1e308", "5e-324", "1e-300", "0.75", "math.huge", "0/0", "0", "-0", "1.7976931348623157e308", "2.2250738585072014e-308"].flatMap(v =>
                ["0", "1", "-1", "10", "-10", "1024", "-1074", "2000", "-2000", "1.9", "-1.9", "'3'", "-1022", "-1023", "52", "-52"].map(e => `math.ldexp(${v}, ${e})`))),
            ...calls(EXACT, ["math.min()", "math.max()", "math.min(1)", "math.max(3, 1, 2)", "math.min(3, 1, 2)", "math.min(1, 0/0)", "math.min(0/0, 1)", "math.max(1, 0/0)", "math.min(1, 'x')", "math.min({})", "math.max(1, nil)",
                "math.clamp(5, 1, 3)", "math.clamp(-5, 1, 3)", "math.clamp(1, 3, 1)", "math.clamp(0/0, 1, 3)", "math.clamp(1, 0/0, 3)", "math.clamp(1)", "math.clamp('2', '1', '3')", "math.clamp(-0, 0, 1)",
                "math.map(5, 0, 10, 0, 100)", "math.map(5, 0, 0, 0, 100)", "math.map(1, 2, 3, 4)", "math.lerp(1, 3, 0.5)", "math.lerp(1, 3, 1)", "math.lerp(1e308, -1e308, 0.5)", "math.lerp(1, 2)", "math.lerp(0.1, 0.3, 1/3)",
                "math.pi", "math.huge", "math.nan", "math.e", "math.phi", "math.sqrt2", "math.tau", "math.abs()", "math.abs(nil)", "math.abs({})", "math.abs(true)", "math.abs('x')", "math.floor('1e2')", "math.fmod(1)", "math.pow(2)",
                "math.ldexp(1)", "math.ldexp(1, 'x')", "math.random(0)", "math.random(3, 1)", "math.random(1, 2, 3)", "math.random(-2147483648, 2147483647)", "math.random('x')", "math.randomseed()", "math.noise()", "math.noise('x')",
                "math.noise(1, {})", "math.log(8, 2)", "math.log(100, 10)", "math.log(8, 'x')", "math.noise(0.3)", "math.noise(0.3, 0.6)", "math.noise('1.5', '2.5', '3.5')", "math.noise(1e10 + 0.3, 0.1, 0.2)"]),
            // the generator, from a seed
            ...["0", "1", "42", "-1", "-2147483648", "2147483647", "12345.9", "'77'", "3000000000", "-3000000000"].map(seed => `${EXACT}math.randomseed(${seed}) local out = '' for i = 1, 6 do out = out .. s(math.random()) end
                for i = 1, 6 do out = out .. s(math.random(10)) end for i = 1, 6 do out = out .. s(math.random(-5, 5)) end
                return out .. s(math.random(2147483647), math.random(-2147483648, 2147483646), math.random(1), math.random(7, 7), math.random(1.9), math.random(2.9, 5.9))`),
            // noise, to the last bit
            ...Array.from({ length: 60 }, () => `${EXACT}return s(${Array.from({ length: 25 }, () => { const scale = pick([1, 1, 1, 10, 100, 300, 1e6, 1e12]); return `math.noise(${uniform(scale)}, ${uniform(scale)}, ${uniform(scale)})`; }).join(", ")})`),
        ];
        check(programs);
    }, 240000);

    it("does what Luau's table library and raw functions do", () => {
        const T = "local t = {10, 20, 30, 40, 50} ";
        // (the table after the call is part of what is compared)
        const on = (list: readonly string[], before = T) => list.map(c => `${EXACT}${before}local r = s(pcall(function() return ${c} end)) local shown = '#' .. #t for i = -1, 8 do shown = shown .. ' ' .. tostring(rawget(t, i)) end return r .. shown`);
        const array = (n: number, kind: string) => `{${Array.from({ length: n }, () => kind === "num" ? String(rand(41) - 20) : kind === "flt" ? ((rand(1001) - 500) / 100).toString() : `'${Array.from({ length: rand(5) }, () => pick([..."abcXYZ09_"])).join("")}'`).join(", ")}}`;
        const programs = [
            ...on(["table.insert(t, 60)", "table.insert(t, 1, 5)", "table.insert(t, 3, 25)", "table.insert(t, 6, 60)", "table.insert(t, 7, 70)", "table.insert(t, 0, 'z')", "table.insert(t, -1, 'n')", "table.insert(t)", "table.insert(t, 1, 2, 3)",
                "table.insert(t, 'x', 1)", "table.insert(t, 2.7, 'f')", "table.insert(t, '2', 's')", "table.insert(nil, 1)", "table.insert()", "table.insert(t, nil)", "table.insert(t, 2, nil)",
                "table.remove(t)", "table.remove(t, 1)", "table.remove(t, 3)", "table.remove(t, 5)", "table.remove(t, 6)", "table.remove(t, 0)", "table.remove(t, -1)", "table.remove(t, 'x')", "table.remove(t, '2')", "table.remove(t, 2.9)", "table.remove()", "table.remove(5)",
                "table.concat(t)", "table.concat(t, ', ')", "table.concat(t, '-', 2)", "table.concat(t, '-', 2, 4)", "table.concat(t, '-', 4, 2)", "table.concat(t, '-', 3, 3)", "table.concat(t, '-', 0, 2)", "table.concat(t, '-', 4, 7)", "table.concat(t, 5)", "table.concat(t, {})",
                "table.concat({1, 'a', 2.5, 1e100, -0})", "table.concat({1, {}, 3})", "table.concat({1, true})", "table.concat({}, 'x')", "table.concat()", "table.concat('x')", "table.concat(t, nil, nil, nil)",
                "table.unpack(t)", "unpack(t)", "table.unpack(t, 2)", "table.unpack(t, 2, 4)", "table.unpack(t, 4, 2)", "table.unpack(t, -1, 1)", "table.unpack(t, 5, 7)", "table.unpack(t, '2', '3')", "table.unpack({}, 1, 3)", "table.unpack()", "unpack(5)", "unpack == table.unpack",
                "select('#', table.unpack(t, 1, 7997))", "select('#', table.unpack(t, 1, 7998))", "table.unpack(t, 1, 1e9)", "table.unpack(t, nil, 2)", "table.pack(nil, nil).n", "#table.pack(1, 2, 3)",
                "table.getn(t)", "table.getn()", "table.getn('x')", "table.maxn(t)", "table.maxn({})", "table.maxn({[1.5] = 1, [10] = 2, x = 3, [-5] = 4})", "table.maxn({1, 2, nil, 4})", "table.maxn()",
                "table.find(t, 30)", "table.find(t, 30, 3)", "table.find(t, 30, 4)", "table.find(t, 99)", "table.find(t, nil)", "table.find(t)", "table.find(t, 10, 0)", "table.find({1, 0/0, 3}, 0/0)", "table.find({1, 2, nil, 4}, 4)", "table.find(t, 30, '2')", "table.find(5, 1)",
                "#table.create(3)", "table.create(3, 'x')[3]", "table.create(-1)", "table.create()", "#table.create('2', 7)", "#table.create(2.9, 1)", "table.clear(t)", "table.clear()", "table.clear(5)", "table.isfrozen(t)", "table.isfrozen()",
                "table.freeze(t) == t", "table.isfrozen(table.freeze(t))", "table.freeze(table.freeze(t))", "table.freeze(setmetatable({}, {__metatable = 1}))", "table.clone(setmetatable({}, {__metatable = 1}))", "table.clone(t) == t", "#table.clone(t)",
                "table.isfrozen(table.clone(table.freeze(t)))", "getmetatable(table.clone(setmetatable({1}, {x = 1}))).x", "table.clone()", "table.freeze()",
                "table.move(t, 1, 3, 2) == t", "table.move(t, 2, 5, 1)", "table.move(t, 1, 5, 3)", "#table.move(t, 1, 3, 1, {})", "table.move(t, 3, 1, 1)", "table.move(t, 1, 3, -1)", "table.move(t, 0, 2, 1)", "table.move(t, 1, 2147483647, 2)",
                "table.move(t, -2147483648, 0, 1)", "table.move(t, 1, 2, 2147483647)", "table.move(t)", "table.move(t, 1, 2)", "table.move(t, 1, 2, 3, 5)", "table.move(t, '1', '2', '3')", "#table.move({7, 8, 9}, 1, 3, 1, t)",
                "rawget(t, 2)", "rawget(t)", "rawget(5, 1)", "rawget(t, nil)", "rawset(t, 2, 'x') == t", "rawset(t, nil, 1)", "rawset(t, 0/0, 1)", "rawset(t, 1)", "rawset(t)", "rawset(5, 1, 2)", "rawequal(t, t)", "rawequal(1, 1.0)", "rawequal({}, {})",
                "rawequal(1)", "rawequal()", "rawequal(0/0, 0/0)", "rawlen(t)", "rawlen('abc')", "rawlen(5)", "rawlen()", "getmetatable(t)", "getmetatable('x').__index == string", "getmetatable(5)", "getmetatable()",
                "getmetatable(setmetatable({}, {__metatable = 'locked'}))", "getmetatable('a') == getmetatable('b')", "typeof(t)", "typeof(1)", "typeof(nil)", "typeof()", "typeof(print)", "_VERSION",
                "table.sort(t)", "table.sort()", "table.sort(5)", "table.sort(t, 5)", "table.sort(t, nil)", "table.sort({3, 'a', 1})", "table.sort({{}, {}})", "table.sort({}, 5)",
                "table.foreach(t, function(k, v) if v == 30 then return k * 2 end end)", "table.foreach(t, 5)", "table.foreach(5, print)", "table.foreach()", "table.foreachi(t, function(i, v) if i == 4 then return v, 'second' end end)", "table.foreachi({}, 5)"]),
            ...on(["table.insert(t, 1)", "table.insert(t, 1, 1)", "table.remove(t)", "table.remove(t, 9)", "table.sort(t)", "table.clear(t)", "table.move({1}, 1, 1, 1, t)", "table.move(t, 1, 0, 1, t)", "rawset(t, 1, 2)", "t[1] = 5", "table.concat(t)",
                "table.unpack(t)", "#table.move(t, 1, 2, 1, {})", "setmetatable(t, {})", "table.find(t, 20)"], "local t = table.freeze({10, 20, 30}) "),
            ...["{1, 2, nil, 4}", "{nil, nil, 3}", "{[1] = 'a', [2] = 'b', [4] = 'd'}", "setmetatable({1, 2, 3}, {__index = function() return 9 end})", "{1, 2, 3, [7] = 7}"].flatMap(t =>
                on(["#t", "table.insert(t, 'e')", "table.remove(t)", "table.concat(t, ',')", "table.unpack(t)", "table.maxn(t)", "table.getn(t)", "table.insert(t, 2, 'i')", "table.remove(t, 1)", "#table.clone(t)", "table.find(t, 4)", "table.move(t, 1, 4, 2) == t"], `local t = ${t} `)),
            // sorting: what order it gives, and what it asks an order function, in what order
            ...[0, 1, 2, 3, 4, 5, 7, 8, 16, 33, 64, 100, 257].flatMap(n => ["num", "flt", "str"].flatMap(kind => {
                const a = array(n, kind);
                return [`local t = ${a} table.sort(t) return table.concat(t, ',')`,
                    `local t = ${a} local log = '' table.sort(t, function(a, b) log = log .. tostring(a) .. '<' .. tostring(b) .. ';' return a > b end) return table.concat(t, ',') .. ' # ' .. #log .. ' ' .. string.sub(log, 1, 400)`];
            })),
            ...[5, 20, 100, 300].flatMap(n => ["function(a, b) return true end", "function(a, b) return false end", "function(a, b) return a <= b end", "function(a, b) return a >= b end", "function(a, b) return nil end",
                "function(a, b) return 1 end", "function(a, b) error('in order') end", "function(a, b) return a.x < b end", "function(a, b) return (a % 3) < (b % 3) end"].map(f =>
                `${EXACT}local t = ${array(n, "num")} local r = s(pcall(table.sort, t, ${f})) return r .. table.concat(t, ',')`)),
            `${EXACT}local t = {5, 3, 8, 1} local r = s(pcall(table.sort, t, function(a, b) t[#t + 1] = 0 return a < b end)) return r .. #t`,
            "local t = {} for i = 1, 500 do t[i] = 500 - i end local n = 0 table.sort(t, function(a, b) n = n + 1 return a < b end) return n, t[1], t[500]",
            "local t = {} for i = 1, 300 do t[i] = 1 end local n = 0 table.sort(t, function(a, b) n = n + 1 return a < b end) return n",
            "local out = '' local t = {1, 2, 3} table.foreachi(t, function(i, v) out = out .. i .. v t[i + 1] = nil end) return out, #t",
            "local t = {} for i = 1, 10 do table.insert(t, i) end for i = 1, 5 do table.remove(t, 1) end table.insert(t, 3, 'm') return table.concat(t, ' ')",
            "local t = table.create(4, 0) t[5] = 1 return #t, table.concat(t)", "local t = {1, 2, 3} table.clear(t) t[1] = 'a' return #t, t[1], t[2]",
        ];
        check(programs);
    }, 240000);

    it("does what Luau's bit32 library does", () => {
        const values = ["0", "1", "-1", "2", "255", "256", "65535", "2147483647", "2147483648", "4294967295", "4294967296", "4294967297", "-2147483648", "-2147483649", "1.5", "-1.5", "1e10", "-1e10", "1e19", "-1e19", "9.3e18",
            "math.huge", "-math.huge", "0/0", "'7'", "'0xff'", "0x80000000", "0xdeadbeef", "0x12345678", "3.99", "-0.5", "2^53", "2^63", "-2^63"];
        const shifts = ["0", "1", "-1", "4", "31", "32", "33", "-31", "-32", "-33", "100", "-100", "1.9", "'3'", "2147483647", "-2147483647"];
        const fields = [["0", "1"], ["0", "32"], ["31", "1"], ["4", "8"], ["0", "33"], ["32", "1"], ["-1", "1"], ["0", "0"], ["0", "-1"], ["16", "16"], ["16", "17"], ["3", "nil"], ["1.9", "2.9"], ["'4'", "'4'"], ["31", "2"], ["0", "31"]];
        const programs = [
            ...["bnot", "countlz", "countrz", "byteswap", "band", "bor", "bxor", "btest"].flatMap(fn => calls(EXACT, values.map(v => `bit32.${fn}(${v})`))),
            ...["band", "bor", "bxor", "btest"].flatMap(fn => calls(EXACT, Array.from({ length: 48 }, () => `bit32.${fn}(${Array.from({ length: rand(5) }, () => pick(values)).join(", ")})`))),
            ...["lshift", "rshift", "arshift", "lrotate", "rrotate"].flatMap(fn => calls(EXACT, ["1", "0x80000000", "0xdeadbeef", "-1", "0x12345678", "4294967296", "1.5", "'255'"].flatMap(v => shifts.map(sh => `bit32.${fn}(${v}, ${sh})`)))),
            ...calls(EXACT, ["0xdeadbeef", "0xffffffff", "0", "-1", "0x12345678"].flatMap(v => fields.flatMap(([f, w]) => [`bit32.extract(${v}, ${f}, ${w})`, `bit32.replace(${v}, 0xabcdef, ${f}, ${w})`, `bit32.replace(${v}, -1, ${f}, ${w})`]))),
            ...calls(EXACT, ["bit32.band()", "bit32.bor()", "bit32.bxor()", "bit32.btest()", "bit32.bnot()", "bit32.bnot('x')", "bit32.bnot({})", "bit32.lshift()", "bit32.lshift(1)", "bit32.lshift('x', 'y')", "bit32.rshift(1)", "bit32.arshift()", "bit32.arshift(1)",
                "bit32.lrotate()", "bit32.lrotate(1)", "bit32.lrotate('x')", "bit32.rrotate()", "bit32.extract()", "bit32.extract(1)", "bit32.extract(1, 'x')", "bit32.extract(1, 1, 'x')", "bit32.replace()", "bit32.replace(1)", "bit32.replace(1, 2)",
                "bit32.replace(1, 2, 'x')", "bit32.countlz()", "bit32.countrz('x')", "bit32.byteswap()", "bit32.band(1, 'x')", "bit32.band(1, nil)", "bit32.bor(nil)"]),
        ];
        check(programs);
    }, 240000);

    it("does what Luau's utf8 and os libraries do", () => {
        const strings = ["''", "'a'", "'abc'", "'h\\195\\169llo'", "'\\226\\130\\172x'", "'\\240\\159\\152\\128!'", "'\\255'", "'a\\128b'", "'\\195'", "'\\237\\160\\128'", "'\\244\\144\\128\\128'", "'\\192\\128'", "'\\224\\128\\128'",
            "'\\248\\136\\128\\128\\128'", "'\\0a\\0'", "'\\195\\169\\195\\169\\195\\169'", "12", "'\\254\\191\\191\\191\\191\\191\\191'"];
        const positions = ["", ", 1", ", 2", ", 3", ", -1", ", -2", ", 0", ", 4", ", 5", ", -5", ", 10", ", -10", ", 1.9", ", '2'"];
        const ranges = ["1", "2", "-1"].flatMap(p => ["1", "2", "-1", "0", "5", "-3"].map(q => `, ${p}, ${q}`));
        const times = ["0", "1", "86399", "86400", "951782400", "1582934400", "1709164800", "1735689599", "1735689600", "1760375400", "4102444800", "-1", "-86400", "1e10", "253402300799", "1.9", "'100'", "2^40", "0/0", "math.huge", "1e18"];
        // (not %z: under gmtime, macOS's strftime gives the local zone's offset)
        const formats = ["%Y-%m-%d %H:%M:%S", "%a %A %b %B", "%c", "%x %X", "%j %U %W %w", "%I %p %y", "%%", "%d/%m", "", "%", "%Y%"];
        const date = "local function d(t) if type(t) ~= 'table' then return t end local r = '' for _, k in ipairs({'year', 'month', 'day', 'hour', 'min', 'sec', 'wday', 'yday', 'isdst'}) do r = r .. k .. '=' .. tostring(t[k]) .. ' ' end return r end ";
        const programs = [
            ...strings.flatMap(st => [
                ...calls(EXACT, [...positions, ...ranges].flatMap(p => [`utf8.len(${st}${p})`, `utf8.codepoint(${st}${p})`])),
                ...calls(EXACT, ["0", "1", "2", "3", "-1", "-2", "5", "-5"].map(n => `utf8.offset(${st}, ${n})`)),
                ...calls(EXACT, ["0", "1", "2", "-1", "-2"].flatMap(n => ["1", "2", "3", "-1", "0", "7"].map(p => `utf8.offset(${st}, ${n}, ${p})`))),
                `${EXACT}return s(pcall(function() local out = '' for p, c in utf8.codes(${st}) do out = out .. p .. ':' .. c .. ' ' end return out end))`,
            ]),
            ...calls(EXACT, ["0", "65", "127", "128", "255", "2047", "2048", "8364", "55296", "57343", "65535", "65536", "128512", "1114111", "1114112", "-1", "'97'", "97.9", "nil", "{}"].map(c => `utf8.char(${c})`)),
            ...calls(EXACT, ["utf8.char()", "utf8.char(72, 228, 8364, 128512)", "utf8.char(65, -1)", "utf8.char(65, 'x')", "utf8.charpattern", "utf8.len()", "utf8.len({})", "utf8.codepoint()", "utf8.offset()", "utf8.offset('a')", "utf8.offset('a', 'x')",
                "utf8.codes()", "utf8.codes(5)", "utf8.codes({})", "select('#', utf8.codes('a'))", "select(2, utf8.codes(12))", "select(3, utf8.codes('a'))", "(utf8.codes('ab'))('ab', 1)", "(utf8.codes('ab'))('ab', 2)", "(utf8.codes('ab'))('ab')",
                "(utf8.codes('ab'))()", "(utf8.codes('ab'))('ab', 'x')", "(utf8.codes('ab'))({}, 1)", "select('#', utf8.codepoint(string.rep('a', 9000), 1, 7997))", "select('#', utf8.codepoint(string.rep('a', 9000), 1, 7998))",
                "string.match('h\\195\\169!', utf8.charpattern, 2)"]),
            ...times.flatMap(t => [...calls(EXACT, formats.map(f => `os.date('!${f}', ${t})`)), `${EXACT}${date}return s(pcall(function() return d(os.date('!*t', ${t})) end))`]),
            ...Array.from({ length: 24 }, (_, i) => 1970 + 3 * i).flatMap(y => [[1, 1], [1, 2], [1, 7], [2, 28], [3, 1], [6, 15], [12, 31]].flatMap(([m, d]) =>
                calls(EXACT, [`os.date('!%Y-%m-%d %a %j %U %W %w %c', os.time({year = ${y}, month = ${m}, day = ${d}}))`, `os.time({year = ${y}, month = ${m}, day = ${d}, hour = 0})`]))),
            ...calls(EXACT, ["{year = 2024, month = 2, day = 29}", "{year = 2024, month = 2, day = 30}", "{year = 2024, month = 13, day = 1}", "{year = 2024, month = 0, day = 1}", "{year = 2024, month = -11, day = 1}", "{year = 1969, month = 12, day = 31}",
                "{year = 1970, month = 1, day = 1, hour = 0}", "{year = 1970, month = 1, day = 1, hour = 0, sec = -1}", "{year = 2024, month = 1}", "{year = 2024, day = 1}", "{month = 1, day = 1}", "{}", "{year = '2024', month = '3', day = '5.9'}",
                "{year = 2024.9, month = 3.9, day = 5.9, hour = 25, min = 61, sec = 61}", "{year = 2024, month = 3, day = 5, isdst = true}", "{year = 2024, month = 3, day = 0}", "{year = 3000, month = 1, day = 1}",
                "{year = 2024, month = 3, day = 5, hour = 'x'}", "{year = true, month = 1, day = 1}"].map(t => `os.time(${t})`)),
            ...calls(EXACT, ["os.time(5)", "os.time('x')", "type(os.time())", "type(os.clock())", "os.difftime(10, 4)", "os.difftime(10)", "os.difftime()", "os.difftime(10.9, 4.2)", "os.difftime('7', '2')", "os.difftime(1, 'x')", "os.date('%Q')", "os.date('!%Q', 0)",
                "os.date('!%E', 0)", "os.date(5, 0)", "os.date({}, 0)", "os.date('!%Y', 'x')", "type(os.date())", "os.date('*t', -1)", "os.date('%Y', -1)", "os.date('!*t', 0).isdst", "os.date('!abc', 0)"]),
            // the host's own zone, which is Luau's here
            ...["0", "1e9", "1710054000", "1710057600", "1730613600", "1730620800", "1760375400"].flatMap(t => [...calls(EXACT, ["%Y-%m-%d %H:%M:%S", "%c", "%z", "%j %U %W %w %a", "%x %X %p %I"].map(f => `os.date('${f}', ${t})`)),
                `${EXACT}${date}return s(pcall(function() return d(os.date('*t', ${t})) end))`]),
        ];
        check(programs);
    }, 240000);

    it("runs coroutines as Luau does", () => {
        const programs = [
            "local co = coroutine.create(function(a) local b = coroutine.yield(a + 1) error('boom ' .. b) end) return s(coroutine.resume(co, 1)) .. s(coroutine.status(co)) .. s(coroutine.resume(co, 'x')) .. s(coroutine.status(co)) .. s(coroutine.resume(co)) .. s(coroutine.close(co)) .. s(coroutine.close(co))",
            "local w = coroutine.wrap(function() error('inner') end) return s(pcall(w)) .. s(pcall(w))",
            "local w = coroutine.wrap(function() error('inner') end) return s(pcall(function() local x = w() return x end)) .. s(pcall(function() local x = w() return x end))",
            "local w = coroutine.wrap(function() error({}) end) return s(pcall(w))",
            "local w = coroutine.wrap(function() error(42, 0) end) local ok, e = pcall(function() local x = w() return x end) return s(ok, e, type(e))",
            "local w = coroutine.wrap(function() local t = nil return t.x end) local ok, e = pcall(function()\n local x = w()\n return x end) return s(ok, e)",
            "return s(pcall(coroutine.resume)) .. s(pcall(coroutine.resume, 5)) .. s(pcall(coroutine.create)) .. s(pcall(coroutine.create, 5)) .. s(pcall(coroutine.wrap, {})) .. s(pcall(coroutine.status)) .. s(pcall(coroutine.close, nil)) .. s(pcall(coroutine.status, 'x')) .. s(pcall(coroutine.wrap))",
            "return s(pcall(coroutine.close, coroutine.create(print)))",
            "local c2 c2 = coroutine.create(function() return s(coroutine.status(c2)) .. s(coroutine.resume(c2)) .. s(pcall(coroutine.close, c2)) .. s(coroutine.running() == c2, coroutine.isyieldable()) end) return s(coroutine.resume(c2)) .. s(coroutine.status(c2))",
            "local co = coroutine.create(function(...) local n = select('#', ...) local a, b = coroutine.yield(n, ...) local c = coroutine.yield() return a, b, c, 'done' end) return s(coroutine.resume(co, 1, nil, 3)) .. s(coroutine.resume(co, 'a', 'b', 'x')) .. s(coroutine.resume(co)) .. s(coroutine.resume(co)) .. s(coroutine.status(co))",
            "local gen = coroutine.wrap(function() for i = 1, 4 do coroutine.yield(i, i * i) end return 'end' end) local out = '' for i = 1, 5 do out = out .. s(gen()) end return out .. s(pcall(gen))",
            "local function range(n) return coroutine.wrap(function() for i = 1, n do coroutine.yield(i) end end) end local t = 0 for v in range(10) do t = t + v end return t",
            "local a, b a = coroutine.create(function() local r = s(coroutine.status(a), coroutine.status(b)) coroutine.yield(r) end) b = coroutine.create(function() local ok, r = coroutine.resume(a) coroutine.yield(r .. s(coroutine.status(a), coroutine.status(b))) end) return s(coroutine.resume(b)) .. s(coroutine.status(a), coroutine.status(b))",
            "local a, b a = coroutine.create(function() return s(coroutine.resume(b)) .. s(pcall(coroutine.close, b)) end) b = coroutine.create(function() return s(coroutine.resume(a)) end) return s(coroutine.resume(b))",
            "local co = coroutine.create(function() coroutine.yield(1) end) coroutine.resume(co) return s(coroutine.close(co)) .. s(coroutine.status(co)) .. s(coroutine.resume(co)) .. s(coroutine.close(co))",
            "local co = coroutine.create(function() error({code = 7}) end) local ok, e = coroutine.resume(co) local ok2, e2 = coroutine.close(co) return s(ok, type(e), e.code, ok2, e == e2) .. s(coroutine.close(co))",
            "local co = coroutine.create(function() local ok, e = pcall(function() coroutine.yield('in pcall') error('after') end) coroutine.yield(tostring(ok) .. tostring(e)) return 'fin' end) return s(coroutine.resume(co)) .. s(coroutine.resume(co)) .. s(coroutine.resume(co)) .. s(coroutine.resume(co))",
            "local co = coroutine.create(function() local ok, e = xpcall(function() coroutine.yield('y') return 'r' end, function(m) return 'h' .. m end) return ok, e end) return s(coroutine.resume(co)) .. s(coroutine.resume(co))",
            "local log = '' local co = coroutine.wrap(function() for k, v in ipairs({10, 20, 30}) do log = log .. k coroutine.yield(v) end end) return s(co(), co(), co(), co()) .. log",
            "local co = coroutine.create(function() local t = {} for i = 1, 3 do t[i] = coroutine.yield(i) end return table.concat(t, ',') end) local out = s(coroutine.resume(co)) for i = 1, 3 do out = out .. s(coroutine.resume(co, 'v' .. i)) end return out",
            "local co = coroutine.create(coroutine.yield) return s(coroutine.resume(co, 1, 2)) .. s(coroutine.resume(co, 3, 4)) .. s(coroutine.status(co))",
            "local co = coroutine.create(pcall) return s(coroutine.resume(co, error, 'e')) .. s(coroutine.status(co))",
            "local co = coroutine.wrap(function(...) return ... end) return s(co(1, 2, 3)) .. s(pcall(co))",
            "local function nest(n) if n == 0 then return 'bottom' end return coroutine.wrap(function() return nest(n - 1) end)() end return nest(50)",
            "local co = coroutine.create(function(a) return a end) return s(type(co), typeof(co), tostring(co) == tostring(co), co == co, rawequal(co, co), ({[co] = 1})[co])",
            "local t = setmetatable({}, {__call = function() return 1 end}) return s(pcall(coroutine.create, t)) .. s(pcall(coroutine.wrap, t))",
            "local co = coroutine.wrap(function() coroutine.yield() end) co() co() return s(pcall(function() local v = co() return v end))",
            "local f = coroutine.wrap(function() return coroutine.isyieldable(), coroutine.running() ~= nil end) return s(f())",
            "local co = coroutine.create(function() coroutine.yield() end) return s(coroutine.resume(co, 1, 2, 3)) .. s(coroutine.resume(co, 4, 5)) .. s(coroutine.resume(co, 6))",
        ].map(p => EXACT + p);
        check(programs);
    }, 240000);

    it("does what Luau's buffer and vector libraries do", () => {
        const B = "local b = buffer.fromstring('\\1\\2\\3\\4\\250\\251\\252\\253\\0\\128\\255\\127') ";
        const offsets = ["0", "1", "4", "8", "11", "12", "-1", "100", "1.9", "'2'", "nil", "{}"];
        const values = ["0", "1", "-1", "255", "256", "65535", "65536", "-32769", "2147483648", "4294967295", "4294967296", "-2147483649", "1.5", "-1.5", "1e20", "-1e20", "0/0", "math.huge", "'7'", "nil", "{}", "3.14159", "1e-40", "1e40"];
        const after = (fn: string, argsList: readonly string[], before = "") => calls(EXACT, argsList.map(a => `(function() ${before}buffer.${fn}(b, ${a}) return b end)()`), B);
        const vs = ["V(1, 2, 3)", "V(-1.5, 0, 2.5)", "V(0, 0, 0)", "V(1e20, -1e20, 0.1)", "V(0/0, 1, math.huge)", "V(3, 4)", "vector.zero", "vector.one", "V(-0, 0.5, -0.5)"];
        const VV = "local V = vector.create ";
        const random = () => { const scale = pick([1, 1, 10, 1000, 1e10, 1e-5, 1e20]); return `V(${uniform(scale)}, ${uniform(scale)}, ${uniform(scale)})`; };
        const programs = [
            ...["readi8", "readu8", "readi16", "readu16", "readi32", "readu32", "readf32", "readf64"].flatMap(fn => calls(EXACT, [...offsets.map(o => `buffer.${fn}(b, ${o})`), `buffer.${fn}()`, `buffer.${fn}(5, 0)`, `buffer.${fn}(b)`], B)),
            ...["writei8", "writeu8", "writei16", "writeu16", "writei32", "writeu32", "writef32", "writef64"].flatMap(fn => [
                ...after(fn, values.map(v => `2, ${v}`)), ...calls(EXACT, [...offsets.map(o => `buffer.${fn}(b, ${o}, 1)`), `buffer.${fn}()`, `buffer.${fn}(b)`, `buffer.${fn}(b, 0)`, `buffer.${fn}({}, 0, 0)`, `select('#', buffer.${fn}(b, 0, 0))`], B)]),
            ...calls(EXACT, ["buffer.create(0)", "buffer.create(3)", "buffer.create(-1)", "buffer.create(1.9)", "buffer.create('2')", "buffer.create()", "buffer.create({})", "buffer.fromstring('')", "buffer.fromstring('abc')", "buffer.fromstring(12)",
                "buffer.fromstring()", "buffer.fromstring({})", "buffer.tostring(b)", "buffer.tostring()", "buffer.tostring('x')", "buffer.len(b)", "buffer.len()", "buffer.len(5)", "type(b)", "typeof(b)", "b == b",
                "buffer.readstring(b, 0, 4)", "buffer.readstring(b, 8, 4)", "buffer.readstring(b, 8, 5)", "buffer.readstring(b, 12, 0)", "buffer.readstring(b, 13, 0)", "buffer.readstring(b, 0, -1)", "buffer.readstring(b, -1, 1)", "buffer.readstring(b, 0)",
                "buffer.readstring(b)", "buffer.readstring(b, 'x', 1)", "buffer.readstring(b, 0, 'x')", "buffer.readstring(b, 1.9, 2.9)"], B),
            ...after("writestring", ["0, 'xy'", "10, 'xy'", "11, 'xy'", "0, 'xyz', 2", "0, 'xyz', 0", "0, 'xyz', 4", "0, 'xyz', -1", "-1, 'x'", "0, 12", "0", "0, {}", "'1', 'q', '1'", "12, ''", "13, ''"]),
            ...after("fill", ["0, 7", "4, 9", "4, 9, 2", "4, 9, 0", "4, 9, 8", "4, 9, 9", "12, 1", "13, 1", "-1, 1", "0, 300", "0, -1", "0, 1.9", "0, 1, -1", "0", "0, 'x'", "'2', '65', '3'"]),
            ...after("copy", ["0, c", "4, c", "5, c", "0, c, 2", "0, c, 2, 3", "0, c, 8", "0, c, 9", "0, c, 0, 9", "0, c, -1", "0, c, 0, -1", "-1, c", "0, b", "2, b, 0, 4", "0, b, 2, 4", "0", "0, 5", "'1', c, '1', '2'", "12, c, 8", "13, c, 8, 0"], "local c = buffer.fromstring('ABCDEFGH') "),
            ...calls(EXACT, [["0", "8"], ["0", "32"], ["4", "12"], ["7", "1"], ["60", "32"], ["64", "32"], ["65", "32"], ["96", "0"], ["97", "0"], ["-1", "1"], ["0", "33"], ["0", "-1"], ["0", "0"], ["3.9", "4.9"], ["'8'", "'8'"], ["1e20", "1"], ["0", "nil"], ["nil", "1"]].map(([o, n]) => `buffer.readbits(b, ${o}, ${n})`), B),
            ...after("writebits", ["0, 8, 255", "4, 12, 0xabc", "7, 1, 1", "60, 32, 0xdeadbeef", "64, 32, -1", "65, 32, 1", "0, 33, 1", "0, 0, 255", "3, 5, 0x1f", "90, 6, 0x3f", "0, 4", "0", "-1, 1, 1", "0, 8, 'x'", "0, 8, 1e20", "'8', '8', '170'"]),
            ...["magnitude", "normalize", "floor", "ceil", "abs", "sign"].flatMap(fn => calls(SINGLE, [...vs.map(v => `vector.${fn}(${v})`), `vector.${fn}()`, `vector.${fn}(5)`, `vector.${fn}('x')`], VV)),
            ...["cross", "dot", "angle", "min", "max"].flatMap(fn => calls(SINGLE, [...vs.slice(0, 5).flatMap(a => vs.slice(1, 4).map(b => `vector.${fn}(${a}, ${b})`)), `vector.${fn}()`, `vector.${fn}(V(1,2,3))`, `vector.${fn}(V(1,2,3), 5)`, `vector.${fn}(5, V(1,2,3))`], VV)),
            ...calls(SINGLE, ["vector.create(1, 2, 3)", "vector.create(1, 2)", "vector.create(1)", "vector.create()", "vector.create('1', '2', '3')", "vector.create(1, 2, 'x')", "vector.create(1, 'x')", "vector.create(1, 2, nil)", "vector.create(1, 2, 3, 4)",
                "vector.create(0.1, 1e40, -1e-50)", "vector.zero", "vector.one", "type(vector.zero)", "tostring(V(1, 2.5, -3))", "V(1,2,3) == V(1,2,3)", "vector.angle(V(1,0,0), V(0,1,0), V(0,0,-1))", "vector.angle(V(1,0,0), V(0,1,0), 5)",
                "vector.clamp(V(5,-5,0.5), V(0,0,0), V(1,1,1))", "vector.clamp(V(5,-5,0.5), V(1,0,0), V(0,1,1))", "vector.clamp(V(5,-5,0.5), V(0,1,0), V(1,0,1))", "vector.clamp(V(5,-5,0.5), V(0,0,1), V(1,1,0))", "vector.clamp(V(1,1,1))", "vector.clamp(1, 2, 3)",
                "vector.min(V(1,5,3), V(2,4,6), V(0,9,9))", "vector.max(V(1,5,3), V(2,4,6), V(0,9,9))", "vector.min(V(1,5,3))", "vector.max(V(1,5,3), V(2,4,6), 5)", "vector.lerp(V(0,0,0), V(10,20,30), 0.25)", "vector.lerp(V(1,2,3), V(4,5,6), 2)",
                "vector.lerp(V(1,2,3), V(4,5,6))", "vector.lerp(V(1,2,3), V(4,5,6), 'x')", "vector.lerp(V(1,2,3), 5, 1)", "vector.lerp(V(0.1,0.2,0.3), V(0.7,0.8,0.9), 1/3)"], VV),
            // to the last bit of a single
            ...["cross", "dot", "angle", "lerp", "magnitude", "normalize"].flatMap(fn => Array.from({ length: 12 }, () => `${SINGLE}${VV}return s(${Array.from({ length: 20 }, (_, k) =>
                fn === "lerp" ? `vector.lerp(${random()}, ${random()}, ${uniform(2)})` : fn === "magnitude" || fn === "normalize" ? `vector.${fn}(${random()})` : fn === "angle" && k % 3 === 0 ? `vector.angle(${random()}, ${random()}, ${random()})` : `vector.${fn}(${random()}, ${random()})`).join(", ")})`)),
        ];
        check(programs);
    }, 240000);
});
