import { bench, describe } from "vitest";
import { Anima } from "./anima";
import { createScheme } from "./scheme";
import type { AbstractByteCode, AnimaMeta } from "./common";
import { ASTStringifier, IProcedure } from "./common";
import { impl, implAot } from "./bytecode-rvm/meta";
import { HostTail, type ByteCode } from "./bytecode-rvm/exec";
import { dumpFull, readFull } from "./bytecode-rvm/utils";

// --- the only part that follows the intrinsics API as it changes ---
const makeInstance = (vmImpl: AnimaMeta) => {
    const anima = createScheme(vmImpl);
    anima.registerIntrinsic("%bench-add", (regs, s) => regs[s] + regs[s + 1], {
        args: [2, 2],
        leaf: true,
        inline: ([a, b], slow) => `(typeof ${a} === "number" && typeof ${b} === "number" ? ${a} + ${b} : ${slow})`,
    });
    anima.registerIntrinsic("%bench-add-call", (regs, s) => regs[s] + regs[s + 1], { args: [2, 2], leaf: true });
    // copies the rest of the window with a loop: regs.slice plus a spread costs about twice as much on windows this small
    anima.registerIntrinsic("%bench-call-or", (regs, s, n) => {
        if (!(regs[s] instanceof IProcedure)) return regs[s];
        const args = new Array(n - 1);
        for (let i = 1; i < n; i++) args[i - 1] = regs[s + i];
        return new HostTail(regs[s], args);
    }, { args: [1, Infinity] });
    return anima;
};
const loadSetup = (anima: Anima, dumped: Uint32Array) => readFull(dumped, anima.intrinsics);
// -------------------------------------------------------------------

const SETUP = `
(define (fib n) (if (< n 2) n (+ (fib (- n 1)) (fib (- n 2)))))
(define (tak x y z) (if (not (< y x)) z (tak (tak (- x 1) y z) (tak (- y 1) z x) (tak (- z 1) x y))))
(define (sum-to n) (let loop ((i 0) (acc 0)) (if (= i n) acc (loop (+ i 1) (+ acc i)))))
(define (build-list n) (let loop ((i n) (acc '())) (if (= i 0) acc (loop (- i 1) (cons i acc)))))
(define (list-sum l) (let loop ((l l) (acc 0)) (if (null? l) acc (loop (cdr l) (+ acc (car l))))))
(define (table-bench n)
  (let ((t (table)))
    (let loop ((i 0) (acc 0))
      (if (= i n) acc
          (begin (table-set! t i (* i 2)) (loop (+ i 1) (+ acc (table-ref t i))))))))
(define (vector-bench n)
  (let ((v (make-vector n 0)))
    (let loop ((i 0) (acc 0))
      (if (= i n) acc
          (begin (vector-set! v i i) (loop (+ i 1) (+ acc (vector-ref v i))))))))

(define xs (build-list 1000))
; map recurses once per element: 500 stays under AOT's direct-call depth limit, so this measures calls, not suspension
(define pairs (map (lambda (x) (cons x x)) (build-list 500)))
(define (fold f acc l) (if (null? l) acc (fold f (f acc (car l)) (cdr l))))
(define (count-by cmp x l) (let loop ((l l) (n 0)) (if (null? l) n (loop (cdr l) (if (cmp (car l) x) (+ n 1) n)))))

(define (host-inline n) (let loop ((i 0) (acc 0)) (if (= i n) acc (loop (+ i 1) (%bench-add acc i)))))
(define (host-call n) (let loop ((i 0) (acc 0)) (if (= i n) acc (loop (+ i 1) (%bench-add-call acc i)))))
(define (host-value n) (let loop ((i 0) (acc 0)) (if (= i n) acc (loop (+ i 1) (+ acc (%bench-call-or i))))))
(define (host-tail n) (let loop ((i 0) (acc 0)) (if (= i n) acc (loop (+ i 1) (+ acc (%bench-call-or (lambda (x) x) i))))))

(define (callcc-bench n) (let loop ((i 0) (acc 0)) (if (= i n) acc (loop (+ i 1) (+ acc (call/cc (lambda (k) (k i))))))))
(define (wind-bench n) (let loop ((i 0) (acc 0)) (if (= i n) acc (loop (+ i 1) (+ acc (dynamic-wind (lambda () #f) (lambda () i) (lambda () #f)))))))
(define (raise-bench n) (let loop ((i 0) (acc 0)) (if (= i n) acc (loop (+ i 1) (+ acc (try (lambda () (raise i)) (lambda (e) e)))))))
(define (coroutine-bench n)
  (let ((co (coroutine-create (lambda () (let loop ((i 0)) (coroutine-yield i) (loop (+ i 1)))))))
    (let loop ((i 0) (acc 0)) (if (= i n) acc (loop (+ i 1) (+ acc (coroutine-resume co)))))))
(define (sq x) (* x x))
(define (sum-squares n) (let loop ((i 0) (acc 0)) (if (= i n) acc (loop (+ i 1) (+ acc (sq i))))))
(define (my-even? n) (if (= n 0) #t (my-odd? (- n 1))))
(define (my-odd? n) (if (= n 0) #f (my-even? (- n 1))))
(define (coroutine-create-bench n)
  (let loop ((i 0) (acc 0))
    (if (= i n) acc (loop (+ i 1) (if (eq? (coroutine-status (coroutine-create (lambda () i))) 'suspended) (+ acc 1) acc)))))
`;

