import { ASTStringifier, MissingVarError, Env } from '../common';
import { describe, it, expect, beforeEach } from 'vitest';
import { createScheme } from '../scheme';
import { ByteCode, AnimaVM, OpCode } from '../bytecode-rvm/vm';
import { Closure, INSTRUCTION_LENGTHS } from '../bytecode-rvm/exec';
import { Anima } from '../anima';
import { impl, implAot } from '../bytecode-rvm/meta';
import { dumpFull, readFull } from '../bytecode-rvm/utils';
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
            expect(() => run(`(%if 1)`)).toThrow("%if requires at least a condition and a branch")
            expect(run(`(list (%if 1 2) (void? (%if #f 2)))`)).toBe("(2 #t)")
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
            expect(() => run("(cons 1)")).toThrow("cons: expected exactly 2 args, got 1");
            expect(run("(cadr '(1 2 3))")).toBe("2");
            expect(run("(cddr '(1 2 3))")).toBe("(3)");
            expect(run("(caar '((1) 2))")).toBe("1");
            expect(run("(caddr '(1 2 3))")).toBe("3");
            expect(run("(cadddr '(1 2 3 4))")).toBe("4");
            expect(run("(map cadr '((1 2) (3 4)))")).toBe("(2 4)");
            expect(() => run("(cadr '(1))")).toThrow("cadr: list is too short");
            expect(() => run("(cadr 5)")).toThrow("cadr: expected a pair but got 5");
            expect(() => run("(cadr 1 2)")).toThrow("cadr: expected exactly 1 args, got 2");
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
            expect(() => run("(zero? 1 2)")).toThrow("zero?: expected exactly 1 args, got 2");
            expect(() => run("(let ((f pair?)) (f))")).toThrow("pair?: expected exactly 1 args, got 0");
            expect(() => run("(let ((f third)) (f '(1 2)))")).toThrow("third: list is too short");
            expect(run("(let ((f <)) (f 1 2))")).toBe("#t");
            expect(() => run("(+ 1 \"a\")")).toThrow("+ requires numbers, but received string");
            expect(() => run("(-)")).toThrow("%-: expected at least 1 args, got 0");
            expect(() => run("(< \"a\")")).toThrow("< requires numbers, but received string");
            expect(() => run("(modulo 1 2 3)")).toThrow("modulo: expected exactly 2 args, got 3");
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

            // a host function that runs Scheme code itself (not through a tail request) is a boundary a yield cannot cross
            evaluator.registerIntrinsic("%host-call", (regs, start) => evaluator.evaluateClosure(regs[start], []), { args: [1, 1] });
            expect(run(`(try (lambda () (coroutine-resume (coroutine-create (lambda () (%host-call (lambda () (coroutine-yield 1)))))))
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

        it('raising into a coroutine', () => {
            // the pending yield raises, under the coroutine's own handlers, and the coroutine goes on
            expect(run(`(define rc (coroutine-create (lambda () (coroutine-yield (try (lambda () (coroutine-yield 1)) (lambda (e) (list 'caught e)))) 'end)))
                        (list (coroutine-resume rc) (coroutine-raise rc 'boom) (coroutine-status rc) (coroutine-resume rc) (coroutine-status rc))`)).toBe("(1 (caught boom) suspended end dead)");
            // unhandled: the coroutine dies and the error is raised again in the resumer; as with any error a coroutine does
            // not handle, its dynamic-wind after-thunks do not run
            expect(run(`(define rlog '())
                        (define rd (coroutine-create (lambda () (dynamic-wind (lambda () #f) (lambda () (coroutine-yield 1) 'never) (lambda () (set! rlog (cons 'after rlog)))))))
                        (coroutine-resume rd)
                        (list (try (lambda () (coroutine-raise rd 'bad)) (lambda (e) (list 'out e))) rlog (coroutine-status rd))`)).toBe("((out bad) () dead)");
            // a coroutine that never ran dies without running
            expect(run(`(define rn-ran #f) (define rn (coroutine-create (lambda () (set! rn-ran #t))))
                        (list (try (lambda () (coroutine-raise rn 'early)) (lambda (e) e)) rn-ran (coroutine-status rn))`)).toBe("(early #f dead)");
            // as a value, in tail position, and from inside another coroutine
            expect(run(`(define rv (coroutine-create (lambda () (try (lambda () (coroutine-yield 1)) (lambda (e) (* e 2))))))
                        (define (raise-into co e) (coroutine-raise co e))
                        (coroutine-resume rv)
                        (list (raise-into rv 21) (coroutine-status rv))`)).toBe("(42 dead)");
            expect(run(`(define ri (coroutine-create (lambda () (try (lambda () (coroutine-yield 1)) (lambda (e) (list 'inner e))))))
                        (define ro (coroutine-create (lambda () (coroutine-resume ri) (list (coroutine-raise ri 'x) (coroutine-status ri)))))
                        (coroutine-resume ro)`)).toBe("((inner x) dead)");
            expect(run(`(define rw (coroutine-create (lambda () (try (lambda () (coroutine-yield 1)) (lambda (e) e)))))
                        (coroutine-resume rw)
                        (let ((r coroutine-raise)) (r rw 'wrapped))`)).toBe("wrapped");
            expect(run(`(try (lambda () (let ((c (coroutine-create (lambda () 1)))) (coroutine-resume c) (coroutine-raise c 'x))) (lambda (e) (error-message e)))`)).toBe('"coroutine-raise: cannot resume a dead coroutine"');

            const hostCo = evaluator.evaluateRaw(evaluator.compileRaw(`(coroutine-create (lambda () (let loop ((v (coroutine-yield 0))) (loop (try (lambda () (coroutine-yield v)) (lambda (e) (list 'handled e)))))))`));
            evaluator.coroutineResume(hostCo);
            expect(evaluator.coroutineResume(hostCo, 1).value).toBe(1);
            expect(new ASTStringifier().stringify(evaluator.coroutineRaise(hostCo, Symbol.for("oops")).value)).toBe("(handled oops)");
            const hostDies = evaluator.evaluateRaw(evaluator.compileRaw(`(coroutine-create (lambda () (coroutine-yield 1)))`));
            evaluator.coroutineResume(hostDies);
            expect(() => evaluator.coroutineRaise(hostDies, Symbol.for("fatal"))).toThrow("fatal");
            expect(hostDies.status).toBe("dead");
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

        // a rest parameter only spread back into a call is bound to an array, never built as a list
        it('forwards rest arguments that are only spread into %apply', () => {
            expect(run(`(define (fw-sum . xs) (%apply %+ xs)) (list (fw-sum) (fw-sum 1 2 3) (apply fw-sum '(4 5)) (map fw-sum '(1 2) '(10 20)))`)).toBe("(0 6 9 (11 22))")
            expect(run(`(define (fw-lead a . xs) (%apply %+ a 10 xs)) (fw-lead 1 2 3)`)).toBe("16")
            // into procedures, in and out of tail position, and applied twice
            expect(run(`(define (fw-list . xs) (%apply list 0 xs)) (fw-list 1 2)`)).toBe("(0 1 2)")
            expect(run(`(define (fw-car . xs) (car (%apply list xs))) (fw-car 7 8)`)).toBe("7")
            expect(run(`(define (fw-k a b c d e . r) (list a e r)) (define (fw-twice . xs) (list (%apply fw-k xs) (%apply fw-k xs) (%apply %* xs))) (fw-twice 1 2 3 4 5 6 7)`))
                .toBe("((1 5 (6 7)) (1 5 (6 7)) 5040)")
            // %apply-multi spreads the last argument as a list, as apply does
            expect(run(`(define (fw-ap f . xs) (%apply-multi f xs)) (list (fw-ap + 1 2 '(3 4)) (fw-ap list '()))`)).toBe("(10 ())")
            expect(() => run(`(define (fw-ap f . xs) (%apply-multi f xs)) (fw-ap + 1 2)`)).toThrow(/must be a list/)
            // a self tail call rebinds the rest array
            expect(run(`(define (fw-loop n . xs) (if (= n 0) (%apply %+ xs) (fw-loop (- n 1) n 1))) (fw-loop 3)`)).toBe("2")
            expect(() => run(`(define (fw-one . xs) (%apply %car xs)) (fw-one 1 2)`)).toThrow("%car: expected exactly 1 args, got 2")

            const bc = evaluator.compileRaw(`(define (fw-t . xs) (%apply %+ xs))`) as ByteCode
            const fn = bc.constants.find((c: any) => c instanceof Closure)!
            expect(fn.tmpl.restArray).toBe(true)
            const ops: OpCode[] = []
            for (let ip = 0; ip < fn.tmpl.code.inst.length; ip += INSTRUCTION_LENGTHS[fn.tmpl.code.inst[ip] as OpCode]) ops.push(fn.tmpl.code.inst[ip])
            expect(ops).toContain(OpCode.APPLYINTR)
            const back = readFull(dumpFull(bc), evaluator.intrinsics) as ByteCode
            expect(back.constants.find((c: any) => c instanceof Closure)!.tmpl.restArray).toBe(true)
        });

        it('keeps a rest list wherever the rest parameter is seen as a value', () => {
            expect(run(`(define (nf-read . xs) (%apply %+ xs) xs) (nf-read 1 2)`)).toBe("(1 2)")
            expect(run(`(define (nf-cap . xs) (lambda () (%apply %+ xs))) ((nf-cap 1 2))`)).toBe("3")
            expect(run(`(define (nf-set . xs) (set! xs (cdr xs)) (%apply %+ xs)) (nf-set 1 2 3)`)).toBe("5")
            // shadowed by a local of the same name: that one is a list, spread as a list
            expect(run(`(define (nf-shadow . xs) (let ((xs (list 5 6))) (%apply %+ xs))) (nf-shadow 1)`)).toBe("11")
            expect(run(`(define (nf-inner . xs) (let ((xs (list 5 6))) (%apply %+ xs)) (%apply %* xs)) (nf-inner 2 3)`)).toBe("6")
            const bc = evaluator.compileRaw(`(define (nf-t . xs) (%apply %+ xs) xs)`) as ByteCode
            expect(bc.constants.find((c: any) => c instanceof Closure)!.tmpl.restArray).toBe(false)
        });
    });

    describe('call-with-values with literal lambdas', () => {
        it('binds the values like receive', () => {
            expect(run(`(call-with-values (lambda () (values 1 2)) (lambda (a b) (list b a)))`)).toBe("(2 1)")
            expect(run(`(call-with-values (lambda () (values 1 2 3)) (lambda (a . rest) (list a rest)))`)).toBe("(1 (2 3))")
            expect(run(`(call-with-values (lambda () (values)) (lambda args args))`)).toBe("()")
            expect(run(`(call-with-values (lambda () (define x 5) (values x 6)) (lambda (a b) (define y (+ a b)) y))`)).toBe("11")
            expect(() => run(`(call-with-values (lambda () (values 1 2)) (lambda (a) a))`)).toThrow()
        })

        it('calls the prelude procedure otherwise', () => {
            expect(run(`(define (cwv-p) (values 3 4)) (call-with-values cwv-p list)`)).toBe("(3 4)")
            expect(run(`(call-with-values (lambda () (values 1 2)) (if #t list vector))`)).toBe("(1 2)")
        })
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
            expect(() => run(`(%first-value)`)).toThrow("%first-value: expected exactly 1 args, got 0")
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

})
})
