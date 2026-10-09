import { describe, expect, it } from "vitest";
import { createScheme } from "../scheme";
import { impl } from "../magicvm/meta";
import { UnitSerializer } from "../magicvm/aot/serializer";
import { UnitLoader } from "../magicvm/loader";
import { AnimaVM, Code } from "../magicvm/vm";
import { Closure, ClosureTemplate, newCallCache } from "../magicvm/code";
import { Env } from "../env";
import type { AnimaExecutionUnit, UnitMeta } from "../magicvm/unit-types";
import { ASTStringifier } from "../scheme/printer";
import { MultipleValues } from "../common";
import { createLuau, toString } from "../lua";
import { compileNative } from "../native";

describe("Execution Unit (.animau) Serializer & Loader", () => {
    const stringify = (v: any) => new ASTStringifier().stringify(v);

    it("enforces strict metadata: only id, version, scriptname", () => {
        const anima = createScheme(impl);
        const code = anima.compileRaw("(+ 1 2)") as Code;
        const meta: UnitMeta = {
            id: "test-unit-1",
            version: "1.0.0",
            scriptname: "math-test.scm",
        };

        const unit = UnitSerializer.serializeUnit(code, meta);
        expect(unit.id).toBe("test-unit-1");
        expect(unit.version).toBe("1.0.0");
        expect(unit.scriptname).toBe("math-test.scm");

        // Verify no unintended metadata fields exist
        const metadataKeys = Object.keys(unit).filter(k =>
            ["id", "version", "scriptname"].includes(k)
        );
        expect(metadataKeys.sort()).toEqual(["id", "scriptname", "version"]);

        // Missing metadata in loader throws
        expect(() => UnitLoader.load({ ...unit, id: "" } as any, anima.intrinsics)).toThrow(
            /missing id, version, or scriptname/
        );
    });

    it("strictly formats rest as null instead of 'none'", () => {
        const anima = createScheme(impl);
        const code = anima.compileRaw("(define (add a b) (+ a b)) add") as Code;
        const meta: UnitMeta = {
            id: "add-unit",
            version: "2.0.0",
            scriptname: "add.scm",
        };

        const unit = UnitSerializer.serializeUnit(code, meta);
        expect(unit.arity.rest).toBeNull();
        expect(unit.arity.params).toBe(0); // top-level wrapper

        // Check child template arity for `add`
        const addTmpl = unit.templates[0];
        expect(addTmpl).toBeDefined();
        expect(addTmpl.arity.params).toBe(2);
        expect(addTmpl.arity.rest).toBeNull();
        expect(addTmpl.arity.pad).toBe(false);
    });

    it("correctly serializes and hydrates variadic procedures with rest", () => {
        const anima = createScheme(impl);
        const code = anima.compileRaw("(define (sum x . rest) rest) sum") as Code;
        const meta: UnitMeta = {
            id: "sum-unit",
            version: "1.0.0",
            scriptname: "sum.scm",
        };

        const unit = UnitSerializer.serializeUnit(code, meta);
        const sumTmpl = unit.templates[0];
        expect(sumTmpl.arity.params).toBe(1);
        expect(sumTmpl.arity.rest).toBe("packed");

        const jsonStr = JSON.stringify(unit);
        const loaded = UnitLoader.load(jsonStr, anima.intrinsics);
        expect(loaded.code.direct).toBe(true);
    });

    it("roundtrips top-level arithmetic expressions", () => {
        const anima = createScheme(impl);
        const src = "(+ (* 3 7) (- 100 58))";
        const code = anima.compileRaw(src) as Code;
        const expected = anima.evaluateRaw(code);

        const meta: UnitMeta = {
            id: "arith-unit",
            version: "1.0.0",
            scriptname: "arith.scm",
        };

        const jsonStr = UnitSerializer.serialize(code, meta);
        const loaded = anima.loadUnit(jsonStr);

        expect(loaded.meta.id).toBe("arith-unit");
        expect(loaded.code.direct).toBe(true);
        expect(loaded.code.directFn).toBeTypeOf("function");
        expect(loaded.code.resumeFn).toBeTypeOf("function");

        const result = anima.evaluateRaw(loaded.code);
        expect(result).toBe(expected);
        expect(result).toBe(63);
    });

    it("roundtrips closures with upvar captures and higher-order functions", () => {
        const anima = createScheme(impl);
        const src = `
            (define (make-adder x)
                (lambda (y) (+ x y)))
            (define add10 (make-adder 10))
            (add10 25)
        `;
        const code = anima.compileRaw(src) as Code;
        const expected = anima.evaluateRaw(code);

        const meta: UnitMeta = {
            id: "closure-unit",
            version: "1.1.0",
            scriptname: "closures.scm",
        };

        const json = UnitSerializer.serializeUnit(code, meta);
        expect(json.templates.length).toBeGreaterThanOrEqual(2);

        const vm = new AnimaVM(anima.intrinsics);
        const loaded = vm.loadUnit(json);

        const result = vm.evaluateRaw(loaded.code, new Env());
        expect(result).toBe(expected);
        expect(result).toBe(35);
    });

    it("roundtrips mutual recursion (letrec)", () => {
        const anima = createScheme(impl);
        const src = `
            (letrec ((my-even? (lambda (n) (if (= n 0) #t (my-odd? (- n 1)))))
                     (my-odd? (lambda (n) (if (= n 0) #f (my-even? (- n 1))))))
              (list (my-even? 10) (my-even? 7) (my-odd? 15)))
        `;
        const code = anima.compileRaw(src) as Code;
        const expected = stringify(anima.evaluateRaw(code));

        const meta: UnitMeta = {
            id: "letrec-unit",
            version: "1.0.0",
            scriptname: "evenodd.scm",
        };

        const json = UnitSerializer.serialize(code, meta);
        const loaded = anima.loadUnit(json);

        const result = stringify(anima.evaluateRaw(loaded.code));
        expect(result).toBe(expected);
        expect(result).toBe("(#t #f #t)");
    });

    it("roundtrips tail-recursive loop with accumulator", () => {
        const anima = createScheme(impl);
        const src = `
            (let loop ((n 1000) (acc 0))
              (if (= n 0)
                  acc
                  (loop (- n 1) (+ acc n))))
        `;
        const code = anima.compileRaw(src) as Code;
        const expected = anima.evaluateRaw(code);

        const meta: UnitMeta = {
            id: "loop-unit",
            version: "1.0.0",
            scriptname: "loop.scm",
        };

        const json = UnitSerializer.serialize(code, meta);
        const loaded = anima.loadUnit(json);
        const result = anima.evaluateRaw(loaded.code);

        expect(result).toBe(expected);
        expect(result).toBe(500500);
    });

    it("roundtrips multiple values with let-values", () => {
        const anima = createScheme(impl);
        const src = `
            (let-values (((a b c) (values 10 20 30)))
              (+ a b c))
        `;
        const code = anima.compileRaw(src) as Code;
        const expected = anima.evaluateRaw(code);

        const meta: UnitMeta = {
            id: "values-unit",
            version: "1.0.0",
            scriptname: "values.scm",
        };

        const json = UnitSerializer.serialize(code, meta);
        const loaded = anima.loadUnit(json);
        const result = anima.evaluateRaw(loaded.code);

        expect(result).toBe(expected);
        expect(result).toBe(60);
    });

    it("roundtrips quoted constants and lists", () => {
        const anima = createScheme(impl);
        const src = `
            (define data '(apple banana cherry))
            (car (cdr data))
        `;
        const code = anima.compileRaw(src) as Code;
        const expected = stringify(anima.evaluateRaw(code));

        const meta: UnitMeta = {
            id: "quoted-unit",
            version: "1.0.0",
            scriptname: "quoted.scm",
        };

        const json = UnitSerializer.serialize(code, meta);
        const loaded = anima.loadUnit(json);
        const result = stringify(anima.evaluateRaw(loaded.code));

        expect(result).toBe(expected);
        expect(result).toBe("banana");
    });

    it("roundtrips global variable reading and writing (LoadGlobal / SetGlobal)", () => {
        const anima = createScheme(impl);
        const src = `
            (define counter 100)
            (set! counter (+ counter 50))
            counter
        `;
        const code = anima.compileRaw(src) as Code;

        const meta: UnitMeta = {
            id: "globals-unit",
            version: "1.0.0",
            scriptname: "globals.scm",
        };

        const json = UnitSerializer.serialize(code, meta);
        const loaded = anima.loadUnit(json);
        const result = anima.evaluateRaw(loaded.code);

        expect(result).toBe(150);
        expect(anima.scope.get(Symbol.for("counter"))).toBe(150);
    });

    it("supports evaluating units directly via anima.evaluateUnit() and vm.evaluateUnit()", () => {
        const anima = createScheme(impl);
        const code = anima.compileRaw("(+ 111 222)") as Code;
        const meta: UnitMeta = {
            id: "eval-unit",
            version: "1.0.0",
            scriptname: "eval.scm",
        };

        const json = UnitSerializer.serialize(code, meta);
        const result = anima.evaluateUnit(json);
        expect(result).toBe(333);

        const vm = new AnimaVM(anima.intrinsics);
        const vmResult = vm.evaluateUnit(json, new Env());
        expect(vmResult).toBe(333);
    });

    it("throws descriptive error when required intrinsic is missing", () => {
        const anima = createScheme(impl);
        const code = anima.compileRaw("(+ 1 2)") as Code;
        const meta: UnitMeta = {
            id: "bad-unit",
            version: "1.0.0",
            scriptname: "bad.scm",
        };

        const unit = UnitSerializer.serializeUnit(code, meta);
        // Inject a nonexistent intrinsic requirement
        unit.intrinsics.push({ name: "%nonexistent-op", leaf: true });

        expect(() => UnitLoader.load(unit, anima.intrinsics)).toThrow(
            /uses intrinsic '%nonexistent-op', which is not registered/
        );
    });

    it("throws descriptive error when intrinsic leaf flag is mismatched", () => {
        const anima = createScheme(impl);
        const code = anima.compileRaw("(+ 1 2)") as Code;
        const meta: UnitMeta = {
            id: "leaf-mismatch",
            version: "1.0.0",
            scriptname: "leaf.scm",
        };

        const unit = UnitSerializer.serializeUnit(code, meta);
        // Flip leaf flag for %+
        const plus = unit.intrinsics.find(i => i.name === "%+");
        expect(plus).toBeDefined();
        plus!.leaf = false;

        expect(() => UnitLoader.load(unit, anima.intrinsics)).toThrow(
            /leaf/
        );
    });

    it("performs ultra-fast cold hydration (< 1 ms)", () => {
        const anima = createScheme(impl);
        const src = `
            (define (fib n)
              (if (< n 2)
                  n
                  (+ (fib (- n 1)) (fib (- n 2)))))
            (fib 10)
        `;
        const code = anima.compileRaw(src) as Code;
        const meta: UnitMeta = {
            id: "fib-unit",
            version: "1.0.0",
            scriptname: "fib.scm",
        };

        const jsonStr = UnitSerializer.serialize(code, meta);

        // Warm up V8 compilation
        UnitLoader.load(jsonStr, anima.intrinsics);

        // Measure cold hydration time
        const start = performance.now();
        const iterations = 50;
        for (let i = 0; i < iterations; i++) {
            UnitLoader.load(jsonStr, anima.intrinsics);
        }
        const elapsedMs = performance.now() - start;
        const avgMs = elapsedMs / iterations;

        // Cold hydration should easily be under 0.5 ms per unit
        expect(avgMs).toBeLessThan(1.0);
    });

    // each program gives the same run as compiled and run from a unit loaded into another instance
    const meta: UnitMeta = { id: "u", version: "1", scriptname: "s" };
    const outcome = (run: () => string): string => { try { return run(); } catch (e: any) { return "error: " + String(e.message); } };

    it("runs Scheme programs from a unit as it runs them compiled", () => {
        const programs = [
            `(define (f a . rest) (cons a rest)) (list (f 1) (f 1 2 3))`,
            `(define (f v) (vector-length v)) (f (vector 1 2 3))`,
            `(define v '#(1 2 3)) (call-with-values (lambda () (pcall vector-set! v 0 9)) (lambda (ok e) ok))`,
            `(define (f) '(1 (2 . 3) #(4 "five"))) (list (f) (eq? (f) (f)))`,
            `(define (two) (values 1 2)) (call-with-values two (lambda (a b) (+ a b)))`,
            `(define (deep n) (if (= n 0) 0 (+ 1 (deep (- n 1))))) (deep 5000)`,
            `(define f (case-lambda ((a) a) ((a b) (+ a b)) ((a . more) more))) (list (f 1) (f 1 2) (f 1 2 3))`,
            `(define (f x)\n  (car x))\n(f 5)`,
            `(call-with-values (lambda () (pcall (lambda () (with-exception-handler (lambda (e) (* e 2)) (lambda () (+ 1 (raise-continuable 20))))))) list)`,
            `(define co (coroutine-create (lambda () (coroutine-yield 1) (raise 'from-co)))) (coroutine-resume co) (call-with-values (lambda () (pcall coroutine-resume co)) list)`,
            `(let loop ((i 0) (acc '())) (if (= i 5) (reverse acc) (loop (+ i 1) (cons (* i i) acc))))`,
            `(list 1.5 -0.0 (/ 1.0 0) 'sym "str" #t '())`,
        ];
        const plain = (src: string) => outcome(() => { const a = createScheme(impl); return stringify(a.evaluateRaw(a.compileRaw(src))); });
        const unit = (src: string) => outcome(() => { const a = createScheme(impl); return stringify(createScheme(impl).evaluateUnit(UnitSerializer.serialize(a.compileRaw(src) as Code, meta))); });
        expect(programs.filter(p => unit(p) !== plain(p))).toEqual([]);
        expect(unit(programs[0])).toBe("((1) (1 2 3))");
        expect(unit(programs[2])).toBe("#f");
    });

    it("runs Luau programs from a unit as it runs them compiled", () => {
        const programs = [
            "local t = {x = 1, y = 2} t.z = 3 return t.x + t.y + t.z, #{1, 2, 3}",
            "local function f(a, b) return a .. b end return f('x', 'y'), ('abc'):upper(), string.format('%5.2f', 3.14159)",
            "return pcall(function() error('boom') end)",
            "local function f(...) return ... end return f(1, nil, 3)",
            "local n = 0 for i, v in ipairs({10, 20}) do n = n + v end for k, v in pairs({a = 1}) do n = n + v end return n",
            "local function fib(n) if n < 2 then return n end return fib(n - 1) + fib(n - 2) end return fib(15)",
            "local x = 5 return `x is {x}`, tostring(2^53), tonumber('0x10'), -0, 0/0, 1/0",
            "local t = {}\nreturn t.a.b",
            "local s = 0 for w in ('a bb ccc'):gmatch('%a+') do s = s + #w end return s, ('x'):rep(3), (('hello'):gsub('l', 'L'))",
            "local function counter() local n = 0 return function() n = n + 1 return n end end local c = counter() c() return c(), c()",
        ];
        const show = (r: any) => (r instanceof MultipleValues ? r.values : [r]).map(toString).join("\t");
        const plain = (src: string) => outcome(() => { const a = createLuau(impl); return show(a.evaluateRaw(a.compileRaw(src, "t"))); });
        const unit = (src: string) => outcome(() => { const a = createLuau(impl); return show(createLuau(impl).evaluateUnit(UnitSerializer.serialize(a.compileRaw(src, "t") as Code, meta))); });
        expect(programs.filter(p => unit(p) !== plain(p))).toEqual([]);
        expect(unit(programs[0])).toBe("6\t3");
        expect(unit(programs[7])).toBe("error: t:2: attempt to index nil with 'b'");
    });

    it("calls intrinsics by name where the host registered them at other positions", () => {
        const make = (order: string[]) => {
            const a = createScheme(impl);
            for (const name of order) a.registerIntrinsic(name, name === "%ta" ? () => "A" : () => "B", { args: [0, 0], leaf: true });
            return a;
        };
        const run = (src: string, order: string[]) => {
            const a = make(["%ta", "%tb"]);
            return stringify(make(order).evaluateUnit(UnitSerializer.serialize(compileNative(a, src) as Code, meta)));
        };
        // at top level and in a nested procedure, which keeps its own list of the intrinsics it uses
        for (const src of [`(%intcall %list (%intcall %ta) (%intcall %tb))`, `(define-global f (lambda () (%intcall %list (%intcall %ta) (%intcall %tb)))) (%call f)`]) {
            expect(run(src, ["%ta", "%tb"])).toBe('("A" "B")');
            expect(run(src, ["%tb", "%ta"])).toBe('("A" "B")');
        }
        const a = make(["%ta", "%tb"]);
        const unit = UnitSerializer.serializeUnit(compileNative(a, `(define-global f (lambda () (%intcall %ta))) 1`) as Code, meta);
        expect(unit.intrinsics.map(i => i.name)).not.toContain("%ta");
        expect(unit.templates[0].intrinsics.map(i => i.name)).toEqual(["%ta"]);
        expect(() => UnitLoader.load(unit, createScheme(impl).intrinsics)).toThrow(/uses intrinsic '%ta', which is not registered/);
    });

    it("refuses a constant it could not give back as it was", () => {
        class Opaque { x = 1; }
        const a = createScheme(impl);
        const code = a.compileRaw("(+ 1 2)") as Code;
        code.constants.push(new Opaque());
        expect(() => UnitSerializer.serializeUnit(code, meta)).toThrow(/Cannot serialize a constant of class Opaque/);
        code.constants.pop();
        expect(() => UnitSerializer.serializeUnit(code, meta)).not.toThrow();
    });

    it("gives a symbol that is not of the registry one new symbol for the unit, wherever the unit holds it", () => {
        const a = createScheme(impl);
        const code = a.compileRaw("(define (f) 1) (+ 1 2)") as Code;
        const [own, other] = [Symbol("mine"), Symbol("mine")];
        const codeIn = (constants: any[]): Code => { const c = constants.find(c => c instanceof ClosureTemplate || c instanceof Closure); return c instanceof Closure ? c.tmpl.code : (c as ClosureTemplate).code; };
        const nested = codeIn(code.constants);
        code.constants.push(own, [own, other], Symbol.for("shared"));
        nested.constants.push(own);
        const unit = UnitSerializer.serializeUnit(code, meta);
        const load = () => {
            const loaded = UnitLoader.load(JSON.stringify(unit), a.intrinsics);
            return [...loaded.code.constants.slice(-3), codeIn(loaded.code.constants).constants.at(-1)];
        };
        const [first, pair, shared, inNested] = load();
        expect([typeof first, first.description, Symbol.keyFor(first)]).toEqual(["symbol", "mine", undefined]);
        // the same symbol everywhere the unit had it, another where it had another, and none of them the original
        expect([pair[0] === first, inNested === first, pair[1] === first, first === own]).toEqual([true, true, false, false]);
        expect(shared).toBe(Symbol.for("shared"));
        // each load makes its own
        expect(load()[0]).not.toBe(first);
    });
});

