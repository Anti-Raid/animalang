import { ASTStringifier } from '../scheme/printer';
import { Msg, VMError, type Formatter } from '../common';
import { schemeFormat } from '../scheme/messages';
import { describe, it, expect, beforeEach } from 'vitest';
import { Cons } from '../scheme/list';
import { createScheme } from '../scheme';
import { Code, AotCompiler } from '../bytecode-rvm/vm';
import { Closure, CORE_COUNT, CORE_INTRINSICS, corePos, listing } from '../bytecode-rvm/exec';
import { Compiler } from '../bytecode-rvm/compiler';
import { Intrinsics } from '../bytecode-rvm/intrinsics';
import { Anima } from '../anima';
import { impl } from '../bytecode-rvm/meta';
import { bindArgs, closureArity } from '../bytecode-rvm/arity';
import { CORE_FORMS, hasCore, newIntrinsics } from '../bytecode-rvm/core';
import { readdirSync, readFileSync } from 'fs';
import { opKinds, registerTestIntrinsics, runNative } from './helpers';
import { compileNative } from '../native';

describe("vm", () => {
    const vmImpl = impl
let bcCache: Record<string, Code> = {}
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
    const nrun = (expr: string) => s.stringify(runNative(evaluator, expr))


    describe('Host intrinsics', () => {
        it('calls leaf intrinsics, inline and not', () => {
            expect(nrun(`(%intcall %test-add 1 2)`)).toBe("3")
            expect(nrun(`(%intcall %test-add "a" "b")`)).toBe('"ab"')
            expect(nrun(`(define (ht-sum n acc) (%if (%call = n 0) acc (%call ht-sum (%call - n 1) (%intcall %test-add acc n)))) (%call ht-sum 100 0)`)).toBe("5050")
            expect(() => nrun(`(%intcall %test-add 1)`)).toThrow()
        })

        it('runs tail requests as Scheme calls', () => {
            expect(nrun(`(%intcall %test-call-or 5)`)).toBe("5")
            expect(nrun(`(%intcall %test-call-or (lambda (x) (%call * x 2)) 21)`)).toBe("42")
            expect(nrun(`(%intcall %test-call-or + 1 2)`)).toBe("3")
            expect(nrun(`(%call + 1 (%intcall %test-call-or (lambda () 41)))`)).toBe("42")
            expect(nrun(`(define (ht-loop n) (%if (%call = n 0) 'ok (%intcall %test-call-or ht-loop (%call - n 1)))) (%call ht-loop 100000)`)).toBe("ok")
        })

        it('lets tail requests yield, re-enter and raise', () => {
            expect(nrun(`(define ht-co (%call coroutine-create (lambda () (%call + 1 (%intcall %test-call-or (lambda () (%call coroutine-yield 'y) 10)))))) (%call list (%call coroutine-resume ht-co) (%call coroutine-resume ht-co))`)).toBe("(y 11)")
            expect(nrun(`(define ht-k #f) (define ht-n 0) (define ht-r (%call + 100 (%intcall %test-call-or (lambda () (%call call/cc (lambda (k) (%set! ht-k k) 1)))))) (%set! ht-n (%call + ht-n 1)) (%if (%call < ht-n 3) (%call ht-k ht-n) (%call list ht-r ht-n))`)).toBe("(102 3)")
            expect(nrun(`(%call try (lambda () (%intcall %test-fail "boom")) (lambda (e) (%call error-message e)))`)).toBe('"boom"')
            expect(nrun(`(%call try (lambda () (%intcall %test-call-or (lambda () (%call raise 'inner)))) (lambda (e) e))`)).toBe("inner")
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
            expect(nrun(`(%intcall %test-add 40 2)`)).toBe("42")
        })

        it('keeps intrinsics per instance, and code keeps the ones it was compiled with', () => {
            const other = createScheme(vmImpl)
            expect(() => runNative(other, `(%intcall %test-add 1 2)`)).toThrow("%test-add is not an intrinsic")
            other.registerIntrinsic("%test-add", (regs, s) => regs[s] * regs[s + 1], { args: [2, 2], leaf: true })
            expect(s.stringify(runNative(other, `(%intcall %test-add 3 4)`))).toBe("12")
            expect(nrun(`(%intcall %test-add 3 4)`)).toBe("7")
            const mul = runNative(other, `(lambda (a b) (%intcall %test-add a b))`)
            expect(s.stringify(evaluator.evaluateClosure(mul, [3, 4]))).toBe("12")
        })

        it('does not let intrinsics be bound as variables', () => {
            expect(() => nrun(`(lambda (%test-add) 1)`)).toThrow("which is an intrinsic")
            expect(() => nrun(`(let ((%marks-first 1)) 1)`)).toThrow("which is an intrinsic")
            expect(() => nrun(`(%intcall %test-add %test-add 1)`)).toThrow()
        })

        it('runs %if chains (c1 e1 c2 e2 ... [else]) as one flat IF ... ELSEIF ... ENDIF', () => {
            expect(nrun(`(%call list (%if #f 1 #t 2 3) (%if #f 1 #f 2 3) (%call void? (%if #f 1 #f 2)) (%if 'a 1 #t 2))`)).toBe("(2 3 #t 1)")
            // conditions run in order, and stop at the first true one
            expect(nrun(`(define ch-log '()) (define (ch-t x) (%set! ch-log (%call cons x ch-log)) (%call = x 2)) (%call list (%if (%call ch-t 1) 'a (%call ch-t 2) 'b (%call ch-t 3) 'c 'd) ch-log)`)).toBe("(b (2 1))")
            // branches keep tail position, and a variable assigned in them is seen after
            expect(run(`(define (ch-count n) (cond ((= n 0) 'done) ((< n 0) 'neg) (else (ch-count (- n 1))))) (ch-count 100000)`)).toBe("done")
            expect(nrun(`(define (ch-set x) (let ((r 0)) (%if (%call = x 1) (%set! r 'one) (%call = x 2) (%set! r 'two) (%set! r 'many)) r)) (%call list (%call ch-set 1) (%call ch-set 2) (%call ch-set 7))`)).toBe("(one two many)")
            const bc = evaluator.compileRaw(`(define (ch-f x) (cond ((= x 1) 'a) ((= x 2) 'b) (else 'c)))`) as Code
            const fn: Code = bc.constants.find((c: any) => c instanceof Closure)!.tmpl.code
            expect(opKinds(fn).filter(k => k === "If" || k === "ElseIf" || k === "EndIf")).toEqual(["If", "ElseIf", "EndIf"])
            // however many clauses
            const clauses = Array.from({ length: 1000 }, (_, i) => `((= x ${i}) ${i})`).join(" ")
            expect(run(`(define (ch-big x) (cond ${clauses} (else -1))) (list (ch-big 0) (ch-big 999) (ch-big 1000))`)).toBe("(0 999 -1)")
        })

        it('compiles builtin calls to intrinsics, and passes builtins as the prelude procedures', () => {
            const bc = evaluator.compileRaw(`(car (cons 1 2))`) as Code
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

        it('words its messages through the table\'s formatter', () => {
            const lua = createScheme(vmImpl)
            const base = lua.intrinsics.format
            const luaFormat: Formatter = (op, args, fmt, at) => {
                const where = at === null ? "" : `${at.file}:${at.line}: `
                if (op === Msg.NonProcedure) return `${where}attempt to call a ${typeof args[0]} value`
                if (op === Msg.Arity) return `bad argument count to '${args[0]}'`
                if (op === Msg.TracebackHeader) return `${args[0]}\nstack traceback (lua):`
                return base(op, args, fmt, at)
            }
            lua.intrinsics.setFormatter(luaFormat)
            const run = (src: string) => lua.evaluateRaw(lua.compileRaw(src))
            // with where it happened (a tail call leaves no frame to tell)
            expect(() => run("(+ 1 (5 1))")).toThrow(/:1: attempt to call a number value$/)
            // Anima code that catches it sees the same message
            expect(run("(try (lambda () (+ 1 (5 1))) (lambda (e) (error-message e)))")).toMatch(/:1: attempt to call a number value$/)
            expect(() => run("(define (fm-f a) a) (fm-f)")).toThrow("bad argument count to 'fm-f'")
            expect(() => runNative(lua, "(%intapply %car (%intcall %spread '(1 2)))")).toThrow("bad argument count to '%car'")
            // compile-time messages too
            expect(() => compileNative(lua, "(%intcall %car 1 2)")).toThrow("bad argument count to '%car'")
            expect(run(`(debug-traceback "m")`)).toMatch(/^m\nstack traceback \(lua\):\n/)

            // a formatter that only words values: every message shows them its way
            const other = createScheme(vmImpl)
            other.intrinsics.setFormatter((op, args, fmt, at) => op === Msg.Value ? "<v>" : schemeFormat(op, args, fmt, at))
            expect(() => other.evaluateRaw(other.compileRaw("(5 1)"))).toThrow("Attempted to call a non-procedure: <v>")
            expect(() => other.evaluateRaw(other.compileRaw("(raise 'boom)"))).toThrow("<v>")
        })

        it('pads the arguments of a padded clause (Lua)', () => {
            const S = Symbol.for
            const L = (options: string[], params: string[], rest: string | null, ...body: any[]) => [S("%lambda"), [options.map(S), params.map(S), rest === null ? null : S(rest), ...body]]
            const list = (...xs: any[]) => [S("%intcall"), S("%list"), ...xs]
            const call = (f: string, ...xs: any[]) => [S("%call"), S(f), ...xs]
            const q = (x: any) => [S("%quote"), x]
            // core forms, straight to the compiler (compileRawAst would read them as Scheme data)
            const compile = (ast: any) => evaluator.compiler.compile(ast)
            const run = (ast: any) => s.stringify(evaluator.evaluateRaw(compile(ast)))
            const f = L(["pad"], ["a", "b"], null, list(S("a"), S("b")))
            // missing ones are <#void>, extra ones dropped: bound locally, globally, and applied
            expect(run([S("%let"), [[S("f"), f]], list(call("f", 1), call("f", 1, 2), call("f", 1, 2, 3), call("f"))])).toBe("((1 <#void>) (1 2) (1 2) (<#void> <#void>))")
            expect(run([S("%begin"), [S("%define-global"), S("pf"), f], list(call("pf", 1), call("pf", 1, 2, 3), [S("%apply"), S("pf"), [S("%quote"), [7]]])])).toBe("((1 <#void>) (1 2) (7 <#void>))")
            // with a rest parameter, extra ones go to it
            const r = L(["pad"], ["a"], "r", list(S("a"), S("r")))
            expect(run([S("%let"), [[S("r"), r]], list(call("r"), call("r", 1, 2, 3))])).toBe("((<#void> ()) (1 (2 3)))")
            // a self tail call with fewer arguments pads them too
            const loop = L(["pad"], ["n", "acc"], null, [S("%if"), call("=", S("n"), 0), S("acc"), call("g", call("-", S("n"), 1))])
            expect(run([S("%letrec"), [[S("g"), loop]], call("g", 3, q(S("x")))])).toBe("<#void>")
            // deep, past direct code's depth, with an extra argument each time
            const deep = L(["pad"], ["n"], null, [S("%if"), call("=", S("n"), 0), 0, call("+", 1, call("h", call("-", S("n"), 1), q(S("extra"))))])
            expect(run([S("%begin"), [S("%define-global"), S("h"), deep], call("h", 3000)])).toBe("3000")
            // a padded last clause takes the counts no clause before it does
            const two = [S("%lambda"), [[], [S("a")], null, q(S("one"))], [[S("pad")], [S("a"), S("b")], null, list(S("a"), S("b"))]]
            expect(run([S("%begin"), [S("%define-global"), S("t2"), two], list(call("t2", 1), call("t2"), call("t2", 1, 2, 3))])).toBe("(one (<#void> <#void>) (1 2))")
            expect(run([S("%let"), [[S("t3"), two]], list(call("t3", 1), call("t3"), call("t3", 1, 2, 3))])).toBe("(one (<#void> <#void>) (1 2))")
            expect(() => compile([S("%lambda"), [[S("pad")], [], null, 1], [[], [], null, 2]])).toThrow("a clause after a padded one would never run")
            expect(() => compile([S("%lambda"), [[S("nope")], [], null, 1]])).toThrow("unknown clause option nope")
            // the host can call it
            const made = evaluator.evaluateRaw(compile(f))
            expect(s.stringify(evaluator.evaluateClosure(made, [5]))).toBe("(5 <#void>)")
        })

        it('has no language without a front end', () => {
            const bare = new Anima(vmImpl)
            expect(bare.intrinsics.byName("%car")).toBeUndefined()
            expect(() => bare.compileRaw(`(+ 1 2)`)).toThrow("no front end")
            const ifForm = [Symbol.for("%if"), false, 1, [Symbol.for("%intcall"), Symbol.for("%values"), 2, 3]]
            expect(s.stringify(bare.evaluateRaw(bare.compileRawAst(ifForm)))).toBe("(values 2 3)")
            // its sequences are arrays: rest parameters, and what %apply spreads
            const restForm = [Symbol.for("%call"), [Symbol.for("%lambda"), [[], [], Symbol.for("r"), Symbol.for("r")]], 1, 2]
            expect(bare.evaluateRaw(bare.compileRawAst(restForm))).toEqual([1, 2])
            const applyForm = [Symbol.for("%apply"), [Symbol.for("%lambda"), [[], [Symbol.for("a")], Symbol.for("r"), Symbol.for("r")]], 1, [Symbol.for("%quote"), [2, 3]]]
            expect(bare.evaluateRaw(bare.compileRawAst(applyForm))).toEqual([2, 3])
            // values print neutrally, unless the front end has its own printer
            // nor wording: without a formatter, a message is its op's name, and the host reads the op and its arguments
            expect(evaluator.intrinsics.print([true, null, Symbol.for("a"), "s"])).toBe('#(#t () a "s")')
            expect(bare.intrinsics.print([true])).toBe("Value")
            let thrown: any
            try { bare.evaluateRaw(bare.compileRawAst([Symbol.for("%intcall"), Symbol.for("%values"), [Symbol.for("%call"), 5, 1]])) } catch (err) { thrown = err }
            expect(thrown).toBeInstanceOf(VMError)
            expect([thrown.message, thrown.op, thrown.args]).toEqual(["NonProcedure", Msg.NonProcedure, [5]])
            expect(() => bare.compileRawAst([])).toThrow("EmptyForm")
            // every call is explicit: a bare (f ...) is no core form, and %intcall names an intrinsic the table has
            expect(() => bare.compileRawAst([Symbol.for("f"), 1])).toThrow("BareCall")
            expect(() => bare.compileRawAst([Symbol.for("%intcall"), Symbol.for("%nope"), 1])).toThrow("UnknownIntrinsic")
            expect(() => evaluator.compiler.compile([Symbol.for("%car"), 1])).toThrow("%car is not a core form")
            // a front end has one pack and one spread
            expect(() => evaluator.registerIntrinsic("%my-pack", () => null, { leaf: true, sequence: "pack" })).toThrow("already has a sequence pack")
            expect(() => bare.registerIntrinsic("%my-spread", () => null, { sequence: "spread" })).toThrow("must be a leaf")
        })

        it('gives inline templates their deps', () => {
            class Point { constructor(readonly x: number) {} }
            const other = createScheme(vmImpl)
            other.registerIntrinsic("%test-px", (regs, s) => regs[s].x, {
                args: [1, 1], leaf: true, deps: { Point },
                inline: ([p], slow, _tmp, d) => `(${p} instanceof ${d.Point} ? ${p}.x : ${slow})`,
            })
            other.scope.set(Symbol.for("pt"), new Point(5))
            expect(s.stringify(runNative(other, `(define (px p) (%intcall %test-px p)) (%call px pt)`))).toBe("5")
            other.registerIntrinsic("%test-bad-dep", (regs, s) => regs[s], {
                args: [1, 1], leaf: true, inline: ([a], _slow, _tmp, d) => `(${d.Missing}, ${a})`,
            })
            const bad = compileNative(other, `(%intcall %test-bad-dep 1)`)
            expect(() => other.evaluateRaw(bad)).toThrow("uses 'Missing', which is not in its deps")
        })
    });

})
})

