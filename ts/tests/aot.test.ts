import { ASTStringifier } from '../common';
import { describe, it, expect } from 'vitest';
import { createScheme } from '../scheme';
import { ByteCode, AnimaVM, AotCompiler, OpCode } from '../bytecode-rvm/vm';
import { CORE_INTRINSICS, corePos } from '../bytecode-rvm/exec';
import { implAot } from '../bytecode-rvm/meta';

describe("JIT Compiler Runtime Compilation & Execution", () => {
    const animaScope = () => {
        const anima = createScheme(implAot);
        return anima.scope;
    };

    it("compiles functions AOT and executes natively", () => {
        const anima = createScheme(implAot);
        const code = anima.compileRaw(`
            (define (double x) (+ x x))
            double
        `);
        const doubleClosure = anima.evaluateRaw(code);
        const fnCode = doubleClosure.tmpl.code as ByteCode;

        expect(fnCode.resumeFn).not.toBeNull();
        expect(typeof fnCode.resumeFn).toBe("function");

        expect(anima.evaluateClosure(doubleClosure, [21])).toBe(42);
        expect(anima.evaluateClosure(doubleClosure, [50])).toBe(100);
        expect(anima.evaluateClosure(doubleClosure, [100])).toBe(200);
    });

    it("executes straight-line native opcodes completely natively in AOT", () => {
        const anima = createScheme(implAot);
        const code = anima.compileRaw(`(lambda (x) x)`);
        const idClosure = anima.evaluateRaw(code);
        const fnCode = idClosure.tmpl.code as ByteCode;

        expect(fnCode.resumeFn).not.toBeNull();
        expect(anima.evaluateClosure(idClosure, [42])).toBe(42);
        expect(anima.evaluateClosure(idClosure, [999])).toBe(999);
        expect(anima.evaluateClosure(idClosure, ["hello"])).toBe("hello");
    });

    it("loads negative and non-integer literals through LOADCONST", () => {
        const anima = createScheme(implAot);
        const bc = anima.compileRaw("(+ -42 -0.5 4294967296)") as ByteCode;
        expect(bc.constants).toEqual(expect.arrayContaining([-42, -0.5, 4294967296]));
        expect(anima.evaluateRaw(bc)).toBe(4294967253.5);
    });

    it("executes BOX, UNBOX, and SETBOX natively", () => {
        // 0: LOADU32 r1, 100
        // 3: BOX r2, r1
        // 6: LOADU32 r3, 200
        // 9: SETBOX r2, r3
        // 12: UNBOX r4, r2
        // 15: RETURN r4
        const inst = new Uint32Array([
            OpCode.LOADU32, 1, 100,
            OpCode.BOX, 2, 1,
            OpCode.LOADU32, 3, 200,
            OpCode.SETBOX, 2, 3,
            OpCode.UNBOX, 4, 2,
            OpCode.RETURN, 4
        ]);
        const bc = new ByteCode([], inst, 5);
        AotCompiler.compile(bc);

        const vm = new AnimaVM();
        expect(vm.evaluateRaw(bc, animaScope())).toBe(200);
    });

    it("executes LOADGLOBAL and SETGLOBAL natively", () => {
        const mySym = Symbol.for("jit-global-var");
        // 0: LOADU32 r1, 777
        // 3: SETGLOBAL r1, const(mySym)
        // 6: LOADGLOBAL r2, const(mySym)
        // 9: RETURN r2
        const inst = new Uint32Array([
            OpCode.LOADU32, 1, 777,
            OpCode.SETGLOBAL, 1, 0,
            OpCode.LOADGLOBAL, 2, 0,
            OpCode.RETURN, 2
        ]);
        const bc = new ByteCode([mySym], inst, 3);
        AotCompiler.compile(bc);

        const vm = new AnimaVM();
        const scope = animaScope();
        expect(vm.evaluateRaw(bc, scope)).toBe(777);
        expect(scope.get(mySym)).toBe(777);
    });

    it("deoptimizes cleanly to interpreter on unhandled opcodes", () => {
        // Function with straight-line ops followed by an unhandled opcode:
        // 0: LOADU32 r1, 50
        // 3: LOADU32 r2, 60
        // 6: CALLINT %list, dest=r0, start=r1, nargs=2
        // 11: RETURN r0
        const inst = new Uint32Array([
            OpCode.LOADU32, 1, 50,
            OpCode.LOADU32, 2, 60,
            OpCode.CALLINT, corePos("%list"), 0, 1, 2,
            OpCode.RETURN, 0
        ]);
        const bc = new ByteCode([], inst, 4, undefined, undefined, false, CORE_INTRINSICS, [{ pos: corePos("%list"), name: "%list", leaf: true }]);

        // Compile it with JIT
        AotCompiler.compile(bc);
        expect(bc.resumeFn).not.toBeNull();

        const vm = new AnimaVM();
        // Evaluating this will run native code for LOADU32 r1, 50 and LOADU32 r2, 60,
        // then hit deopt(6) at CALL, drop to interpreter, and execute CALL and RETURN!
        const res = vm.evaluateRaw(bc, animaScope());
        expect(new ASTStringifier().stringify(res)).toBe("(50 60)");
    });

    it("executes IF, ELSE, ENDIF control flow completely natively in AOT", () => {
        const anima = createScheme(implAot);
        const code = anima.compileRaw(`
            (define (my-branch c a b)
                (if c a b))
            my-branch
        `);
        const branchClosure = anima.evaluateRaw(code);
        const fnCode = branchClosure.tmpl.code as ByteCode;

        expect(fnCode.resumeFn).not.toBeNull();
        expect(anima.evaluateClosure(branchClosure, [true, 10, 20])).toBe(10);
        expect(anima.evaluateClosure(branchClosure, [false, 10, 20])).toBe(20);
        expect(anima.evaluateClosure(branchClosure, [true, 99, 100])).toBe(99);
        expect(anima.evaluateClosure(branchClosure, [false, 99, 100])).toBe(100);
    });

    it("executes nested IF, ELSE, ENDIF completely natively in AOT", () => {
        const anima = createScheme(implAot);
        const code = anima.compileRaw(`
            (define (classify a b)
                (if a
                    (if b "both" "only-a")
                    (if b "only-b" "neither")))
            classify
        `);
        const fnClosure = anima.evaluateRaw(code);
        const fnCode = fnClosure.tmpl.code as ByteCode;

        expect(fnCode.resumeFn).not.toBeNull();
        expect(anima.evaluateClosure(fnClosure, [true, true])).toBe("both");
        expect(anima.evaluateClosure(fnClosure, [true, false])).toBe("only-a");
        expect(anima.evaluateClosure(fnClosure, [false, true])).toBe("only-b");
        expect(anima.evaluateClosure(fnClosure, [false, false])).toBe("neither");
    });

    it("executes tail CALL recursively in JIT without stack overflow", () => {
        const anima = createScheme(implAot);
        const code = anima.compileRaw(`
            (define (sum-loop n acc)
                (if (= n 0)
                    acc
                    (sum-loop (- n 1) (+ acc n))))
            sum-loop
        `);
        const loopClosure = anima.evaluateRaw(code);
        const fnCode = loopClosure.tmpl.code as ByteCode;

        expect(fnCode.resumeFn).not.toBeNull();
        expect(anima.evaluateClosure(loopClosure, [5, 0])).toBe(15);
        expect(anima.evaluateClosure(loopClosure, [1000, 0])).toBe(500500);
        expect(anima.evaluateClosure(loopClosure, [5000, 0])).toBe(12502500);
    });

    it("executes non-tail CALL to user closures natively in AOT", () => {
        const anima = createScheme(implAot);
        const code = anima.compileRaw(`
            (define (square x) (* x x))
            (define (sum-of-squares a b)
                (+ (square a) (square b)))
            sum-of-squares
        `);
        const sumSqClosure = anima.evaluateRaw(code);
        const fnCode = sumSqClosure.tmpl.code as ByteCode;

        expect(fnCode.resumeFn).not.toBeNull();
        expect(anima.evaluateClosure(sumSqClosure, [3, 4])).toBe(25);
        expect(anima.evaluateClosure(sumSqClosure, [5, 12])).toBe(169);
        expect(anima.evaluateClosure(sumSqClosure, [6, 8])).toBe(100);
    });

    it("executes CALL with call/cc in AOT mode", () => {
        const anima = createScheme(implAot);
        const code = anima.compileRaw(`
            (define (test-callcc x)
                (+ x (call/cc (lambda (k) (+ 10 (k 5))))))
            test-callcc
        `);
        const fnClosure = anima.evaluateRaw(code);
        const fnCode = fnClosure.tmpl.code as ByteCode;

        expect(fnCode.resumeFn).not.toBeNull();

        // Run 1
        expect(anima.evaluateClosure(fnClosure, [100])).toBe(105);

        // Run 2
        expect(anima.evaluateClosure(fnClosure, [200])).toBe(205);

        // Run 3
        expect(anima.evaluateClosure(fnClosure, [300])).toBe(305);
    });
});
