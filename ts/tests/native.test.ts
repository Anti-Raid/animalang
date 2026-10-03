import { describe, expect, it } from 'vitest';
import { compileNative, createNativeScheme, readNative, showValue, transformNative, NativeReadError } from '../native';
import { Anima } from '../anima';
import { createScheme } from '../scheme';
import { ASTStringifier } from '../scheme/printer';
import { impl } from '../magicvm/meta';
import { SOURCE_POS } from '../common';

const S = Symbol.for;
const s = new ASTStringifier();

describe("native-scheme's reader", () => {
    it("reads lists as arrays, names as symbols, and VM values", () => {
        expect(readNative(`(%if #t 1 (%call f -2.5 1e3 "a\\nb\\u{41}" #f #null #void 12n))`)).toEqual(
            [S("%if"), true, 1, [S("%call"), S("f"), -2.5, 1000, "a\nbA", false, null, undefined, 12n]]);
        expect(readNative(`; nothing but a comment\n  x ; and another`)).toBe(S("x"));
        expect(readNative(`(a) (b)`)).toEqual([S("%begin"), [S("a")], [S("b")]]);
        expect(readNative(``)).toEqual([S("%begin")]);
        expect(readNative(`(%quote ((1 2) x))`)).toEqual([S("%quote"), [[1, 2], S("x")]]);
        expect(readNative(`'(1 x)`)).toEqual([S("%quote"), [1, S("x")]]);
    });

    it("keeps where each list was read", () => {
        const e = readNative(`(%begin\n  (%call f\n    (g)))`, "t.core");
        expect(SOURCE_POS.get(e)).toEqual({ file: "t.core", line: 1, col: 1 });
        expect(SOURCE_POS.get(e[1])).toEqual({ file: "t.core", line: 2, col: 3 });
        expect(SOURCE_POS.get(e[1][2])).toEqual({ file: "t.core", line: 3, col: 5 });
    });

    it("reports what it cannot read, and where", () => {
        const error = (src: string) => {
            try {
                readNative(src, "t.core");
            } catch (err) {
                expect(err).toBeInstanceOf(NativeReadError);
                const e = err as NativeReadError;
                return [e.what, e.at.line, e.at.col];
            }
            throw new Error("expected an error");
        };
        expect(error(`(a\n (b)`)).toEqual(["unclosed list", 1, 1]);
        expect(error(`(a))`)).toEqual(["unexpected )", 1, 4]);
        expect(error(`"abc`)).toEqual(["unclosed string", 1, 1]);
        expect(error(`"a\\qb"`)).toEqual(["bad escape \\q in a string", 1, 3]);
        expect(error(`(#nil)`)).toEqual(["bad token #nil", 1, 2]);
        expect(error(`(a ')`)).toEqual(["unexpected )", 1, 5]);
    });

    it("gives quoted data to the front end's datum, and only quoted data", () => {
        const seen: any[] = [];
        const datum = (x: any) => { seen.push(x); return "D"; };
        expect(readNative(`(%call f (%quote (1 2)) (3 4) (%quote x y))`, undefined, { datum })).toEqual(
            [S("%call"), S("f"), [S("%quote"), "D"], [3, 4], [S("%quote"), S("x"), S("y")]]);
        expect(seen).toEqual([[1, 2]]);
    });

    it("compiles core text on any instance, with the front end's datum unless told otherwise", () => {
        const bare = new Anima(impl);
        expect(bare.evaluateRaw(compileNative(bare, `(%call (%lambda (() (a) r r)) 1 2 3)`))).toEqual([2, 3]);
        expect(bare.evaluateRaw(compileNative(bare, `(%quote (1 2))`))).toEqual([1, 2]);
        const scheme = createScheme(impl);
        expect(s.stringify(scheme.evaluateRaw(compileNative(scheme, `(%intcall %reverse (%quote (1 (2 3))))`)))).toBe("((2 3) 1)");
        expect(s.stringify(scheme.evaluateRaw(compileNative(scheme, `(%quote (1 2))`, "t.core", { datum: x => x })))).toBe("#(1 2)");
        expect(() => compileNative(scheme, `(%call f`, "t.core")).toThrow("read: unclosed list at t.core:1:1");
    });
});