const GROUPS: [group: string, calls: Record<string, string>][] = [
    ["direct builtin calls", {
        "fib 20": "(fib 20)",
        "tak 18 12 6": "(tak 18 12 6)",
        "sum loop 100k": "(sum-to 100000)",
        "cons 10k": "(build-list 10000)",
        "car/cdr walk 1k": "(list-sum xs)",
    }],
    ["calls between functions", {
        "helper call 100k": "(sum-squares 100000)",
        "mutual tail calls 100k": "(my-even? 100000)",
    }],
    ["tables and vectors", {
        "table set/ref 10k": "(table-bench 10000)",
        "vector set/ref 10k": "(vector-bench 10000)",
    }],
    ["builtins as values", {
        "map car 500": "(map car pairs)",
        "fold + 1k": "(fold + 0 xs)",
        "apply + 1k": "(apply + xs)",
        "count-by < 1k": "(count-by < 500 xs)",
    }],
    ["host intrinsics", {
        "leaf, inlined 100k": "(host-inline 100000)",
        "leaf, called 100k": "(host-call 100000)",
        "non-leaf, value 100k": "(host-value 100000)",
        "non-leaf, hostTail 100k": "(host-tail 100000)",
    }],
    ["control", {
        "call/cc escape 10k": "(callcc-bench 10000)",
        "dynamic-wind 10k": "(wind-bench 10000)",
        "raise/try 10k": "(raise-bench 10000)",
        "coroutine resume/yield 10k": "(coroutine-bench 10000)",
        "coroutine create/status 10k": "(coroutine-create-bench 10000)",
    }],
];

const MODES: [mode: string, vmImpl: AnimaMeta][] = [["interp", impl], ["aot", implAot]];

const printer = new ASTStringifier();
const stringify = (v: any): string => printer.stringify(v);

// every workload is run once per mode up front; the modes must agree, so a broken workload fails loudly
const prepared = MODES.map(([mode, vmImpl]) => {
    const anima = makeInstance(vmImpl);
    anima.evaluateRaw(anima.compileRaw(SETUP));
    const groups = GROUPS.map(([group, calls]) => [group, Object.entries(calls).map(([name, src]) => {
        const bc = anima.compileRaw(src);
        return { name, bc, result: stringify(anima.evaluateRaw(bc)) };
    })] as const);
    return { mode, vmImpl, anima, groups };
});
for (const { mode, groups } of prepared.slice(1)) {
    groups.forEach(([group, runs], g) => runs.forEach((run, i) => {
        const expected = prepared[0].groups[g][1][i].result;
        if (run.result !== expected) throw new Error(`${group} / ${run.name}: ${mode} gave ${run.result}, interp gave ${expected}`);
    }));
}

const OPTS = { time: 1000, warmupTime: 300 };

for (const { mode, anima, groups } of prepared) {
    for (const [group, runs] of groups) {
        describe(`${mode}: ${group}`, () => {
            for (const { name, bc } of runs) bench(name, () => { anima.evaluateRaw(bc as AbstractByteCode); }, OPTS);
        });
    }
}

for (const { mode, vmImpl, anima } of prepared) {
    describe(`${mode}: startup, compile, load`, () => {
        const compiled = anima.compileRaw(SETUP) as ByteCode;
        const dumped = dumpFull(compiled);
        bench("new instance", () => { createScheme(vmImpl); }, OPTS);
        bench("compile setup program", () => { anima.compileRaw(SETUP); }, OPTS);
        bench("dump + load setup program", () => { loadSetup(anima, dumpFull(compiled)); }, OPTS);
        bench("load setup program", () => { loadSetup(anima, dumped); }, OPTS);
    });
}
