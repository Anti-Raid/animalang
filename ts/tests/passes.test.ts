import { describe, it, expect } from 'vitest';
import { SOURCE_POS } from '../common';
import { createScheme } from '../scheme';
import { impl } from '../bytecode-rvm/meta';
import { Lsrc, check, extend, mapExprs, parts, withBounds } from '../bytecode-rvm/passes/lang';
import { Lconv } from '../bytecode-rvm/passes/assignments';

const S = Symbol.for;

describe("Languages", () => {
    it("extend another by removing and adding forms", () => {
        const L1 = extend(Lsrc, "L1", { remove: ["%let*"], add: { "%my-let": "let" } });
        expect(L1.forms.has(S("%let*"))).toBe(false);
        expect(L1.forms.get(S("%my-let"))).toBe("let");
        expect(Lsrc.forms.has(S("%let*"))).toBe(true);
        const letStar = [S("%let*"), [[S("a"), 1]], S("a")];
        expect(() => check(Lsrc, letStar)).not.toThrow();
        expect(() => check(L1, [S("%begin"), letStar])).toThrow("not L1: a form the language does not have in (%let* ...)");
    });

    it("check each form's layout", () => {
        expect(() => check(Lsrc, [S("%let"), [[1, 2]], 3])).toThrow("malformed bindings");
        expect(() => check(Lsrc, [S("%lambda"), [[], [S("x")], 5, S("x")]])).toThrow("a malformed clause");
        expect(() => check(Lsrc, [S("%set!"), "x", 1])).toThrow("a name that is not a symbol");
        // quoted data is not checked
        expect(() => check(Lsrc, [S("%quote"), [S("%let*"), 1]])).not.toThrow();
    });

    it("give each expression the names bound around it", () => {
        const lam = [S("%lambda"), [[], [S("x")], S("r"), S("x"), S("y")]];
        expect(parts(Lsrc, lam).exprs).toEqual([[S("x"), [S("x"), S("r")]], [S("y"), [S("x"), S("r")]]]);
        const letStar = [S("%let*"), [[S("a"), 1], [S("b"), S("a")]], S("b")];
        // one growing set, so it is read as each position comes
        const seen: [any, symbol[]][] = [];
        for (const [x, bound] of withBounds(parts(Lsrc, letStar), new Set())) seen.push([x, [...bound]]);
        expect(seen).toEqual([[1, []], [S("a"), [S("a")]], [S("b"), [S("a"), S("b")]]]);
    });

    it("rebuild a form only when an expression in it changed, keeping its position", () => {
        const e = [S("%if"), S("c"), 1, 2];
        SOURCE_POS.set(e, { file: "t", line: 1, col: 2 });
        expect(mapExprs(Lsrc, e, x => x)).toBe(e);
        const next = mapExprs(Lsrc, e, x => x === 1 ? 10 : x);
        expect(next).toEqual([S("%if"), S("c"), 10, 2]);
        expect(SOURCE_POS.get(next)).toEqual({ file: "t", line: 1, col: 2 });
    });
});

describe("The compiler's passes", () => {
    it("run in order, each core-forms pass giving core forms", () => {
        const anima = createScheme(impl);
        const seen: string[] = [];
        anima.compiler.trace = (name, output) => {
            seen.push(name);
            if (name === "rename" || name === "block-escapes" || name === "split-case-lambdas" || name === "lift-lambdas") check(Lsrc, output);
            if (name === "assignments") check(Lconv, (output as any).ast);
        };
        anima.compileRaw(`
            (define (f . xs) (let* ((a 1) (b (+ a 1))) (set! a (lambda () b)) (call/cc (lambda (k) (if (null? xs) (k b) a)))))
            (define (g n) (define h (case-lambda ((x) x) ((x y) (+ x y)))) (letrec ((loop (lambda (i) (if (= i n) (h i) (loop (+ i 1)))))) (loop 0)))
            (let-values (((a . b) (values 1 2))) (g 3))`);
        expect(seen).toEqual(["rename", "block-escapes", "split-case-lambdas", "lift-lambdas", "resolve", "assignments", "unbox", "closures", "generate", "interrupts", "lower"]);
    });
});
