import { describe, expect, it } from 'vitest';
import { createScheme } from '../scheme';
import { ASTStringifier } from '../scheme/printer';
import { impl } from '../magicvm/meta';
import { Code } from '../magicvm/vm';
import { listing } from '../magicvm/exec';
import { InterruptError, hostInterruptError, hostYield } from '../index';
import type { Anima } from '../anima';
import { expose } from './helpers';

const s = new ASTStringifier();

describe("Interrupts", () => {
    const vmImpl = impl
    // an instance whose code checks, calling `handler` now and then
    const make = (handler: (a: Anima) => any) => {
        const a = createScheme(vmImpl);
        a.registerIntrinsic("%tick", () => handler(a), { args: [0, 0] });
        a.intrinsics.setInterruptHandler("%tick");
        return a;
    };
    const run = (a: Anima, src: string) => s.stringify(a.evaluateRaw(a.compileRaw(src)));
    const stopped = (a: Anima, src: string) => {
        try {
            run(a, src);
        } catch (e) {
            expect(e).toBeInstanceOf(InterruptError);
            return (e as InterruptError).value;
        }
        throw new Error("expected a stop");
    };
    const stopAt = (calls: number) => {
        let n = 0;
        return () => ++n >= calls ? hostInterruptError("timeout") : undefined;
    };

    it("leaves code as it was when the handler continues, calling it now and then, in loops and recursion", () => {
        // when is the VM's choice: only eventually, and not on every check
        let calls = 0;
        const a = make(() => { calls++; });
        expect(run(a, `(let loop ((i 0) (acc 0)) (if (= i 1000000) acc (loop (+ i 1) (+ acc i))))`)).toBe("499999500000");
        expect(calls).toBeGreaterThan(0);
        expect(calls).toBeLessThan(10000);
        calls = 0;
        expect(run(a, `(define (fib n) (if (< n 2) n (+ (fib (- n 1)) (fib (- n 2))))) (fib 27)`)).toBe("196418");
        expect(calls).toBeGreaterThan(0);
    });

    it("stops code that would run forever: a loop, tail recursion and recursion that grows the stack", () => {
        expect(stopped(make(stopAt(3)), `(let loop () (loop))`)).toBe("timeout");
        expect(stopped(make(stopAt(3)), `(define (spin n) (spin (+ n 1))) (spin 0)`)).toBe("timeout");
        expect(stopped(make(stopAt(3)), `(define (deep n) (+ 1 (deep n))) (deep 0)`)).toBe("timeout");
        // from inside a procedure the prelude calls back
        expect(stopped(make(stopAt(3)), `(define (spin) (spin)) (map (lambda (x) (spin)) '(1 2 3))`)).toBe("timeout");
    });

    it("cannot be caught or cleaned up after by the code it stops", () => {
        const a = make(stopAt(3));
        expect(stopped(a, `(try (lambda () (let loop () (loop))) (lambda (e) 'caught))`)).toBe("timeout");
        expect(stopped(make(stopAt(3)), `(pcall (lambda () (let loop () (loop))))`)).toBe("timeout");
        expect(stopped(make(stopAt(3)), `(with-exception-handler (lambda (e) 'handled) (lambda () (let loop () (loop))))`)).toBe("timeout");
        const b = make(stopAt(3));
        expect(stopped(b, `(define ran #f) (dynamic-wind (lambda () #f) (lambda () (let loop () (loop))) (lambda () (set! ran #t)))`)).toBe("timeout");
        expect(run(b, `ran`)).toBe("#f");
    });

    it("pauses the running coroutine, which goes on where it was when resumed", () => {
        const a = make(a => a.coroutineYieldable() ? hostYield("tick") : undefined);
        run(a, `(define n 0) (define co (coroutine-create (lambda () (let loop () (set! n (+ n 1)) (loop)))))`);
        expect(run(a, `(coroutine-resume co)`)).toBe('"tick"');
        const first = Number(run(a, `n`));
        expect(first).toBeGreaterThan(0);
        expect(run(a, `(list (coroutine-resume co) (coroutine-status co))`)).toBe('("tick" suspended)');
        expect(Number(run(a, `n`))).toBeGreaterThan(first);
        // the host resumes it the same way
        expect(a.coroutineResume(a.evaluateRaw(a.compileRaw(`co`))).value).toBe("tick");
    });

    it("stops, saying why, when asked to pause code outside a coroutine or given something else", () => {
        const a = make(() => hostYield("tick"));
        expect(String(stopped(a, `(let loop () (loop))`))).toMatch(/not in a coroutine it can pause/);
        let calls = 0;
        const b = make(() => { calls++; return 42; });
        expect(run(b, `(let loop ((i 0)) (if (= i 1000000) 'done (loop (+ i 1))))`)).toBe("done");
        expect(calls).toBeGreaterThan(0);
    });

    it("kills the coroutines a stop leaves, and the instance goes on", () => {
        const a = make(stopAt(3));
        expect(stopped(a, `(define inner (coroutine-create (lambda () (let loop () (loop)))))
                          (define outer (coroutine-create (lambda () (coroutine-resume inner))))
                          (coroutine-resume outer)`)).toBe("timeout");
        expect(run(a, `(list (coroutine-status inner) (coroutine-status outer))`)).toBe("(dead dead)");
        expect(a.currentCoroutine()).toBe(null);
        expect(run(a, `(+ 1 2)`)).toBe("3");
        // one the host resumes
        const b = make(stopAt(3));
        const co = b.evaluateRaw(b.compileRaw(`(define spinner (coroutine-create (lambda () (let loop () (loop))))) spinner`));
        expect(() => b.coroutineResume(co)).toThrow(InterruptError);
        expect(run(b, `(coroutine-status spinner)`)).toBe("dead");
    });

    it("takes a new handler the next time it calls one", () => {
        let calls = 0;
        const a = make(() => { calls++; });
        a.registerIntrinsic("%stop", () => hostInterruptError("swapped"), { args: [0, 0] });
        expect(run(a, `(let loop ((i 0)) (if (= i 1000000) 'done (loop (+ i 1))))`)).toBe("done");
        expect(calls).toBeGreaterThan(0);
        a.intrinsics.setInterruptHandler("%stop");
        expect(stopped(a, `(let loop () (loop))`)).toBe("swapped");
    });

    it("comes eventually however code runs without end: self and mutual tail calls at any depth, and call trees that stay shallow", () => {
        // a self tail call restarts the function at the depth it was called at, odd or even
        expect(stopped(make(stopAt(3)), `(define (spin n) (spin (+ n 1))) (define (start) (spin 0)) (start)`)).toBe("timeout");
        expect(stopped(make(stopAt(3)), `(define (spin n) (spin (+ n 1))) (define (start) (+ 1 (spin 0))) (define (outer) (+ 1 (start))) (outer)`)).toBe("timeout");
        expect(stopped(make(stopAt(3)), `(define (f n) (g (+ n 1))) (define (g n) (f (+ n 1))) (f 0)`)).toBe("timeout");
        // 3^30 calls, none deeper than 30 and no loop
        expect(stopped(make(stopAt(3)), `(define (tree n) (if (= n 0) 0 (+ (tree (- n 1)) (tree (- n 1)) (tree (- n 1))))) (tree 30)`)).toBe("timeout");
    });

    it("counts each instance's code for its own handler", () => {
        let first = 0, second = 0;
        const a = make(() => { first++; });
        const b = make(() => { second++; });
        run(a, `(let loop ((i 0)) (if (= i 1000000) 'done (loop (+ i 1))))`);
        expect(first).toBeGreaterThan(0);
        expect(second).toBe(0);
        run(b, `(let loop ((i 0)) (if (= i 1000000) 'done (loop (+ i 1))))`);
        expect(second).toBeGreaterThan(0);
    });

    it("lets a long-running intrinsic check for interrupts itself", () => {
        // an intrinsic that works through `n` units, checking now and then
        const grinding = (a: Anima) => a.registerIntrinsic("%grind", (regs, start) => {
            for (let i = 0; i < regs[start]; i += 1000) a.checkInterrupt(1000);
            return "ground";
        }, { args: [1, 1] }) && expose(a, "%grind");
        // continuing
        let calls = 0;
        const a = make(() => { calls++; });
        grinding(a);
        expect(run(a, `(grind 10000000)`)).toBe('"ground"');
        expect(calls).toBeGreaterThan(0);
        // stopping, where nothing can catch it
        const b = make(stopAt(1));
        grinding(b);
        expect(stopped(b, `(try (lambda () (grind 1000000000)) (lambda (e) 'caught))`)).toBe("timeout");
        // pausing: after the intrinsic returns, at the coroutine's next check
        const c = make(c => c.coroutineYieldable() ? hostYield("tick") : undefined);
        grinding(c);
        run(c, `(define rounds 0) (define co (coroutine-create (lambda () (let loop () (grind 1000000) (set! rounds (+ rounds 1)) (loop)))))`);
        expect(run(c, `(coroutine-resume co)`)).toBe('"tick"');
        expect(Number(run(c, `rounds`))).toBeGreaterThan(0);
        // a pause where the code cannot pause is dropped
        expect(run(c, `(grind 10000000)`)).toBe('"ground"');
    });

    it("stops from any host intrinsic that asks to", () => {
        const a = createScheme(vmImpl);
        a.registerIntrinsic("%cancel", () => hostInterruptError("cancelled"), { args: [0, 0] });
        expose(a, "%cancel");
        expect(stopped(a, `(try (lambda () (cancel)) (lambda (e) 'caught))`)).toBe("cancelled");
    });

    it("checks only where code could run without end, and only when turned on", () => {
        const src = `(define (inc x) (+ x 1)) (define (twice f x) (f (f x))) (define (count n) (let loop ((i 0)) (if (= i n) i (loop (+ i 1)))))`;
        const checks = (a: Anima) => {
            const bc = a.compileRaw(src) as Code;
            const all: string[] = [];
            const walk = (code: Code) => {
                all.push(...listing(code));
                // a closure with no upvars is made once, when compiled
                for (const c of code.constants) {
                    const inner = c?.code ?? c?.tmpl?.code;
                    if (inner instanceof Code) walk(inner);
                }
            };
            walk(bc);
            return all.filter(line => line.includes("%interrupt")).length;
        };
        expect(checks(createScheme(vmImpl))).toBe(0);
        // twice calls (one check on entry), count loops (one at the back-edge); inc does neither
        expect(checks(make(() => undefined))).toBe(2);
    });

    it("refuses code compiled before interrupts were turned on", () => {
        const a = createScheme(vmImpl);
        a.registerIntrinsic("%tick", () => undefined, { args: [0, 0] });
        const old = a.compileRaw(`(let loop () (loop))`) as Code;
        a.intrinsics.setInterruptHandler("%tick");
        expect(() => a.evaluateRaw(old)).toThrow(/compiled without interrupt checks/);
        const checked = a.compileRaw(`(+ 1 2)`) as Code;
        expect(checked.interrupts).toBe(true);
    });
});
