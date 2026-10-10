import { describe, expect, it } from 'vitest';
import { MultipleValues } from '../common';
import { createLuau, toString } from '../lua';
import { comparer, lit } from './luau-compare';
import { PortMatcher, capturesOf, matcherOf, usesRegExp, type Matcher } from '../lua/matcher';
import { impl } from '../magicvm/meta';

const luau = createLuau(impl);

// what the chunk returns, as Luau's tostring writes each value, tab-separated; or its error's message
const run = (src: string): string => {
    try {
        const r = luau.evaluateRaw(luau.compileRaw(src, "t"));
        return (r instanceof MultipleValues ? r.values : [r]).map(toString).join("\t");
    } catch (e: any) {
        return "error: " + e.message;
    }
};

// what a matcher finds, or the error it raises, as text
const outcome = (m: Matcher, src: string, from: number, anchored: boolean): string => {
    try {
        const found = m.find(src, from, anchored);
        return found === null ? "none" : `${found.start}-${found.end} ${JSON.stringify(capturesOf(found, false))}`;
    } catch (e: any) {
        return "error: " + e.message;
    }
};

let seed = 12345;
const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 4096) % n; };
const pick = <T,>(xs: readonly T[]): T => xs[rand(xs.length)];

// a random pattern, some of them malformed, and a subject for it
const items = ["a", "b", "c", ".", "%a", "%d", "%s", "%w", "%A", "%S", "%p", "%x", "%.", "%%", "%-", "[ab]", "[^a]", "[a-c]", "[%d_]", "[%a-]", "[]]", "[^]b]", "[a%]]", "[c-a]", "[%w%s]", "1", " ", "-", "_", "\0", "%z", "x"];
const suffixes = ["", "", "", "*", "+", "-", "?"];
const piece = (depth: number): string => {
    const r = rand(20);
    if (r < 12) return pick(items) + pick(suffixes);
    if (r < 15 && depth > 0) return `(${Array.from({ length: 1 + rand(3) }, () => piece(depth - 1)).join("")})`;
    if (r === 15) return "()";
    if (r === 16) return pick(["%1", "%2", "%f[%w]", "%f[%s]", "%f[^%z]", "%f[%z]", "%f[a]"]);
    if (r === 17) return pick(["$", "^", "(", ")", "%", "[", "%b()", "%bab", "%f", "%0", "*", "+", "?"]);
    return pick(items);
};
const pattern = () => Array.from({ length: 1 + rand(5) }, () => piece(2)).join("") + (rand(6) === 0 ? "$" : "");
const subject = () => Array.from({ length: rand(12) }, () => pick(["a", "b", "c", "1", "2", " ", ".", "-", "_", "(", ")", "%", "x", "\0", "A", "\n", "]"])).join("");

describe("Lua patterns", () => {
    it("are matched by a RegExp where one gives what Luau's matcher gives, by the matcher's port otherwise", () => {
        expect(["a+b", "(%d+)%.(%d*)", "[%a_][%w_]*", "%f[%w]%w+", "(.)%1", "x-y", "^abc", "a$", "()a()"].map(p => usesRegExp(p))).toEqual(Array(9).fill(true));
        // balanced matches, what is malformed, a reference to a capture that is open or a position
        expect(["%b()", "a(", "a)", "%", "[a", "%f", "%1", "(a%1)", "()%1", "a%0"].map(p => usesRegExp(p))).toEqual(Array(10).fill(false));
        expect(usesRegExp("a?".repeat(160))).toBe(false);
    });

    it("find the same match either way", () => {
        let viaRegExp = 0, total = 0;
        const wrong: string[] = [];
        for (let i = 0; i < 6000; i++) {
            const pat = pattern();
            if (usesRegExp(pat)) viaRegExp++;
            const fast = matcherOf(pat), port = new PortMatcher(pat, 0);
            for (let j = 0; j < 4; j++) {
                const src = subject(), from = rand(src.length + 1), anchored = rand(3) === 0;
                const a = outcome(fast, src, from, anchored), b = outcome(port, src, from, anchored);
                total++;
                if (a !== b) wrong.push(`${JSON.stringify(pat)} on ${JSON.stringify(src)} from ${from}${anchored ? " anchored" : ""}: ${a} but Luau's matcher ${b}`);
            }
        }
        expect(wrong.slice(0, 5)).toEqual([]);
        // most patterns are a RegExp's, and the rest are tried too
        expect(viaRegExp).toBeGreaterThan(2000);
        expect(viaRegExp).toBeLessThan(5500);
        expect(total).toBe(24000);
    });
});