describe("native-scheme", () => {
    const make = (options = impl) => {
        const a = createNativeScheme(options);
        a.registerIntrinsic("%+", (regs, st, n) => { let t = 0; for (let i = 0; i < n; i++) t += regs[st + i]; return t; }, { args: [0, Infinity], leaf: true });
        a.registerIntrinsic("%-", (regs, st) => regs[st] - regs[st + 1], { args: [2, 2], leaf: true });
        a.registerIntrinsic("%=", (regs, st) => regs[st] === regs[st + 1], { args: [2, 2], leaf: true });
        a.registerIntrinsic("%<", (regs, st) => regs[st] < regs[st + 1], { args: [2, 2], leaf: true });
        a.registerIntrinsic("%push", (regs, st) => [...regs[st], regs[st + 1]], { args: [2, 2], leaf: true });
        a.registerIntrinsic("%at", (regs, st) => regs[st][regs[st + 1]], { args: [2, 2], leaf: true });
        return a;
    };
    const run = (a: Anima, src: string) => showValue(a.evaluateRaw(a.compileRaw(src, "t.ns")));

    it("is the core forms, with calls written out", () => {
        const a = make();
        expect(run(a, `(%call (%lambda (() (x) #null (%intcall %+ x 1))) 41)`)).toBe("42");
        expect(run(a, `'(1 #t "s" x)`)).toBe(`(1 #t "s" x)`);
        expect(() => a.compileRaw(`(%+ 1 2)`)).toThrow("%+ is not a core form");
        expect(() => a.compileRaw(`(f 1)`)).toThrow("f is not a core form");
    });

    it("has lambda, define-global and Scheme's let, let* and letrec as sugar", () => {
        const a = make();
        expect(run(a, `(define-global (add . xs) (%intapply %+ xs)) (define-global one 1) (%call add one 2 3)`)).toBe("6");
        expect(run(a, `(%call (lambda (a b . r) (%intcall %push r (%intcall %+ a b))) 1 2 3)`)).toBe("(3 3)");
        expect(run(a, `(%call (lambda xs xs) 1 2)`)).toBe("(1 2)");
        expect(run(a, `(let ((x 1) (y 2)) (let* ((x 10) (z (%intcall %+ x y))) z))`)).toBe("12");
        expect(run(a, `(letrec ((ev? (lambda (n) (%if (%intcall %= n 0) #t (%call od? (%intcall %- n 1)))))
                                (od? (lambda (n) (%if (%intcall %= n 0) #f (%call ev? (%intcall %- n 1))))))
                         (%call ev? 10))`)).toBe("#t");
        // a global, wherever it is defined; native-scheme has no define of locals (let and letrec bind them)
        expect(run(a, `(let ((x 1)) (define-global y (%intcall %+ x 1)) y)`)).toBe("2");
        expect(() => a.compileRaw(`(define z 1)`)).toThrow("define is not a core form");
        expect(() => a.compileRaw(`(lambda (a . b c) a)`)).toThrow("one name must follow .");
    });

    it("has when, unless, and and or", () => {
        const a = make();
        expect(run(a, `(%intcall %array (when #t 1 2) (when #f 1) (unless #f 3) (unless 0 4))`)).toBe("(2 #void 3 #void)");
        expect(run(a, `(%intcall %array (and) (and 1 2) (and 1 #f 3) (or) (or #f 2) (or #f #f))`)).toBe("(#t 2 #f #f 2 #f)");
        // only #f is false
        expect(run(a, `(%intcall %array (and 0 #null) (or #null 1))`)).toBe("(#null #null)");
    });

    it("makes a named let a loop when its name is only called in tail position", () => {
        const a = make();
        const sum = `(let loop ((i 0) (acc 0)) (%if (%intcall %= i 100000) acc (%call loop (%intcall %+ i 1) (%intcall %+ acc i))))`;
        expect(run(a, sum)).toBe("4999950000");
        expect(JSON.stringify(transformNative(readNative(sum)), (_, v) => typeof v === "symbol" ? v.description : v)).toContain('"%loop"');
        // nested, and the inner one going round the outer
        expect(run(a, `(let outer ((i 0) (out '()))
                         (%if (%intcall %= i 3) out
                           (let inner ((j 0) (out out))
                             (%if (%intcall %= j i) (%call outer (%intcall %+ i 1) out) (%call inner (%intcall %+ j 1) (%intcall %push out j))))))`)).toBe("(0 0 1)");
        // used as a value, or not in tail position: a procedure
        const proc = `(let count ((n 3)) (%if (%intcall %= n 0) 0 (%intcall %+ 1 (%call count (%intcall %- n 1)))))`;
        expect(run(a, proc)).toBe("3");
        expect(JSON.stringify(transformNative(readNative(proc)), (_, v) => typeof v === "symbol" ? v.description : v)).toContain('"%letrec"');
        expect(run(a, `(let f ((n 1)) (%if (%intcall %= n 1) f n))`).startsWith("#<procedure")).toBe(true);
        // a parameter of the loop's name hides it
        expect(run(a, `(let f ((f 5)) f)`)).toBe("5");
        // an escape to a block that is not in tail position is not a tail call, even if an outer block of the same name
        // is: (outer 1) here is an argument of +, so this is recursion (result 2), not a loop (result 1)
        const shadowed = `(let outer ((i 0)) (%if (%intcall %= i 1) i (%block b (%intcall %+ 1 (%block b (%escape b (%call outer 1)))))))`;
        expect(run(a, shadowed)).toBe("2");
        expect(JSON.stringify(transformNative(readNative(shadowed)), (_, v) => typeof v === "symbol" ? v.description : v)).toContain('"%letrec"');
        // defining a global of the loop's name leaves the loop alone
        expect(run(a, `(%intcall %array (let loop ((i 0)) (%define-global loop 42) (%if (%intcall %= i 3) i (%call loop (%intcall %+ i 1)))) loop)`)).toBe("(3 42)");
    });

    it("gives each round of a named let loop its own bindings, as calls would", () => {
        const a = make();
        expect(run(a, `(define-global k #f) (define-global n 0)
            (define-global r (let loop ((i 0) (acc '()))
                (%if (%intcall %= i 3) acc
                    (%call loop (%intcall %+ i 1) (%intcall %push acc (%intcall %call/cc (lambda (c) (%if (%intcall %= i 1) (%set! k c)) i)))))))
            (%set! n (%intcall %+ n 1))
            (%if (%intcall %< n 3) (%call k (%intcall %+ 10 n)) (%intcall %array r n))`)).toBe("((0 12 2) 3)");
        // closures made in a round keep that round's value
        expect(run(a, `(let loop ((i 0) (fs '()))
            (%if (%intcall %= i 3) (%intcall %array (%call (%intcall %at fs 0)) (%call (%intcall %at fs 2))) (%call loop (%intcall %+ i 1) (%intcall %push fs (lambda () i)))))`)).toBe("(0 2)");
    });

    it("compiles on another front end's instance, with its quoted data and table", () => {
        const scheme = createScheme(impl);
        expect(s.stringify(scheme.evaluateRaw(compileNative(scheme, `(let loop ((l '(1 2 3)) (acc 0)) (%if (%intcall %null? l) acc (%call loop (%intcall %cdr l) (%intcall %+ acc (%intcall %car l)))))`)))).toBe("6");
    });

    it("words messages in its own terms", () => {
        const a = make();
        expect(() => run(a, `(%call 5 1)`)).toThrow("not a procedure: 5");
        expect(() => run(a, `nope`)).toThrow("unbound variable nope");
        expect(() => a.compileRaw(`(let ((x)) x)`, "t.ns")).toThrow("let: bindings must be ((name init) ...) at t.ns:1:1");
    });
});
