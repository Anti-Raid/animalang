import { describe, expect, it } from 'vitest';
import { createScheme } from '../scheme';
import { ASTStringifier } from '../scheme/printer';
import { hostCall, hostTail } from '../index';
import type { Anima } from '../anima';

const s = new ASTStringifier();

// (%sum-calls f n): (f 0) + ... + (f n-1), each call made with hostCall and the sum carried from one `then` to the next
const sumCalls = (regs: any[], start: number) => {
    const f = regs[start], n = regs[start + 1];
    const step = (i: number, acc: number): any => i === n ? acc : hostCall(f, [i], v => step(i + 1, acc + v));
    return step(0, 0);
};

describe.each([
    ["AOT", { debug: false, optimize: true }],
    ["debug", { debug: true, optimize: false }],
])("Host calls (%s)", (_, options) => {
    const make = () => {
        const a = createScheme(options);
        a.registerIntrinsic("%sum-calls", sumCalls, { args: [2, 2] });
        a.registerIntrinsic("%then-tail", (regs, start) => hostCall(regs[start], [], v => hostTail(regs[start + 1], v)), { args: [2, 2] });
        return a;
    };
    const run = (a: Anima, src: string) => s.stringify(a.evaluateRaw(a.compileRaw(src, "t.anima")));

    it("calls back, then goes on with what it returned", () => {
        const a = make();
        expect(run(a, `(%sum-calls (lambda (i) (* i i)) 4)`)).toBe("14");
        expect(run(a, `(define (hc-t n) (%sum-calls (lambda (i) i) n)) (list (hc-t 0) (hc-t 10))`)).toBe("(0 45)");
        expect(run(a, `(%then-tail (lambda () 5) (lambda (x) (* x 2)))`)).toBe("10");
        expect(run(a, `(%sum-calls (lambda (i) (%sum-calls (lambda (j) (* i j)) 3)) 3)`)).toBe("9");
    });

    it("resumes `then` again when a continuation captured in the callback is re-entered", () => {
        const a = make();
        expect(run(a, `(define hc-k #f) (define hc-n 0) (define hc-out '())
            (define hc-r (%sum-calls (lambda (i) (if (= i 1) (call/cc (lambda (k) (set! hc-k k) 1)) i)) 3))
            (set! hc-out (cons hc-r hc-out)) (set! hc-n (+ hc-n 1))
            (if (< hc-n 3) (hc-k (* 100 hc-n)) hc-out)`)).toBe("(202 102 3)");
    });

    it("lets the callback yield, escape and raise", () => {
        const a = make();
        expect(run(a, `(define hc-co (coroutine-create (lambda () (%sum-calls (lambda (i) (coroutine-yield i) i) 3))))
            (list (coroutine-resume hc-co) (coroutine-resume hc-co) (coroutine-resume hc-co) (coroutine-resume hc-co))`)).toBe("(0 1 2 3)");
        expect(run(a, `(call/ec (lambda (k) (%sum-calls (lambda (i) (if (= i 2) (k 'out) i)) 5)))`)).toBe("out");
        expect(run(a, `(try (lambda () (%sum-calls (lambda (i) (raise 'bad)) 2)) (lambda (e) (list 'caught e)))`)).toBe("(caught bad)");
    });

    it("lets the callback be interrupted", () => {
        let calls = 0;
        const a = make();
        a.registerIntrinsic("%tick", () => { calls++; }, { args: [0, 0] });
        a.intrinsics.setInterruptHandler("%tick");
        expect(run(a, `(%sum-calls (lambda (i) (let loop ((j 0)) (if (= j 1000) i (loop (+ j 1))))) 2000)`)).toBe("1999000");
        expect(calls).toBeGreaterThan(0);
    });

    it("recurses without limit through the host", () => {
        const a = make();
        expect(run(a, `(define (hc-deep n) (if (= n 0) 0 (+ 1 (%sum-calls (lambda (i) (hc-deep (- n 1))) 1)))) (hc-deep 100000)`)).toBe("100000");
    });

    it("shows the callback under its caller in tracebacks, not the frame holding `then`", () => {
        const a = make();
        const tb = run(a, `(define (hc-tb) (car (%then-tail (lambda () (list (debug-traceback))) (lambda (x) x)))) (hc-tb)`);
        expect(tb).toMatch(/in lambda@t\.anima:1\\n.*in hc-tb/);
        expect(tb).not.toMatch(/host-call/);
    });
});