// the expected values are what Luau gives
describe("Luau's string library", () => {
    it("measures, cuts and changes strings", () => {
        expect(run("return string.len('hello'), ('abc'):upper(), ('ABC'):lower(), ('abc'):rep(3), ('abc'):reverse(), ('hello'):sub(2, 4), ('hello'):sub(-3), ('hello'):sub(2)"))
            .toBe("5\tABC\tabc\tabcabcabc\tcba\tell\tllo\tello");
        expect(run("return ('hello'):byte(), ('hello'):byte(2, 4), string.char(72, 105), ('x'):byte(5)")).toBe("104\t101\tHi");
        expect(run("return string.rep('ab', 0), string.rep('ab', -1), string.rep('', 5), ('x'):rep(3)")).toBe("\t\t\txxx");
        expect(run("return ('abc'):find('b', 10), ('abc'):find('', 4), ('abc'):find('', 5), ('abc'):sub(0), ('abc'):sub(5), ('abc'):sub(-100, 100)")).toBe("nil\t4\tnil\tabc\t\tabc");
        expect(run("local t = string.split('a,b,,c', ',') return #t, t[3], #string.split('abc', ''), string.split('a b')[1], #string.split('')")).toBe("4\t\t3\ta b\t1");
        // a number is a string where one is wanted; only the 26 letters change case
        expect(run("return string.len(12.5), string.upper('a\\255z')")).toBe("4\tA\xffZ");
    });

    it("finds and replaces by pattern", () => {
        expect(run("return string.find('hello world', 'o w'), string.find('hello', 'l+'), string.find('hello', 'xyz'), string.find('a.b', '.', 1, true), string.find('hello', '(l)(l)')"))
            .toBe("5\t3\tnil\t2\t3\t4\tl\tl");
        expect(run("return string.match('key = value', '(%w+)%s*=%s*(%w+)'), string.match('2024-01-15', '%d+'), string.match('abc', '()b()'), string.match('abc', 'x')")).toBe("key\t2024\t2\tnil");
        expect(run("return string.match('  trim  ', '^%s*(.-)%s*$'), string.match('THE (quick) fox', '%((%a+)%)'), string.find('a+b', '+', 1, true)")).toBe("trim\tquick\t2\t2");
        expect(run("local out = '' for w in string.gmatch('one two  three', '%a+') do out = out .. w .. ',' end return out")).toBe("one,two,three,");
        expect(run("local out = '' for k, v in ('a=1, b=2'):gmatch('(%w+)=(%w+)') do out = out .. k .. v end return out")).toBe("a1b2");
        expect(run("return string.gsub('hello world', 'o', '0'), string.gsub('hello', 'l', 'L', 1), string.gsub('abc', '%w', '%0%0'), string.gsub('hello world', '(%w+) (%w+)', '%2 %1')"))
            .toBe("hell0 w0rld\theLlo\taabbcc\tworld hello\t1");
        expect(run("return string.gsub('hello', '^h', 'J'), string.gsub('abc', 'b*', 'x'), string.gsub('abc', '%w*', 'x')")).toBe("Jello\txaxxcx\txx\t2");
        // a table or a function gives the replacement; nil or false keeps the match
        expect(run("return string.gsub('abc', '%w', {a = 'x', c = false}), string.gsub('abc', '.', function(c) if c ~= 'b' then return c:upper() .. '.' end end)")).toBe("xbc\tA.bC.\t3");
        expect(run("return string.match('hello world from lua', '%f[%w]%w+%f[%W]'), string.gsub('THE (quick) fox', '%f[%a]%a+', string.lower), string.match('x(a(b)c)y', '%b()')"))
            .toBe("hello\tthe (quick) fox\t(a(b)c)");
    });

    it("formats as C's printf does", () => {
        expect(run("return string.format('%d %5d %-5d| %05d %+d %x %X %o %c', 42, 42, 42, 42, 42, 255, 255, 8, 65)")).toBe("42    42 42   | 00042 +42 ff FF 10 A");
        expect(run("return string.format('%f %.2f %10.3f %-10.1f| %e %.3E %g %g %g %G', 3.14159, 3.14159, 3.14159, 3.14159, 12345.678, 0.00012345, 100000, 1e20, 0.0001, 1e-10)"))
            .toBe("3.141590 3.14      3.142 3.1       | 1.234568e+04 1.234E-04 100000 1e+20 0.0001 1E-10");
        expect(run("return string.format('%s %10s %-10s| %.2s %q %%', 'hi', 'hi', 'hi', 'hello', 'a\"b\\n\\0c')")).toBe('hi         hi hi        | he "a\\"b\\\n\\000c" %');
        // a tie rounds to even
        expect(run("return string.format('%.0f %.0f %.0f %.0f %.1f %.2f', 0.5, 1.5, 2.5, 3.5, 0.25, 1.005)")).toBe("0 2 2 4 0.2 1.00");
        expect(run("return string.format('%5.1f|%-8.3e|%+.2g|% d|%#x|%#o|%.3d|%5s|%05.1f', 3.14159, 1234.5, 0.000123, 5, 255, 8, 7, 'ab', 2.5)")).toBe("  3.1|1.234e+03|+0.00012| 5|0xff|010|007|   ab|002.5");
        expect(run("return string.format('%*, %*, %*, %*', 1, nil, true, 'x'), string.format('%g %g %g', 1/0, -1/0, 0/0)")).toBe("1, nil, true, x\tinf -inf nan");
        expect(run("return ('%d'):format(3.7), ('%d'):format(-3.7), ('%x'):format(-1), ('%u'):format(-1), ('%5.2s|'):format('abc')")).toBe("3\t-3\tffffffffffffffff\t18446744073709551615\t   ab|");
    });

    it("interpolates strings through string.format", () => {
        expect(run("local x, y = 5, 'str' return `x is {x}, y is {y}, sum {x + 1}`, `plain`, `100%`, `{x}{y}`, `{'lit'} {1}{2}`")).toBe("x is 5, y is str, sum 6\tplain\t100%\t5str\tlit 12");
        expect(run("local function two() return 1, 2 end return `{two()}|{nil}|{true}`")).toBe("1|nil|true");
    });

    it("reports Luau's errors, where the function was called", () => {
        expect(run("return string.format('%d', 'x')")).toBe("error: t:1: invalid argument #2 to 'format' (number expected, got string)");
        expect(run("return string.format('%d')")).toBe("error: t:1: missing argument #2");
        expect(run("return string.format('%y', 1)")).toBe("error: t:1: invalid option '%y' to 'format'");
        expect(run("return string.upper()")).toBe("error: t:1: missing argument #1 to 'upper' (string expected)");
        expect(run("local s = 5\nreturn s:rep(2)")).toBe("error: t:2: attempt to index number with 'rep'");
        expect(run("return string.find('abc', '[a'), 1")).toBe("error: t:1: malformed pattern (missing ']')");
        expect(run("return string.find('abc', '%'), 1")).toBe("error: t:1: malformed pattern (ends with '%')");
        expect(run("return string.gsub('abc', 'b', '%2')")).toBe("error: t:1: invalid capture index");
        expect(run("return string.gsub('abc', 'b', '%')")).toBe("error: t:1: invalid use of '%' in replacement string");
        expect(run("return string.gsub('abc', 'b', nil)")).toBe("error: t:1: invalid argument #3 to 'gsub' (string/function/table expected, got nil)");
        expect(run("return string.gsub('abc', '%w', {b = true})")).toBe("error: t:1: invalid replacement value (a boolean)");
    });
});

