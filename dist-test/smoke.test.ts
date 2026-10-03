// The built package (dist/), through its public API only: catches what only breaks once bundled (module order, inlined
// enums, what the entry exports). The sources' own tests are in ts/tests/
import { describe, it, expect } from 'vitest';
import { createScheme, createNativeScheme, compileNative, implRvm, implRvmDebug, hostTailFrom, Table, ASTStringifier } from 'animalang';

const s = new ASTStringifier();

describe.each([["release", implRvm], ["debug", implRvmDebug]] as const)("dist %s", (_mode, options) => {
    const instance = () => {
        const anima = createScheme(options);
        anima.registerIntrinsic("%smoke-add", (regs: any[], start: number) => regs[start] + regs[start + 1], {
            args: [2, 2],
            leaf: true,
            inline: ([a, b]: string[], slow: string) => `(typeof ${a} === "number" && typeof ${b} === "number" ? ${a} + ${b} : ${slow})`,
        });
        // calls its first argument with the rest (a non-leaf, which calls back into the VM)
        anima.registerIntrinsic("%smoke-call", (regs: any[], start: number, nargs: number) => hostTailFrom(regs[start], regs, start + 1, nargs - 1), { args: [1, Infinity] });
        // Scheme code reaches intrinsics only through procedures the host defines, in native-scheme
        anima.evaluateRaw(compileNative(anima, `
            (define (smoke-add a b) (%intcall %smoke-add a b))
            (define smoke-call (%lambda (() (f) #null (%intcall %smoke-call f)) (() (f a b) #null (%intcall %smoke-call f a b))))`, "host.ns"));
        return anima;
    };
    const run = (anima: ReturnType<typeof createScheme>, src: string) => s.stringify(anima.evaluateRaw(anima.compileRaw(src)));

    it("runs Scheme", () => {
        const anima = instance();
        expect(run(anima, "(define (fib n) (if (< n 2) n (+ (fib (- n 1)) (fib (- n 2))))) (fib 20)")).toBe("6765");
        expect(run(anima, "(map (lambda (x) (* x x)) '(1 2 3))")).toBe("(1 4 9)");
        expect(run(anima, "(list (apply + 1 '(2 3)) (let loop ((l '(1 2 3)) (a 0)) (if (null? l) a (loop (cdr l) (+ a (car l))))))")).toBe("(6 6)");
        expect(run(anima, "(cond ((= 1 2) 'a) ((= 1 1) 'b) (else 'c))")).toBe("b");
        expect(run(anima, "(let-values (((a b) (values 1 2))) (list b a))")).toBe("(2 1)");
        expect(run(anima, "(let ((v (vector 1 2 3)) (t (table \"k\" 1))) (vector-set! v 0 9) (table-set! t \"j\" 2) (list (vector-ref v 0) (table-ref t \"j\")))")).toBe("(9 2)");
    });

    it("runs control flow", () => {
        const anima = instance();
        expect(run(anima, "(+ 1 (call/cc (lambda (k) (k 41))))")).toBe("42");
        expect(run(anima, "(let ((log '())) (dynamic-wind (lambda () (set! log (cons 'in log))) (lambda () 'body) (lambda () (set! log (cons 'out log)))) log)")).toBe("(out in)");
        expect(run(anima, "(try (lambda () (raise 'boom)) (lambda (e) (list 'caught e)))")).toBe("(caught boom)");
        expect(run(anima, "(let ((co (coroutine-create (lambda (a) (+ a (coroutine-yield (* a 2))))))) (list (coroutine-resume co 5) (coroutine-resume co 1)))")).toBe("(10 6)");
        expect(() => run(anima, "(car '())")).toThrow("car: list is too short");
    });

    it("runs host intrinsics", () => {
        const anima = instance();
        expect(run(anima, "(list (smoke-add 1 2) (smoke-call (lambda (a b) (* a b)) 6 7) (smoke-call +))")).toBe("(3 42 0)");
        expect(() => run(anima, "(%smoke-add 1 2)")).toThrow("Variable '%smoke-add' is not defined");
        expect(anima.scope).toBeDefined();
        expect(new Table()).toBeInstanceOf(Table);
    });

    it("runs native-scheme", () => {
        const ns = createNativeScheme(options);
        ns.registerIntrinsic("%add", (regs: any[], start: number) => regs[start] + regs[start + 1], { args: [2, 2], leaf: true });
        ns.registerIntrinsic("%less", (regs: any[], start: number) => regs[start] < regs[start + 1], { args: [2, 2], leaf: true });
        expect(ns.evaluateRaw(ns.compileRaw(`(define (sum n) (named-let loop ((i 0) (acc 0)) (%if (%intcall %less i n) (%call loop (%intcall %add i 1) (%intcall %add acc i)) acc))) (%call sum 10)`))).toBe(45);
    });
});
