import { ASTStringifier } from '../common';
import { describe, it, expect, beforeEach } from 'vitest';
import { Cons } from '../list';
import { createScheme } from '../scheme';
import { ByteCode } from '../bytecode-rvm/vm';
import { Anima } from '../anima';
import { impl, implAot, implDebug, implAotDebug } from '../bytecode-rvm/meta';
import { registerTestIntrinsics } from './helpers';

describe.each([["interp", impl], ["aot", implAot]] as const)("%s", (_mode, vmImpl) => {
let bcCache: Record<string, ByteCode> = {}
describe('Anima', () => {
    let evaluator: Anima
    let s = new ASTStringifier()
    // every test starts from a fresh instance, so none depends on what ran before it
    beforeEach(() => {
        evaluator = createScheme(vmImpl)
        registerTestIntrinsics(evaluator)
        bcCache = {}
        evaluator.scope.set(Symbol.for("port"), 8080)
        evaluator.scope.set(Symbol.for("protocol"), "tcp")
        evaluator.scope.set(Symbol.for("is_active"), true)
        evaluator.scope.set(Symbol.for("user_role"), null)
    })
    
    const run = (expr: string) => {
        if (bcCache[expr]) return s.stringify(evaluator.evaluateRaw(bcCache[expr]))
        const bc = evaluator.compileRaw(expr)
        bcCache[expr] = bc
        return s.stringify(evaluator.evaluateRaw(bc));
    };


    describe('Debugging & tracebacks', () => {
        const runFile = (src: string) => evaluator.evaluateRaw(evaluator.compileRaw(src, "t.anima"));
        const errorOf = (src: string): any => {
            try {
                runFile(src);
            } catch (e) {
                return e;
            }
            throw new Error("expected an error");
        };

        it("names procedures after their bindings", () => {
            expect(runFile(`(define (f x) x) f`).debugName).toBe("f");
            expect(runFile(`(define g (lambda () 1)) g`).debugName).toBe("g");
            expect(runFile(`(let ((h (lambda () 1))) h)`).debugName).toBe("h");
            expect(runFile(`(lambda () 1)`).debugName).toBe("lambda@t.anima:1");
            expect(runFile(`map`).debugName).toBe("map");
        });

        it("debug-traceback lists the live frames with positions", () => {
            const tb = runFile(`(define (inner)
  (list (debug-traceback "here")))
(define (outer)
  (car (inner)))
(car (list (outer)))`);
            expect(tb).toBe("here\nstack traceback:\n  t.anima:2:9 in inner\n  t.anima:4:8 in outer\n  t.anima:5:12 in top-level");
        });

        it("debug-frames returns name/file/line/col records and honours level", () => {
            expect(s.stringify(runFile(`(define (f) (car (debug-frames))) (list (f))`))).toBe(`(#("f" "t.anima" 1 18))`);
            expect(s.stringify(runFile(`(define (f) (car (debug-frames 1))) (list (f))`))).toBe(`(#("top-level" "t.anima" 1 43))`);
        });

        it("tail calls drop frames", () => {
            const tb = runFile(`(define (a) (debug-traceback)) (define (b) (a)) (car (list (b)))`);
            // b tail-called a, so only a (which took the snapshot) and top-level remain
            expect(tb).toBe("stack traceback:\n  t.anima:1:13 in a\n  t.anima:1:60 in top-level");
        });

        it("tracebacks of coroutines waiting on one they resumed", () => {
            expect(runFile(`(define tb-outer #f)
(define tb-inner (coroutine-create (lambda () (debug-traceback tb-outer))))
(define (tb-resumer) (list (coroutine-resume tb-inner)))
(set! tb-outer (coroutine-create (lambda () (car (tb-resumer)))))
(coroutine-resume tb-outer)`)).toMatch(/^stack traceback:\n  t\.anima:3:\d+ in tb-resumer\n  t\.anima:4:\d+ in lambda@t\.anima:4$/);
            // a tail resume replaces its caller's frame, so the trace starts below it
            expect(runFile(`(define tb-outer2 #f)
(define tb-inner2 (coroutine-create (lambda () (debug-traceback tb-outer2))))
(define (tb-resumer2) (coroutine-resume tb-inner2))
(set! tb-outer2 (coroutine-create (lambda () (car (list (tb-resumer2))))))
(coroutine-resume tb-outer2)`)).toMatch(/^stack traceback:\n  t\.anima:4:\d+ in lambda@t\.anima:4$/);
        });

        it("takes stack snapshots without capturing a continuation", () => {
            expect(runFile(`(define (sn-a) (debug-frames)) (define (sn-b) (list (sn-a))) (length (car (sn-b)))`)).toBe(3);
            expect(runFile(`(define sn-tb debug-traceback) (define (sn-c) (list (sn-tb "via value"))) (car (sn-c))`)).toBe("via value\nstack traceback:\n  t.anima:1:53 in sn-c\n  t.anima:1:80 in top-level");
            expect(runFile(`(define (sn-loop i acc) (if (= i 20) acc (sn-loop (+ i 1) (+ acc (length (debug-frames)))))) (sn-loop 0 0)`)).toBe(20);
        });

        it("unhandled errors carry a traceback", () => {
            const err = errorOf(`(define (bad x)
  (car x))
(define (go)
  (+ 1 (bad '())))
(go)`);
            expect(err.message).toBe("car: list is too short");
            expect(err.animaTraceback).toMatch(/^car: list is too short\nstack traceback:\n  t\.anima:\d+:\d+ in bad\n  t\.anima:4:8 in go$/);
        });

        it("tracebacks work inside exception handlers", () => {
            const tb = runFile(`(define (bad) (list (raise 'boom)))
(call/cc (lambda (k)
  (with-exception-handler
    (lambda (e) (k (debug-traceback e)))
    (lambda () (list (bad))))))`);
            expect(tb).toMatch(/^boom\nstack traceback:\n/);
            expect(tb).toContain("t.anima:1:21 in bad");
        });

        it("tracebacks of suspended coroutines", () => {
            runFile(`(define tb-co (coroutine-create (lambda ()
  (define (deep) (list (coroutine-yield 1)))
  (list (deep)))))
(coroutine-resume tb-co)`);
            const expected = "stack traceback:\n  t.anima:2:24 in deep\n  t.anima:3:9 in lambda@t.anima:1";
            expect(runFile(`(debug-traceback tb-co)`)).toBe(expected);
            expect(evaluator.traceback(runFile(`tb-co`))).toBe(expected);
            expect(runFile(`(define fresh-co (coroutine-create (lambda () 1))) (debug-traceback fresh-co)`)).toBe("stack traceback:");
        });

        it("%at overrides positions for transpiled code", () => {
            const err = errorOf(`(define (lua-fn t)
  (%at "game.luau" 12 5 (car t)))
(list (lua-fn '()))`);
            expect(err.animaTraceback).toContain("game.luau:12:5 in lua-fn");
            expect(() => runFile(`(%at "x" 1 (car '(1)))`)).toThrow("%at must be in format");
        });

        it("continuations stay multi-shot after a traceback", () => {
            expect(runFile(`(define saved #f)
(define count 0)
(define (f) (debug-traceback) (call/cc (lambda (k) (set! saved k) 0)))
(define r (f))
(set! count (+ count 1))
(if (< count 3) (saved count) (list r count))`)).toEqual(Cons.list(2, 3));
        });
    });
})
})