describe.skipIf(!process.env.LUAU)("Luau's string library against Luau", () => {
    const compare = comparer(luau);
    const strings = ["", "a", "hello", "Hello World", "a,b,,c", "  x  ", "%d", "\0a\0", "abcabc", "x".repeat(40), "\xff\xe9Z", ",", "ab"];
    const numbers = ["0", "1", "2", "3", "5", "10", "-1", "-2", "-5", "1.5", "2.9", "-0.5", "100", "2147483648", "-2147483649", "1e10", "0/0", "1/0", "-1/0", "'3'", "' 2 '"];
    const others = ["nil", "true", "{}", "string.len", "'x'"];
    const arg = (kind: "s" | "n"): string => {
        const r = rand(12);
        if (r === 0) return pick(others);
        if (r === 1) return kind === "s" ? pick(numbers) : lit(pick(strings));
        return kind === "s" ? lit(pick(strings)) : pick(numbers);
    };

    it("measures, cuts and changes strings as Luau does", () => {
        const shapes: [string, string][] = [["len", "s"], ["upper", "s"], ["lower", "s"], ["reverse", "s"], ["sub", "snn"], ["sub", "sn"], ["rep", "sn"], ["byte", "s"], ["byte", "sn"], ["byte", "snn"],
            ["char", "n"], ["char", "nnn"], ["split", "s"], ["split", "ss"], ["find", "ss"], ["find", "ssn"], ["len", ""], ["sub", "s"]];
        const programs = Array.from({ length: 3000 }, () => {
            const [name, kinds] = pick(shapes);
            let args = [...kinds].map(k => arg(k as "s" | "n"));
            if (name === "rep") args[1] = pick(["0", "1", "2", "3", "-1", "1.9", "'2'", "nil", "0/0", "100"]);
            // (a plain find: patterns have a test of their own)
            if (name === "find") args = [args[0], args[1], args[2] ?? "1", "true"];
            const call = `string.${name}(${args.join(", ")})`;
            return name === "split" ? `local t = ${call} return #t, t[1], t[2], t[#t]` : `return ${call}`;
        });
        expect(compare(programs).slice(0, 3)).toEqual([]);
    }, 60000);

    it("matches patterns as Luau does", () => {
        const replacements = ["'x'", "''", "'%0%0'", "'[%1]'", "'%2'", "'%%'", "'%'", "5", "{a = 'A', b = 1, [1] = 'one'}", "function(a, b) return (a or '') .. '!' end", "function(a) return nil end", "function(a) return 7 end", "true"];
        const programs = Array.from({ length: 4000 }, () => {
            const p = lit(pattern()), s = lit(subject());
            switch (rand(6)) {
                case 0: return `return string.find(${s}, ${p}${rand(3) === 0 ? ", " + pick(["1", "2", "0", "-1", "-3", "20"]) : ""})`;
                case 1: return `return string.match(${s}, ${p}${rand(4) === 0 ? ", " + pick(["2", "-2", "5"]) : ""})`;
                case 2: return `local n, first, last = 0 for a, b in string.gmatch(${s}, ${p}) do n = n + 1 first = first or a last = b or a if n > 20 then break end end return n, first, last`;
                case 3: return `return string.gsub(${s}, ${p}, ${pick(replacements)}${rand(4) === 0 ? ", " + pick(["0", "1", "2", "-1"]) : ""})`;
                case 4: return `return string.gsub(${s}, ${rand(2) ? "'^' .. " : ""}${p}, ${pick(replacements)})`;
                default: return `return string.find(${s}, ${rand(2) ? "'^' .. " : ""}${p})`;
            }
        });
        expect(compare(programs).slice(0, 3)).toEqual([]);
    }, 120000);

    it("formats as Luau does", () => {
        const values = ["0", "1", "-1", "42", "-42", "255", "65", "3.14159", "-3.14159", "0.5", "1.5", "2.5", "0.125", "1e15", "1e16", "1e-5", "123456789", "0.000123456", "1e100", "1e-100", "5e-324", "1.7976931348623157e308",
            "2^53", "2^63", "-2^63", "2^64", "1/0", "-1/0", "0/0", "-0", "0.1", "99.995", "1e21", "9.5", "0.045", "1234.5678", "'12'", "'abc'", "'a\\0b'", "''", "nil", "true"];
        const programs = Array.from({ length: 5000 }, () => {
            const n = 1 + rand(3);
            const specs = Array.from({ length: n }, () => {
                const conv = pick(["d", "i", "u", "x", "X", "o", "e", "E", "f", "g", "G", "c", "s", "q", "f", "g", "e", "d"]);
                // (flags C leaves undefined for a conversion are left out: what they do depends on the C library)
                const allowed = conv === "s" || conv === "c" ? "-" : conv === "q" ? "" : "duxXo".includes(conv) ? (conv === "d" || conv === "i" ? "-+ 0" : conv === "u" ? "-0" : "-#0") : "-+ #0";
                const flags = [...allowed].filter(() => rand(4) === 0).join("");
                const width = conv === "q" || rand(2) ? "" : String(rand(14));
                const precision = conv === "q" || conv === "c" || rand(2) ? "" : "." + pick(["", "0", "1", "2", "3", "5", "8", "12", "20"]);
                return `%${flags}${width}${precision}${conv}`;
            });
            const args = specs.map(spec => rand(12) === 0 ? pick(values) : "sq".includes(spec.at(-1)!) ? pick(["'abc'", "'a\\0b'", "''", "'hello world'", "12", "1.5"]) : pick(values.slice(0, 36)));
            return `return string.format(${lit(specs.join("|"))}, ${args.join(", ")})`;
        });
        expect(compare(programs).slice(0, 3)).toEqual([]);
    }, 120000);

    it("interpolates and reports errors as Luau does", () => {
        const programs = [
            "local x, y = 5, 'str' return `x is {x}, y is {y}, sum {x + 1}`, `plain`, `100%`, `{x}{y}`",
            "local t = {} return `{1}{'a'}{nil}{true}{2.5}` .. `%d{1}%s`",
            "return string.format('%d', 'x')", "return string.format('%d')", "return string.format('%y', 1)", "return string.format('%')", "return string.format('%10')",
            "return string.format('%-----5d', 1)", "return string.format('%123d', 1)", "return string.format('%.123d', 1)", "return string.format('%5*', 1)", "return string.format('%*')",
            "return string.upper()", "return string.rep('x')", "return ('x'):rep()", "return string.char(256)", "return string.char(-1)", "return string.char('a')",
            "return string.gsub('abc', 'b', '%2')", "return string.gsub('abc', 'b', '%')", "return string.gsub('abc', 'b', nil)", "return string.gsub('abc', 'b')", "return string.gsub('abc', '%w', {b = true})",
            "return string.gsub('abc', '%w', function() return {} end)", "return string.gsub('abc', 'b', 'x', 'y')", "return string.rep('ab', 1e9)",
            "local f = string.gmatch('abc', '(') return f()", "return string.gmatch('abc')", "return string.gmatch(nil, 'a')", "local f = string.gmatch('a b', '%a') return f(), f(), f()",
            "return ('abc'):nope()", "return string.find()", "return string.find('a')", "return string.match('a', nil)", "return string.split()", "return string.byte()", "return string.sub('a')",
        ];
        expect(compare(programs)).toEqual([]);
    }, 60000);
});
