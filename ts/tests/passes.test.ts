import { describe, it, expect } from 'vitest';
import { SOURCE_POS } from '../common';
import { createScheme } from '../scheme';
import { ASTStringifier } from '../scheme/printer';
import { opKinds, runNative } from './helpers';
import { impl } from '../magicvm/meta';
import { Lsrc, check, extend, mapExprs, parts, withBounds } from '../magicvm/passes/lang';
import { Lconv } from '../magicvm/passes/assignments';

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
            if (name === "assignments" || name === "cp0") check(Lconv, (output as any).ast);
        };
        anima.compileRaw(`
            (define (f . xs) (let* ((a 1) (b (+ a 1))) (set! a (lambda () b)) (call/cc (lambda (k) (if (null? xs) (k b) a)))))
            (define (g n) (define h (case-lambda ((x) x) ((x y) (+ x y)))) (letrec ((loop (lambda (i) (if (= i n) (h i) (loop (+ i 1)))))) (loop 0)))
            (let-values (((a . b) (values 1 2))) (g 3))`);
        expect(seen).toEqual(["rename", "block-escapes", "split-case-lambdas", "lift-lambdas", "resolve", "assignments", "cp0", "unbox", "closures", "generate", "interrupts", "lower"]);
    });
});

describe("The optimizer", () => {
    const s = new ASTStringifier();
    const make = (optimize: boolean) => createScheme({ debug: false, optimize });
    const run = (src: string, optimize = true) => { const a = make(optimize); return s.stringify(a.evaluateRaw(a.compileRaw(src, "t.anima"))) };
    const proc = (src: string) => { const a = make(true); return a.evaluateRaw(a.compileRaw(src)).tmpl.code };

    it("folds foldable intrinsics on constants, recording them as used", () => {
        const code = proc(`(lambda () (+ 1 (* 2 3)))`);
        expect(opKinds(code)).toEqual(["LoadInt", "Return"]);
        expect(code.intrinsics.map((u: any) => u.name)).toEqual(expect.arrayContaining(["%+", "%*"]));
        expect(run(`((lambda () (+ 1 (* 2 3))))`)).toBe("7");
    });

    it("leaves a call that throws to throw when it runs", () => {
        expect(opKinds(proc(`(lambda () (car '()))`))).toContain("IntCall");
        expect(() => run(`(define (oe-f) (car '())) (oe-f)`)).toThrow("car");
        expect(() => run(`(define (oe-g) (+ 1 'a) 2) (oe-g)`)).toThrow();
    });

    it("folds %if on a constant test, only #f being false", () => {
        expect(opKinds(proc(`(lambda () (if #f (car '()) 5))`))).toEqual(["LoadInt", "Return"]);
        expect(run(`(list (if 0 'yes 'no) (if '() 'yes 'no) (if #f 'yes 'no))`)).toBe("(yes yes no)");
    });

    it("inlines a helper called once, and propagates constants into it", () => {
        const code = proc(`(lambda (x) (define (sq y) (* y y)) (+ 1 (sq x)))`);
        expect(opKinds(code)).not.toContain("NewClosure");
        expect(opKinds(code)).not.toContain("Call");
        expect(run(`((lambda (x) (define (sq y) (* y y)) (+ 1 (sq x))) 4)`)).toBe("17");
        expect(opKinds(proc(`(lambda () (define (sq y) (* y y)) (sq 4))`))).toEqual(["LoadInt", "Return"]);
    });

    it("keeps recursion as recursion, and self tail calls as loops", () => {
        expect(run(`(define (oe-loop n) (letrec ((go (lambda (i acc) (if (= i 0) acc (go (- i 1) (+ acc 1)))))) (go n 0))) (oe-loop 100000)`)).toBe("100000");
        expect(run(`(define (oe-ev? n) (letrec ((ev? (lambda (n) (if (= n 0) #t (od? (- n 1))))) (od? (lambda (n) (if (= n 0) #f (ev? (- n 1)))))) (ev? n))) (oe-ev? 1001)`)).toBe("#f");
    });

    it("drops procedures nothing uses, even ones that call each other", () => {
        const kinds = opKinds(proc(`(lambda (n) (letrec ((ev? (lambda (n) (if (= n 0) #t (od? (- n 1))))) (od? (lambda (n) (if (= n 0) #f (ev? (- n 1)))))) n))`));
        expect(kinds).not.toContain("NewClosure");
        expect(kinds.filter(k => k === "LoadConst")).toHaveLength(0);
        expect(run(`((lambda (n) (letrec ((ev? (lambda (n) (if (= n 0) #t (od? (- n 1))))) (od? (lambda (n) (if (= n 0) #f (ev? (- n 1)))))) (od? n))) 7)`)).toBe("#t");
    });

    it("inlines procedures with rest and padded parameters, and applies to a list made there as a call", () => {
        expect(opKinds(proc(`(lambda (f a b) (define (g . xs) (apply f xs)) (g a b))`)).filter(k => k === "Call" || k === "HostCall")).toEqual(["Call"]);
        expect(run(`(define (rp) (define (g a . r) (list a r)) (list (g 1) (g 1 2 3))) (rp)`)).toBe("((1 ()) (1 (2 3)))");
        expect(run(`(define (ra) (define (g . xs) (apply + xs)) (g 1 2 3)) (ra)`)).toBe("6");
        // an applied intrinsic whose count does not fit still fails when it runs
        expect(() => runNative(make(true), `(define (rb) (letrec ((g (lambda xs (%intapply %car (%intcall %spread xs))))) (%call g 1 2))) (%call rb)`)).toThrow("expected exactly 1 args, got 2");
        // a padded clause (Lua): missing parameters <#void>, extra arguments evaluated and dropped
        const S = Symbol.for;
        const anima = make(true);
        const list = (...xs: any[]) => [S("%intcall"), S("%list"), ...xs];
        const padded = [S("%lambda"), [[S("pad")], [S("a"), S("b")], null, list(S("a"), S("b"))]];
        const program = [S("%let"), [[S("f"), padded]], list([S("%call"), S("f"), 1], [S("%call"), S("f"), 1, 2, list(3)])];
        expect(s.stringify(anima.evaluateRaw(anima.compiler.compile(program)))).toBe("((1 <#void>) (1 2))");
    });

    it("keeps a parameter of an inlined procedure that is assigned a variable of its own", () => {
        expect(run(`(define (ap) (define (g x) (set! x (+ x 1)) x) (list (g 1) (g 10))) (ap)`)).toBe("(2 11)");
    });

    it("inlines map, for-each and filter given a procedure it knows, unless they are redefined", () => {
        const calls = (src: string, a = make(true)) => opKinds(a.evaluateRaw(a.compileRaw(src)).tmpl.code).filter(k => k === "Call" || k === "TailCall" || k === "HostCall");
        expect(calls(`(lambda (l) (map (lambda (x) (* x 2)) l))`)).toEqual([]);
        expect(calls(`(lambda (l) (for-each (lambda (x) (display x)) l) (filter (lambda (x) (odd? x)) l))`)).toEqual([]);
        expect(calls(`(lambda (f l) (map f l))`)).toHaveLength(1);
        const redefined = make(true);
        redefined.evaluateRaw(redefined.compileRaw(`(define (map f l) 'mine)`));
        expect(calls(`(lambda (l) (map (lambda (x) x) l))`, redefined)).toHaveLength(1);
        expect(run(`(list (map (lambda (x y) (+ x y)) '(1 2) '(10 20)) (map car '((1) (2))))`)).toBe("((11 22) (1 2))");
    });

    it("keeps effects, and their order", () => {
        expect(run(`(define oe-log '()) (define (oe-note x) (set! oe-log (cons x oe-log)) x)
                    (define (oe-h) (let ((unused (oe-note 1))) (define (two a b) (list b a)) (two (oe-note 2) (oe-note 3))))
                    (list (oe-h) oe-log)`)).toBe("((3 2) (3 2 1))");
        expect(run(`(define oe-n 0) (define (oe-k) (let ((x (set! oe-n (+ oe-n 1)))) 5)) (oe-k) oe-n`)).toBe("1");
    });

    it("gives the same results and tracebacks as unoptimized code", () => {
        const programs = [
            `(define (tb-a) (define (inner x) (list (debug-traceback) x)) (car (inner 1))) (tb-a)`,
            `(define (tb-b) (define (inner x) (debug-traceback)) (inner 1)) (tb-b)`,
            `(define (tb-c) (define (h x) (car x)) (define (g x) (list (h x))) (list (g '(1)))) (tb-c)`,
            `(define (tb-d n) (define (twice f x) (f (f x))) (twice (lambda (y) (* y n)) 3)) (tb-d 2)`,
            `(define (tb-e) (define (k) (list (car (debug-frames)))) (k)) (tb-e)`,
        ];
        for (const src of programs) expect(run(src, true), src).toBe(run(src, false));
        const err = (optimize: boolean) => { try { run(`(define (tb-f) (define (bad x) (car x)) (list (bad '()))) (tb-f)`, optimize); } catch (e: any) { return e.animaTraceback; } };
        expect(err(true)).toBe(err(false));
        expect(err(true)).toContain("in bad");
    });
});