describe.each([["interp", implDebug], ["aot", implAotDebug]] as const)("debug %s", (_mode, vmImpl) => {
    let evaluator: Anima;
    beforeEach(() => { evaluator = createScheme(vmImpl) });
    const runFile = (src: string) => evaluator.evaluateRaw(evaluator.compileRaw(src, "t.anima"));
    const errorOf = (src: string): any => {
        try {
            runFile(src);
        } catch (e) {
            return e;
        }
        throw new Error("expected an error");
    };

    it("shows each frame's tail-call trail, collapsing repeats", () => {
        const err = errorOf(`(define (loop n) (if (= n 0) (helper n) (loop (- n 1))))
(define (helper n) (list (explode n)))
(define (explode n)
  (car n))
(define (start) (loop 5))
(start)`);
        expect(err.animaTraceback).toBe(
            "car: expected a pair but got 0\nstack traceback:\n  t.anima:4:3 in explode\n" +
            "  t.anima:2:26 in helper (tail calls: helper <- loop x6 <- start)"
        );
    });

    it("reports the exact failing position without a preceding call", () => {
        const err = errorOf(`(define (f x)
  (let ((y (+ x 1)))
    (list (car y))))
(list (f 1))`);
        expect(err.animaTraceback).toContain("t.anima:3:11 in f");
    });

    it("keeps the prelude out of tail-call trails", () => {
        const err = errorOf(`(define (g) (raise 'x)) (list (g))`);
        // raise is delivered from g itself, not a prelude procedure g tail-called
        expect(err.animaTraceback).toBe("x\nstack traceback:\n  t.anima:1:13 in g\n  t.anima:1:31 in top-level");
    });
});