describe("A call site's cache", () => {
    it("keeps the first four callees, and gives a slot up only when its callee no longer runs directly", () => {
        const anima = createScheme(impl);
        const vm = new AnimaVM(anima.intrinsics);
        const closures = Array.from({ length: 6 }, (_, i) => anima.evaluateRaw(anima.compileRaw(`(lambda (x) (+ x ${i}))`)) as Closure);
        const cache = newCallCache();
        for (const c of closures.slice(0, 5)) expect(vm.executor.entry(c, cache, 1, 0)).not.toBeNull();
        expect([cache.t0, cache.t1, cache.t2, cache.t3]).toEqual(closures.slice(0, 4).map(c => c.tmpl));
        // a fifth callee is not kept, however often it comes
        vm.executor.entry(closures[4], cache, 1, 0);
        expect([cache.t0, cache.t1, cache.t2, cache.t3]).toEqual(closures.slice(0, 4).map(c => c.tmpl));
        closures[1].tmpl.code.direct = false;
        vm.executor.entry(closures[5], cache, 1, 0);
        expect(cache.t1).toBe(closures[5].tmpl);
        expect(cache.f1).toBe(closures[5].tmpl.code.entry(1));
    });

    it("calls the right procedure at a site that sees many", () => {
        const luau = createLuau(impl);
        const fs = Array.from({ length: 8 }, (_, i) => `local function f${i}(x) return x + ${i} end`).join(" ");
        const src = `${fs} local fs = {${Array.from({ length: 8 }, (_, i) => `f${i}`).join(", ")}} local s = 0 for i = 1, 4000 do s = s + fs[i % 8 + 1](i) end return s`;
        expect(luau.evaluateRaw(luau.compileRaw(src, "t"))).toBe(4000 * 4001 / 2 + 500 * 28);
    });
});
