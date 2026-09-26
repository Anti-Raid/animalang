// Made w/ lots of help from gemini cli
import { ASTStringifier, AbstractByteCode, MissingVarError, isDeepEqual, Table, Env, ASPParseError, BS, BSReader } from './common';
import { describe, it, expect, beforeEach } from 'vitest';
import { Cons } from './list';
import { BuiltinFunction } from './std';
import { ByteCode, AnimaVM, AotCompiler, OpCode } from './bytecode-rvm/vm';
import { BUILTINS_START, INSTRUCTION_LENGTHS } from './bytecode-rvm/exec';
import { Anima } from './anima';
import { impl, implAot, implDebug, implAotDebug } from './bytecode-rvm/meta';
import { dumpFull, readFull, BYTECODE_VERSION } from './bytecode-rvm/utils';

describe.each([["interp", impl], ["aot", implAot]] as const)("%s", (_mode, vmImpl) => {
let bcCache: Record<string, AbstractByteCode> = {}
describe('Anima', () => {
    let evaluator: Anima
    let s = new ASTStringifier()
    // every test starts from a fresh instance, so none depends on what ran before it
    beforeEach(() => {
        evaluator = new Anima(vmImpl)
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

    describe('Primitives, Strings & Symbols', () => {
        it('table-border is the array-part border and is inlined', () => {
            expect(run(`(define (tb t) (table-border t)) (let ((t {1 "a" 2 "b" 3 "c"})) (table-set! t 2 <#void>) (list (tb t) (tb {}) (tb {"x" 1}) (table-size t)))`)).toBe("(1 0 0 2)")
            expect(run(`(let ((t {})) (table-set! t 2 "b") (table-set! t 1 "a") (table-border t))`)).toBe("2")
            expect(() => run(`(define (tb2 t) (table-border t)) (tb2 '())`)).toThrow("table-border requires a table")
        })
        it('inlined n-ary arithmetic agrees with the builtins', () => {
            const outcome = (src: string) => {
                try {
                    return run(src)
                } catch (e: any) {
                    return `error: ${e.message}`
                }
            }
            const argSets = [[], ["7"], ["0"], ["-0.0"], ["2", "3"], ["6", "0"], ["1", "2", "3"], ["3", "2", "1"], ["5", "5", "5"],
                ["8", "2", "0", "1"], ["+nan.0", "1"], ["+inf.0", "-inf.0", "2"], ["1", "\"x\""], ["\"x\"", "1", "2"], ["1", "2", "#t"]]
            for (const op of ["+", "-", "*", "/", "=", "<", "<=", ">", ">=", "eq?"]) {
                for (const args of argSets) {
                    const list = args.join(" ")
                    // direct calls inside a procedure are inlined in AOT; apply always goes through the builtin
                    const direct = outcome(`((lambda () (${op} ${list})))`)
                    const viaApply = outcome(`(apply ${op} (list ${list}))`)
                    expect(direct, `(${op} ${list})`).toBe(viaApply)
                }
            }
        })
        it('table intrinsics inline and fall back to the builtin for errors', () => {
            expect(run(`(define tt {"a" 1 "v" <#void>}) (define (tget t k) (table-ref t k)) (list (tget tt "a") (table-has? tt "v") (table-ref tt "zz" 7))`)).toBe("(1 #f 7)")
            expect(run(`(define tp {"x" 1}) (define (tget2 t k) (table-ref t k)) (table-set! tp "y" 2) (list (tget2 tp "x") (tget2 tp "y") (table-has? tp "x") (table-has? tp "z"))`)).toBe("(1 2 #t #f)")
            expect(run(`(define (tput! t k v) (table-set! t k v)) (define tw {}) (list (tput! tw "k" 5) (table-ref tw "k"))`)).toBe("(<#void> 5)")
            expect(() => run(`(define (tget3 t k) (table-ref t k)) (tget3 {"a" 1} "b")`)).toThrow("table-ref: key not found: b")
            expect(() => run(`(define (tget4 t k) (table-ref t k)) (tget4 5 "b")`)).toThrow("table-ref requires a table")
            expect(() => run(`(define (tput2! t) (table-set! t "a" 2)) (define tf {"a" 1}) (table-freeze! tf) (tput2! tf)`)).toThrow("Cannot modify a frozen Table")
            expect(() => run(`(define (thas t) (table-has? t 1)) (thas '())`)).toThrow("table-has? requires a table")
            expect(run(`(map table-has? (list {1 2} {}) (list 1 1))`)).toBe("(#t #f)")
        })
        it('core forms: surface syntax lowers to % forms, which can also be written directly', () => {
            expect(run(`''a`)).toBe("(quote a)")
            expect(run(`'(if (lambda (x) x) (begin 1))`)).toBe("(if (lambda (x) x) (begin 1))")
            expect(run(`(quote (%if 1 2 3))`)).toBe("(%if 1 2 3)")
            expect(run(`(%if #f 1 (%begin 2 3))`)).toBe("3")
            expect(run(`((%lambda (x) (define y (+ x 1)) (* y 2)) 4)`)).toBe("10")
            expect(run(`(define cf-v 1) (%set! cf-v (%quote (a b))) cf-v`)).toBe("(a b)")
            expect(() => run(`(if 1 2)`)).toThrow("if condition must be in format")
            expect(() => run(`(%if 1 2)`)).toThrow("if condition must be in format")
            expect(() => run(`(quote 1 2)`)).toThrow("quote must be in format")
            expect(() => run(`(define %if 1)`)).toThrow()
            expect(() => run(`(lambda (%lambda) 1)`)).toThrow()
            expect(() => run(`(let ((%quote 1)) %quote)`)).toThrow()
        })
        it('inlined predicates agree with the builtins', () => {
            const vals = `(list 0 -0.0 1 -3 4 2.5 +inf.0 -inf.0 +nan.0 "" "a" #t #f 'sym '() '(1) '(1 . 2) (vector) (vector 1) {} {1 2} car (lambda () 1) <#void>)`
            const safe = ["null?", "pair?", "list?", "number?", "integer?", "positive?", "negative?", "zero?", "infinite?", "finite?", "nan?",
                "boolean?", "void?", "symbol?", "string?", "procedure?", "error?", "vector?", "table?", "empty?"]
            for (const p of safe) {
                expect(run(`(define (inl-${p} xs) (if (null? xs) '() (cons (${p} (car xs)) (inl-${p} (cdr xs))))) (inl-${p} ${vals})`)).toBe(run(`(map ${p} ${vals})`))
            }
            expect(run(`(define (evens xs) (if (null? xs) '() (cons (list (even? (car xs)) (odd? (car xs))) (evens (cdr xs))))) (evens (list 0 1 -3 -4 7))`)).toBe("((#t #f) (#f #t) (#f #t) (#t #f) (#f #t))")
            expect(() => run(`(define (ev x) (even? x)) (ev 2.5)`)).toThrow("even? requires an integer")
            expect(() => run(`(define (od x) (odd? x)) (od "a")`)).toThrow("odd? requires an integer")
            expect(run(`(list (vector-empty? (vector)) (table-empty? {}) (table-frozen? {1 2}))`)).toBe("(#t #t #f)")
            expect(() => run(`(define (ve x) (vector-empty? x)) (ve '())`)).toThrow("vector-empty? requires a vector")
            expect(() => run(`(define (te x) (table-empty? x)) (te 1)`)).toThrow("table-empty? requires a table")
        })
        it('vector intrinsics inline and fall back to the builtin for errors', () => {
            expect(run(`(define v (vector 1 2 3)) (list (vector-ref v 0) (vector-length v) (begin (vector-set! v 1 9) (vector-ref v 1)))`)).toBe("(1 3 9)")
            expect(run(`(define (vsum v i acc) (if (= i (vector-length v)) acc (vsum v (+ i 1) (+ acc (vector-ref v i))))) (vsum (vector 1 2 3 4) 0 0)`)).toBe("10")
            expect(run(`(define (vlast v) (vector-ref v (- (vector-length v) 1))) (vlast (vector 4 5 6))`)).toBe("6")
            expect(run(`(define (put! v) (vector-set! v 0 'x)) (define w (vector 1)) (list (put! w) w)`)).toBe("(<#void> #(x))")
            expect(run(`(map vector-length (list (vector) (vector 1 2)))`)).toBe("(0 2)")
            expect(() => run(`(define (at v i) (vector-ref v i)) (at (vector 1) 5)`)).toThrow("vector-ref: index 5 out of bounds for vector of length 1")
            expect(() => run(`(vector-ref (vector 1) 0.5)`)).toThrow("vector-ref: index 0.5 out of bounds")
            expect(() => run(`(vector-set! '(1) 0 2)`)).toThrow("vector-set! requires a vector")
            expect(() => run(`(define (len v) (vector-length v)) (len 5)`)).toThrow("vector-length requires a vector")
        })

        it('builtins in tail position are inlined with the same semantics', () => {
            expect(run(`(define (f x) (car x)) (f '(7 8))`)).toBe("7")
            expect(run(`(define (g a b) (+ a b)) (g 2 3)`)).toBe("5")
            expect(() => run(`(define (h a b) (+ a b)) (h "x" 1)`)).toThrow("+ requires numbers, but received string")
            expect(() => run(`(define (f2 x) (car x)) (f2 '())`)).toThrow("car: list is too short")
        })
        it('reverse', () => {
            expect(run("(reverse '(1 2 3))")).toBe("(3 2 1)")
            expect(run("(reverse '())")).toBe("()")
            expect(run("(reverse (list 1 (list 2 3)))")).toBe("((2 3) 1)")
            expect(() => run("(reverse '(1 . 2))")).toThrow("reverse requires a proper list")
            expect(() => run("(reverse 5)")).toThrow("reverse requires a proper list")
        })
        it('parses string escapes and raw control characters', () => {
            const str = (src: string) => evaluator.evaluateRaw(evaluator.compileRaw(src))
            expect(str('"a\nb\tc"')).toBe("a\nb\tc")
            expect(str('"a\\nb\\tc\\\\d\\"e"')).toBe('a\nb\tc\\d"e')
            expect(str('"\\u0041\\x42;\\x1F600;\\a\\0"')).toBe("AB\u{1F600}\x07\0")
            expect(str('"\u0001\u001f"')).toBe("\u0001\u001f")
            expect(() => str('"\\q"')).toThrow("unknown escape")
            expect(() => str('"\\u12"')).toThrow("bad \\u escape")
        })
        it('evaluates boolean primitives', () => {
            expect(run("#t")).toBe("#t");
            expect(run("#f")).toBe("#f");
        });

        it('evaluates numbers and raw arrays', () => {
            expect(run("42")).toBe("42");
            expect(run("[]")).toBe("()"); // ASP parses [] to a PUSHEMPTYLIST, VM evals [] as null
        });

        it('evaluates native Symbols as implicit variables', () => {
            expect(run("port")).toBe("8080");
            expect(run("protocol")).toBe("\"tcp\"");
        });

        it('evaluates literal JS strings as Scheme strings directly', () => {
            expect(run('"hello"')).toBe("\"hello\"");
            expect(run('"port"')).toBe("\"port\""); // String primitive, not a variable lookup
        });

        it('errors for unknown variables', () => {
            expect(() => run("missing_var")).toThrow(MissingVarError);
        });

        it('basic math', () => {
            expect(run("(+ (* 1 2) (- 1 1) (- 1 2))")).toBe("1");
            expect(run("(+ (* 1 2) (- 1 1) (- 1 51))")).toBe("-48");
            expect(run("(+ (let [(x 1)] x) 1)")).toBe("2");
        });

        it('arithmetic intrinsics and prelude procedures', () => {
            expect(run("(+)")).toBe("0");
            expect(run("(*)")).toBe("1");
            expect(run("(+ 5)")).toBe("5");
            expect(run("(- 5)")).toBe("-5");
            expect(run("(/ 4)")).toBe("0.25");
            expect(run("(- 10 1 2 3)")).toBe("4");
            expect(run("(modulo -7 3)")).toBe("2");
            expect(run("(remainder -7 3)")).toBe("-1");
            expect(run("(= 2 2 2)")).toBe("#t");
            expect(run("(< 1 3 2)")).toBe("#f");
            expect(run("(eq? 'a 'a)")).toBe("#t");
            expect(run("(map + '(1 2) '(10 20))")).toBe("(11 22)");
            expect(run("(apply * '(2 3 4))")).toBe("24");
            expect(run("(apply + 1 2 '(3 4))")).toBe("10");
            expect(run("(let ((ap apply)) (ap + 1 '(2 3)))")).toBe("6");
            expect(run("(let ((ap apply)) (ap list 1 '(2 3)))")).toBe("(1 2 3)");
            expect(() => run("(apply + 1 2)")).toThrow("last argument must be a list");
            expect(run("(list)")).toBe("()");
            expect(run("(list 1 (+ 1 1) 3)")).toBe("(1 2 3)");
            expect(run("(map list '(1 2) '(3 4))")).toBe("((1 3) (2 4))");
            expect(run("(car (cons 1 2))")).toBe("1");
            expect(run("(cdr '(1 2))")).toBe("(2)");
            expect(run("(null? '())")).toBe("#t");
            expect(run("(pair? 1)")).toBe("#f");
            expect(run("(map car '((1) (2)))")).toBe("(1 2)");
            expect(() => run("(car '())")).toThrow("car: list is too short");
            expect(() => run("(cdr 5)")).toThrow("cdr: expected a pair but got 5");
            expect(() => run("(cons 1)")).toThrow("cons requires 2 arguments");
            expect(run("(cadr '(1 2 3))")).toBe("2");
            expect(run("(cddr '(1 2 3))")).toBe("(3)");
            expect(run("(caar '((1) 2))")).toBe("1");
            expect(run("(caddr '(1 2 3))")).toBe("3");
            expect(run("(cadddr '(1 2 3 4))")).toBe("4");
            expect(run("(map cadr '((1 2) (3 4)))")).toBe("(2 4)");
            expect(() => run("(cadr '(1))")).toThrow("cadr: list is too short");
            expect(() => run("(cadr 5)")).toThrow("cadr: expected a pair but got 5");
            expect(() => run("(cadr 1 2)")).toThrow("cadr requires 1 argument");
            expect(() => run("(lambda (cddr) 1)")).toThrow("cannot bind builtin cddr");
            expect(run("(first '(1 2 3))")).toBe("1");
            expect(run("(second '(1 2 3))")).toBe("2");
            expect(run("(third '(1 2 3))")).toBe("3");
            expect(run("(map second '((1 2) (3 4)))")).toBe("(2 4)");
            expect(() => run("(third '(1 2))")).toThrow("third: list is too short");
            expect(run("(number? 1)")).toBe("#t");
            expect(run("(list? '(1 . 2))")).toBe("#f");
            expect(run("(even? 4)")).toBe("#t");
            expect(run("(map null? '(() 1))")).toBe("(#t #f)");
            expect(() => run("(even? 1.5)")).toThrow("even? requires an integer");
            expect(() => run("(table-empty? 1)")).toThrow("table-empty? requires a table");
            expect(() => run("(zero? 1 2)")).toThrow("zero? requires 1 argument");
            expect(() => run("(let ((f pair?)) (f))")).toThrow("pair? requires 1 argument");
            expect(() => run("(let ((f third)) (f '(1 2)))")).toThrow("third: list is too short");
            expect(run("(let ((f <)) (f 1 2))")).toBe("#t");
            expect(() => run("(+ 1 \"a\")")).toThrow("+ requires numbers, but received string");
            expect(() => run("(-)")).toThrow("- requires at least 1 argument");
            expect(() => run("(< \"a\")")).toThrow("< requires numbers, but received string");
            expect(() => run("(modulo 1 2 3)")).toThrow("modulo requires 2 arguments");
            expect(() => run("(/ 1 0)")).toThrow("division by zero");
        });

        it('self tail calls respect redefinition and rest params', () => {
            run(`(define (count-down n) (if (= n 0) 'done (begin (if (= n 5) (set! count-down (lambda (m) 'swapped)) #f) (count-down (- n 1)))))`);
            expect(run("(count-down 10)")).toBe("swapped");
            run(`(define (rest-loop n . xs) (if (= n 0) xs (rest-loop (- n 1) n (* n 10))))`);
            expect(run("(rest-loop 3)")).toBe("(1 10)");
            run(`(define (sum-to n acc) (if (= n 0) acc (sum-to (- n 1) (+ acc n))))`);
            expect(run("(sum-to 100000 0)")).toBe("5000050000");
        });

        it('non-tail calls keep call/cc, errors and deep recursion working', () => {
            expect(run(`(define (deep n k) (if (= n 0) (k 'escaped) (+ 1 (deep (- n 1) k))))
                        (call/cc (lambda (k) (deep 50 k)))`)).toBe("escaped");
            expect(run(`(define saved #f)
                        (define hits 0)
                        (define (f) (+ 100 (call/cc (lambda (k) (set! saved k) 1))))
                        (define (g) (let ((r (f))) (set! hits (+ hits 1)) (if (< hits 3) (saved hits) (list r hits))))
                        (g)`)).toBe("(102 3)");
            expect(run(`(define (mk n acc) (if (= n 0) acc (mk (- n 1) (cons n acc))))
                        (define (len l) (if (null? l) 0 (+ 1 (len (cdr l)))))
                        (len (mk 100000 '()))`)).toBe("100000");
            expect(run(`(define (thrower n) (if (= n 0) (raise 'boom) (+ 1 (thrower (- n 1)))))
                        (try (lambda () (thrower 20)) (lambda (e) (list 'caught e)))`)).toBe("(caught boom)");
            expect(run(`(define (resumer n) (if (= n 0) (raise-continuable 'x) (+ 1 (resumer (- n 1)))))
                        (with-exception-handler (lambda (e) 10) (lambda () (resumer 5)))`)).toBe("15");
            expect(run(`(define trail '())
                        (define (inner k) (dynamic-wind (lambda () (set! trail (cons 'in trail))) (lambda () (+ 1 (k 'out))) (lambda () (set! trail (cons 'after trail)))))
                        (list (call/cc (lambda (k) (+ 1 (inner k)))) trail)`)).toBe("(out (after in))");
            expect(run(`(define (wound) (dynamic-wind (lambda () 'before-val) (lambda () 42) (lambda () 'after-val)))
                        (+ 1 (wound))`)).toBe("43");
            expect(run(`(+ 1 (call/cc (lambda (k) (dynamic-wind (lambda () 'b) (lambda () (k 10)) (lambda () 'a)))))`)).toBe("11");
            expect(run(`(define (vsum . xs) (if (null? xs) 0 (+ (car xs) (apply vsum (cdr xs)))))
                        (define (outer n) (+ n (vsum 1 2 3)))
                        (outer 10)`)).toBe("16");
            expect(run(`(define (ev? n) (if (= n 0) #t (od? (- n 1))))
                        (define (od? n) (if (= n 0) #f (ev? (- n 1))))
                        (list (ev? 100000) (od? 100001))`)).toBe("(#t #t)");
            expect(run(`(define (ap f . xs) (apply f xs))
                        (define (use) (list (ap + 1 2) (ap (lambda (a b) (* a b)) 3 4) (ap vsum 5 6)))
                        (use)`)).toBe("(3 12 11)");
            expect(run(`(define (gen-list)
                          (let ((acc '()) (k-saved #f) (n 0))
                            (call/cc (lambda (done)
                              (let ((v (call/cc (lambda (k) (set! k-saved k) 0))))
                                (set! acc (cons v acc))
                                (set! n (+ n 1))
                                (if (< n 4) (k-saved n) (done #f)))))
                            acc))
                        (define (wrap) (list 'result (gen-list)))
                        (wrap)`)).toBe("(result (3 2 1 0))");
            expect(run(`(define calls 0)
                        (define (ev2 n) (set! calls (+ calls 1)) (if (= n 0) #t (od2 (- n 1))))
                        (define (od2 n) (set! calls (+ calls 1)) (if (= n 0) #f (ev2 (- n 1))))
                        (list (ev2 5000) calls)`)).toBe("(#t 5001)");
            expect(run(`(define lcalls 0)
                        (define (len2 l) (set! lcalls (+ lcalls 1)) (if (null? l) 0 (+ 1 (len2 (cdr l)))))
                        (list (len2 (mk 5000 '())) lcalls)`)).toBe("(5000 5001)");
            run(`(define (bad n) (if (= n 0) (car '()) (+ 1 (bad (- n 1)))))`);
            expect(() => run("(bad 10)")).toThrow("car: list is too short");
            expect(run("(try (lambda () (bad 5)) (lambda (e) 'caught))")).toBe("caught");
        });

        it('coroutines', () => {
            expect(run(`(define gen (coroutine-create (lambda () (coroutine-yield 1) (coroutine-yield 2) 3)))
                        (list (coroutine-resume gen) (coroutine-status gen) (coroutine-resume gen) (coroutine-resume gen) (coroutine-status gen))`)).toBe("(1 suspended 2 3 dead)");
            expect(run(`(define acc-co (coroutine-create (lambda (start) (let loop ((total start)) (loop (+ total (coroutine-yield total)))))))
                        (list (coroutine-resume acc-co 1) (coroutine-resume acc-co 10) (coroutine-resume acc-co 100))`)).toBe("(1 11 111)");
            expect(run(`(define inner-co (coroutine-create (lambda () (coroutine-yield (coroutine-status outer-co)) 'inner-done)))
                        (define outer-co (coroutine-create (lambda () (list (coroutine-resume inner-co) (coroutine-resume inner-co) (coroutine-status outer-co)))))
                        (coroutine-resume outer-co)`)).toBe("(normal inner-done running)");
            expect(run(`(define (walk n) (if (= n 0) (coroutine-yield 'bottom) (+ 1 (walk (- n 1)))))
                        (define deep-co (coroutine-create (lambda (n) (walk n))))
                        (list (coroutine-resume deep-co 3000) (coroutine-resume deep-co 0))`)).toBe("(bottom 3000)");
            expect(run(`(define hco (coroutine-create (lambda ()
                          (with-exception-handler (lambda (e) (list 'inner-caught e))
                            (lambda () (coroutine-yield 'paused) (raise-continuable 'oops))))))
                        (list (coroutine-resume hco)
                              (try (lambda () (raise 'outside)) (lambda (e) (list 'outer-caught e)))
                              (coroutine-resume hco))`)).toBe("(paused (outer-caught outside) (inner-caught oops))");
            expect(run(`(define bad-co (coroutine-create (lambda () (coroutine-yield 1) (raise 'broken))))
                        (coroutine-resume bad-co)
                        (list (try (lambda () (coroutine-resume bad-co)) (lambda (e) (list 'caught e))) (coroutine-status bad-co))`)).toBe("((caught broken) dead)");
            expect(run(`(try (lambda () (coroutine-resume (coroutine-create (lambda () (car '()))))) (lambda (e) (error-message e)))`)).toBe('"car: list is too short"');
            expect(run(`(try (lambda () (coroutine-resume gen)) (lambda (e) (error-message e)))`)).toBe('"coroutine-resume: cannot resume a dead coroutine"');
            expect(run(`(try (lambda () (coroutine-yield 1)) (lambda (e) (error-message e)))`)).toBe('"coroutine-yield: not inside a coroutine (or across a host call boundary)"');
            expect(run(`(map (lambda (co) (coroutine-resume co)) (list (coroutine-create (lambda () 'a)) (coroutine-create (lambda () 'b))))`)).toBe("(a b)");

            evaluator.scope.set(Symbol.for("host-call"), new BuiltinFunction(Symbol.for("host-call"), (regs, start) => evaluator.evaluateClosure(regs[start], [])));
            expect(run(`(try (lambda () (coroutine-resume (coroutine-create (lambda () (host-call (lambda () (coroutine-yield 1)))))))
                             (lambda (e) (error-message e)))`)).toBe('"coroutine-yield: not inside a coroutine (or across a host call boundary)"');
        });

        it('coroutines switch inside the driver loop', () => {
            expect(run(`(define (id-list . xs) xs)
                        (list (apply id-list '(1)) (+ 1 1) (apply id-list '(3)))`)).toBe("((1) 2 (3))");
            expect(run(`(define (make-task n) (coroutine-create (lambda () (let loop ((i 0)) (if (< i 20) (begin (coroutine-yield i) (loop (+ i 1))) 'done)))))
                        (define (build n acc) (if (= n 0) acc (build (- n 1) (cons (make-task n) acc))))
                        (define (step tasks) (if (null? tasks) '() (let ((t (car tasks))) (coroutine-resume t) (if (eq? (coroutine-status t) 'dead) (step (cdr tasks)) (cons t (step (cdr tasks)))))))
                        (define (sched tasks rounds) (if (null? tasks) rounds (sched (step tasks) (+ rounds 1))))
                        (sched (build 1000 '()) 0)`)).toBe("21");
            expect(run(`(define (chain n) (coroutine-resume (coroutine-create (lambda () (if (= n 0) 'bottom (chain (- n 1)))))))
                        (chain 100000)`)).toBe("bottom");
            expect(run(`(define inner-bad (coroutine-create (lambda () (raise 'deep))))
                        (define outer-ok (coroutine-create (lambda () (try (lambda () (coroutine-resume inner-bad)) (lambda (e) (list 'outer-caught e))))))
                        (list (coroutine-resume outer-ok) (coroutine-status inner-bad))`)).toBe("((outer-caught deep) dead)");
            expect(run(`(define dc (coroutine-create (lambda () (coroutine-yield 41) 0)))
                        (define (helper co) (+ 1 (coroutine-resume co)))
                        (define (outer-fn) (helper dc))
                        (list (outer-fn) (outer-fn) (coroutine-status dc))`)).toBe("(42 1 dead)");
            expect(run(`(define (nest n) (if (= n 0) 0 (+ 1 (coroutine-resume (coroutine-create (lambda () (+ 0 (nest (- n 1)))))))))
                        (nest 40)`)).toBe("40");
        });

        it('coroutine-close runs pending dynamic-wind cleanup', () => {
            expect(run(`(define close-log '())
                        (define (note x) (set! close-log (cons x close-log)))
                        (define res-co (coroutine-create (lambda ()
                          (dynamic-wind (lambda () (note 'outer-open))
                            (lambda () (dynamic-wind (lambda () (note 'inner-open))
                                                     (lambda () (coroutine-yield 1) 'unreachable)
                                                     (lambda () (note 'inner-close))))
                            (lambda () (note 'outer-close))))))
                        (coroutine-resume res-co)
                        (coroutine-close res-co)
                        (list close-log (coroutine-status res-co))`)).toBe("((outer-close inner-close inner-open outer-open) dead)");
            expect(run(`(define fresh-co (coroutine-create (lambda () 1)))
                        (coroutine-close fresh-co)
                        (coroutine-close fresh-co)
                        (coroutine-status fresh-co)`)).toBe("dead");
            expect(run(`(define self-co (coroutine-create (lambda () (coroutine-close self-co))))
                        (try (lambda () (coroutine-resume self-co)) (lambda (e) (error-message e)))`)).toBe('"coroutine-close: cannot close a running coroutine"');
            expect(run(`(define err-co (coroutine-create (lambda () (dynamic-wind (lambda () #f) (lambda () (coroutine-yield 1)) (lambda () (raise 'cleanup-failed))))))
                        (coroutine-resume err-co)
                        (list (try (lambda () (coroutine-close err-co)) (lambda (e) (list 'caught e))) (coroutine-status err-co))`)).toBe("((caught cleanup-failed) dead)");
            expect(run(`(define yc-co (coroutine-create (lambda () (dynamic-wind (lambda () #f) (lambda () (coroutine-yield 1)) (lambda () (coroutine-yield 2))))))
                        (coroutine-resume yc-co)
                        (try (lambda () (coroutine-close yc-co)) (lambda (e) (error-message e)))`)).toBe('"coroutine-yield: cannot yield while a coroutine is closing"');

            const hostCo = evaluator.evaluateRaw(evaluator.compileRaw(`(define host-closed #f) (coroutine-create (lambda () (dynamic-wind (lambda () #f) (lambda () (coroutine-yield 'a)) (lambda () (set! host-closed #t)))))`));
            evaluator.coroutineResume(hostCo);
            evaluator.coroutineClose(hostCo);
            expect(run("host-closed")).toBe("#t");
        });

        it('host can resume coroutines across evaluations', () => {
            const co = evaluator.evaluateRaw(evaluator.compileRaw(`(coroutine-create (lambda (x) (+ (coroutine-yield (* x 2)) 1)))`));
            expect(evaluator.coroutineResume(co, 5)).toEqual({ done: false, value: 10, values: [10] });
            expect(evaluator.coroutineResume(co, 7)).toEqual({ done: true, value: 8, values: [8] });
            expect(() => evaluator.coroutineResume(co)).toThrow("cannot resume a dead coroutine");

            const fetcher = evaluator.evaluateRaw(evaluator.compileRaw(`(coroutine-create (lambda () (+ (coroutine-yield '(fetch a)) (coroutine-yield '(fetch b)))))`));
            const answers: Record<string, number> = { a: 1, b: 2 };
            let step = evaluator.coroutineResume(fetcher);
            while (!step.done) {
                const key = Symbol.keyFor(step.value.cdr.car)!;
                step = evaluator.coroutineResume(fetcher, answers[key]);
            }
            expect(step.value).toBe(3);

            const failing = evaluator.evaluateRaw(evaluator.compileRaw(`(coroutine-create (lambda () (raise 'nope)))`));
            expect(() => evaluator.coroutineResume(failing)).toThrow("nope");
        });

        it('multiple values', () => {
            expect(run("(call-with-values (lambda () (values 1 2)) +)")).toBe("3");
            expect(run("(call-with-values (lambda () 5) list)")).toBe("(5)");
            expect(run("(call-with-values (lambda () (values)) list)")).toBe("()");
            expect(run("(values 7)")).toBe("7");
            expect(run("(values 1 'a)")).toBe("(values 1 a)");
            expect(run("(receive (a b . rest) (values 1 2 3 4) (list a b rest))")).toBe("(1 2 (3 4))");
            expect(run("(receive all (values 1 2) all)")).toBe("(1 2)");
            expect(run("(let-values (((a b) (values 1 2)) ((c) (values 3))) (list a b c))")).toBe("(1 2 3)");
            expect(run("(let ((a 10)) (let-values (((a) (values 1)) ((b) (values a))) (list a b)))")).toBe("(1 10)");
            expect(run("(let*-values (((a) (values 1)) ((b) (values (+ a 1)))) (list a b))")).toBe("(1 2)");
            expect(run(`(define mv-co (coroutine-create (lambda (a b) (receive (x y) (coroutine-yield (+ a b) (* a b)) (list x y)))))
                        (list (call-with-values (lambda () (coroutine-resume mv-co 2 3)) list) (coroutine-resume mv-co 'p 'q))`)).toBe("((5 6) (p q))");
            expect(run(`(define mv-co2 (coroutine-create (lambda () (let ((y coroutine-yield)) (y 1 2)))))
                        (call-with-values (lambda () (let ((r coroutine-resume)) (r mv-co2))) list)`)).toBe("(1 2)");

            expect(run(`(define mv-co3 (coroutine-create (lambda () (let ((y coroutine-yield)) (+ 100 (y 1))))))
                        (list (coroutine-resume mv-co3) (coroutine-resume mv-co3 5) (coroutine-status mv-co3))`)).toBe("(1 105 dead)");

            const hostCo = evaluator.evaluateRaw(evaluator.compileRaw(`(coroutine-create (lambda (a b) (receive (x y) (coroutine-yield b a) (+ x y))))`));
            expect(evaluator.coroutineResume(hostCo, 1, 2)).toEqual({ done: false, value: 2, values: [2, 1] });
            expect(evaluator.coroutineResume(hostCo, 10, 20)).toEqual({ done: true, value: 30, values: [30] });
        });

        it('global lookups stay correct when globals change', () => {
            expect(run(`(define (k2) 1) (define (use2) (k2)) (list (use2) (begin (set! k2 (lambda () 2)) (use2)))`)).toBe("(1 2)");
            run(`(define (kk) 1) (define (usek) (kk))`);
            expect(run("(usek)")).toBe("1");
            run(`(define (kk) 2)`);
            expect(run("(usek)")).toBe("2");
            run(`(define (usem) not-yet-defined)`);
            expect(() => run("(usem)")).toThrow("not-yet-defined");
            run(`(define not-yet-defined 5)`);
            expect(run("(usem)")).toBe("5");

            const bc = evaluator.compileRaw("(+ gx 1)");
            const vm = new AnimaVM("aot");
            const scopeA = new Env(); scopeA.set(Symbol.for("gx"), 1);
            const scopeB = new Env(); scopeB.set(Symbol.for("gx"), 10);
            expect(vm.evaluateRaw(bc as ByteCode, scopeA)).toBe(2);
            expect(vm.evaluateRaw(bc as ByteCode, scopeB)).toBe(11);
            expect(vm.evaluateRaw(bc as ByteCode, scopeA)).toBe(2);
            scopeA.set(Symbol.for("gx"), 100);
            expect(vm.evaluateRaw(bc as ByteCode, scopeA)).toBe(101);
        });

        it('rejects binding reserved builtins', () => {
            expect(() => run("(lambda (+) 1)")).toThrow("cannot bind builtin +");
            expect(() => run("(let ((< 1)) <)")).toThrow("cannot bind builtin <");
            expect(() => run("(define apply 1)")).toThrow("cannot bind builtin apply");
            expect(() => run("(set! = 1)")).toThrow("cannot bind builtin =");
            expect(() => run("(lambda (list) 1)")).toThrow("cannot bind builtin list");
            expect(() => run("(lambda (car) car)")).toThrow("cannot bind builtin car");
            expect(() => run("(define map 1)")).toThrow("cannot bind builtin map");
        });

        it('comparisons', () => {
            expect(run("(< 1 2 3)")).toBe("#t");
            expect(run("(< 1 3 2)")).toBe("#f");
            expect(run("(< 2 2)")).toBe("#f");
            expect(run("(<= 1 2 2 3)")).toBe("#t");
            expect(run("(<= 1 3 2)")).toBe("#f");
            expect(run("(> 3 2 1)")).toBe("#t");
            expect(run("(> 3 1 2)")).toBe("#f");
            expect(run("(> 2 2)")).toBe("#f");
            expect(run("(>= 3 2 2 1)")).toBe("#t");
            expect(run("(>= 3 1 2)")).toBe("#f");
        });

        it('Ensure valid TCO', () => {
            const script = `
                (begin
                  (define (loop n)
                    (if (= n 0)
                        "survived!"
                        (loop (- n 1))))
                  (loop 15000))
            `;
            expect(() => run(script)).not.toThrow();
            expect(run(script)).toBe("\"survived!\"");
        });

        it('Ensure valid TCO [2]', () => {
            const script = `
                (begin
                  (define (loop n)
                    (if (= n 0)
                        "survived!"
                        (loop (- n 1))))
                  (loop 15000))
            `;
            expect(() => run(script)).not.toThrow();
            expect(run(script)).toBe("\"survived!\"");
        });

        it('test recursion', () => {
            const script = `
(define (f n)
  (if (= n 0)
      (lambda () n) 
      (f (- n 1))))

((f 10))`

            expect(run(script)).toBe("0")
        })

        it('test recursion and closure capture', () => {
            const script = `
(define (f n)
  (if (= n 0)
      (lambda () n)
      (begin
        (let ((inner-closure (f (- n 1))))
           inner-closure))))

((f 1))
            `
            expect(run(script)).toBe("0")
        })

        it('test upvars/upvalues', () => {
            const script = `
(define (f n)
  (define m n) ; m will now become a upvalue
  (define (o)
    (define (q) (+ 1 m))
    (+ 1 (q))
  )
  (o)
)

(f 1)
            `
            expect(run(script)).toBe("3")

            expect(run(`
(define (test-deep-reach x)
  (define (level1)
    (define (level2)
      (define (level3)
        (+ x 10))  ; level3 uses 'x'
      (level3))    ; level2 just passes through
    (level2))      ; level1 just passes through
  (level1))

(test-deep-reach 5)    
            `)).toBe("15")

            expect(run(`
(define (test-shadowing)
  (let ((x 100))
    (let ((x 20))
      (let ((f (lambda () x)))
        (let ((x 50))
          (f)))))) ; f should still return 20, not 50 or 100

(test-shadowing)
            `)).toBe("20")

            expect(run(`
(define (make-account initial)
  (let ((balance initial))
    (define (withdraw amount)
      (set! balance (- balance amount))
      balance)
    (define (deposit amount)
      (set! balance (+ balance amount))
      balance)
    (withdraw 10)
    (deposit 50)))

(make-account 100)
            `)).toBe("140")

            expect(run(`
(define (make-counter)
  (let ((count 0))
    (lambda ()
      (set! count (+ count 1))
      count)))

(let ((counter-a (make-counter))
      (counter-b (make-counter)))
  (counter-a) ; 1
  (counter-a) ; 2
  (counter-b) ; 1 (Should be completely independent)
  (counter-a))
`)).toBe("3")

            expect(run(`
(define (multiplier factor)
  (lambda (n)
    (* n factor)))

(let ((times-two (multiplier 2))
      (times-five (multiplier 5)))
  (+ (times-two 10) (times-five 10)))
                `)).toBe("70")
        })
    });

    describe('Logic & Control Flow', () => {
        it('evaluates strict equality', () => {
            expect(run("(eqv? port 8080)")).toBe("#t");
            expect(run(`(not (eqv? protocol "udp"))`)).toBe("#t");
        });

        it('evaluates if statements using strict truthiness', () => {
            expect(run(`(if is_active "yes" "no")`)).toEqual('"yes"');
            expect(run(`(if (not (empty? user_role)) "yes" "no")`)).toBe('"no"');
            expect(run(`(if 0 "yes" "no")`)).toEqual('"yes"');
        });

        it('short-circuits AND statements', () => {
            expect(run("(and #t #f does_not_exist)")).toBe("#f");
        });

        it('short-circuits OR statements and returns actual truthy values', () => {
            expect(run("(or #f port (crash!))")).toEqual("8080");
        });
    });

    describe('map', () => {
        it('maps a procedure over a single list', () => {
            const script = `
                (begin
                  (define (double x) (* x 2))
                  (map double '(1 2 3 4)))
            `;
            expect(run(script)).toEqual("(2 4 6 8)");
        });

        it('maps a procedure over a single list [2]', () => {
            const script = `
                (begin
                  (define (double x) (* x 2))
                  (map double '(1 2 3 4)))
            `;
            expect(run(script)).toEqual("(2 4 6 8)");
        });

        it('maps a procedure over multiple lists in parallel', () => {
            const script = `(map + '(1 2 3) '(10 20 30))`;
            expect(run(script)).toEqual("(11 22 33)");
            
            const script3 = `(map + '(1 1 1) '(2 2 2) '(3 3 3))`;
            expect(run(script3)).toEqual("(6 6 6)");
        });

        it('safely terminates when the shortest list is exhausted', () => {
            const script = `(map + '(1 2 3 4 5) '(10 20))`;
            expect(run(script)).toEqual("(11 22)");
        });

        it('errors with prelude in mapped lambda', () => {
            const script = `(map (lambda (x) (%ArrayNew)) '(1 2 3 4 5))`;
            expect(() => run(script)).toThrow(MissingVarError);
        });
    })

    describe('apply', () => {
        it('applies a procedure to a single list of arguments', () => {
            expect(run(`(apply + '(1 2 3 4))`)).toBe("10");
            expect(run(`(apply * '(2 3 4))`)).toBe("24");
        });

        it('handles preceding standalone arguments before the final list', () => {
            expect(run(`(apply + 100 200 '(1 2))`)).toBe("303");
            expect(run(`(apply - 100 '(50 25))`)).toBe("25");
        });

        it('works flawlessly with user-defined closures', () => {
            const script = `
                (begin
                  (define (multiply-add a b c) (+ (* a b) c))
                  (apply multiply-add 10 '(5 2)))
            `;
            // (10 * 5) + 2 = 52
            expect(run(script)).toBe("52"); 
        });

        it('handles the empty list gracefully', () => {
            const script = `
                (begin
                  (define (return-five) 5)
                  (apply return-five '()))
            `;
            expect(run(script)).toBe("5");
        });

        it('throws an error if the last argument is not a list', () => {
            expect(() => run(`(apply + 1 2 3)`)).toThrow(/must be a list/);
        });

        it('supports first-class aliasing like (define apply2 apply)', () => {
            expect(run(`
                (begin
                  (define apply2 apply)
                  (apply2 + '(10 20 30)))
            `)).toBe("60");
            expect(run(`
                (begin
                  (define apply2 apply)
                  (define (f xs) (apply2 * xs))
                  (f '(2 3 4)))
            `)).toBe("24");
        });
    });

    describe('Exception handlers as continuation marks', () => {
        it('runs a handler with the outer handlers installed', () => {
            expect(run(`(with-exception-handler (lambda (e) (+ e 1))
                          (lambda () (with-exception-handler (lambda (e) (raise-continuable (* e 10)))
                                       (lambda () (raise-continuable 1)))))`)).toBe("11")
            expect(run(`(try (lambda () (with-exception-handler (lambda (e) (raise (list 'wrapped e))) (lambda () (raise 'x)))) (lambda (e) e))`)).toBe("(wrapped x)")
            expect(run(`(try (lambda () (with-exception-handler (lambda (e) 'ignored) (lambda () (raise 'x)))) (lambda (e) (error-message e)))`)).toBe('"handler returned on non-continuable exception"')
        })

        it('catches errors from a tail call that leaves no frame', () => {
            expect(run(`(define hm-len vector-length) (try (lambda () (hm-len 5)) (lambda (e) 'caught))`)).toBe("caught")
            expect(run(`(define (hm-tail) (hm-len 5)) (try hm-tail (lambda (e) 'caught))`)).toBe("caught")
        })

        it('restores handlers after escapes and on re-entry', () => {
            expect(run(`(list (try (lambda () (raise 1)) (lambda (e) e)) (try (lambda () (raise 2)) (lambda (e) e)))`)).toBe("(1 2)")
            expect(run(`(define hm-k #f) (define hm-n 0)
                        (define hm-r (with-exception-handler (lambda (e) (list 'handled e)) (lambda () (call/cc (lambda (c) (set! hm-k c))) (raise-continuable hm-n))))
                        (set! hm-n (+ hm-n 1))
                        (if (< hm-n 2) (hm-k #f) hm-r)`)).toBe("(handled 1)")
        })

        it('installs handlers in tail position in constant stack space', () => {
            expect(run(`(define (hm-loop n) (if (= n 0) 'ok (with-exception-handler (lambda (e) e) (lambda () (hm-loop (- n 1)))))) (hm-loop 100000)`)).toBe("ok")
        })
    });

    describe('pcall and %catch', () => {
        it('returns #t and all the values, or #f and the error', () => {
            expect(run(`(call-with-values (lambda () (pcall + 1 2)) list)`)).toBe("(#t 3)")
            expect(run(`(call-with-values (lambda () (pcall (lambda () (values 1 2)))) list)`)).toBe("(#t 1 2)")
            expect(run(`(call-with-values (lambda () (pcall (lambda () (values)))) list)`)).toBe("(#t)")
            expect(run(`(call-with-values (lambda () (pcall raise 'x)) list)`)).toBe("(#f x)")
            expect(run(`(call-with-values (lambda () (pcall vector-length 5)) (lambda (ok e) (list ok (error-message e))))`)).toBe('(#f "vector-length requires a vector")')
            expect(run(`(call-with-values (lambda () (pcall 5)) (lambda (ok e) ok))`)).toBe("#f")
            expect(run(`(define pc-f pcall) (call-with-values (lambda () (pc-f raise 'z)) list)`)).toBe("(#f z)")
        })

        it('evaluates the procedure and arguments before protecting the call', () => {
            expect(run(`(try (lambda () (pcall car (car '()))) (lambda (e) 'outer))`)).toBe("outer")
        })

        it('unwinds before running the handler', () => {
            expect(run(`(define pc-log '())
                        (try (lambda () (dynamic-wind (lambda () #f) (lambda () (raise 'x)) (lambda () (set! pc-log (cons 'after pc-log)))))
                             (lambda (e) (set! pc-log (cons 'handler pc-log))))
                        pc-log`)).toBe("(handler after)")
            expect(run(`(try (lambda () (try (lambda () (raise 1)) (lambda (e) (raise (+ e 1))))) (lambda (e) e))`)).toBe("2")
        })

        it('lets inner handlers see errors first', () => {
            expect(run(`(call-with-values (lambda () (pcall (lambda () (with-exception-handler (lambda (e) 42) (lambda () (+ 1 (raise-continuable 'c))))))) list)`)).toBe("(#t 43)")
            expect(run(`(call-with-values (lambda () (pcall raise-continuable 'y)) list)`)).toBe("(#f y)")
        })

        it('evaluates the %catch handler only when an error is caught', () => {
            expect(run(`(define ce-n 0) (list (%catch (lambda () 1) (begin (set! ce-n (+ ce-n 1)) (lambda (e) e))) ce-n)`)).toBe("(1 0)")
            expect(run(`(list (%catch (lambda () (raise 5)) (begin (set! ce-n (+ ce-n 1)) (lambda (e) (* e 2)))) ce-n)`)).toBe("(10 1)")
            expect(run(`(let ((h (lambda (e) (list 'h e)))) (list (%catch (lambda () (raise 1)) h)))`)).toBe("((h 1))")
        })

        it('keeps nested handlers once raising code runs on heap frames', () => {
            expect(run(`(define (ce-many n) (if (= n 0) 'done (begin (try (lambda () (raise n)) (lambda (e) e)) (ce-many (- n 1)))))
                        (ce-many 50)
                        (try (lambda () (try (lambda () (raise 'inner)) (lambda (e) (raise (list 'wrapped e))))) (lambda (e) e))`)).toBe("(wrapped inner)")
            expect(run(`(define (ce-cm) (with-continuation-mark 'ce-q 7 (call/cc (lambda (k) (continuation-mark-set-first #f 'ce-q)))))
                        (let loop ((i 0) (s 0)) (if (= i 20) s (loop (+ i 1) (+ s (ce-cm)))))`)).toBe("140")
        })

        it('calls the %catch handler in tail position', () => {
            expect(run(`(define (ce-loop n) (if (= n 0) 'ok (%catch (lambda () (raise n)) (lambda (e) (ce-loop (- e 1)))))) (ce-loop 100000)`)).toBe("ok")
        })

        it('catches repeatedly, from coroutines, and lets escapes through', () => {
            expect(run(`(let loop ((i 0) (n 0)) (if (= i 50) n (loop (+ i 1) (+ n (try (lambda () (vector-length i)) (lambda (e) 1))))))`)).toBe("50")
            expect(run(`(call-with-values (lambda () (pcall coroutine-resume (coroutine-create (lambda () (raise 'co))))) list)`)).toBe("(#f co)")
            expect(run(`(call/ec (lambda (k) (try (lambda () (k 'esc)) (lambda (e) 'no))))`)).toBe("esc")
        })
    });

    describe('The exception model (%raise / %catch)', () => {
        it('delivers %raise to handlers, continuable or not', () => {
            expect(run(`(with-exception-handler (lambda (e) (* e 2)) (lambda () (+ 1 (%raise 20 #t))))`)).toBe("41")
            expect(run(`(%catch (lambda () (with-exception-handler (lambda (e) 'ignored) (lambda () (%raise 'x)))) (lambda (e) (error-message e)))`)).toBe('"handler returned on non-continuable exception"')
            expect(run(`(%catch (lambda () (%raise 'x)) (lambda (e) (list 'caught e)))`)).toBe("(caught x)")
        })

        it('runs %catch pre-handlers before unwinding, with the outer handlers', () => {
            expect(run(`(define em-log '())
                        (%catch (lambda () (dynamic-wind (lambda () #f) (lambda () (%raise 'x)) (lambda () (set! em-log (cons 'after em-log)))))
                                (lambda (v) (list v (reverse em-log)))
                                (lambda (e) (set! em-log (cons 'pre em-log)) (list 'pre-saw e)))`)).toBe("((pre-saw x) (pre after))")
            expect(run(`(%catch (lambda () (%catch (lambda () (%raise 1)) (lambda (v) (list 'inner v)) (lambda (e) (%raise (+ e 1))))) (lambda (v) (list 'outer v)))`)).toBe("(outer 2)")
            expect(run(`(%catch (lambda () (car '())) (lambda (v) v) (lambda (e) (error-message e)))`)).toBe('"car: list is too short"')
            expect(run(`(define em-many (let loop ((i 0) (n 0)) (if (= i 30) n (loop (+ i 1) (+ n (%catch (lambda () (%raise i)) (lambda (v) v) (lambda (e) 1))))))) em-many`)).toBe("30")
        })

        it('mixes handler procedures and catches in one list', () => {
            expect(run(`(%catch (lambda () (with-exception-handler (lambda (e) (%raise (list 'from-handler e))) (lambda () (%raise 'x)))) (lambda (v) v))`)).toBe("(from-handler x)")
            expect(run(`(with-exception-handler (lambda (e) 99) (lambda () (%catch (lambda () (+ 1 (%raise 'y #t))) (lambda (v) (list 'caught v)))))`)).toBe("(caught y)")
            expect(run(`(call-with-values (lambda () (pcall (lambda () (with-exception-handler (lambda (e) (list 'h e)) (lambda () (%raise 'z #t)))))) list)`)).toBe("(#t (h z))")
        })

        it('reports unhandled raises with a traceback', () => {
            expect(() => run(`(define (em-bad) (%raise 'nope)) (list (em-bad))`)).toThrow("nope")
        })
    });

    describe('Exception Handling & Dynamic Wind', () => {
        it('executes dynamic-wind before, body, and after in order', () => {
            expect(run(`
                (define trace '())
                (define res (dynamic-wind
                    (lambda () (set! trace (cons 'before trace)))
                    (lambda () (set! trace (cons 'body trace)) 42)
                    (lambda () (set! trace (cons 'after trace)))))
                (list res trace)
            `)).toBe('(42 (after body before))');
        });

        it('re-executes before and after thunks when jumping with continuations', () => {
            expect(run(`
                (define trace '())
                (define saved-k #f)
                (dynamic-wind
                    (lambda () (set! trace (cons 'enter trace)))
                    (lambda ()
                        (call/cc (lambda (k) (set! saved-k k)))
                        (set! trace (cons 'inside trace)))
                    (lambda () (set! trace (cons 'exit trace))))
                (if saved-k
                    (let ((k saved-k))
                        (set! saved-k #f)
                        (k #f))
                    #f)
                trace
            `)).toBe('(exit inside enter exit inside enter)');
        });

        it('handles with-exception-handler and raise', () => {
            expect(run(`
                (call/cc
                    (lambda (k)
                        (with-exception-handler
                            (lambda (err) (k 99))
                            (lambda () (raise 'boom)))))
            `)).toBe('99');
        });

        it('intercepts runtime exceptions like division by zero and missing variables', () => {
            expect(run(`
                (call/cc
                    (lambda (k)
                        (with-exception-handler
                            (lambda (err) (k (error-message err)))
                            (lambda () (/ 1 0)))))
            `)).toContain('division by zero');

            expect(run(`
                (call/cc
                    (lambda (k)
                        (with-exception-handler
                            (lambda (err) (k (error-message err)))
                            (lambda () undefined-variable-xyz))))
            `)).toContain("Variable 'Symbol(undefined-variable-xyz)' is not defined");
        });

        it('supports raise-continuable where handler returns to call site', () => {
            expect(run(`
                (with-exception-handler
                    (lambda (err) 10)
                    (lambda () (+ 5 (raise-continuable 'request-five))))
            `)).toBe('15');
        });

        it('throws an error if handler returns on non-continuable raise', () => {
            expect(() => run(`
                (with-exception-handler
                    (lambda (err) 42)
                    (lambda () (raise 'boom)))
            `)).toThrow(/non-continuable exception/);
        });

        it('evaluates guard macro correctly', () => {
            expect(run(`
                (guard (e
                        ((= e 1) "one")
                        ((= e 2) "two")
                        (else "other"))
                    (raise 2))
            `)).toBe('"two"');

            expect(run(`
                (guard (e
                        ((= e 1) "one")
                        (else "fallback"))
                    (raise 99))
            `)).toBe('"fallback"');

            expect(run(`
                (guard (e
                        (else "error"))
                    (+ 10 20))
            `)).toBe('30');
        });

        it('re-raises to outer guard when no clause matches', () => {
            expect(run(`
                (guard (outer
                        ((= outer 42) "caught-by-outer"))
                    (guard (inner
                            ((= inner 1) "caught-by-inner"))
                        (raise 42)))
            `)).toBe('"caught-by-outer"');
        });

        it('supports try helper from prelude', () => {
            expect(run(`
                (try
                    (lambda () (/ 1 0))
                    (lambda (err) "caught division by zero"))
            `)).toBe('"caught division by zero"');

            expect(run(`
                (try
                    (lambda () (+ 10 20))
                    (lambda (err) "failed"))
            `)).toBe('30');
        });

        it('unwinds with-exception-handler before enclosing dynamic-wind after thunk runs', () => {
            expect(run(`
                (define handler-ran #f)
                (define outer-caught #f)
                (define saved-k #f)

                (call/cc
                    (lambda (exit)
                        (with-exception-handler
                            (lambda (err)
                                (set! outer-caught #t)
                                (exit 999))
                            (lambda ()
                                (dynamic-wind
                                    (lambda () #f)
                                    (lambda ()
                                        (with-exception-handler
                                            (lambda (err)
                                                (set! handler-ran #t)
                                                123)
                                            (lambda ()
                                                (call/cc (lambda (k) (set! saved-k k))))))
                                    (lambda ()
                                        ;; In after thunk: inner handler must be uninstalled!
                                        (raise 'after-error)))))))

                (if saved-k
                    (let ((k saved-k))
                        (set! saved-k #f)
                        (k #f))
                    #f)

                (list handler-ran outer-caught)
            `)).toBe('(#f #t)');
        });
    });

    describe('Math Operations', () => {
        it('performs basic arithmetic', () => {
            expect(run("(+ 10 5)")).toBe("15");
            expect(run("(- 10 5)")).toBe("5");
            expect(run("(* 10 5)")).toBe("50");
            expect(run("(/ 10 5)")).toBe("2");
            expect(run("(modulo 10 3)")).toBe("1");
        });
    });

    describe('Data Structures & Types', () => {
        it('creates lists and evaluates length', () => {
            expect(run("(list 1 2 3)")).toEqual("(1 2 3)");
            expect(run(`(length (list "a" "b"))`)).toBe("2");
            expect(run(`(length "string_len")`)).toBe("10");
        });

        it('checks contains', () => {
            expect(run("(contains? (list 1 2) 2)")).toBe("#t");
            expect(run("(contains? (list 1 2) 3)")).toBe("#f");
        });
    });

    describe('Lexical Scoping & Closures', () => {
        it('executes defines correctly', () => {
            const script = `
                (define x 10)
                (define y 20)
                (+ x y)
            `;
            expect(run(script)).toBe("30");
        });

        it('creates and calls a lambda with arguments', () => {
            const script = `
                (begin
                  (define (add a b) (+ a b))
                  (add 5 7))
            `;
            expect(run(script)).toBe("12");
        });

        it('creates and calls a lambda with multiple body expressions', () => {
            const script = `
                (begin
                  (define counter 0)
                  (define (increment)
                    (set! counter (+ counter 1))
                    counter)
                  (increment))
            `;
            expect(run(script)).toBe("1");
        });

        it('respects closure scope (variables enclosed at creation)', () => {
            const script = `
                (begin
                  (define x 100)
                  (define (make_adder y) (+ x y))
                  (define x 999)
                  (make_adder 5))
            `;
            expect(run(script)).toBe("1004");
        });
    });

    describe('quote operator & Native Symbols', () => {
        it('quotes primitive numbers', () => {
            expect(run("'42")).toBe("42");
        });

        it('quotes Symbols perfectly', () => {
            expect(run("'x")).toBe("x");
        });

        it('protects lists and retains inner native types', () => {
            expect(run("'(+ 1 2)")).toEqual("(+ 1 2)");
        });

        it('protects nested lists perfectly', () => {
            expect(run("'(1 (2 3) 4)")).toEqual("(1 (2 3) 4)");
        });

        it('handles nested quotes recursively', () => {
            expect(run("''100")).toEqual("(quote 100)");
        });

        it('throws an error if given too many arguments natively', () => {
            expect(() => run("(quote 1 2)")).toThrow();
        });
    });

    describe('cond special form', () => {
        it('Matches the first truthy condition', () => {
            const script = `
                (cond 
                  (#t "first")
                  (#t "second"))
            `;
            expect(run(script)).toBe('"first"');
        });

        it('Skips falsey conditions and matches later ones', () => {
            const script = `
                (cond 
                  (#f "first")
                  ((= 1 2) "second")
                  ((> 5 3) "third"))
            `;
            expect(run(script)).toBe('"third"');
        });

        it('Falls back to the else clause if nothing matches', () => {
            const script = `
                (cond 
                  (#f "first")
                  (#f "second")
                  (else "fallback"))
            `;
            expect(run(script)).toBe('"fallback"');
        });

        it('Returns void if no conditions match and there is no else clause', () => {
            const script = `
                (cond 
                  (#f "first")
                  ((= 1 2) "second"))
            `;
            expect(run(script)).toBe("<#void>");
        });
    });

    describe('Cons, Arrays & FFI Boundary', () => {
        it('constructs a proper list and extracts values (car/cdr)', () => {
            expect(run("(car (cons 1 (cons 2 null)))")).toBe("1");
            expect(run("(car (cdr (cons 1 (cons 2 null))))")).toBe("2");
        });

        it('supports improper lists perfectly', () => {
            expect(run("(car (cons 1 2))")).toBe("1");
            expect(run("(cdr (cons 1 2))")).toBe("2");
            expect(run("(length (cons 1 2))")).toBe("1");
        });

        it('triggers the O(1) Fast Path for raw JS arrays', () => {
            expect(run("(car '(10 20 30))")).toBe("10");
            expect(run("(car (cdr '(10 20 30)))")).toBe("20");
            expect(run("(length '(10 20 30))")).toBe("3");
        });

        it('handles array -> Cons', () => {
            expect(run("(car (cons 1 '(2 3)))")).toBe("1");
            expect(run("(car (cdr (cons 1 '(2 3))))")).toBe("2");
            expect(run("(length (cons 1 '(2 3)))")).toBe("3"); 
        });

        it('throws errors for empty lists', () => {
            expect(() => run("(car null)")).toThrow();
            expect(() => run("(car '())")).toThrow();
            expect(() => run("(cdr '())")).toThrow();
        });

        it('traverses cons-array hybrids with standard operators (last, contains)', () => {
            expect(run(`(contains? (cons "a" (cons "b" null)) "b")`)).toBe("#t");
            expect(run(`(contains? (cons "a" (cons "b" null)) "c")`)).toBe("#f");
            expect(run(`(contains? '("a" "b") "b")`)).toBe("#t");

            expect(run(`(last (cons "a" (cons "b" null)))`)).toBe('"b"');
            expect(run(`(last '("a" "b"))`)).toBe('"b"');
            expect(run(`(last (cons "a" "b"))`)).toBe('"b"');
        });
    });

    describe('let bindings', () => {
        it('evaluates a simple single binding', () => {
            const script = `(let ([x 10]) x)`;
            expect(run(script)).toBe("10");
        });

        it('evaluates multiple bindings', () => {
            const script1 = `
                (let ([x 10] [y 20] [z 5]) 
                  (- (+ x y) z))
            `;
            expect(run(script1)).toBe("25");

            const script2 = `(let ((a 5) (b 5)) (+ a b))`;
            expect(run(script2)).toBe("10");
        });

        it('shadows outer variables without mutating them (Lexical Purity)', () => {
            const script = `
                (begin
                  (define x 100)
                  (define result (let ([x 5] [y 5]) (+ x y)))
                  (list result x))
            `;
            expect(run(script)).toStrictEqual("(10 100)");
        });

        it('supports multiple body expressions', () => {
            const script = `
                (let ([multiplier 10])
                  (define x 5)
                  (define y 2)
                  (* x y multiplier))
            `;
            expect(run(script)).toBe("100");
        });

        it('handles empty bindings correctly', () => {
            const script = `(let () 99)`;
            expect(run(script)).toBe("99");
        });
        
        it('throws an error for malformed bindings', () => {
            const script = `(let ([x]) x)`;
            expect(() => run(script)).toThrow();
        });
    });

    describe('Complex tests', () => {
        it('my-set?', () => {
            expect(run(`
(define my-set?
  (lambda (a)
    (define (in a rst) 
      (cond 
         [(empty? rst) #f]
         [(equal? a (car rst)) #t]
         [else (in a (cdr rst))]))

    (cond 
      [(empty? a) #t]
      [else 
        (if (in (car a) (cdr a)) #f (my-set? (cdr a)))])))

(my-set? (list 1 2 3 4 5))`
)).toBe("#t");

            expect(run(`
(define my-set?
  (lambda (a)
    (define (in a rst) 
      (cond 
         [(empty? rst) #f]
         [(equal? a (car rst)) #t]
         [else (in a (cdr rst))]))

    (cond 
      [(empty? a) #t]
      [else 
        (if (in (car a) (cdr a)) #f (my-set? (cdr a)))])))

(my-set? (list 1 2 3 4 4))`
)).toBe("#f");

        expect(run(`
(define union
    (lambda (a b)
        (define (in a rst) 
        (cond 
            [(empty? rst) #f]
            [(equal? a (car rst)) #t]
            [else (in a (cdr rst))]))

        (cond
        ; if either set is empty, the other one if the union
        [(empty? a) b]
        [(empty? b) a]
        ; if b is in a, skip it
        [(in (car b) a) (union a (cdr b))]
        [else (cons (car b) (union a (cdr b)))])))

(define sum-of-squares
  (lambda (a)
    ; do x*x for every element in a, then sum them all up
    (apply + [map (lambda (x) (* x x)) a])))
        
    (list (equal? (union '(a b d e f h j) '(f c e g a)) '(c g a b d e f h j)) (equal? (sum-of-squares (list 1 3 5 7)) 84))
        `)).toEqual("(#t #t)")
        });
    });

    it('or: evaluates base cases (0 and 1 argument)', () => {
        expect(run(`(or)`)).toBe("#f");
        expect(run(`(or #t)`)).toBe("#t");
        expect(run(`(or #f)`)).toBe("#f");
        expect(run(`(or 42)`)).toBe("42");
    });

    it('or: returns the first truthy value', () => {
        expect(run(`(or #f 42)`)).toBe("42");
        expect(run(`(or 42 #f)`)).toBe("42");
        expect(run(`(or #f #f 'hello)`)).toBe('hello'); 
        expect(run(`(or 1 2 3)`)).toBe("1");
    });

    it('or: short-circuits and does not evaluate subsequent expressions', () => {
        const code = `
            (define x 0)
            (or #t (set! x 99) (set! x 100))
            x
        `;
        // x should remain 0 because #t short-circuits the evaluation
        expect(run(code)).toBe("0");
    });

    it('or: evaluates the truthy condition exactly once (IIFE/let validation)', () => {
        // This specifically tests that `(let ((tmp expr)) (if tmp tmp ...))` 
        // does not double-evaluate `expr` if it has side effects.
        const code = `
            (define counter 0)
            (define (inc-and-return-true)
                (set! counter (+ counter 1))
                'success)
            
            (define result (or (inc-and-return-true) 'fallback))
            
            ;; Return a pair/list of the result and the counter
            (list result counter)
        `;
        // If it evaluates twice, counter would be 2.
        const res = run(code);
        expect(res).toBe('(success 1)');
    });

    it('or:  evaluates falsy conditions exactly once', () => {
        const code = `
            (define counter 0)
            (define (inc-and-return-false)
                (set! counter (+ counter 1))
                #f)
            
            (define result (or (inc-and-return-false) (inc-and-return-false) 42))
            
            (list result counter)
        `;
        // The function is called twice (once for each false condition), so counter should be 2.
        // It should NOT be 4, which would happen if the desugaring was `(if expr expr ...)` without `let`.
        const res = run(code);
        expect(res).toBe("(42 2)");
    });

    it('or: treats everything except #f as truthy', () => {
        // In Scheme, 0, empty string, and empty list are all truthy.
        expect(run(`(or 0 #f)`)).toBe("0");
        expect(run(`(or "" #f)`)).toBe('""');
        expect(run(`(or '() #f)`)).toEqual("()"); // Adjust expected value based on your AST for '()
    });

    it('or: preserves tail-call optimization in the terminal position', () => {
        // If the tail call state is lost during the desugaring of `or`,
        // this recursive loop will crash with a Maximum Call Stack Size Exceeded error.
        const code = `
            (define (loop n)
                (if (= n 0)
                    'done
                    ;; The recursive call is the fallback of the \`or\`, 
                    ;; which MUST remain in tail position.
                    (or #f (loop (- n 1)))))
            
            (loop 50000)
        `;
        
        // Should complete successfully without blowing the JS stack
        expect(() => run(code)).not.toThrow();
        expect(run(code)).toBe('done');
    });

    it('anima-macro', () => {
        expect(run(`
(anima-macro first-sym 
    (list 'quote (car (car (cdr orig)))))

(first-sym (listof 1 2 3))
`)).toBe("listof");
    });

    it('call/cc', () => {
        expect(run(`
(+ 2 (call/cc (lambda (k) (+ 3 (k 5)))))
`)).toBe("7");

        expect(run(`
(define (product lst)
  (call/cc
    (lambda (break)
      (letrec ((loop (lambda (l)
                      (cond
                        ((null? l) 1)
                        ((= (car l) 0) (break 0))
                        (else (* (car l) (loop (cdr l))))))))
        (loop lst)))))

(list (product '(1 2 3 4 5)) (product '(1 2 0 4 5)))
`)).toBe("(120 0)");

        expect(run(`
(let ((retry #f)
      (val 0))
  (begin
    (set! val (call/cc (lambda (k) 
                          (set! retry k) 
                          1)))
    (if (< val 5)
        (begin
          (set! val (+ val 1))
          (retry val))
        val)))`)).toBe("5");

        // Verify continuation is an IProcedure and procedure? recognizes it
        expect(run(`(procedure? (call/cc (lambda (k) k)))`)).toBe("#t");

        // Multi-shot continuation test within same evaluation context
        expect(run(`
(let ((k #f)
      (count 0))
  (set! count (+ count 1))
  (call/cc (lambda (cont) (set! k cont)))
  (if (< count 3)
      (begin
        (set! count (+ count 1))
        (k #t))
      count))
`)).toBe("3");

        // Disallow invoking continuations across separate execution / FFI boundaries
        run(`(define saved-k #f)`);
        run(`(+ 10 (call/cc (lambda (k) (set! saved-k k) 5)))`);
        expect(() => run(`(saved-k 42)`)).toThrow("Cannot invoke a continuation across execution/FFI boundary");

        // Verify debugName on procedures
        const plusProc = evaluator.scope.get(Symbol.for("+"));
        expect(plusProc.debugName).toBe("+");

        const closure = evaluator.evaluateRaw(evaluator.compileRaw(`(lambda (x y) (+ x y))`));
        expect(closure.debugName).toBe("lambda@<input>:1");
        const restClosure = evaluator.evaluateRaw(evaluator.compileRaw(`(lambda (x . rest) x)`));
        expect(restClosure.debugName).toBe("lambda@<input>:1");
        const named = evaluator.evaluateRaw(evaluator.compileRaw(`(define (named-fn x) x) named-fn`));
        expect(named.debugName).toBe("named-fn");

        const cont = evaluator.evaluateRaw(evaluator.compileRaw(`(call/cc (lambda (k) k))`));
        expect(cont.debugName).toBe("continuation");
    });
    
    describe('call/cc + dynamic-wind (multi-shot & multi-level)', () => {

        it('unwinds three nested dynamic-winds innermost-first on a single escape', () => {
            expect(run(`
                (define trace '())
                (define (add! x) (set! trace (cons x trace)))

                (call/cc
                    (lambda (escape)
                        (dynamic-wind
                            (lambda () (add! 'a-in))
                            (lambda ()
                                (dynamic-wind
                                    (lambda () (add! 'b-in))
                                    (lambda ()
                                        (dynamic-wind
                                            (lambda () (add! 'c-in))
                                            (lambda () (escape 'done))
                                            (lambda () (add! 'c-out))))
                                    (lambda () (add! 'b-out))))
                            (lambda () (add! 'a-out)))))

                trace
            `)).toBe('(a-out b-out c-out c-in b-in a-in)');
        });

        it('re-enters two nested dynamic-winds root-to-leaf when a continuation is invoked from outside', () => {
            expect(run(`
                (define trace '())
                (define (add! x) (set! trace (cons x trace)))
                (define k-inner #f)

                (dynamic-wind
                    (lambda () (add! 'a-in))
                    (lambda ()
                        (dynamic-wind
                            (lambda () (add! 'b-in))
                            (lambda ()
                                (call/cc (lambda (k) (set! k-inner k)))
                                (add! 'body))
                            (lambda () (add! 'b-out))))
                    (lambda () (add! 'a-out)))

                (if k-inner
                    (let ((k k-inner))
                        (set! k-inner #f)
                        (k #f))
                    #f)

                trace
            `)).toBe('(a-out b-out body b-in a-in a-out b-out body b-in a-in)');
        });

        it('supports a multi-shot generator: resuming the same continuation across separate later calls', () => {
            expect(run(`
                (define (make-generator lst)
                    (define return #f)
                    (define (control-state k)
                        (define (loop rest)
                            (if (null? rest)
                                (return 'done)
                                (begin
                                    (set! k (call/cc (lambda (resume-here)
                                                        (set! control-state resume-here)
                                                        (return (car rest)))))
                                    (loop (cdr rest)))))
                        (loop lst))
                    (define (generator)
                        (call/cc (lambda (return-here)
                                    (set! return return-here)
                                    (control-state control-state))))
                    generator)

                (define gen (make-generator '(1 2 3)))
                (list (gen) (gen) (gen) (gen))
            `)).toBe('(1 2 3 done)');
        });

        it('keeps guard/raise state correctly scoped across repeated independent invocations', () => {
            expect(run(`
                (define log '())
                (define (add! x) (set! log (cons x log)))

                (define (try-once tag n)
                    (guard (e (#t (add! (list tag 'caught e))))
                        (add! (list tag 'before))
                        (if (> n 0) (raise n) #f)
                        (add! (list tag 'after))))

                (try-once 'first 1)
                (try-once 'second 0)
                (try-once 'third 2)

                log
            `)).toBe("((third caught 2) (third before) (second after) (second before) (first caught 1) (first before))");
        });

        it('keeps a handler installed across two sequential raise-continuable calls', () => {
            expect(run(`
                (define trace '())
                (with-exception-handler
                    (lambda (e) (set! trace (cons (list 'handled e) trace)) (* e 10))
                    (lambda ()
                        (let ((a (raise-continuable 1)))
                            (let ((b (raise-continuable 2)))
                                (set! trace (cons (list 'sum (+ a b)) trace))))))
                trace
            `)).toBe("((sum 30) (handled 2) (handled 1))");
        });

        it('lets a continuation escape from inside a dynamic-wind after-thunk, aborting the rest of that thunk', () => {
            expect(run(`
                (define escape-target #f)
                (define trace '())
                (define (add! x) (set! trace (cons x trace)))

                (call/cc
                    (lambda (top)
                        (set! escape-target top)
                        (dynamic-wind
                            (lambda () (add! 'in))
                            (lambda () (add! 'body))
                            (lambda ()
                                (add! 'out-start)
                                (escape-target 'bail)
                                (add! 'out-end)))))

                trace
            `)).toBe('(out-start body in)');
        });

        it('correctly nests dynamic-wind under moderate recursion', () => {
            expect(run(`
                (define depth 0)
                (define max-depth 0)
                (define (my-max a b) (if (> a b) a b))
                (define (track-enter) (set! depth (+ depth 1)) (set! max-depth (my-max max-depth depth)))
                (define (track-exit) (set! depth (- depth 1)))

                (define (loop n)
                    (dynamic-wind
                        track-enter
                        (lambda ()
                            (if (= n 0)
                                'done
                                (loop (- n 1))))
                        track-exit))

                (let ((result (loop 25)))
                    (list result depth max-depth))
            `)).toBe("(done 0 26)");
        });

        // the whole source is one top-level body, so saved-k's continuation includes the (saved-k ...) call itself:
        // re-entering unconditionally loops forever, so this bounds it with a counter
        it('correctly does not clobber regs', () => {
            expect(run(`
(define saved-k #f)
(define n 0)
(define seen '())

(define (test-accumulator)
  (let ((result (dynamic-wind
                  (lambda () #f)
                  (lambda ()
                    (call/cc (lambda (k)
                               (set! saved-k k)
                               "initial-return")))
                  (lambda ()
                    999))))
    (set! seen (cons result seen))))

(test-accumulator)
(set! n (+ n 1))
(if (< n 3)
    (saved-k "re-entered-value")
    seen)
            `)).toBe(`("re-entered-value" "re-entered-value" "initial-return")`)
        })
    });

    describe('Structured control flow (%block / %escape / %loop)', () => {
        it('blocks yield their body or an escaped value', () => {
            expect(run(`(%block k 1 2)`)).toBe("2")
            expect(run(`(%block k (%escape k 5) 6)`)).toBe("5")
            expect(run(`(%block k (%escape k))`)).toBe("<#void>")
            expect(run(`(%block a (+ 1 (%block b (%escape a 10))))`)).toBe("10")
            expect(run(`(%block a (+ 1 (%block b (%escape b 10))))`)).toBe("11")
            expect(run(`(%block k (%block k (%escape k 1)) 2)`)).toBe("2")
        })

        it('loops run until an escape, with break and continue as blocks', () => {
            expect(run(`(define (count-to n) (let ((i 0)) (%block done (%loop (%if (= i n) (%escape done i) (%begin)) (set! i (+ i 1)))))) (count-to 100000)`)).toBe("100000")
            // continue = escape to a block around the body, so the step still runs
            expect(run(`(define (sum-odds n)
                          (let ((i 0) (sum 0))
                            (%block break
                              (%loop
                                (%if (> i n) (%escape break sum) (%begin))
                                (%block continue
                                  (%if (even? i) (%escape continue) (%begin))
                                  (set! sum (+ sum i)))
                                (set! i (+ i 1))))))
                        (sum-odds 10)`)).toBe("25")
            // nested loops: escaping the inner one only
            expect(run(`(define (pairs n) (let ((i 0) (acc '()))
                          (%block outer (%loop
                            (%if (= i n) (%escape outer (reverse acc)) (%begin))
                            (let ((j 0))
                              (%block inner (%loop
                                (%if (= j i) (%escape inner) (%begin))
                                (set! acc (cons (list i j) acc))
                                (set! j (+ j 1)))))
                            (set! i (+ i 1))))))
                        (pairs 3)`)).toBe("((1 0) (2 0) (2 1))")
        })

        it('early return from a function is an escape in tail position', () => {
            expect(run(`(define (find-first pred xs)
                          (let ((l xs))
                            (%block return
                              (%loop
                                (%if (null? l) (%escape return #f) (%begin))
                                (%if (pred (car l)) (%escape return (car l)) (%begin))
                                (set! l (cdr l))))))
                        (find-first even? '(1 3 4 5 6))`)).toBe("4")
            // a named let used only as a loop compiles to a %loop, so escaping out of it is fine
            expect(run(`(%block return (let loop ((l '(1 2))) (%if (null? l) 'none (%escape return (car l)))))`)).toBe("1")
            // one whose name is used as a value stays a procedure, so escaping out of it is rejected
            expect(() => run(`(%block return (let loop ((l '(1))) (list loop) (%escape return l)))`)).toThrow("from inside a lambda")
            // the escaped value is computed in tail position, so this does not grow the stack
            expect(run(`(define (down n) (%block k (%if (= n 0) (%escape k 'done) (%escape k (down (- n 1)))))) (down 100000)`)).toBe("done")
        })

        it('each iteration can capture its own variable', () => {
            expect(run(`(let ((fs '()) (i 0))
                          (%block d (%loop
                            (%if (= i 3) (%escape d) (%begin))
                            (let ((j i)) (set! fs (cons (lambda () j) fs)))
                            (set! i (+ i 1))))
                          (map (lambda (f) (f)) fs))`)).toBe("(2 1 0)")
        })

        it('works across call/cc re-entry and coroutine yields', () => {
            // i is a variable (a location), so a re-entry continues from its current value rather than from 1;
            // entries bounds the re-entries, since the continuation includes the rest of the program
            expect(run(`(define saved #f)
                        (define hits 0)
                        (define entries 0)
                        (define (loop-with-k)
                          (let ((i 0))
                            (%block done (%loop
                              (%if (>= i 3) (%escape done i) (%begin))
                              (%if (= i 1) (call/cc (lambda (k) (set! saved k))) (%begin))
                              (set! hits (+ hits 1))
                              (set! i (+ i 1))))))
                        (define r (loop-with-k))
                        (set! entries (+ entries 1))
                        (%if (< entries 3) (saved #f) (list r hits entries))`)).toBe("(5 5 3)")
            expect(run(`(define gen (coroutine-create (lambda () (let ((i 0)) (%block d (%loop (%if (= i 3) (%escape d 'end) (%begin)) (coroutine-yield i) (set! i (+ i 1))))))))
                        (list (coroutine-resume gen) (coroutine-resume gen) (coroutine-resume gen) (coroutine-resume gen))`)).toBe("(0 1 2 end)")
        })

        it('rejects escapes that leave a lambda or name no block', () => {
            expect(() => run(`(%block k (map (lambda (x) (%escape k x)) '(1)))`)).toThrow("cannot escape to block k from inside a lambda")
            expect(() => run(`(%escape nope 1)`)).toThrow("no enclosing block named nope")
            expect(() => run(`(%block 5 1)`)).toThrow("%block requires a block name symbol")
            // a let is an inlined lambda, so escaping through it is fine
            expect(run(`(%block k (let ((x 1)) (%escape k (+ x 1))))`)).toBe("2")
        })

        it('keeps the structured direct entry in AOT', () => {
            if (_mode !== "aot") return
            const f = evaluator.evaluateRaw(evaluator.compileRaw(`(lambda (n) (let ((i 0)) (%block d (%loop (%if (= i n) (%escape d i) (%begin)) (set! i (+ i 1))))))`))
            expect(f.tmpl.code.directFn).not.toBeNull()
        })
    });

    describe('call/cc-heavy code in AOT', () => {
        it('stays correct when a function switches from direct calls to heap frames', () => {
            // after a few call/cc suspends its direct entry is turned off; values before and after must agree
            expect(run(`(define (make-cc-gen n)
                          (define return #f)
                          (define resume-point #f)
                          (lambda ()
                            (call/cc (lambda (r)
                              (set! return r)
                              (if resume-point
                                  (resume-point #f)
                                  (begin
                                    (let loop ((i 0))
                                      (if (< i n)
                                          (begin (call/cc (lambda (k) (set! resume-point k) (return i))) (loop (+ i 1)))
                                          #f))
                                    (return 'done)))))))
                        (define (collect g acc) (let ((v (g))) (if (eq? v 'done) (reverse acc) (collect g (cons v acc)))))
                        (let ((xs (collect (make-cc-gen 50) '()))) (list (length xs) (car xs) (car (reverse xs)) (apply + xs)))`)).toBe("(50 0 49 1225)")
        })
    });

    describe('call/ec (escape continuations)', () => {
        it('returns normally or escapes with a value', () => {
            expect(run(`(call/ec (lambda (k) 7))`)).toBe("7")
            expect(run(`(call/ec (lambda (k) (+ 1 (k 42))))`)).toBe("42")
            expect(run(`(call-with-escape-continuation (lambda (k) (k 'x)))`)).toBe("x")
            expect(run(`(define ec-f call/ec) (ec-f (lambda (k) (k 3)))`)).toBe("3")
            expect(run(`(let/ec out (map (lambda (x) (if (= x 3) (out x) x)) '(1 2 3 4)))`)).toBe("3")
            expect(run(`(call/ec (lambda (k) (procedure? k)))`)).toBe("#t")
        })

        it('escapes from deep non-tail recursion', () => {
            expect(run(`(define (ec-deep k n) (if (= n 0) (k 'done) (+ 1 (ec-deep k (- n 1)))))
                        (call/ec (lambda (k) (ec-deep k 5000)))`)).toBe("done")
        })

        it('escapes many times in a loop', () => {
            expect(run(`(let loop ((i 0) (s 0)) (if (= i 100) s (loop (+ i 1) (+ s (call/ec (lambda (k) (k i)))))))`)).toBe("4950")
        })

        it('runs dynamic-wind after thunks when escaping, every time', () => {
            expect(run(`(define ec-log '())
                        (define (ec-wind i) (call/ec (lambda (k) (dynamic-wind (lambda () (set! ec-log (cons 'in ec-log))) (lambda () (k i)) (lambda () (set! ec-log (cons 'out ec-log)))))))
                        (let loop ((i 0) (s 0)) (if (= i 20) (list s (length ec-log) (car ec-log)) (loop (+ i 1) (+ s (ec-wind i)))))`)).toBe("(190 40 out)")
        })

        it('restores continuation marks after an escape', () => {
            expect(run(`(with-continuation-mark 'ec-m 1
                          (let ((v (call/ec (lambda (k) (with-continuation-mark 'ec-m 2 (+ 0 (k (continuation-mark-set-first #f 'ec-m))))))))
                            (list v (continuation-mark-set-first #f 'ec-m))))`)).toBe("(2 1)")
        })

        it('escapes from code that captured a full continuation', () => {
            expect(run(`(call/ec (lambda (k) (+ 1 (call/cc (lambda (c) (k 5))))))`)).toBe("5")
            expect(run(`(define (ec-cc i) (call/ec (lambda (k) (call/cc (lambda (c) c)) (+ 1 (k i)))))
                        (let loop ((i 0) (s 0)) (if (= i 20) s (loop (+ i 1) (+ s (ec-cc i)))))`)).toBe("190")
        })

        it('cannot be invoked after its extent has ended', () => {
            expect(() => run(`(define ec-saved #f) (call/ec (lambda (k) (set! ec-saved k) 1)) (ec-saved 2)`)).toThrow("outside of its dynamic extent")
            expect(() => run(`(define ec-inner #f) (define ec-count 0)
                              (define ec-r (call/ec (lambda (outer) (+ 100 (call/ec (lambda (inner) (set! ec-inner inner) (dynamic-wind (lambda () 0) (lambda () (outer 1)) (lambda () 0))))))))
                              (set! ec-count (+ ec-count 1))
                              (if (< ec-count 3) (ec-inner 2) ec-r)`)).toThrow("outside of its dynamic extent")
        })

        it('keeps the frames of a stale escape for handlers and tracebacks', () => {
            expect(run(`(define ec-stale (call/ec (lambda (k) k)))
                        (define (ec-use n) (if (= n 0) (ec-stale 1) (+ 1 (ec-use (- n 1)))))
                        (try (lambda () (ec-use 3)) (lambda (e) 'stale))`)).toBe("stale")
        })

        it('escapes from an extent re-entered through call/cc', () => {
            expect(run(`(define ec-re #f) (define ec-n 0)
                        (call/ec (lambda (k) (call/cc (lambda (c) (set! ec-re c))) (set! ec-n (+ ec-n 1)) (if (< ec-n 3) (ec-re #f) (k ec-n))))`)).toBe("3")
            expect(run(`(define ec-re2 #f) (define ec-m 0)
                        (define ec-v (call/ec (lambda (k) (call/cc (lambda (c) (set! ec-re2 c))) (k 'out))))
                        (set! ec-m (+ ec-m 1))
                        (if (< ec-m 2) (ec-re2 #f) (list ec-v ec-m))`)).toBe("(out 2)")
        })

        it('keeps try working, including nested and on host errors', () => {
            expect(run(`(try (lambda () (try (lambda () (raise 'inner)) (lambda (e) (raise (list 'wrapped e))))) (lambda (e) e))`)).toBe("(wrapped inner)")
            expect(run(`(let loop ((i 0) (n 0)) (if (= i 20) n (loop (+ i 1) (+ n (try (lambda () (car '())) (lambda (e) 1))))))`)).toBe("20")
            expect(run(`(try (lambda () 'fine) (lambda (e) 'bad))`)).toBe("fine")
        })
    });

    describe('Continuation marks', () => {
        it('reads marks, and drops them when a non-tail mark body returns', () => {
            expect(run(`(with-continuation-mark 'k 1 (continuation-mark-set-first #f 'k))`)).toBe("1")
            expect(run(`(define (cm-get) (continuation-mark-set-first #f 'k)) (list (with-continuation-mark 'k 1 (cm-get)) (cm-get))`)).toBe("(1 #f)")
            expect(run(`(continuation-mark-set-first #f 'cm-missing 'none)`)).toBe("none")
            expect(run(`(list (continuation-mark-set? (current-continuation-marks)) (continuation-mark-set? 1))`)).toBe("(#t #f)")
        })

        it('replaces a mark on tail calls and adds one per non-tail frame', () => {
            expect(run(`(define (cm-down n) (with-continuation-mark 'k n (if (= n 0) (continuation-mark-set->list (current-continuation-marks) 'k) (cm-down (- n 1))))) (cm-down 3)`)).toBe("(0)")
            expect(run(`(define (cm-nest n) (with-continuation-mark 'k n (if (= n 0) (continuation-mark-set->list (current-continuation-marks) 'k) (car (list (cm-nest (- n 1))))))) (cm-nest 2)`)).toBe("(0 1 2)")
            // a deep tail loop that sets a mark every iteration stays flat
            expect(run(`(define (cm-loop n) (with-continuation-mark 'k n (if (= n 0) (length (continuation-mark-set->list (current-continuation-marks) 'k)) (cm-loop (- n 1))))) (cm-loop 100000)`)).toBe("1")
        })

        it('restores marks when escaping out of a mark body', () => {
            expect(run(`(list (%block b (+ 1 (with-continuation-mark 'k 1 (%escape b 5)))) (continuation-mark-set-first #f 'k))`)).toBe("(5 #f)")
        })

        it('travels with continuations and coroutines', () => {
            expect(run(`(define cm-k #f) (define cm-n 0)
                        (define (cm-cc) (with-continuation-mark 'k 'inside (car (list (call/cc (lambda (k) (set! cm-k k) (continuation-mark-set-first #f 'k)))))))
                        (define cm-r (cm-cc))
                        (set! cm-n (+ cm-n 1))
                        (if (< cm-n 2) (cm-k 'again) (list cm-r cm-n (continuation-mark-set-first #f 'k)))`)).toBe("(again 2 #f)")
            expect(run(`(define cm-co (coroutine-create (lambda () (with-continuation-mark 'k 'co (begin (coroutine-yield (continuation-mark-set-first #f 'k)) (continuation-mark-set-first #f 'k))))))
                        (with-continuation-mark 'k 'outer (list (coroutine-resume cm-co) (continuation-mark-set-first #f 'k) (coroutine-resume cm-co)))`)).toBe("(co outer co)")
        })
    });

    describe('named let as a loop', () => {
        // a procedure compiled with no nested procedures means the named let became a %loop
        const nestedProcs = (src: string): number => {
            const f = evaluator.evaluateRaw(evaluator.compileRaw(src))
            return f.tmpl.code.constants.filter((c: any) => c instanceof Object && ("tmpl" in c || "upvarLocs" in c)).length
        }

        it('compiles tail-call-only named lets to loops', () => {
            expect(nestedProcs(`(lambda (n) (let loop ((i 0) (acc 0)) (if (= i n) acc (loop (+ i 1) (+ acc i)))))`)).toBe(0)
            expect(nestedProcs(`(lambda (xs) (let loop ((l xs) (n 0)) (cond ((null? l) n) ((even? (car l)) (loop (cdr l) (+ n 1))) (else (loop (cdr l) n)))))`)).toBe(0)
            expect(run(`(define (count-to n) (let loop ((i 0)) (if (= i n) i (loop (+ i 1))))) (count-to 100000)`)).toBe("100000")
        })

        it('keeps a procedure when the name is used any other way', () => {
            // non-tail recursion
            expect(nestedProcs(`(lambda () (let fact ((n 5)) (if (= n 0) 1 (* n (fact (- n 1))))))`)).toBe(1)
            expect(run(`(let fact ((n 5)) (if (= n 0) 1 (* n (fact (- n 1)))))`)).toBe("120")
            // used as a value, called from a nested lambda, assigned, wrong argument count
            expect(run(`(let loop ((i 0)) (if (= i 2) (procedure? loop) (loop (+ i 1))))`)).toBe("#t")
            expect(run(`(let loop ((l '(1 2 3)) (acc 0)) (if (null? l) acc (apply loop (list (cdr l) (+ acc (car l))))))`)).toBe("6")
            expect(run(`(let loop ((i 0)) (if (< i 3) ((lambda () (loop (+ i 1)))) i))`)).toBe("3")
            expect(() => run(`(let loop ((i 0)) (if (< i 3) (loop) i))`)).toThrow("expected exactly 1 args, got 0")
        })

        it('handles set! on the loop name and on its parameters', () => {
            // assigning the name keeps the procedure, and later calls go to the new value
            const setName = `(let loop ((i 0)) (if (= i 0) (begin (set! loop (lambda (x) (list 'replaced x))) (loop 1)) i))`
            expect(nestedProcs(`(lambda () ${setName})`)).toBeGreaterThan(0)
            expect(run(setName)).toBe("(replaced 1)")
            // assigning a parameter keeps the loop; each iteration still gets a fresh variable
            const setParam = `(let loop ((i 0) (acc '())) (if (= i 3) (reverse acc) (begin (set! i (+ i 1)) (loop i (cons i acc)))))`
            expect(nestedProcs(`(lambda () ${setParam})`)).toBe(0)
            expect(run(setParam)).toBe("(1 2 3)")
            expect(run(`(let loop ((i 0) (fs '())) (if (= i 3) (map (lambda (f) (f)) fs) (let ((g (lambda () i))) (set! i (* i 10)) (loop (+ (/ i 10) 1) (cons g fs)))))`)).toBe("(20 10 0)")
        })

        it('converts nested loops whose inner loop exits by calling the outer one', () => {
            const grid = `(let outer ((i 0) (acc '())) (if (= i 3) (reverse acc) (let inner ((j 0) (acc acc)) (if (= j 2) (outer (+ i 1) acc) (inner (+ j 1) (cons (list i j) acc))))))`
            expect(nestedProcs(`(lambda () ${grid})`)).toBe(0)
            expect(run(grid)).toBe("((0 0) (0 1) (1 0) (1 1) (2 0) (2 1))")
            // an escape to a block that is not in tail position is not a tail call, even if an outer block of the same
            // name is: (outer 1) here is an argument of +, so this is recursion (result 2), not a loop (result 1)
            const shadowed = `(let outer ((i 0)) (if (= i 1) i (%block b (+ 1 (%block b (%escape b (outer 1)))))))`
            expect(nestedProcs(`(lambda () ${shadowed})`)).toBeGreaterThan(0)
            expect(run(shadowed)).toBe("2")
        })

        it('is not confused by a parameter with the loop name', () => {
            // (loop 5) calls the parameter, not the loop
            expect(run(`(let loop ((loop (lambda (x) (* x 2)))) (loop 5))`)).toBe("10")
        })

        it('is not confused by a define of the loop name', () => {
            // an internal define shadows the loop name for the whole body
            expect(run(`(let loop ((i 0)) (define (loop x) (* x 100)) (loop 5))`)).toBe("500")
            // defining a global of that name leaves the local binding (and the loop) alone
            const defGlobal = `(let loop ((i 0)) (%define-global nl-global-loop 42) (if (= i 3) i (loop (+ i 1))))`
            expect(nestedProcs(`(lambda () ${defGlobal})`)).toBe(0)
            expect(run(`(list ${defGlobal} nl-global-loop)`)).toBe("(3 42)")
            expect(run(`(list (let loop ((i 0)) (%define-global loop 42) (if (= i 3) i (loop (+ i 1)))) loop)`)).toBe("(3 42)")
        })

        it('updates in parallel and binds fresh variables every iteration', () => {
            expect(run(`(let loop ((a 1) (b 2) (n 3)) (if (= n 0) (list a b) (loop b a (- n 1))))`)).toBe("(2 1)")
            expect(run(`(let loop ((i 0) (fs '())) (if (= i 3) (map (lambda (f) (f)) fs) (loop (+ i 1) (cons (lambda () i) fs))))`)).toBe("(2 1 0)")
            expect(run(`(let loop ((i 3)) (let ((loop (lambda (x) (* x 10)))) (loop i)))`)).toBe("30")
            expect(run(`(let loop ((i 0) (acc '())) (define sq (* i i)) (if (= i 3) (reverse acc) (loop (+ i 1) (cons sq acc))))`)).toBe("(0 1 4)")
        })

        it('works with call/cc re-entry and coroutines inside the loop', () => {
            expect(run(`(define nl-k #f) (define nl-n 0)
                        (define nl-r (let loop ((i 0) (acc '()))
                          (if (= i 3) (reverse acc)
                              (begin (if (= i 1) (call/cc (lambda (k) (set! nl-k k))) #f)
                                     (loop (+ i 1) (cons i acc))))))
                        (set! nl-n (+ nl-n 1))
                        (if (< nl-n 3) (nl-k #f) (list nl-r nl-n))`)).toBe("((0 1 2) 3)")
            expect(run(`(define nl-co (coroutine-create (lambda () (let loop ((i 0)) (if (= i 3) 'end (begin (coroutine-yield i) (loop (+ i 1))))))))
                        (list (coroutine-resume nl-co) (coroutine-resume nl-co) (coroutine-resume nl-co) (coroutine-resume nl-co))`)).toBe("(0 1 2 end)")
        })
    });

    describe('%let', () => {
        // whether a variable is boxed shows up as BOX instructions in the procedure's code
        const boxesIn = (src: string): number => {
            const closure = evaluator.evaluateRaw(evaluator.compileRaw(src))
            const inst: Uint32Array = closure.tmpl.code.inst
            let boxes = 0
            for (let ip = 0; ip < inst.length; ip += INSTRUCTION_LENGTHS[inst[ip] as OpCode]) if (inst[ip] === OpCode.BOX) boxes++
            return boxes
        }

        it('does not box variables that are only read inside a let', () => {
            expect(boxesIn(`(lambda (n) (let ((x 1)) (let* ((y (+ x n))) (+ x y n))))`)).toBe(0)
            // captured by a real lambda: boxed
            expect(boxesIn(`(lambda (n) (let ((x 1)) (lambda () (+ x n))))`)).toBe(2)
            // assigned but never read after a call: a plain register
            expect(boxesIn(`(lambda (n) (let ((x 1)) (set! x n) x))`)).toBe(0)
            expect(boxesIn(`(lambda (f) (let ((x 1)) (f) (set! x 2) x))`)).toBe(0)
            // assigned and read after a call (a continuation captured there must see later assignments): boxed
            expect(boxesIn(`(lambda (f) (let ((x 1)) (set! x 2) (f) x))`)).toBe(1)
            // a loop counter read after a call in the body is live across it
            expect(boxesIn(`(lambda (f n) (let ((i 0)) (%block d (%loop (%if (= i n) (%escape d i) (%begin)) (f) (set! i (+ i 1))))))`)).toBe(1)
            // ... but with no calls in the loop it stays a register
            expect(boxesIn(`(lambda (n) (let ((i 0) (s 0)) (%block d (%loop (%if (= i n) (%escape d s) (%begin)) (set! s (+ s i)) (set! i (+ i 1))))))`)).toBe(0)
        })

        it('keeps location semantics for assigned variables across continuations', () => {
            // x is assigned after the capture and read after re-entry, so it must be one location (boxed)
            expect(run(`(define ls-k #f) (define ls-n 0)
                        (define (ls-f) (let ((x 0)) (call/cc (lambda (k) (set! ls-k k))) (set! ls-n (+ ls-n 1)) (let ((r x)) (set! x 10) r)))
                        (define ls-r (ls-f))
                        (if (< ls-n 2) (ls-k #f) (list ls-r ls-n))`)).toBe("(10 2)")
            // y is always assigned before it is read after the capture, so a register is indistinguishable
            expect(run(`(define lt-k #f) (define lt-n 0)
                        (define (lt-f) (let ((y 0)) (call/cc (lambda (k) (set! lt-k k))) (set! y (+ lt-n 100)) (set! lt-n (+ lt-n 1)) y))
                        (define lt-r (lt-f))
                        (if (< lt-n 2) (lt-k #f) (list lt-r lt-n))`)).toBe("(101 2)")
        })

        it('turns immediately applied lambdas into lets', () => {
            expect(run(`((lambda (a b) (+ a b)) 1 2)`)).toBe("3")
            expect(run(`((lambda (a . rest) (list a rest)) 1 2 3)`)).toBe("(1 (2 3))")
            expect(run(`((lambda args args) 1 2)`)).toBe("(1 2)")
            expect(run(`((lambda () (define z 4) (* z z)))`)).toBe("16")
            // escapes pass through them like any let
            expect(run(`(%block k ((lambda (x) (%escape k (* x 10))) 4))`)).toBe("40")
            // a wrong argument count stays a real call and fails at runtime
            expect(() => run(`((lambda (a b) a) 1)`)).toThrow()
        })

        it('scopes like let, let* and letrec', () => {
            expect(run(`(let ((x 1)) (let ((x 2) (y x)) (list x y)))`)).toBe("(2 1)")
            expect(run(`(let* ((x 1) (y (+ x 1))) (list x y))`)).toBe("(1 2)")
            expect(run(`(letrec ((ev? (lambda (n) (if (= n 0) #t (od? (- n 1))))) (od? (lambda (n) (if (= n 0) #f (ev? (- n 1)))))) (ev? 10))`)).toBe("#t")
            expect(run(`(let () 5)`)).toBe("5")
            expect(run(`(%let ((a 1) (b 2)) (define c 3) (+ a b c))`)).toBe("6")
            expect(() => run(`(%let ((a 1) (a 2)) a)`)).toThrow("duplicate parameter name")
            expect(() => run(`(%let (a) a)`)).toThrow("let binding bad syntax")
        })
    });

    describe('%let-values', () => {
        it('pads missing values with void and drops extras (Lua style)', () => {
            expect(run(`(%let-values (((a b c) (values 1 2))) (list a b c))`)).toBe("(1 2 <#void>)")
            expect(run(`(%let-values (((a) (values 1 2 3))) a)`)).toBe("1")
            expect(run(`(%let-values (((a b) 7)) (list a b))`)).toBe("(7 <#void>)")
            expect(run(`(%let-values (((a . r) (values 1 2 3)) (all (values))) (list a r all))`)).toBe("(1 (2 3) ())")
            expect(run(`(%let-values (((a b . r) (values 1))) (list a b r))`)).toBe("(1 <#void> ())")
        })

        it('is strict for receive, let-values and let*-values (Scheme style)', () => {
            expect(() => run(`(receive (a b) (values 1) a)`)).toThrow("let-values: expected 2 values but got 1")
            expect(() => run(`(let-values (((a) (values 1 2))) a)`)).toThrow("let-values: expected 1 value but got 2")
            expect(() => run(`(let*-values (((a b . r) (values 1))) a)`)).toThrow("let-values: expected at least 2 values but got 1")
            expect(run(`(%let-values/strict (((a b) (values 1 2))) (+ a b))`)).toBe("3")
        })

        it('binds in parallel, captures correctly and works across yields and continuations', () => {
            expect(run(`(let ((a 10)) (%let-values (((a) (values 1)) ((b) (values a))) (list a b)))`)).toBe("(1 10)")
            expect(run(`(define (pair-fns) (%let-values (((x y) (values 1 2))) (list (lambda () x) (lambda () y)))) (map (lambda (f) (f)) (pair-fns))`)).toBe("(1 2)")
            expect(run(`(define lv-co (coroutine-create (lambda () (%let-values (((a b) (coroutine-yield 'ready))) (list b a)))))
                        (list (coroutine-resume lv-co) (coroutine-resume lv-co 1 2))`)).toBe("(ready (2 1))")
            expect(run(`(define lv-k #f) (define lv-n 0)
                        (define lv-r (%let-values (((a b) (call/cc (lambda (k) (set! lv-k k) (values 1 2))))) (list a b)))
                        (set! lv-n (+ lv-n 1))
                        (if (= lv-n 1) (lv-k 5) (list lv-r lv-n))`)).toBe("((5 <#void>) 2)")
        })

        it('%first-value truncates multiple values to the first (Lua)', () => {
            expect(run(`(list (%first-value (values 1 2 3)) (%first-value 5) (%first-value (values)))`)).toBe("(1 5 <#void>)")
            expect(run(`(define (two) (values 10 20)) (define (fv-sum) (+ (%first-value (two)) 1)) (fv-sum)`)).toBe("11")
            expect(() => run(`(%first-value)`)).toThrow("%first-value requires 1 arguments")
        })

        it('compiles without closures', () => {
            // receive used to build a producer and a consumer lambda; now the procedure has no nested procedures at all
            const f = evaluator.evaluateRaw(evaluator.compileRaw(`(lambda (p) (receive (a b) (p) (+ a b)))`))
            const nested = f.tmpl.code.constants.filter((c: any) => c instanceof Object && ("tmpl" in c || "upvarLocs" in c))
            expect(nested).toEqual([])
        })
    });

    describe('Macro expansion limits', () => {
        it('stops a macro that keeps expanding into itself through a body', () => {
            expect(() => run(`(anima-macro self-ref (list 'lambda '() (list 'self-ref))) (self-ref)`)).toThrow(/nested too deeply|expansion limit/)
        })

        it('expands deep but finite programs', () => {
            // expansion does not depend on the backend, and AOT spends ~100ms generating code for the huge function
            if (_mode === "aot") return
            const clauses = Array.from({ length: 1000 }, (_, i) => `((= x ${i}) ${i})`).join(" ")
            expect(run(`(define x 999) (cond ${clauses} (else -1))`)).toBe("999")
            expect(run(Array.from({ length: 500 }, () => "((lambda () ").join("") + "1" + "))".repeat(500))).toBe("1")
        })
    });

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
            expect(tb).toBe("stack traceback:\n  t.anima:1:60 in top-level");
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

describe.each([["interp", implDebug], ["aot", implAotDebug]] as const)("debug %s", (_mode, vmImpl) => {
    let evaluator: Anima;
    beforeEach(() => { evaluator = new Anima(vmImpl) });
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

describe("Table internals", () => {
    it('border() is always a valid border and contents match a plain Map under random edits', () => {
        let seed = 12345
        const rand = (n: number) => {
            seed = (seed * 1103515245 + 12345) % 2147483648
            return seed % n
        }
        const problems: string[] = []
        for (let round = 0; round < 20; round++) {
            const t = new Table()
            const model = new Map<any, any>()
            for (let step = 0; step < 150; step++) {
                const key = rand(10) === 0 ? `s${rand(3)}` : rand(12) + 1
                if (rand(3) === 0) {
                    t.set(key, undefined)
                    model.delete(key)
                } else {
                    const val = rand(100)
                    t.set(key, val)
                    model.set(key, val)
                }
                const n = t.border()
                if ((n > 0 && !t.has(n)) || t.has(n + 1)) problems.push(`round ${round} step ${step}: ${n} is not a border`)
                if (t.size !== model.size) problems.push(`round ${round} step ${step}: size ${t.size} != ${model.size}`)
            }
            for (const [k, v] of model) if (t.get(k) !== v) problems.push(`round ${round}: ${k} is ${t.get(k)}, expected ${v}`)
        }
        expect(problems).toEqual([])
    });
});

describe("isDeepEqual: Improper Lists (Dotted Pairs)", () => {
    
    it("should correctly equate identical improper lists", () => {
        // (1 2 . 3)
        const a = Cons.pair(1, Cons.pair(2, 3));
        const b = Cons.pair(1, Cons.pair(2, 3));
        expect(isDeepEqual(a, b)).toBe(true);
    });

    it("should fail when comparing a proper list to an improper list", () => {
        // (1 2 3) 
        const proper = Cons.pair(1, Cons.pair(2, Cons.pair(3, null)));
        // (1 2 . 3)
        const improper = Cons.pair(1, Cons.pair(2, 3));
        
        expect(isDeepEqual(proper, improper)).toBe(false);
    });

    it("should fail when comparing an improper list to a native JS Array", () => {
        // (1 2 3)
        const arr = [1, 2, 3];
        // (1 2 3) as cons
        const arrCons = Cons.pair(1, Cons.pair(2, Cons.pair(3, null)))
        // (1 2 . 3) 
        const improper = Cons.pair(1, Cons.pair(2, 3));
        
        expect(isDeepEqual(arr, arrCons)).toBe(false);
        expect(isDeepEqual(arr, improper)).toBe(false);
    });

    it("should fail when improper lists have different tails", () => {
        // (1 2 . 3)
        const a = Cons.pair(1, Cons.pair(2, 3));
        // (1 2 . 4)
        const b = Cons.pair(1, Cons.pair(2, 4));
        
        expect(isDeepEqual(a, b)).toBe(false);
    });

    it("should correctly handle nested improper lists", () => {
        // (1 (2 . 3) . 4)
        const a = Cons.pair(1, Cons.pair(Cons.pair(2, 3), 4));
        const b = Cons.pair(1, Cons.pair(Cons.pair(2, 3), 4));
        // (1 (2 . 99) . 4)
        const c = Cons.pair(1, Cons.pair(Cons.pair(2, 99), 4));

        expect(isDeepEqual(a, b)).toBe(true);
        expect(isDeepEqual(a, c)).toBe(false);
    });
    
    it("should correctly handle list primitive equalities", () => {
        const a = Cons.pair(1, 2); // (1 . 2)
        const b = 2; // primitive (2)
        expect(isDeepEqual(a, b)).toBe(false);
    });
});

describe('Vectors (using JS Arrays)', () => {
    let evaluator: Anima;
    beforeEach(() => { evaluator = new Anima(vmImpl) });
    let s = new ASTStringifier();

    const run = (expr: string) => {
        const bc = evaluator.compileRaw(expr);
        return s.stringify(evaluator.evaluateRaw(bc));
    };

    it('evaluates vector literals #(...) and #[...]', () => {
        expect(run("#()")).toBe("#()");
        expect(run("#(1 2 3)")).toBe("#(1 2 3)");
        expect(run("'#(10 20 30)")).toBe("#(10 20 30)");
        expect(run("#[1 2 3]")).toBe("#(1 2 3)");
        expect(run('#("hello" #t 42)')).toBe('#("hello" #t 42)');
    });

    it('tests vector? predicate', () => {
        expect(run("(vector? #(1 2 3))")).toBe("#t");
        expect(run("(vector? #())")).toBe("#t");
        expect(run("(vector? '(1 2 3))")).toBe("#f");
        expect(run("(vector? '())")).toBe("#f");
        expect(run("(vector? 42)")).toBe("#f");
        expect(run('(vector? "vec")')).toBe("#f");
    });

    it('creates vectors with make-vector and vector', () => {
        expect(run("(make-vector 3)")).toBe("#(0 0 0)");
        expect(run("(make-vector 4 #t)")).toBe("#(#t #t #t #t)");
        expect(run("(make-vector 0)")).toBe("#()");
        expect(run("(vector 1 2 3)")).toBe("#(1 2 3)");
        expect(run("(vector)")).toBe("#()");
        expect(run("(let ((x 10)) (vector x (+ x 5)))")).toBe("#(10 15)");
    });

    it('measures vector-length', () => {
        expect(run("(vector-length #(1 2 3 4 5))")).toBe("5");
        expect(run("(vector-length #())")).toBe("0");
        expect(run("(vector-length (make-vector 10))")).toBe("10");
        expect(() => run("(vector-length '(1 2 3))")).toThrow();
    });

    it('indexes with vector-ref and bounds checks', () => {
        expect(run("(vector-ref #(10 20 30) 0)")).toBe("10");
        expect(run("(vector-ref #(10 20 30) 1)")).toBe("20");
        expect(run("(vector-ref #(10 20 30) 2)")).toBe("30");
        expect(() => run("(vector-ref #(10 20 30) 3)")).toThrow();
        expect(() => run("(vector-ref #(10 20 30) -1)")).toThrow();
    });

    it('mutates vectors with vector-set!', () => {
        const script = `
            (let ((v (vector 1 2 3)))
              (begin
                (vector-set! v 1 99)
                v))
        `;
        expect(run(script)).toBe("#(1 99 3)");
        expect(() => run("(let ((v (vector 1 2 3))) (vector-set! v 5 99))")).toThrow();
    });

    it('converts between vectors and lists', () => {
        expect(run("(vector->list #(1 2 3))")).toBe("(1 2 3)");
        expect(run("(vector->list #())")).toBe("()");
        expect(run("(list->vector '(1 2 3))")).toBe("#(1 2 3)");
        expect(run("(list->vector '())")).toBe("#()");
        expect(run("(vector->list (list->vector '(a b c)))")).toBe("(a b c)");
        expect(() => run("(list->vector 42)")).toThrow();
    });

    it('supports vector-fill!', () => {
        const script = `
            (let ((v (vector 1 2 3 4)))
              (begin
                (vector-fill! v 7)
                v))
        `;
        expect(run(script)).toBe("#(7 7 7 7)");
    });

    it('copies vectors independently with vector-copy', () => {
        const script = `
            (let ((v1 (vector 1 2 3)))
              (let ((v2 (vector-copy v1)))
                (begin
                  (vector-set! v2 0 99)
                  (list v1 v2))))
        `;
        expect(run(script)).toBe("(#(1 2 3) #(99 2 3))");
    });

    it('concatenates vectors with vector-append', () => {
        expect(run("(vector-append #(1 2) #(3 4) #(5))")).toBe("#(1 2 3 4 5)");
        expect(run("(vector-append)")).toBe("#()");
        expect(run("(vector-append #(1 2))")).toBe("#(1 2)");
    });

    it('checks vector-empty? and generic empty?', () => {
        expect(run("(vector-empty? #())")).toBe("#t");
        expect(run("(vector-empty? #(1))")).toBe("#f");
        expect(run("(empty? #())")).toBe("#t");
        expect(run("(empty? #(1))")).toBe("#f");
        expect(run("(empty? '())")).toBe("#t");
        expect(run('(empty? "")')).toBe("#t");
    });

    it('compares vectors with equal?', () => {
        expect(run("(equal? #(1 2 3) #(1 2 3))")).toBe("#t");
        expect(run("(equal? #(1 2) #(1 3))")).toBe("#f");
        expect(run("(equal? #(1 2) #(1 2 3))")).toBe("#f");
        expect(run("(equal? #(1 2) '(1 2))")).toBe("#f");
        expect(run("(equal? #(1 #(2 3)) #(1 #(2 3)))")).toBe("#t");
    });
});

describe('Tables (using Table class)', () => {
    let evaluator: Anima;
    beforeEach(() => { evaluator = new Anima(vmImpl) });
    let s = new ASTStringifier();

    const run = (expr: string) => {
        const bc = evaluator.compileRaw(expr);
        return s.stringify(evaluator.evaluateRaw(bc));
    };

    const runRaw = (expr: string) => {
        const bc = evaluator.compileRaw(expr);
        return evaluator.evaluateRaw(bc);
    };

    it('evaluates table literals {...}', () => {
        expect(run("{}")).toBe("{}");
        expect(run('{"a" 1 "b" 2}')).toBe('{"a" 1 "b" 2}');
        expect(run('{"sum" (+ 10 20) "isTrue" #t}')).toBe('{"sum" 30 "isTrue" #t}');
        expect(run('{"nested" {"x" 42}}')).toBe('{"nested" {"x" 42}}');
    });

    it('throws on malformed table literals', () => {
        expect(() => evaluator.compileRaw('{"a"}')).toThrow(ASPParseError);
        expect(() => evaluator.compileRaw('{"a" 1 "b"}')).toThrow(ASPParseError);
        expect(() => evaluator.compileRaw('{"a" . 1}')).toThrow(ASPParseError);
        expect(() => evaluator.compileRaw('{"a" 1 )')).toThrow(ASPParseError);
        expect(() => evaluator.compileRaw('(list 1 2 }')).toThrow(ASPParseError);
    });

    it('tests table? predicate', () => {
        expect(run("(table? {})")).toBe("#t");
        expect(run('(table? (table "a" 1))')).toBe("#t");
        expect(run("(table? #(1 2))")).toBe("#f");
        expect(run("(table? '(1 2))")).toBe("#f");
        expect(run('(table? "string")')).toBe("#f");
        expect(run("(table? 123)")).toBe("#f");
        expect(run("(table? #t)")).toBe("#f");
    });

    it('creates tables with table constructor', () => {
        expect(run("(table)")).toBe("{}");
        expect(run('(table "k" 99)')).toBe('{"k" 99}');
        expect(run('(table "a" 1 "b" 2)')).toBe('{"a" 1 "b" 2}');
        expect(() => run('(table "a")')).toThrow();
    });

    it('indexes with table-ref and defaults', () => {
        expect(run('(table-ref {"a" 1 "b" 2} "a")')).toBe("1");
        expect(run('(table-ref {"a" 1 "b" 2} "b")')).toBe("2");
        expect(run('(table-ref {"a" 1} "missing" 42)')).toBe("42");
        expect(run('(table-ref {"a" 1} "missing" #f)')).toBe("#f");
        expect(() => run('(table-ref {"a" 1} "missing")')).toThrow();
        expect(run(`(table-ref {'id 123} 'id)`)).toBe("123")
    });

    it('checks equality with table-is?', () => {
        expect(run('(table-is? {"a" 1 "b" 2} "a" 1)')).toBe("#t");
        expect(run('(table-is? {"a" 1 "b" 2} "a" 2)')).toBe("#f");
        expect(run('(table-is? {"a" 1 "b" 2} "b" 2)')).toBe("#t");
        expect(run('(table-is? {"a" "food"} "a" "food")')).toBe("#t");
        expect(run('(table-is? {"a" "food"} "a" "toys")')).toBe("#f");
        expect(run('(table-is? {"a" 1} "missing" 1)')).toBe("#f");
        expect(run('(table-is? {"a" 1} "missing" "default" "default")')).toBe("#t");
        expect(run('(table-is? {"a" 1} "missing" "other" "default")')).toBe("#f");
        expect(run('(table-is? {\'id "123"} \'id "123")')).toBe("#t");
        expect(run('(table-is? {\'id "123"} \'id "456")')).toBe("#f");
        expect(() => run('(table-is? "not-a-table" "a" 1)')).toThrow();
        expect(() => run('(table-is? {"a" 1} "a")')).toThrow();
    });

    it('mutates tables with table-set!', () => {
        const script = `
            (let ((tbl (table)))
              (begin
                (table-set! tbl "x" 10)
                (table-set! tbl "y" 20)
                (table-set! tbl "x" 30)
                (list (table-ref tbl "x") (table-ref tbl "y"))))
        `;
        expect(run(script)).toBe("(30 20)");
    });

    it('checks membership with table-has?', () => {
        expect(run('(table-has? {"a" 1} "a")')).toBe("#t");
        expect(run('(table-has? {"a" 1} "b")')).toBe("#f");
        expect(run('(table-has? {} "any")')).toBe("#f");
    });

    it('removes keys with table-delete!', () => {
        const script = `
            (let ((tbl {"a" 1 "b" 2}))
              (let ((removed (table-delete! tbl "a")))
                (list removed (table-has? tbl "a") (table-size tbl))))
        `;
        expect(run(script)).toBe("(#t #f 1)");
    });

    it('clears table with table-clear!', () => {
        const script = `
            (let ((tbl {"a" 1 "b" 2}))
              (begin
                (table-clear! tbl)
                (table-size tbl)))
        `;
        expect(run(script)).toBe("0");
    });

    it('measures size with table-size and table-empty? / empty?', () => {
        expect(run("(table-size {})")).toBe("0");
        expect(run('(table-size {"a" 1 "b" 2})')).toBe("2");
        expect(run("(table-empty? {})")).toBe("#t");
        expect(run('(table-empty? {"a" 1})')).toBe("#f");
        expect(run("(empty? {})")).toBe("#t");
        expect(run('(empty? {"a" 1})')).toBe("#f");
    });

    it('extracts table-keys and table-values as vectors', () => {
        expect(run("(vector? (table-keys {}))")).toBe("#t");
        expect(run("(vector? (table-values {}))")).toBe("#t");
        expect(run("(table-keys {})")).toBe("#()");
        expect(run("(table-values {})")).toBe("#()");
        expect(run('(table-keys {"a" 1})')).toBe('#("a")');
        expect(run('(table-values {"a" 1})')).toBe("#(1)");
    });

    it('copies tables with table-copy', () => {
        const script = `
            (let ((t1 {"a" 1}))
              (let ((t2 (table-copy t1)))
                (begin
                  (table-set! t2 "a" 99)
                  (list (table-ref t1 "a") (table-ref t2 "a")))))
        `;
        expect(run(script)).toBe("(1 99)");
    });

    it('freezes tables with table-freeze! and enforces immutability', () => {
        expect(run("(table-frozen? {})")).toBe("#f");
        expect(run('(table-frozen? (table-freeze! {"a" 1}))')).toBe("#t");

        // Mutating a frozen table throws
        const failSet = `
            (let ((tbl (table-freeze! {"a" 1})))
              (table-set! tbl "a" 2))
        `;
        expect(() => run(failSet)).toThrow();

        // Deleting from a frozen table throws
        const failDel = `
            (let ((tbl (table-freeze! {"a" 1})))
              (table-delete! tbl "a"))
        `;
        expect(() => run(failDel)).toThrow();

        // Clearing a frozen table throws
        const failClear = `
            (let ((tbl (table-freeze! {"a" 1})))
              (table-clear! tbl))
        `;
        expect(() => run(failClear)).toThrow();

        // table-copy creates an unfrozen mutable copy of a frozen table
        const copyScript = `
            (let ((frozen (table-freeze! {"a" 1})))
              (let ((unfrozen (table-copy frozen)))
                (begin
                  (table-set! unfrozen "a" 42)
                  (list (table-frozen? frozen) (table-frozen? unfrozen) (table-ref unfrozen "a")))))
        `;
        expect(run(copyScript)).toBe("(#t #f 42)");
    });

    it('merges tables with table-merge!', () => {
        const script = `
            (let ((t1 {"a" 1 "b" 2})
                  (t2 {"b" 20 "c" 30}))
              (begin
                (table-merge! t1 t2)
                (list (table-ref t1 "a") (table-ref t1 "b") (table-ref t1 "c"))))
        `;
        expect(run(script)).toBe("(1 20 30)");
    });

    it('compares tables with equal?', () => {
        expect(run("(equal? {} {})")).toBe("#t");
        expect(run('(equal? {"a" 1 "b" 2} {"b" 2 "a" 1})')).toBe("#t");
        expect(run('(equal? {"a" 1} {"a" 2})')).toBe("#f");
        expect(run('(equal? {"a" 1} {"a" 1 "b" 2})')).toBe("#f");
        expect(run('(equal? {"nested" {"x" 1}} {"nested" {"x" 1}})')).toBe("#t");
        expect(run('(equal? {"a" 1} \'("a" 1))')).toBe("#f");
    });

    it('supports JS Table class interop and FFI methods', () => {
        const meta = new Table();
        meta.set("active", true);

        const t = new Table();
        t.set("name", "Willow");
        t.set("version", 2);
        t.set("meta", meta);

        expect(t instanceof Table).toBe(true);
        expect(t.size).toBe(3);
        expect(t.get("name")).toBe("Willow");
        expect(t.get("meta") instanceof Table).toBe(true);
        expect((t.get("meta") as Table).get("active")).toBe(true);

        // JS iteration
        const entries = [...t.entries()];
        expect(entries.length).toBe(3);

        // JS freeze
        t.frozen = true;
        expect(t.frozen).toBe(true);
        expect(() => t.set("name", "Other")).toThrow();
        expect(() => t.delete("version")).toThrow();
        expect(() => t.clear()).toThrow();

        // JS host can unfreeze
        t.frozen = false;
        expect(t.frozen).toBe(false);
        t.set("name", "Other");
        expect(t.get("name")).toBe("Other");
        t.frozen = true;

        // Scheme evaluateRaw returns actual Table instance
        const rawT = runRaw('{"id" "test-123" "count" 5}');
        expect(rawT instanceof Table).toBe(true);
        expect(rawT.get("id")).toBe("test-123");
        expect(rawT.get("count")).toBe(5);
    });

    it('stores keys 1..n in an array part and treats <#void> as absent', () => {
        const t = new Table();
        t.set(2, "b"); t.set(1, "a"); t.set("k", "v"); t.set(3, "c");
        expect(t.border()).toBe(3);
        expect([...t.entries()]).toEqual([[1, "a"], [2, "b"], [3, "c"], ["k", "v"]]);

        // removing from the middle keeps the array part dense; the rest stays reachable
        t.set(2, undefined);
        expect(t.border()).toBe(1);
        expect(t.has(2)).toBe(false);
        expect(t.get(3)).toBe("c");
        expect(t.size).toBe(3);
        t.set(2, "B");
        expect(t.border()).toBe(3);
        expect([...t.keys()]).toEqual([1, 2, 3, "k"]);

        // 1.0 and 1 are the same key, and so are 0 and -0
        t.set(1.0, "one"); t.set(-0, "zero");
        expect(t.get(1)).toBe("one");
        expect(t.get(0)).toBe("zero");

        expect(() => t.set(NaN, 1)).toThrow("table key cannot be NaN");
        expect(() => t.set(undefined, 1)).toThrow("table key cannot be <#void>");
        expect(t.get(NaN)).toBeUndefined();
    });

    it('table-set! of <#void> removes the key in Scheme', () => {
        expect(run(`(let ((t {"a" 1 "b" 2})) (table-set! t "a" <#void>) (list (table-has? t "a") (table-size t) (table-ref t "a" 'gone)))`)).toBe("(#f 1 gone)")
        expect(run(`(let ((t {1 "x" 2 "y" 3 "z"})) (table-set! t 2 <#void>) (list (table-size t) (table-ref t 3) (vector-length (table-entries t))))`)).toBe(`(2 "z" 2)`)
        expect(run(`(table-size {"a" <#void>})`)).toBe("0")
    });
});

describe('Floats, Infinities & NaNs', () => {
    let evaluator: Anima;
    beforeEach(() => { evaluator = new Anima(vmImpl) });
    let s = new ASTStringifier();

    const run = (expr: string) => {
        const bc = evaluator.compileRaw(expr);
        return s.stringify(evaluator.evaluateRaw(bc));
    };

    const runRaw = (expr: string) => {
        const bc = evaluator.compileRaw(expr);
        return evaluator.evaluateRaw(bc);
    };

    it('evaluates floating-point number literals', () => {
        expect(run("3.14")).toBe("3.14");
        expect(runRaw("3.14")).toBe(3.14);
        expect(run("-0.5")).toBe("-0.5");
        expect(runRaw("-0.5")).toBe(-0.5);
        expect(run("0.0")).toBe("0");
        expect(run(".25")).toBe("0.25");
        expect(run("-.75")).toBe("-0.75");
        expect(run("1.5e3")).toBe("1500");
        expect(run("1.5e-3")).toBe("0.0015");
    });

    it('evaluates infinities (+inf.0, -inf.0, inf.0) and NaNs (+nan.0, -nan.0, nan.0)', () => {
        expect(run("+inf.0")).toBe("+inf.0");
        expect(runRaw("+inf.0")).toBe(Infinity);
        expect(run("-inf.0")).toBe("-inf.0");
        expect(runRaw("-inf.0")).toBe(-Infinity);
        expect(run("inf.0")).toBe("+inf.0");
        expect(runRaw("inf.0")).toBe(Infinity);
        expect(run("+Infinity")).toBe("+inf.0");
        expect(run("-Infinity")).toBe("-inf.0");
        expect(run("Infinity")).toBe("+inf.0");

        expect(run("+nan.0")).toBe("+nan.0");
        expect(Number.isNaN(runRaw("+nan.0"))).toBe(true);
        expect(run("-nan.0")).toBe("+nan.0");
        expect(Number.isNaN(runRaw("-nan.0"))).toBe(true);
        expect(run("nan.0")).toBe("+nan.0");
        expect(Number.isNaN(runRaw("nan.0"))).toBe(true);
    });

    it('tests numeric predicates with floats, infinities and NaNs', () => {
        // number?
        expect(run("(number? 3.14)")).toBe("#t");
        expect(run("(number? +inf.0)")).toBe("#t");
        expect(run("(number? -inf.0)")).toBe("#t");
        expect(run("(number? +nan.0)")).toBe("#t");

        // integer?
        expect(run("(integer? 42)")).toBe("#t");
        expect(run("(integer? 3.14)")).toBe("#f");
        expect(run("(integer? +inf.0)")).toBe("#f");
        expect(run("(integer? -inf.0)")).toBe("#f");
        expect(run("(integer? +nan.0)")).toBe("#f");

        // positive?
        expect(run("(positive? 3.14)")).toBe("#t");
        expect(run("(positive? +inf.0)")).toBe("#t");
        expect(run("(positive? -inf.0)")).toBe("#f");
        expect(run("(positive? +nan.0)")).toBe("#f");

        // negative?
        expect(run("(negative? -3.14)")).toBe("#t");
        expect(run("(negative? -inf.0)")).toBe("#t");
        expect(run("(negative? +inf.0)")).toBe("#f");
        expect(run("(negative? +nan.0)")).toBe("#f");

        // zero?
        expect(run("(zero? 0.0)")).toBe("#t");
        expect(run("(zero? +inf.0)")).toBe("#f");
        expect(run("(zero? -inf.0)")).toBe("#f");
        expect(run("(zero? +nan.0)")).toBe("#f");

        // infinite?
        expect(run("(infinite? +inf.0)")).toBe("#t");
        expect(run("(infinite? -inf.0)")).toBe("#t");
        expect(run("(infinite? 3.14)")).toBe("#f");
        expect(run("(infinite? 42)")).toBe("#f");
        expect(run("(infinite? +nan.0)")).toBe("#f");

        // finite?
        expect(run("(finite? 3.14)")).toBe("#t");
        expect(run("(finite? 42)")).toBe("#t");
        expect(run("(finite? +inf.0)")).toBe("#f");
        expect(run("(finite? -inf.0)")).toBe("#f");
        expect(run("(finite? +nan.0)")).toBe("#f");

        // nan?
        expect(run("(nan? +nan.0)")).toBe("#t");
        expect(run("(nan? -nan.0)")).toBe("#t");
        expect(run("(nan? nan.0)")).toBe("#t");
        expect(run("(nan? 3.14)")).toBe("#f");
        expect(run("(nan? +inf.0)")).toBe("#f");
    });

    it('performs arithmetic with floating-point numbers', () => {
        expect(run("(+ 1.5 2.5)")).toBe("4");
        expect(run("(+ 1.25 0.5)")).toBe("1.75");
        expect(run("(- 10.5 3.25)")).toBe("7.25");
        expect(run("(- 5.5)")).toBe("-5.5");
        expect(run("(* 2.5 4.0)")).toBe("10");
        expect(run("(* -1.5 2.0)")).toBe("-3");
        expect(run("(/ 7.5 2.5)")).toBe("3");
        expect(run("(/ 1.0 4.0)")).toBe("0.25");
        expect(run("(remainder 5.5 2.0)")).toBe("1.5");
    });

    it('performs arithmetic with infinities', () => {
        expect(run("(- +inf.0)")).toBe("-inf.0");
        expect(run("(- -inf.0)")).toBe("+inf.0");
        expect(run("(+ +inf.0 100)")).toBe("+inf.0");
        expect(run("(+ -inf.0 100)")).toBe("-inf.0");
        expect(run("(* 2.0 +inf.0)")).toBe("+inf.0");
        expect(run("(* -2.0 +inf.0)")).toBe("-inf.0");
        expect(run("(/ 1.0 +inf.0)")).toBe("0");
        expect(run("(/ +inf.0 2.0)")).toBe("+inf.0");
        expect(run("(/ +inf.0 +inf.0)")).toBe("+nan.0");
        expect(run("(- +inf.0 +inf.0)")).toBe("+nan.0");
    });

    it('compares floats and infinities correctly', () => {
        expect(run("(< -inf.0 -100 0 100 +inf.0)")).toBe("#t");
        expect(run("(<= -inf.0 -inf.0 0 3.14 +inf.0 +inf.0)")).toBe("#t");
        expect(run("(> +inf.0 100 0 -100 -inf.0)")).toBe("#t");
        expect(run("(>= +inf.0 +inf.0 3.14 0 -inf.0 -inf.0)")).toBe("#t");
        expect(run("(= +inf.0 +inf.0)")).toBe("#t");
        expect(run("(= -inf.0 -inf.0)")).toBe("#t");
        expect(run("(= +inf.0 -inf.0)")).toBe("#f");
        expect(run("(= 3.14 3.14)")).toBe("#t");
        expect(run("(= 3.14 3.15)")).toBe("#f");
        expect(run("(= +nan.0 +nan.0)")).toBe("#f");

        expect(run("(eqv? +inf.0 +inf.0)")).toBe("#t");
        expect(run("(eqv? -inf.0 -inf.0)")).toBe("#t");
        expect(run("(eqv? +inf.0 -inf.0)")).toBe("#f");
        expect(run("(eqv? 3.14 3.14)")).toBe("#t");

        expect(run("(equal? +inf.0 +inf.0)")).toBe("#t");
        expect(run("(equal? -inf.0 -inf.0)")).toBe("#t");
        expect(run("(equal? '(1.5 +inf.0) '(1.5 +inf.0))")).toBe("#t");
        expect(run("(equal? #(1.5 +inf.0) #(1.5 +inf.0))")).toBe("#t");
        expect(run('(equal? {"x" +inf.0} {"x" +inf.0})')).toBe("#t");
    });

    it('serializes and deserializes floats and infinities in ByteCode (BS / BSReader)', () => {
        // Direct BS / BSReader F64 serde
        const bs = new BS();
        bs.writeF64(3.141592653589793);
        bs.writeF64(Infinity);
        bs.writeF64(-Infinity);
        bs.writeF64(NaN);
        bs.writeValue(2.71828);
        bs.writeValue(Infinity);
        bs.writeValue(-Infinity);
        bs.writeValue(100);

        const buf = bs.finalize();
        const reader = new BSReader(buf);

        expect(reader.readF64()).toBe(3.141592653589793);
        expect(reader.readF64()).toBe(Infinity);
        expect(reader.readF64()).toBe(-Infinity);
        expect(Number.isNaN(reader.readF64())).toBe(true);

        expect(reader.read()).toBe(2.71828);
        expect(reader.read()).toBe(Infinity);
        expect(reader.read()).toBe(-Infinity);
        expect(reader.read()).toBe(100);

        // ByteCode serialization containing floats and infinities
        const bc = evaluator.compileRaw('(+ 3.14 2.71 +inf.0)');
        const bcBs = new BS();
        ByteCode.register(new BSReader(new Uint32Array(0)));
        bcBs.writeSerializable(bc as ByteCode);

        const dumped = bcBs.finalize();
        const bcReader = new BSReader(dumped);
        ByteCode.register(bcReader);
        const deserializedBc = bcReader.read() as ByteCode;

        expect(deserializedBc instanceof ByteCode).toBe(true);
        expect(s.stringify(evaluator.evaluateRaw(deserializedBc))).toBe("+inf.0");

        // ByteCode serialization with float result
        const bcFloat = evaluator.compileRaw('(* 2.5 1.5)');
        const bcFloatBs = new BS();
        bcFloatBs.writeSerializable(bcFloat as ByteCode);
        const floatDumped = bcFloatBs.finalize();
        const floatReader = new BSReader(floatDumped);
        ByteCode.register(floatReader);
        const deserializedFloatBc = floatReader.read() as ByteCode;
        expect(s.stringify(evaluator.evaluateRaw(deserializedFloatBc))).toBe("3.75");

        // Quoted list constants (proper, nested, improper)
        for (const [src, expected] of [
            ["'(1 2 3)", "(1 2 3)"],
            ["(car '(1 2))", "1"],
            ["'((a b) (c . d) \"s\")", "((a b) (c . d) \"s\")"],
            ["'(1 2 . 3)", "(1 2 . 3)"],
        ]) {
            const listBs = new BS();
            listBs.writeSerializable(evaluator.compileRaw(src) as ByteCode);
            const listReader = new BSReader(listBs.finalize());
            ByteCode.register(listReader);
            expect(s.stringify(evaluator.evaluateRaw(listReader.read() as ByteCode))).toBe(expected);
        }

        const longList = Cons.fromArray(Array.from({ length: 100000 }, (_, i) => i));
        const longBs = new BS();
        longBs.writeValue(longList);
        const longBack = new BSReader(longBs.finalize()).read() as Cons;
        expect(longBack instanceof Cons).toBe(true);
        expect(longBack.length).toBe(100000);

        const full = dumpFull(evaluator.compileRaw("(list 1 '(2 3))") as ByteCode);
        expect(full[1]).toBe(BYTECODE_VERSION);
        expect(s.stringify(evaluator.evaluateRaw(readFull(full) as ByteCode))).toBe("(1 (2 3))");
        const wrongVersion = full.slice();
        wrongVersion[1] = BYTECODE_VERSION + 1;
        expect(() => readFull(wrongVersion)).toThrow(`bytecode version ${BYTECODE_VERSION + 1} is not supported`);
        expect(() => readFull(full.subarray(2))).toThrow("not anima bytecode");
    });
});

});

describe("JIT Compiler Runtime Compilation & Execution", () => {
    const animaScope = () => {
        const anima = new Anima(implAot);
        return anima.scope;
    };

    it("compiles functions AOT and executes natively", () => {
        const anima = new Anima(implAot);
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
        const anima = new Anima(implAot);
        const code = anima.compileRaw(`(lambda (x) x)`);
        const idClosure = anima.evaluateRaw(code);
        const fnCode = idClosure.tmpl.code as ByteCode;

        expect(fnCode.resumeFn).not.toBeNull();
        expect(anima.evaluateClosure(idClosure, [42])).toBe(42);
        expect(anima.evaluateClosure(idClosure, [999])).toBe(999);
        expect(anima.evaluateClosure(idClosure, ["hello"])).toBe("hello");
    });

    it("loads negative and non-integer literals through LOADCONST", () => {
        const anima = new Anima(implAot);
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
        // 6: CALL builtin(+), start=r1, nargs=2; MOVEACC r0
        // 13: RETURN r0
        const plusSym = Symbol.for("+");
        const inst = new Uint32Array([
            OpCode.LOADU32, 1, 50,
            OpCode.LOADU32, 2, 60,
            OpCode.CALL, BUILTINS_START, 1, 2, 0, OpCode.MOVEACC, 0,
            OpCode.RETURN, 0
        ]);
        const bc = new ByteCode([], inst, 4);

        // Compile it with JIT
        AotCompiler.compile(bc);
        expect(bc.resumeFn).not.toBeNull();

        const vm = new AnimaVM();
        // Evaluating this will run native code for LOADU32 r1, 50 and LOADU32 r2, 60,
        // then hit deopt(6) at CALL, drop to interpreter, and execute CALL and RETURN!
        const res = vm.evaluateRaw(bc, animaScope());
        expect(res).toBe(110);
    });

    it("executes IF, ELSE, ENDIF control flow completely natively in AOT", () => {
        const anima = new Anima(implAot);
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
        const anima = new Anima(implAot);
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
        const anima = new Anima(implAot);
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
        const anima = new Anima(implAot);
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
        const anima = new Anima(implAot);
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


/*
const TEST_PROG = `
(define union
    (lambda (a b)
        (define (in a rst) 
        (cond 
            [(empty? rst) #f]
            [(equal? a (car rst)) #t]
            [else (in a (cdr rst))]))

        (cond
        ; if either set is empty, the other one if the union
        [(empty? a) b]
        [(empty? b) a]
        ; if b is in a, skip it
        [(in (car b) a) (union a (cdr b))]
        [else (cons (car b) (union a (cdr b)))])))

(define sum-of-squares
  (lambda (a)
    ; do x*x for every element in a, then sum them all up
    (apply + [map (lambda (x) (* x x)) a])))
        
    (list (equal? (union '(a b d e f h j) '(f c e g a)) '(c g a b d e f h j)) (equal? (sum-of-squares (list 1 3 5 7)) 84))
`
//export const TEST_PROG = `(cond [#f 1] [#f 2])`

export const TEST_PROG_BC = new AnimaCompiler().compileExpr(new ASP(TEST_PROG).parse(), false, false)
*/