describe("Optimizer properties", () => {
    it("are declared by the front end, on leaves that take no context only", () => {
        const anima = createScheme(impl)
        const of = (name: string) => anima.intrinsics.byName(name)!
        expect([of("%+").foldable, of("%+").effectFree]).toEqual([true, false])
        expect([of("%cons").foldable, of("%cons").effectFree]).toEqual([false, true])
        expect([of("%null?").foldable, of("%null?").effectFree]).toEqual([true, true])
        expect([of("%vector-set!").foldable, of("%vector-set!").effectFree]).toEqual([false, false])
        expect(of("%values").effectFree).toBe(true)
        expect(() => anima.registerIntrinsic("%test-nonleaf", () => 1, { foldable: true })).toThrow("must be a leaf that takes no context")
        expect(anima.registerIntrinsic("%test-host", () => 1, { leaf: true }).foldable).toBe(false)
    })
})

describe("Instructions", () => {
    it("are listed by kind and fields", () => {
        const anima = createScheme(impl)
        const bc = anima.compileRaw(`
            (define (ds-ap f . xs) (apply f 1 xs))
            (define (ds-sum . xs) (apply + xs))
            (define (ds-l f lst) (apply f lst))
            (let-values (((a . b) (values 1 2))) (if a (car b) (ds-ap ds-sum 1 '(2))))`) as Code
        const lines = listing(bc)
        const sum = listing(bc.constants.find((c: any) => c instanceof Closure && c.debugName === "ds-sum").tmpl.code)
        const ap = listing(bc.constants.find((c: any) => c instanceof Closure && c.debugName === "ds-ap").tmpl.code)
        expect(lines).toContain("0000: LoadConst   dst=r1, idx=c.fn(f . xs)")
        expect(lines.some(line => /Unpack +src=r\d+, start=r\d+, count=1, flags=rest\|strict/.test(line))).toBe(true)
        expect(lines.some(line => /IntCall +pos=%car, /.test(line))).toBe(true)
        expect(lines.some(line => /LoadConst +dst=r\d+, idx=\(2\)$/.test(line))).toBe(true)
        expect(lines.some(line => /Call +proc=r\d+, start=r\d+, nargs=3, tail=true$/.test(line))).toBe(true)
        expect(sum.some(line => /IntApply +pos=%\+, dst=r\d+, start=r\d+, nargs=1$/.test(line))).toBe(true)
        expect(ap.some(line => /HostCall +pos=%apply-array, start=r\d+, nargs=3, tail=true$/.test(line))).toBe(true)
        // a spread list is a new array, called with as it is
        const l = listing(bc.constants.find((c: any) => c instanceof Closure && c.debugName === "ds-l").tmpl.code)
        expect(l.some(line => /HostCall +pos=%apply-fresh, start=r\d+, nargs=2, tail=true$/.test(line))).toBe(true)
        // an instruction's position is its index
        bc.ops.forEach((op, i) => expect(op.ip).toBe(i))
    })

})
describe("Core operations", () => {
    it("are the first entries of every table, at the same positions", () => {
        const a = createScheme(impl), b = createScheme(impl)
        for (const table of [a.intrinsics, b.intrinsics, newIntrinsics(), newIntrinsics(a.intrinsics)]) {
            expect(hasCore(table)).toBe(true)
            expect(table.byName("%values")!.pos).toBe(corePos("%values"))
        }
        expect(CORE_COUNT).toBe(CORE_INTRINSICS.entries.length)
        expect(() => new Compiler(new Intrinsics())).toThrow("must start with the core operations")
        expect(() => a.registerIntrinsic("%values", () => null)).toThrow("'%values' is already defined")
        expect(() => CORE_INTRINSICS.register("%x", () => null)).toThrow("frozen")
        expect(() => a.registerIntrinsic("%x", () => null, { context: true })).toThrow("only the VM's core operations do")
        // a leaf that takes the context is an IntCall like any other
        const ops = (compileNative(a, "(%intcall %coroutine-create (lambda () 1))") as Code).ops
        expect(ops.some(op => op.k === "IntCall" && op.pos === corePos("%coroutine-create"))).toBe(true)
    })

    it("compile and apply like any intrinsic", () => {
        {
            const vmImpl = impl
            const anima = createScheme(vmImpl)
            const run = (src: string) => new ASTStringifier().stringify(runNative(anima, src))
            expect(run("(%intcall %list 1 2 3)")).toBe("(1 2 3)")
            expect(run("(%intapply %list 1 (%intcall %spread '(2 3)))")).toBe("(1 2 3)")
            // one that takes the context, applied
            expect(run("(let ((co (%intcall %coroutine-create (lambda () 1)))) (%intapply %coroutine-status (%intcall %spread (%intcall %list co))))")).toBe("suspended")
            expect(run("(let ((co (%intcall %coroutine-create (lambda () 1)))) (%intcall %coroutine-close co) (%intcall %coroutine-status co))")).toBe("dead")
            expect(() => run("(%intcall %values->array 1 2)")).toThrow("%values->array: expected exactly 1 args, got 2")
        }
        const anima = createScheme(impl)
        const bc = compileNative(anima, "(%intcall %values 1 2)") as Code
        expect(listing(bc).some(line => /IntCall +pos=%values, /.test(line))).toBe(true)
    })
})
describe("Control operations", () => {
    it("are core intrinsics that return requests the VM carries out at the call", () => {
        {
            const vmImpl = impl
            const anima = createScheme(vmImpl)
            const run = (src: string) => new ASTStringifier().stringify(anima.evaluateRaw(anima.compileRaw(src)))
            for (const name of ["%call/cc", "%raise", "%current-stack", "%coroutine-yield", "%coroutine-resume", "%coroutine-resume-array", "%apply-array"]) {
                const entry = CORE_INTRINSICS.byName(name)!
                expect(entry.leaf, name).toBe(false)
                expect(anima.intrinsics.byName(name), name).toBe(entry)
            }
            const nrun = (src: string) => new ASTStringifier().stringify(runNative(anima, src))
            expect(nrun("(%intcall %+ 1 (%intcall %call/cc (lambda (k) (%call k 41))))")).toBe("42")
            // a tail %call/cc is a tail call: a loop through it runs in constant space
            expect(nrun("(define (cc-loop n) (%if (%intcall %= n 0) 'done (%intcall %call/cc (lambda (k) (%call cc-loop (%intcall %- n 1)))))) (%call cc-loop 100000)")).toBe("done")
            expect(nrun("(%catch (lambda () (%intcall %raise 'boom)) (lambda (e) (%intcall %list 'caught e)))")).toBe("(caught boom)")
            expect(() => nrun("(%intcall %raise 'boom 5)")).toThrow("%raise: continuable must be #t or #f")
            expect(nrun("(define (cs-f skip) (%intcall %vector-ref (%intcall %vector-ref (%intcall %debug-frames (%intcall %current-stack skip) (%intcall %vector) #f) 0) 0)) (%call cs-f 0)")).toBe('"cs-f"')
            expect(() => nrun("(%intcall %current-stack -1)")).toThrow("%current-stack: expected a count of frames to skip")
            expect(() => nrun("(%intcall %apply-array list '(1))")).toThrow("%apply: expected an array but got (1)")
            expect(nrun("(let ((co (%intcall %coroutine-create (lambda (a) (%intcall %+ a (%intcall %coroutine-yield (%intcall %* a 2))))))) (%intcall %list (%intcall %coroutine-resume co 5) (%intcall %coroutine-resume co 1)))")).toBe("(10 6)")
            // the Scheme names are aliases: a call whose count does not fit calls the prelude procedure, which reports it
            expect(run("(list (call/cc (lambda (k) (k 1))) (dynamic-wind (lambda () 0) (lambda () 2) (lambda () 0)) (map call/cc (list (lambda (k) 3))))")).toBe("(1 2 (3))")
            expect(() => run("(raise 'a 'b)")).toThrow("raise: expected exactly 1 args, got 2")
            expect(() => run("(call/cc)")).toThrow("call/cc: expected exactly 1 args, got 0")
            expect(run("(let ((call/cc (lambda (f) 'mine))) (call/cc 1))")).toBe("mine")
        }
        // AOT code carries control operations out at the call, with no request object
        const co = compileNative(createScheme(impl), "(define (co-f v) (%intcall %+ 1 (%intcall %coroutine-yield v)))") as Code
        const coTmpl = co.constants.find((c: any) => c instanceof Closure)!.tmpl
        const src = AotCompiler.generateSource(coTmpl.code, coTmpl)
        expect(src).toContain("executor.coYield(ctx, frame, r")
        expect(src).toContain("throw Suspend.yield(r")
        expect(src).not.toContain("res.run(")
        const bc = compileNative(createScheme(impl), "(define (cc-f g) (%intcall %call/cc g))") as Code
        const lines = listing(bc.constants.find((c: any) => c instanceof Closure)!.tmpl.code)
        expect(lines.some(line => /HostCall +pos=%call\/cc, start=r\d+, nargs=1, tail=true$/.test(line))).toBe(true)
    })
})
describe("Argument binding", () => {
    it("binds positionals and a packed or array rest, in place over the argument window too", () => {
        const packed = closureArity(2, "packed")
        expect(packed).toEqual({ min: 2, max: Infinity, rest: "packed", params: 2, pad: false })
        const fresh: any[] = []
        bindArgs(packed, fresh, ["x", "a", "b", "c", "d"], 1, 4, (regs, start, nargs) => regs.slice(start, start + nargs).join("+"))
        expect(fresh).toEqual(["a", "b", "c+d"])
        // a self tail call: the window overlaps the parameters it is bound to
        const regs = ["p0", "p1", "p2", "a", "b", "c"]
        bindArgs(closureArity(2, "array"), regs, regs, 1, 5, null)
        expect(regs.slice(0, 3)).toEqual(["p1", "p2", ["a", "b", "c"]])
        const exact = ["p0", "p1", "x", "y"]
        bindArgs(closureArity(2, "none"), exact, exact, 2, 2, null)
        expect(exact).toEqual(["x", "y", "x", "y"])
    })

    it("gives closures and intrinsics one arity message", () => {
        const arityMessage = (...args: any[]) => schemeFormat(Msg.Arity, args, schemeFormat, null)
        expect(arityMessage("f", 2, 2, 1)).toBe("f: expected exactly 2 args, got 1")
        expect(arityMessage("f", 1, Infinity, 0)).toBe("f: expected at least 1 args, got 0")
        expect(arityMessage("f", 2, 3, 4)).toBe("f: expected 2 to 3 args, got 4")
        const anima = createScheme(impl)
        const tmpl = (anima.compileRaw("(define (ab-f a . r) r)") as Code).constants.find((c: any) => c instanceof Closure)!.tmpl
        expect(tmpl.arity).toEqual({ min: 1, max: Infinity, rest: "packed", params: 1, pad: false })
        expect(() => anima.evaluateRaw(anima.compileRaw("(define (ab-g a b) a) (ab-g 1)"))).toThrow("ab-g: expected exactly 2 args, got 1")
        expect(() => runNative(anima, "(%intapply %car (%intcall %spread '(1 2)))")).toThrow("%car: expected exactly 1 args, got 2")
        expect(() => compileNative(anima, "(%intcall %car 1 2)")).toThrow("%car: expected exactly 1 args, got 2")
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
        const mentions = files.filter(file => /scheme/i.test(readFileSync(file, "utf8")) || /\bCons\b/.test(readFileSync(file, "utf8")));
        expect(mentions).toEqual([]);
        // nor does the code the VM and the front end share
        expect(readFileSync(new URL("../common.ts", import.meta.url), "utf8")).not.toMatch(/\bCons\b|scheme\//);
        // nor of either front end's tables
        const tables = [...files, new URL("../common.ts", import.meta.url).pathname].filter(file => /\bTable\b|lua\/table|from "\.\.?\/table"/.test(readFileSync(file, "utf8")));
        expect(tables).toEqual([]);
    });
});
