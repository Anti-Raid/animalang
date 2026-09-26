import { ASTStringifier } from '../common';
import { describe, it, expect, beforeEach } from 'vitest';
import { Cons } from '../list';
import { createScheme } from '../scheme';
import { ByteCode, AotCompiler, OpCode } from '../bytecode-rvm/vm';
import { Closure, CORE_COUNT, CORE_INTRINSICS, corePos, INSTRUCTION_LENGTHS } from '../bytecode-rvm/exec';
import { Compiler } from '../bytecode-rvm/compiler';
import { Intrinsics } from '../bytecode-rvm/intrinsics';
import { Anima } from '../anima';
import { impl, implAot } from '../bytecode-rvm/meta';
import { dumpFull, readFull, stringifyInst } from '../bytecode-rvm/utils';
import { OPCODES } from '../bytecode-rvm/opcodes';
import { arityMessage, bindArgs, closureArity, restValue } from '../bytecode-rvm/arity';
import { CORE_FORMS, hasCore, newIntrinsics } from '../bytecode-rvm/core';
import { readdirSync, readFileSync } from 'fs';
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


    describe('Host intrinsics', () => {
        it('calls leaf intrinsics, inline and not', () => {
            expect(run(`(%test-add 1 2)`)).toBe("3")
            expect(run(`(%test-add "a" "b")`)).toBe('"ab"')
            expect(run(`(define (ht-sum n acc) (if (= n 0) acc (ht-sum (- n 1) (%test-add acc n)))) (ht-sum 100 0)`)).toBe("5050")
            expect(() => run(`(%test-add 1)`)).toThrow()
        })

        it('runs tail requests as Scheme calls', () => {
            expect(run(`(%test-call-or 5)`)).toBe("5")
            expect(run(`(%test-call-or (lambda (x) (* x 2)) 21)`)).toBe("42")
            expect(run(`(%test-call-or + 1 2)`)).toBe("3")
            expect(run(`(+ 1 (%test-call-or (lambda () 41)))`)).toBe("42")
            expect(run(`(define (ht-loop n) (if (= n 0) 'ok (%test-call-or ht-loop (- n 1)))) (ht-loop 100000)`)).toBe("ok")
        })

        it('lets tail requests yield, re-enter and raise', () => {
            expect(run(`(define ht-co (coroutine-create (lambda () (+ 1 (%test-call-or (lambda () (coroutine-yield 'y) 10))))))
                        (list (coroutine-resume ht-co) (coroutine-resume ht-co))`)).toBe("(y 11)")
            expect(run(`(define ht-k #f) (define ht-n 0)
                        (define ht-r (+ 100 (%test-call-or (lambda () (call/cc (lambda (k) (set! ht-k k) 1))))))
                        (set! ht-n (+ ht-n 1))
                        (if (< ht-n 3) (ht-k ht-n) (list ht-r ht-n))`)).toBe("(102 3)")
            expect(run(`(try (lambda () (%test-fail "boom")) (lambda (e) (error-message e)))`)).toBe('"boom"')
            expect(run(`(try (lambda () (%test-call-or (lambda () (raise 'inner)))) (lambda (e) e))`)).toBe("inner")
        })

        it('checks registrations, and freezing stops them but not compiling', () => {
            expect(() => evaluator.registerIntrinsic("no-percent", () => 1)).toThrow("start with '%'")
            expect(() => evaluator.registerIntrinsic("%test-add", () => 1)).toThrow("already defined")
            expect(() => evaluator.registerIntrinsic("%marks-first", () => 1)).toThrow("already defined")
            expect(() => evaluator.registerIntrinsic("%wind", () => 1)).toThrow("already defined")
            expect(() => evaluator.registerIntrinsic("%car", () => 1)).toThrow("already defined")
            expect(() => evaluator.registerIntrinsic("%test-range", () => 1, { args: [2, 1] })).toThrow("bad argument count range")
            expect(evaluator.freeze()).toBe(evaluator)
            expect(evaluator.intrinsics.frozen).toBe(true)
            expect(() => evaluator.registerIntrinsic("%test-late", () => 1)).toThrow("frozen")
            expect(run(`(%test-add 40 2)`)).toBe("42")
        })

        it('keeps intrinsics per instance, and code keeps the ones it was compiled with', () => {
            const other = createScheme(vmImpl)
            expect(() => other.evaluateRaw(other.compileRaw(`(%test-add 1 2)`))).toThrow()
            other.registerIntrinsic("%test-add", (regs, s) => regs[s] * regs[s + 1], { args: [2, 2], leaf: true })
            expect(s.stringify(other.evaluateRaw(other.compileRaw(`(%test-add 3 4)`)))).toBe("12")
            expect(run(`(%test-add 3 4)`)).toBe("7")
            const mul = other.evaluateRaw(other.compileRaw(`(lambda (a b) (%test-add a b))`))
            expect(s.stringify(evaluator.evaluateClosure(mul, [3, 4]))).toBe("12")
        })

        it('does not let intrinsics be bound as variables', () => {
            expect(() => run(`(lambda (%test-add) 1)`)).toThrow("which is an intrinsic")
            expect(() => run(`(let ((%marks-first 1)) 1)`)).toThrow("which is an intrinsic")
            expect(() => run(`(%test-add %test-add 1)`)).toThrow()
        })

        it('runs %if chains (c1 e1 c2 e2 ... [else]) as one flat IF ... ELSEIF ... ENDIF', () => {
            expect(run(`(list (%if #f 1 #t 2 3) (%if #f 1 #f 2 3) (void? (%if #f 1 #f 2)) (%if 'a 1 #t 2))`)).toBe("(2 3 #t 1)")
            // conditions run in order, and stop at the first true one
            expect(run(`(define ch-log '()) (define (ch-t x) (set! ch-log (cons x ch-log)) (= x 2))
                        (list (%if (ch-t 1) 'a (ch-t 2) 'b (ch-t 3) 'c 'd) ch-log)`)).toBe("(b (2 1))")
            // branches keep tail position, and a variable assigned in them is seen after
            expect(run(`(define (ch-count n) (cond ((= n 0) 'done) ((< n 0) 'neg) (else (ch-count (- n 1))))) (ch-count 100000)`)).toBe("done")
            expect(run(`(define (ch-set x) (let ((r 0)) (%if (= x 1) (set! r 'one) (= x 2) (set! r 'two) (set! r 'many)) r)) (list (ch-set 1) (ch-set 2) (ch-set 7))`)).toBe("(one two many)")
            const bc = evaluator.compileRaw(`(define (ch-f x) (cond ((= x 1) 'a) ((= x 2) 'b) (else 'c)))`) as ByteCode
            const fn: ByteCode = bc.constants.find((c: any) => c instanceof Closure)!.tmpl.code
            const ops: OpCode[] = []
            for (let ip = 0; ip < fn.inst.length; ip += INSTRUCTION_LENGTHS[fn.inst[ip] as OpCode]) ops.push(fn.inst[ip])
            expect(ops.filter(op => op === OpCode.IF || op === OpCode.ELSEIF || op === OpCode.ENDIF)).toEqual([OpCode.IF, OpCode.ELSEIF, OpCode.ENDIF])
            // however many clauses, in both modes
            const clauses = Array.from({ length: 1000 }, (_, i) => `((= x ${i}) ${i})`).join(" ")
            expect(run(`(define (ch-big x) (cond ${clauses} (else -1))) (list (ch-big 0) (ch-big 999) (ch-big 1000))`)).toBe("(0 999 -1)")
        })

        it('compiles builtin calls to intrinsics, and passes builtins as the prelude procedures', () => {
            const bc = evaluator.compileRaw(`(car (cons 1 2))`) as ByteCode
            expect(bc.intrinsics.map(used => used.name).sort()).toEqual(["%car", "%cons"])
            expect(run(`(car (cons 1 2))`)).toBe("1")
            expect(run(`(list (procedure? car) (map car '((1) (2))) (apply + '(1 2 3)) (apply list 1 '(2)) (apply values '(4)))`)).toBe("(#t (1 2) 6 (1 2) 4)")
            // a call with the wrong count stays an ordinary call, so it compiles, and fails only if it runs
            expect(run(`(if #f (car) 'fine)`)).toBe("fine")
            expect(() => run(`(apply car '(1 2))`)).toThrow("car: expected exactly 1 args, got 2")
            expect(() => run(`(apply vector-append '(1))`)).toThrow("vector-append requires all arguments to be vectors")
            expect(() => run(`(apply table-ref '(1))`)).toThrow("%table-ref: expected 2 to 3 args, got 1")
            // the builtins' intrinsics are at the same positions in every instance
            expect(createScheme(vmImpl).intrinsics.byName("%car")!.pos).toBe(evaluator.intrinsics.byName("%car")!.pos)
        })

        it('has no language without a front end', () => {
            const bare = new Anima(vmImpl)
            expect(bare.intrinsics.byName("%car")).toBeUndefined()
            expect(() => bare.compileRaw(`(+ 1 2)`)).toThrow("no front end")
            const ifForm = Cons.list(Symbol.for("%if"), false, 1, Cons.list(Symbol.for("%list"), 2, 3))
            expect(s.stringify(bare.evaluateRaw(bare.compileRawAst(ifForm)))).toBe("(2 3)")
        })

        it('gives inline templates their deps', () => {
            class Point { constructor(readonly x: number) {} }
            const other = createScheme(vmImpl)
            other.registerIntrinsic("%test-px", (regs, s) => regs[s].x, {
                args: [1, 1], leaf: true, deps: { Point },
                inline: ([p], slow, _tmp, d) => `(${p} instanceof ${d.Point} ? ${p}.x : ${slow})`,
            })
            other.scope.set(Symbol.for("pt"), new Point(5))
            expect(s.stringify(other.evaluateRaw(other.compileRaw(`(define (px p) (%test-px p)) (px pt)`)))).toBe("5")
            other.registerIntrinsic("%test-bad-dep", (regs, s) => regs[s], {
                args: [1, 1], leaf: true, inline: ([a], _slow, _tmp, d) => `(${d.Missing}, ${a})`,
            })
            const bad = other.compileRaw(`(%test-bad-dep 1)`)
            if (_mode === "aot") expect(() => other.evaluateRaw(bad)).toThrow("uses 'Missing', which is not in its deps")
            else expect(s.stringify(other.evaluateRaw(bad))).toBe("1")
        })
    });

})
})

describe("Opcode spec", () => {
    it("describes every opcode, and instruction lengths follow from it", () => {
        const ops = Object.values(OpCode).filter((v): v is OpCode => typeof v === "number")
        // the enum (in exec.ts, for the interpreter) and the spec list the same opcodes in the same order
        expect(OPCODES.map(spec => spec.name)).toEqual(ops.map(op => OpCode[op]))
        for (const op of ops) {
            expect(INSTRUCTION_LENGTHS[op], OpCode[op]).toBe(1 + OPCODES[op].operands.length)
            // a tail call's `tail` operand says whether the next instruction starts a block
            expect(OPCODES[op].split === "nonTail", OpCode[op]).toBe(OPCODES[op].operands.some(([, kind]) => kind === "tail"))
        }
    })

    it("disassembles from the spec", () => {
        const anima = createScheme(impl)
        const bc = anima.compileRaw(`
            (define (ds-ap f . xs) (%apply-multi f xs))
            (define (ds-sum . xs) (%apply %+ xs))
            (let-values (((a . b) (values 1 2))) (if a (car b) (ds-ap ds-sum 1 '(2))))`) as ByteCode
        const lines = stringifyInst(bc)
        const sum = stringifyInst(bc.constants.find((c: any) => c instanceof Closure && c.debugName === "ds-sum").tmpl.code)
        const ap = stringifyInst(bc.constants.find((c: any) => c instanceof Closure && c.debugName === "ds-ap").tmpl.code)
        expect(lines).toContain("0000: LOADCONST   dst=r1, const=c.fn(f . xs)")
        expect(lines.some(line => /UNPACK +src=r\d+, start=r\d+, count=1, flags=rest\|strict/.test(line))).toBe(true)
        expect(lines.some(line => /CALLINT +pos=%car, /.test(line))).toBe(true)
        expect(lines.some(line => /LOADCONST +dst=r\d+, const=\(2\)$/.test(line))).toBe(true)
        expect(lines.some(line => /CALL +proc=r\d+, start=r\d+, nargs=3, tail=tail$/.test(line))).toBe(true)
        expect(sum.some(line => /APPLYINTR +pos=%\+, dst=r\d+, start=r\d+, nargs=1$/.test(line))).toBe(true)
        expect(ap.some(line => /CALLHOST +pos=%apply-array-multi, start=r\d+, nargs=2, tail=tail$/.test(line))).toBe(true)
        // ips count by the spec's lengths
        const ips = lines.filter(line => /^\d{4}:/.test(line)).map(line => +line.slice(0, 4))
        for (let i = 1; i < ips.length; i++) expect(ips[i] - ips[i - 1]).toBe(INSTRUCTION_LENGTHS[bc.inst[ips[i - 1]] as OpCode])
    })

})
describe("Core operations", () => {
    it("are the first entries of every table, at the same positions", () => {
        const a = createScheme(impl), b = createScheme(implAot)
        for (const table of [a.intrinsics, b.intrinsics, newIntrinsics(), newIntrinsics(a.intrinsics)]) {
            expect(hasCore(table)).toBe(true)
            expect(table.byName("%list")!.pos).toBe(corePos("%list"))
        }
        expect(CORE_COUNT).toBe(CORE_INTRINSICS.entries.length)
        expect(() => new Compiler(new Intrinsics())).toThrow("must start with the core operations")
        expect(() => a.registerIntrinsic("%list", () => null)).toThrow("'%list' is already defined")
        expect(() => CORE_INTRINSICS.register("%x", () => null)).toThrow("frozen")
        expect(() => a.registerIntrinsic("%x", () => null, { context: true })).toThrow("only the VM's core operations do")
        // leaves that take the context have their own opcode, so other intrinsic calls pass just the window
        const ops = (a.compileRaw("(%coroutine-create (lambda () 1))") as ByteCode).inst
        expect(Array.from(ops)).toContain(OpCode.CALLCTX)
    })

    it("compile and apply like any intrinsic", () => {
        for (const vmImpl of [impl, implAot]) {
            const anima = createScheme(vmImpl)
            const run = (src: string) => new ASTStringifier().stringify(anima.evaluateRaw(anima.compileRaw(src)))
            expect(run("(%list 1 2 3)")).toBe("(1 2 3)")
            expect(run("(%apply %list 1 '(2 3))")).toBe("(1 2 3)")
            // one that takes the context, applied
            expect(run("(let ((co (%coroutine-create (lambda () 1)))) (%apply %coroutine-status (list co)))")).toBe("suspended")
            expect(run("(let ((co (%coroutine-create (lambda () 1)))) (%coroutine-close co) (%coroutine-status co))")).toBe("dead")
            expect(() => run("(%list->values 1 2)")).toThrow("%list->values: expected exactly 1 args, got 2")
        }
        const anima = createScheme(impl)
        const bc = anima.compileRaw("(%list 1 2)") as ByteCode
        expect(stringifyInst(bc).some(line => /CALLINT +pos=%list, /.test(line))).toBe(true)
        // code that only uses core operations loads without a table
        expect(new ASTStringifier().stringify(anima.evaluateRaw(readFull(dumpFull(bc)) as ByteCode))).toBe("(1 2)")
    })
})
describe("Control operations", () => {
    it("are core intrinsics that return requests the VM carries out at the call", () => {
        for (const vmImpl of [impl, implAot]) {
            const anima = createScheme(vmImpl)
            const run = (src: string) => new ASTStringifier().stringify(anima.evaluateRaw(anima.compileRaw(src)))
            for (const name of ["%call/cc", "%raise", "%current-stack", "%coroutine-yield", "%coroutine-resume", "%apply-list", "%apply-array"]) {
                const entry = CORE_INTRINSICS.byName(name)!
                expect(entry.leaf, name).toBe(false)
                expect(anima.intrinsics.byName(name), name).toBe(entry)
            }
            expect(run("(+ 1 (%call/cc (lambda (k) (k 41))))")).toBe("42")
            // a tail %call/cc is a tail call: a loop through it runs in constant space
            expect(run("(define (cc-loop n) (if (= n 0) 'done (%call/cc (lambda (k) (cc-loop (- n 1)))))) (cc-loop 100000)")).toBe("done")
            expect(run("(%catch (lambda () (%raise 'boom)) (lambda (e) (list 'caught e)))")).toBe("(caught boom)")
            expect(() => run("(%raise 'boom 5)")).toThrow("%raise: continuable must be #t or #f")
            expect(run("(define (cs-f skip) (vector-ref (car (%debug-frames (%current-stack skip) '())) 0)) (cs-f 0)")).toBe('"cs-f"')
            expect(() => run("(%current-stack -1)")).toThrow("%current-stack: expected a count of frames to skip")
            expect(() => run("(%apply-array list '(1))")).toThrow("%apply-array: the last argument must be a rest array")
            expect(run("(let ((co (%coroutine-create (lambda (a) (+ a (%coroutine-yield (* a 2))))))) (list (%coroutine-resume co 5) (%coroutine-resume co 1)))")).toBe("(10 6)")
            // the Scheme names are aliases: a call whose count does not fit calls the prelude procedure, which reports it
            expect(run("(list (call/cc (lambda (k) (k 1))) (dynamic-wind (lambda () 0) (lambda () 2) (lambda () 0)) (map call/cc (list (lambda (k) 3))))")).toBe("(1 2 (3))")
            expect(() => run("(raise 'a 'b)")).toThrow("raise: expected exactly 1 args, got 2")
            expect(() => run("(call/cc)")).toThrow("call/cc: expected exactly 1 args, got 0")
            expect(() => run("(define (call/cc x) x)")).toThrow("cannot bind builtin call/cc")
        }
        // AOT code carries control operations out at the call, with no request object
        const co = createScheme(impl).compileRaw("(define (co-f v) (+ 1 (%coroutine-yield v)))") as ByteCode
        const coTmpl = co.constants.find((c: any) => c instanceof Closure)!.tmpl
        const src = AotCompiler.generateSource(coTmpl.code, coTmpl)
        expect(src).toContain("executor.coYield(ctx, frame, r")
        expect(src).toContain("throw Suspend.yield(r")
        expect(src).not.toContain("res.run(")
        const bc = createScheme(impl).compileRaw("(define (cc-f g) (%call/cc g))") as ByteCode
        const lines = stringifyInst(bc.constants.find((c: any) => c instanceof Closure)!.tmpl.code)
        expect(lines.some(line => /CALLHOST +pos=%call\/cc, start=r\d+, nargs=1, tail=tail$/.test(line))).toBe(true)
    })
})
describe("Argument binding", () => {
    it("binds positionals and a rest list or array, in place over the argument window too", () => {
        const list = closureArity(2, "list")
        expect(list).toEqual({ min: 2, max: Infinity, rest: "list" })
        const fresh: any[] = []
        bindArgs(list, fresh, ["x", "a", "b", "c", "d"], 1, 4)
        expect(fresh.slice(0, 2)).toEqual(["a", "b"])
        expect(new ASTStringifier().stringify(fresh[2])).toBe('("c" "d")')
        // a self tail call: the window overlaps the parameters it is bound to
        const regs = ["p0", "p1", "p2", "a", "b", "c"]
        bindArgs(closureArity(2, "array"), regs, regs, 1, 5)
        expect(regs.slice(0, 3)).toEqual(["p1", "p2", ["a", "b", "c"]])
        const exact = ["p0", "p1", "x", "y"]
        bindArgs(closureArity(2, "none"), exact, exact, 2, 2)
        expect(exact).toEqual(["x", "y", "x", "y"])
        // an owned argument array can be the rest array itself; otherwise it is copied
        const args = [1, 2]
        expect(restValue("array", args, 0, 2, true)).toBe(args)
        expect(restValue("array", args, 0, 2)).not.toBe(args)
        expect(restValue("list", args, 2, 2)).toBe(null)
    })

    it("gives closures and intrinsics one arity message", () => {
        expect(arityMessage("f", 2, 2, 1)).toBe("f: expected exactly 2 args, got 1")
        expect(arityMessage("f", 1, Infinity, 0)).toBe("f: expected at least 1 args, got 0")
        expect(arityMessage("f", 2, 3, 4)).toBe("f: expected 2 to 3 args, got 4")
        const anima = createScheme(impl)
        const tmpl = (anima.compileRaw("(define (ab-f a . r) r)") as ByteCode).constants.find((c: any) => c instanceof Closure)!.tmpl
        expect(tmpl.arity).toEqual({ min: 1, max: Infinity, rest: "list" })
        expect(() => anima.evaluateRaw(anima.compileRaw("(define (ab-g a b) a) (ab-g 1)"))).toThrow("ab-g: expected exactly 2 args, got 1")
        expect(() => anima.evaluateRaw(anima.compileRaw("(%apply %car '(1 2))"))).toThrow("%car: expected exactly 1 args, got 2")
        expect(() => anima.compileRaw("(%car 1 2)")).toThrow("%car: expected exactly 1 args, got 2")
    })
})
describe("Compiler intrinsics", () => {
    it("are all documented in the compiler's README", () => {
        const readme = readFileSync(new URL("../bytecode-rvm/README.md", import.meta.url), "utf8");
        const documented = (name: string) => new RegExp("[`(]" + name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&") + "[`\\s)]").test(readme);
        expect([...[...CORE_FORMS.keys()].map(sym => Symbol.keyFor(sym)!), ...CORE_INTRINSICS.entries.map(entry => entry.name)].filter(name => !documented(name))).toEqual([]);
    });

    it("belong to a compiler that knows nothing of the Scheme front end", () => {
        const dir = new URL("../bytecode-rvm/", import.meta.url);
        const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => `${(entry as any).parentPath ?? (entry as any).path}/${entry.name}`);
        const mentions = files.filter(file => /scheme/i.test(readFileSync(file, "utf8")));
        expect(mentions).toEqual([]);
    });
});
