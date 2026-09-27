import { MissingVarError, Env } from '../common';
import { ASTStringifier } from '../scheme/printer';
import { describe, it, expect, beforeEach } from 'vitest';
import { createScheme } from '../scheme';
import { ByteCode, AnimaVM, OpCode } from '../bytecode-rvm/vm';
import { Closure, INSTRUCTION_LENGTHS } from '../bytecode-rvm/exec';
import { Anima } from '../anima';
import { impl, implAot } from '../bytecode-rvm/meta';
import { dumpFull, readFull, stringifyInst } from '../bytecode-rvm/utils';
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
            // unhandled: the coroutine dies and the error is raised again in the resumer, after its dynamic-wind after-thunks
            expect(run(`(define rlog '())
                        (define rd (coroutine-create (lambda () (dynamic-wind (lambda () #f) (lambda () (coroutine-yield 1) 'never) (lambda () (set! rlog (cons 'after rlog)))))))
                        (coroutine-resume rd)
                        (list (try (lambda () (coroutine-raise rd 'bad)) (lambda (e) (list 'out e))) rlog (coroutine-status rd))`)).toBe("((out bad) (after) dead)");
            // the same for an error the coroutine raises itself: nested after-thunks run innermost first, and an error in one
            // replaces the original
            expect(run(`(define dlog '())
                        (define (note x) (lambda () (set! dlog (cons x dlog))))
                        (define dw-co (coroutine-create (lambda () (dynamic-wind (lambda () #f) (lambda () (dynamic-wind (lambda () #f) (lambda () (coroutine-yield 1) (car '())) (note 'inner))) (note 'outer)))))
                        (coroutine-resume dw-co)
                        (list (try (lambda () (coroutine-resume dw-co)) (lambda (e) 'failed)) (reverse dlog) (coroutine-status dw-co))`)).toBe("(failed (inner outer) dead)");
            expect(run(`(define dw-bad (coroutine-create (lambda () (dynamic-wind (lambda () #f) (lambda () (raise 'first)) (lambda () (raise 'second))))))
                        (list (try (lambda () (coroutine-resume dw-bad)) (lambda (e) e)) (coroutine-status dw-bad))`)).toBe("(second dead)");
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
            const hostWind = evaluator.evaluateRaw(evaluator.compileRaw(`(define host-unwound #f) (coroutine-create (lambda () (dynamic-wind (lambda () #f) (lambda () (coroutine-yield 1)) (lambda () (set! host-unwound #t)))))`));
            evaluator.coroutineResume(hostWind);
            expect(() => evaluator.coroutineRaise(hostWind, Symbol.for("fatal"))).toThrow("fatal");
            expect(run("host-unwound")).toBe("#t");
        });

        it('coroutine-create takes a closure as its body', () => {
            // builtins used as values are closures (their prelude wrappers)
            expect(run(`(coroutine-resume (coroutine-create car) '(1 2))`)).toBe("1");
            expect(run(`(coroutine-resume (coroutine-create (lambda args (length args))) 1 2 3)`)).toBe("3");
            const message = (body: string) => run(`(try (lambda () (coroutine-create ${body})) (lambda (e) (error-message e)))`);
            expect(message("5")).toBe('"coroutine-create: expected a closure but got 5"');
            expect(message("'sym")).toMatch(/^"coroutine-create: expected a closure but got /);
            // a continuation is a procedure, but not Anima code a coroutine can start in
            expect(message("(call/cc (lambda (k) k))")).toMatch(/^"coroutine-create: expected a closure but got /);
            expect(message("(call/ec (lambda (k) k))")).toMatch(/^"coroutine-create: expected a closure but got /);
        });

        it('coroutine-create with a finally thunk', () => {
            run(`(define fin-log '()) (define (fin-co tag body) (coroutine-create body (lambda () (set! fin-log (cons tag fin-log)))))`);
            // runs once the body is left for good: a return (after which its values are the resume's), not a yield
            expect(run(`(define fc1 (fin-co 'returned (lambda (x) (coroutine-yield x) (values 1 2))))
                        (list (coroutine-resume fc1 'a) fin-log (call-with-values (lambda () (coroutine-resume fc1)) list) fin-log (coroutine-status fc1))`)).toBe("(a () (1 2) (returned) dead)");
            // an error, raised by the coroutine or into it, and a close
            expect(run(`(define fc2 (fin-co 'errored (lambda () (coroutine-yield 1) (raise 'x)))) (coroutine-resume fc2)
                        (list (try (lambda () (coroutine-resume fc2)) (lambda (e) e)) (car fin-log))`)).toBe("(x errored)");
            expect(run(`(define fc3 (fin-co 'raised-in (lambda () (coroutine-yield 1)))) (coroutine-resume fc3)
                        (list (try (lambda () (coroutine-raise fc3 'y)) (lambda (e) e)) (car fin-log))`)).toBe("(y raised-in)");
            expect(run(`(define fc4 (fin-co 'closed (lambda () (coroutine-yield 1)))) (coroutine-resume fc4) (coroutine-close fc4) (car fin-log)`)).toBe("closed");
            // not for a coroutine that never started
            expect(run(`(define fc5 (fin-co 'never (lambda () 1))) (coroutine-close fc5) (car fin-log)`)).toBe("closed");
            // as a value, and out of tracebacks
            expect(run(`(let ((f coroutine-create)) (list (coroutine-resume (f (lambda () 'v) (lambda () (set! fin-log (cons 'as-value fin-log))))) (car fin-log)))`)).toBe("(v as-value)");
            expect(run(`(coroutine-resume (fin-co 'tb (lambda () (debug-traceback))))`)).not.toContain("coroutine-finally");
            expect(run(`(try (lambda () (coroutine-create (lambda () 1) 5)) (lambda (e) (error-message e)))`)).toBe('"coroutine-create: expected a finally procedure but got 5"');
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
        it('forwards rest arguments that are only spread into apply', () => {
            expect(run(`(define (fw-sum . xs) (apply %+ xs)) (list (fw-sum) (fw-sum 1 2 3) (apply fw-sum '(4 5)) (map fw-sum '(1 2) '(10 20)))`)).toBe("(0 6 9 (11 22))")
            expect(run(`(define (fw-lead a . xs) (apply %+ a 10 xs)) (fw-lead 1 2 3)`)).toBe("16")
            // into procedures, in and out of tail position, and applied twice
            expect(run(`(define (fw-list . xs) (apply list 0 xs)) (fw-list 1 2)`)).toBe("(0 1 2)")
            expect(run(`(define (fw-car . xs) (car (apply list xs))) (fw-car 7 8)`)).toBe("7")
            expect(run(`(define (fw-k a b c d e . r) (list a e r)) (define (fw-twice . xs) (list (apply fw-k xs) (apply fw-k xs) (apply %* xs))) (fw-twice 1 2 3 4 5 6 7)`))
                .toBe("((1 5 (6 7)) (1 5 (6 7)) 5040)")
            // apply as a value spreads its last argument too
            expect(run(`(define (fw-ap f . xs) (apply apply f xs)) (list (fw-ap + 1 2 '(3 4)) (fw-ap list '()))`)).toBe("(10 ())")
            expect(() => run(`(define (fw-ap f . xs) (apply apply f xs)) (fw-ap + 1 2)`)).toThrow(/must be a list/)
            // a self tail call rebinds the rest array
            expect(run(`(define (fw-loop n . xs) (if (= n 0) (apply %+ xs) (fw-loop (- n 1) n 1))) (fw-loop 3)`)).toBe("2")
            expect(() => run(`(define (fw-one . xs) (apply %car xs)) (fw-one 1 2)`)).toThrow("%car: expected exactly 1 args, got 2")

            const bc = evaluator.compileRaw(`(define (fw-t . xs) (apply %+ xs))`) as ByteCode
            const fn = bc.constants.find((c: any) => c instanceof Closure)!
            expect(fn.tmpl.rest).toBe("array")
            const ops: OpCode[] = []
            for (let ip = 0; ip < fn.tmpl.code.inst.length; ip += INSTRUCTION_LENGTHS[fn.tmpl.code.inst[ip] as OpCode]) ops.push(fn.tmpl.code.inst[ip])
            expect(ops).toContain(OpCode.APPLYINT)
            const back = readFull(dumpFull(bc), evaluator.intrinsics) as ByteCode
            expect(back.constants.find((c: any) => c instanceof Closure)!.tmpl.rest).toBe("array")
        });

        it('keeps a rest list wherever the rest parameter is seen as a value', () => {
            expect(run(`(define (nf-read . xs) (apply %+ xs) xs) (nf-read 1 2)`)).toBe("(1 2)")
            expect(run(`(define (nf-cap . xs) (lambda () (apply %+ xs))) ((nf-cap 1 2))`)).toBe("3")
            expect(run(`(define (nf-set . xs) (set! xs (cdr xs)) (apply %+ xs)) (nf-set 1 2 3)`)).toBe("5")
            // shadowed by a local of the same name: that one is a list, spread as a list
            expect(run(`(define (nf-shadow . xs) (let ((xs (list 5 6))) (apply %+ xs))) (nf-shadow 1)`)).toBe("11")
            expect(run(`(define (nf-inner . xs) (let ((xs (list 5 6))) (apply %+ xs)) (apply %* xs)) (nf-inner 2 3)`)).toBe("6")
            // read as a value, captured by a nested lambda, or reassigned: the closure keeps the list path
            for (const src of [`(define (nf-t . xs) (apply %+ xs) xs)`, `(define (nf-t . xs) (lambda () (apply %+ xs)))`, `(define (nf-t . xs) (set! xs (cdr xs)) (apply %+ xs))`]) {
                const bc = evaluator.compileRaw(src) as ByteCode
                expect(bc.constants.find((c: any) => c instanceof Closure)!.tmpl.rest).toBe("packed")
            }
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
            // captured by a real lambda but never assigned: copied into the closure, not boxed
            expect(boxesIn(`(lambda (n) (let ((x 1)) (lambda () (+ x n))))`)).toBe(0)
            // captured and assigned (here inside the closure): boxed, so every sharer sees the assignment
            expect(boxesIn(`(lambda (n) (let ((x 1)) (lambda () (set! x n) x)))`)).toBe(1)
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

        it('copies never-assigned variables into closures, one binding per iteration or call', () => {
            expect(run(`(let loop ((i 0) (fs '())) (if (= i 3) (map (lambda (f) (f)) fs) (loop (+ i 1) (cons (lambda () i) fs))))`)).toBe("(2 1 0)")
            expect(run(`(define (cap-collect n acc) (if (= n 0) acc (cap-collect (- n 1) (cons (lambda () n) acc)))) (map (lambda (f) (f)) (cap-collect 3 '()))`)).toBe("(1 2 3)")
            expect(run(`(define (cap-adder x) (lambda (y) (+ x y))) (list ((cap-adder 1) 10) ((cap-adder 2) 10))`)).toBe("(11 12)")
            expect(run(`(define (cap-counter) (let ((c 0)) (lambda () (set! c (+ c 1)) c))) (define cap-c (cap-counter)) (cap-c) (cap-c)`)).toBe("2")
        })

        it('binds letrecs of lambdas with %letrec, without boxes', () => {
            expect(run(`(define (lr-parity n) (define (ev? k) (if (= k 0) #t (od? (- k 1)))) (define (od? k) (if (= k 0) #f (ev? (- k 1)))) (list (ev? n) (od? n))) (lr-parity 10)`)).toBe("(#t #f)")
            expect(run(`(define (lr-deep n) (define (ev? k) (if (= k 0) #t (od? (- k 1)))) (define (od? k) (if (= k 0) #f (ev? (- k 1)))) (ev? n)) (lr-deep 100001)`)).toBe("#f")
            expect(boxesIn(`(lambda (n) (letrec ((f (lambda (k) (if (= k 0) 0 (g (- k 1))))) (g (lambda (k) (f k)))) (f n)))`)).toBe(0)
            expect(boxesIn(`(lambda (n) (define (f k) (if (= k 0) n (f (- k 1)))) (f n))`)).toBe(0)
            // closures escaping the letrec keep their siblings, and capture outer variables too
            expect(run(`(define (lr-pair) (letrec ((get (lambda () (other))) (other (lambda () 'me))) get)) ((lr-pair))`)).toBe("me")
            expect(run(`(define (lr-outer z) (letrec ((f (lambda () (+ z (g)))) (g (lambda () z))) (f))) (lr-outer 3)`)).toBe("6")
            expect(run(`(define (lr-fns) (letrec ((a (lambda () (list 'a (b)))) (b (lambda () 'b)) (c (lambda () (a)))) (list a b c))) (map (lambda (f) (f)) (lr-fns))`)).toBe("((a b) b (a b))")
        })

        it('binds values and lambdas together, filling values into closures once known', () => {
            expect(run(`(define (lrv-add k) (define base 10) (define (add x) (+ base x)) (add k)) (lrv-add 5)`)).toBe("15")
            expect(boxesIn(`(lambda (k) (define base 10) (define (add x) (+ base x)) (add k))`)).toBe(0)
            // a helper defined before the value it reads
            expect(run(`(define (lrv-fwd) (define (get) b) (define b 7) (get)) (lrv-fwd)`)).toBe("7")
            expect(boxesIn(`(lambda () (define (get) b) (define b 7) (get))`)).toBe(0)
            // a value computed with an earlier lambda
            expect(run(`(define (lrv-sq) (define (sq x) (* x x)) (define nine (sq 3)) (list nine (sq 2))) (lrv-sq)`)).toBe("(9 4)")
        })

        it('boxes a letrec value that a closure may copy before it exists', () => {
            // made by an earlier init
            expect(run(`(define (lrv-early) (define a (list (lambda () b))) (define b 3) ((car a))) (lrv-early)`)).toBe("3")
            // made by one of the letrec's lambdas, run by an earlier init
            expect(run(`(define (lrv-mk) (define (mk) (lambda () b)) (define a (mk)) (define b 2) (a)) (lrv-mk)`)).toBe("2")
            expect(boxesIn(`(lambda () (define (mk) (lambda () b)) (define a (mk)) (define b 2) (a))`)).toBe(1)
            // its own init
            expect(run(`(letrec ((x (list (lambda () x)))) (eq? ((car x)) x))`)).toBe("#t")
        })

        it('supports letrec*: each init sees the earlier values', () => {
            expect(run(`(letrec* ((a 1) (b (+ a 1)) (f (lambda () (list a b (g)))) (g (lambda () 'g))) (f))`)).toBe("(1 2 g)")
            expect(run(`(define lrs-log '()) (letrec* ((x (begin (set! lrs-log (cons 'x lrs-log)) 1)) (y (begin (set! lrs-log (cons 'y lrs-log)) (+ x 1)))) (list y lrs-log))`)).toBe("(2 (y x))")
            expect(() => run(`(define (lrs-bad) (letrec* 1 2))`)).toThrow("letrec*")
        })

        it('runs letrec values in order, and lets them be assigned', () => {
            expect(run(`(define lrv-log '()) (letrec ((a (begin (set! lrv-log (cons 'a lrv-log)) 1)) (b (begin (set! lrv-log (cons 'b lrv-log)) 2))) (list a b lrv-log))`)).toBe("(1 2 (b a))")
            expect(run(`(letrec ((x 1) (f (lambda () x))) (set! x 5) (f))`)).toBe("5")
        })

        it('lifts helpers that are only called, so no closure is made for them', () => {
            const closuresIn = (src: string): number => {
                const closure = evaluator.evaluateRaw(evaluator.compileRaw(src))
                const inst: Uint32Array = closure.tmpl.code.inst
                let made = 0
                for (let ip = 0; ip < inst.length; ip += INSTRUCTION_LENGTHS[inst[ip] as OpCode]) if (inst[ip] === OpCode.NEWCLOSURE) made++
                return made
            }
            expect(run(`(define (ll1 k) (define (helper x) (+ k x)) (helper 1)) (ll1 5)`)).toBe("6")
            expect(closuresIn(`(lambda (k) (define (helper x) (+ k x)) (helper 1))`)).toBe(0)
            // recursive and mutually recursive helpers receive themselves and each other
            expect(run(`(define (ll2 n) (define (sum i acc) (if (= i 0) acc (sum (- i 1) (+ acc n)))) (list (sum 3 0) (sum 1 0))) (ll2 5)`)).toBe("(15 5)")
            expect(closuresIn(`(lambda (n) (define (sum i acc) (if (= i 0) acc (sum (- i 1) (+ acc n)))) (sum 3 0))`)).toBe(0)
            expect(run(`(define (ll3 d) (define (ev? k) (if (= k 0) d (od? (- k 1)))) (define (od? k) (if (= k 0) (not d) (ev? (- k 1)))) (list (ev? 4) (od? 4))) (ll3 #t)`)).toBe("(#t #f)")
            expect(closuresIn(`(lambda (d) (define (ev? k) (if (= k 0) d (od? (- k 1)))) (define (od? k) (if (= k 0) (not d) (ev? (- k 1)))) (ev? 4))`)).toBe(0)
            // calls from a closure that escapes, and rest parameters
            expect(run(`(define (ll4 k) (define (h x) (+ k x)) (lambda (y) (h y))) ((ll4 10) 5)`)).toBe("15")
            expect(run(`(define (ll5 k) (define (h . xs) (cons k xs)) (h 1 2)) (ll5 0)`)).toBe("(0 1 2)")
        })

        it('lifts named lets that are not loops, evaluating their initial values outside', () => {
            expect(run(`(define (nl-copy l) (let copy ((l l)) (if (null? l) '() (cons (car l) (copy (cdr l)))))) (nl-copy '(1 2 3))`)).toBe("(1 2 3)")
            // an initial value naming the loop means the variable around it
            expect(run(`(define (nl-outer walk) (let walk ((n (walk))) (if (= n 0) 'done (list n (walk (- n 1)))))) (nl-outer (lambda () 2))`)).toBe("(2 (1 done))")
        })

        it('keeps helpers closures when lifting them would be wrong', () => {
            // used as a value
            expect(run(`(define (lk1 k) (define (h) k) h) ((lk1 7))`)).toBe("7")
            // a free variable that is assigned
            expect(run(`(define (lk2 k) (define (h) k) (set! k 9) (h)) (lk2 1)`)).toBe("9")
            // a call where a free variable is shadowed, or inside a lifted helper that shadows it
            expect(run(`(define (lk3 k) (define (h) k) (let ((k 100)) (h))) (lk3 1)`)).toBe("1")
            expect(run(`(define (lk4 k) (define (g) k) (define (f) (let ((k 50)) (g))) (f)) (lk4 2)`)).toBe("2")
            // a call with the wrong number of arguments still fails as a call of a closure
            expect(() => run(`(define (lk5) (define (h x) x) (h)) (lk5)`)).toThrow()
        })

        it('binds let* sequentially in one form', () => {
            expect(run(`(let* ((a 1) (b (+ a 1)) (a (* b 10))) (list a b))`)).toBe("(20 2)")
            expect(run(`(let* () 5)`)).toBe("5")
            // an init naming a global that a later binding shadows still means the global
            expect(run(`(define ls-g 5) (let* ((a ls-g) (ls-g 10) (b ls-g)) (list a ls-g b))`)).toBe("(5 10 10)")
            expect(run(`(define ls-h 3) (define (ls-fwd) (let* ((a (lambda () ls-h)) (ls-h 9)) (list (a) ls-h))) (ls-fwd)`)).toBe("(3 9)")
            expect(run(`(define (ls-cap n) (let* ((a n) (f (lambda () a)) (a 0)) (list (f) a))) (ls-cap 7)`)).toBe("(7 0)")
            // a helper defined in a let* body is still lifted, and sees the let*'s names
            expect(run(`(define (ls-lift n) (let* ((k (* n 2))) (define (h x) (+ k x)) (h 1))) (ls-lift 3)`)).toBe("7")
        })

        it('compiles very long let*s', () => {
            const n = 5000
            const binds = Array.from({ length: n }, (_, i) => `(x${i} ${i === 0 ? 1 : `(+ x${i - 1} 1)`})`).join(" ")
            expect(run(`(define (ls-long) (let* (${binds}) x${n - 1})) (ls-long)`)).toBe(String(n))
        })

        it('keeps letrec semantics when the values are not all lambdas, or a name is assigned', () => {
            expect(run(`(letrec ((x 1) (f (lambda () x))) (f))`)).toBe("1")
            expect(run(`(letrec ((f (lambda () 1)) (g (lambda () (f)))) (set! f (lambda () 2)) (g))`)).toBe("2")
            expect(boxesIn(`(lambda () (letrec ((f (lambda () 1)) (g (lambda () (f)))) (set! f (lambda () 2)) (g)))`)).toBe(1)
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

    describe('R7RS syntax', () => {
        it('when / unless run their body or give <#void>', () => {
            expect(run(`(list (when #t 1 2) (when #f 1) (unless #f 3) (unless #t 4))`)).toBe("(2 <#void> 3 <#void>)")
        })

        it('case compares with eqv?, with else and =>', () => {
            const src = (k: string) => `(case ${k} ((1 2 3) 'small) ((a b) => (lambda (x) (list 'sym x))) (else 'other))`
            expect(run(`(list ${src("2")} ${src("'b")} ${src("9")})`)).toBe("(small (sym b) other)")
            expect(run(`(case 5 ((1) 'one))`)).toBe("<#void>")
            expect(run(`(case 5 (else => (lambda (x) (* x 2))))`)).toBe("10")
            // the key is evaluated once
            expect(run(`(define n 0) (case (begin (set! n (+ n 1)) n) ((9) 'no) ((8) 'no) (else n))`)).toBe("1")
        })

        it('cond takes => and test-only clauses', () => {
            expect(run(`(define (find k) (if (= k 2) '(2 . b) #f)) (list (cond ((find 2) => cdr) (else 'none)) (cond ((find 3) => cdr) (else 'none)))`)).toBe("(b none)")
            expect(run(`(list (cond (#f) (7)) (cond (#f)))`)).toBe("(7 <#void>)")
            expect(run(`(cond (#f 1) ((+ 1 2) => (lambda (x) (* x x))))`)).toBe("9")
        })

        it('do loops with steps and results', () => {
            expect(run(`(do ((i 0 (+ i 1)) (acc '() (cons i acc))) ((= i 4) acc))`)).toBe("(3 2 1 0)")
            expect(run(`(let ((v (make-vector 3 0))) (do ((i 0 (+ i 1))) ((= i 3) v) (vector-set! v i (* i i))))`)).toBe("#(0 1 4)")
            expect(run(`(do ((i 0 (+ i 1))) ((= i 2)))`)).toBe("<#void>")
            // a long loop runs in constant space
            expect(run(`(do ((i 0 (+ i 1)) (s 0 (+ s i))) ((= i 100000) s))`)).toBe("4999950000")
        })

        it('define-values at the top level and in bodies', () => {
            expect(run(`(define-values (dv-a dv-b . dv-r) (values 1 2 3 4)) (list dv-a dv-b dv-r)`)).toBe("(1 2 (3 4))")
            expect(run(`(define (dv-f) (define-values (x y) (values 1 2)) (define z (+ x y)) (list x y z)) (dv-f)`)).toBe("(1 2 3)")
            expect(run(`(define-values all (values 5 6)) all`)).toBe("(5 6)")
            expect(() => run(`(define-values (dv-p dv-q) (values 1))`)).toThrow()
        })

        it('delay, delay-force, make-promise and force', () => {
            expect(run(`(define n 0) (define p (delay (begin (set! n (+ n 1)) n))) (list (force p) (force p) n (promise? p))`)).toBe("(1 1 1 #t)")
            expect(run(`(list (force (make-promise 5)) (force 7) (promise? (make-promise (make-promise 1))))`)).toBe("(5 7 #t)")
            // a delay-force chain is forced in constant space
            expect(run(`(define (loop n) (delay-force (if (= n 0) (delay 'done) (loop (- n 1))))) (force (loop 100000))`)).toBe("done")
            // a promise forced again while being forced keeps its first value (R7RS)
            expect(run(`(define count 0) (define p (delay (begin (set! count (+ count 1)) (if (> count 5) count (force p))))) (list (force p) count)`)).toBe("(6 6)")
            expect(() => run(`(force (delay-force 5))`)).toThrow("delay-force: the expression must give a promise")
        })

        it('parameters and parameterize', () => {
            expect(run(`(define p (make-parameter 10)) (list (p) (parameterize ((p 20)) (p)) (p))`)).toBe("(10 20 10)")
            // converters apply to the initial value and to parameterized ones
            expect(run(`(define q (make-parameter 1 (lambda (x) (* x 10)))) (list (q) (parameterize ((q 2)) (q)))`)).toBe("(10 20)")
            // procedures called from the body see it; an escape out of it restores the outer value
            expect(run(`(define r (make-parameter 'outer)) (define (get) (r)) (list (parameterize ((r 'inner)) (get)) (call/ec (lambda (k) (parameterize ((r 'x)) (k (r))))) (r))`)).toBe("(inner x outer)")
            // several at once, and the values are converted before any is set
            expect(run(`(define a (make-parameter 1)) (define b (make-parameter 2 (lambda (x) (list x (a))))) (parameterize ((a 10) (b 20)) (list (a) (b)))`)).toBe("(10 (20 1))")
            // a coroutine sees the parameters where it was resumed? no: where its body runs, i.e. its own continuation
            expect(run(`(define c (make-parameter 0)) (define co (parameterize ((c 1)) (coroutine-create (lambda () (c))))) (parameterize ((c 2)) (coroutine-resume co))`)).toBe("0")
            expect(() => run(`(parameterize ((car 1)) 1)`)).toThrow("parameterize: not a parameter")
        })

        it('case-lambda runs the first clause whose arity fits', () => {
            const f = `(define f (case-lambda ((a) (list 'one a)) ((a b) (list 'two a b)) ((a . r) (list 'many a r))))`
            expect(run(`${f} (list (f 1) (f 1 2) (f 1 2 3) (apply f '(9)) (map f '(1 2)) (procedure? f))`)).toBe("((one 1) (two 1 2) (many 1 (2 3)) (one 9) ((one 1) (one 2)) #t)")
            expect(() => run(`${f} (f)`)).toThrow("f: no clause takes 0 args")
            // clauses capture, and tail calls between them run in constant space
            expect(run(`(define (make k) (case-lambda (() k) ((x) (+ x k)))) (define g (make 10)) (list (g) (g 5))`)).toBe("(10 15)")
            expect(run(`(define h (case-lambda ((n) (h n 0)) ((n acc) (if (= n 0) acc (h (- n 1) (+ acc 1)))))) (h 100000)`)).toBe("100000")
            // non-tail recursion through it goes deeper than the js stack
            expect(run(`(define d (case-lambda ((n) (if (= n 0) 0 (+ 1 (d (- n 1))))))) (d 20000)`)).toBe("20000")
            expect(() => evaluator.compileRaw(`(%case-lambda 5)`)).toThrow("%case-lambda clauses must be %lambda forms")
        })

        it('a local case-lambda calls its clauses directly', () => {
            const made = (src: string) => {
                const closure = evaluator.evaluateRaw(evaluator.compileRaw(src))
                const inst: Uint32Array = closure.tmpl.code.inst
                const ops: number[] = []
                for (let ip = 0; ip < inst.length; ip += INSTRUCTION_LENGTHS[inst[ip] as OpCode]) ops.push(inst[ip])
                return { closures: ops.filter(op => op === OpCode.NEWCLOSURE).length, intrinsicCalls: ops.filter(op => op === OpCode.CALLINT).length }
            }
            const local = `(lambda (k) (define f (case-lambda ((a) (+ a k)) ((a b) (f (+ a b))) ((a . r) (length r)))) (list (f 1) (f 1 2) (f 1 2 3 4)))`
            expect(run(`(${local} 10)`)).toBe("(11 13 3)")
            // every call is resolved, so no procedure is made, and the clauses are lifted: nothing is made at all
            expect(made(local)).toEqual({ closures: 0, intrinsicCalls: 1 })
            // used as a value too: the procedure is made, from the same clauses
            expect(run(`((lambda (k) (define f (case-lambda ((a) (+ a k)) ((a b) (* a b)))) (list (f 1) (map f '(1 2)) (apply f '(3 4)))) 10)`)).toBe("(11 (11 12) 12)")
            // let and let* bindings, and a later let* binding of the name
            expect(run(`(let ((g (case-lambda ((a) a) ((a b) b)))) (list (g 1) (g 1 2)))`)).toBe("(1 2)")
            expect(run(`(let* ((x 5) (g (case-lambda ((a) (+ a x)) (() x))) (y (g 1)) (g (lambda (z) 'other))) (list y (g 9)))`)).toBe("(6 other)")
            // a call no clause takes is left to fail as it would
            expect(() => run(`(let ((h (case-lambda ((a) a)))) (h 1 2))`)).toThrow("no clause takes 2 args")
            // shadowed, it is not the case-lambda
            expect(run(`(let ((g (case-lambda ((a) 'clause)))) ((lambda (g) (g 1)) (lambda (x) 'shadow)))`)).toBe("shadow")
            // assigned, it is left alone
            expect(run(`(let ((g (case-lambda ((a) 1)))) (set! g (lambda (a) 2)) (g 0))`)).toBe("2")
            // tail calls between clauses stay loops
            expect(run(`((lambda () (define f (case-lambda ((n) (f n 0)) ((n acc) (if (= n 0) acc (f (- n 1) (+ acc 1)))))) (f 100000)))`)).toBe("100000")
        })

        it('call/cc and call/ec whose k is only called in the body are blocks', () => {
            const ops = (src: string) => {
                const closure = evaluator.evaluateRaw(evaluator.compileRaw(src))
                const inst: Uint32Array = closure.tmpl.code.inst
                const out: number[] = []
                for (let ip = 0; ip < inst.length; ip += INSTRUCTION_LENGTHS[inst[ip] as OpCode]) out.push(inst[ip])
                return out
            }
            for (const cc of ["call/cc", "call/ec", "call-with-current-continuation"]) {
                expect(run(`(list (+ 1 (${cc} (lambda (k) (+ 10 (k 5))))) (${cc} (lambda (k) 7)) (${cc} (lambda (k) (if #t (k 'early) 'late))))`)).toBe("(6 7 early)")
                // no escape continuation or continuation is made at all
                const made = ops(`(lambda (x) (+ 1 (${cc} (lambda (k) (if (> x 0) (k x) 0)))))`)
                expect(made).not.toContain(OpCode.CALLEC)
                expect(made).not.toContain(OpCode.CALLHOST)
            }
            // several values, and none
            expect(run(`(list (call-with-values (lambda () (call/cc (lambda (k) (k 1 2)))) list) (call-with-values (lambda () (call/cc (lambda (k) (k)))) list))`)).toBe("((1 2) ())")
            // an escape from a body re-entered through a continuation captured in it lands where k would return
            expect(run(`(define inner #f) (define n 0) (define r (call/cc (lambda (k) (call/cc (lambda (c) (set! inner c))) (set! n (+ n 1)) (if (< n 3) (k n) (k 'done))))) (if (< n 3) (inner #f) (list r n))`)).toBe("(done 3)")
            // the body stays in tail position
            expect(run(`(define (cc-loop n) (if (= n 0) 'done (call/cc (lambda (k) (cc-loop (- n 1)))))) (cc-loop 100000)`)).toBe("done")
            // a k of its own in the body is not the continuation
            expect(run(`(call/cc (lambda (k) (let ((k (lambda (x) (* x 100)))) (k 2))))`)).toBe("200")
        })

        it('keeps a real continuation when k is used any other way', () => {
            // kept and re-entered later (multi-shot)
            expect(run(`(define r '()) (define k2 #f) (set! r (cons (call/cc (lambda (k) (set! k2 k) 0)) r)) (if (< (length r) 3) (k2 (length r)) r)`)).toBe("(2 1 0)")
            // called from a lambda, passed on, returned
            expect(run(`(call/cc (lambda (k) (let ((f (lambda (x) (k x)))) (f 5) 'not)))`)).toBe("5")
            expect(run(`(call/ec (lambda (k) (apply k '(6)) 'not))`)).toBe("6")
            expect(run(`(procedure? (call/ec (lambda (k) k)))`)).toBe("#t")
            // assigned
            expect(run(`(call/cc (lambda (k) (set! k (lambda (x) (* x 2))) (k 21)))`)).toBe("42")
        })

        it('call-with-continuation-barrier stops re-entry but not escapes', () => {
            expect(run(`(call-with-continuation-barrier (lambda () 5))`)).toBe("5")
            expect(run(`(+ 1 (call/cc (lambda (k) (call-with-continuation-barrier (lambda () (k 1))))))`)).toBe("2")
            // a continuation captured inside, called again inside, is fine
            expect(run(`(call-with-continuation-barrier (lambda () (let ((n 0) (k #f)) (call/cc (lambda (c) (set! k c))) (set! n (+ n 1)) (if (< n 3) (k #f) n))))`)).toBe("3")
            // called from outside, it would re-enter
            expect(() => run(`(define saved #f) (define n 0) (call-with-continuation-barrier (lambda () (call/cc (lambda (k) (set! saved k))) (set! n (+ n 1)))) (if (< n 2) (saved #f) n)`)).toThrow("cannot re-enter a continuation barrier")
            // re-entry is an error Anima code can catch
            expect(run(`(define s2 #f) (call-with-continuation-barrier (lambda () (call/cc (lambda (k) (set! s2 k))))) (try (lambda () (if s2 (let ((k s2)) (set! s2 #f) (k 1)) 'done)) (lambda (e) (error-object-message e)))`)).toBe('"cannot re-enter a continuation barrier"')
        })

        it('R7RS error objects', () => {
            expect(run(`(try (lambda () (error "bad thing:" 1 'x)) (lambda (e) (list (error-object? e) (error-object-message e) (error-object-irritants e))))`)).toBe('(#t "bad thing:" (1 x))')
            expect(run(`(try (lambda () (car 1)) (lambda (e) (list (error-object? e) (error-object-irritants e))))`)).toBe("(#t ())")
            expect(run(`(try (lambda () (raise 'sym)) (lambda (e) (error-object? e)))`)).toBe("#f")
            expect(() => run(`(error "oops" 1 "two")`)).toThrow('oops 1 "two"')
        })
    });

    describe('List procedures', () => {
        it('append copies all but the last list', () => {
            expect(run(`(list (append) (append '(1)) (append '(1 2) '(3) '() '(4 5)) (append '(1) 2) (append '() '()))`)).toBe("(() (1) (1 2 3 4 5) (1 . 2) ())")
            expect(run(`(define tail '(3 4)) (define r (append '(1 2) tail)) (list (eq? (cddr r) tail) r)`)).toBe("(#t (1 2 3 4))")
            expect(run(`(list (apply append '((1) (2) (3))) (map append '((1) (2)) '((a) (b))))`)).toBe("((1 2 3) ((1 a) (2 b)))")
            expect(() => run(`(append '(1 . 2) '(3))`)).toThrow("append: expected a list")
            expect(() => run(`(append 5 '(3))`)).toThrow("append: expected a list")
        })

        it('map, for-each and filter, inline and as procedures', () => {
            // a literal lambda is inlined; anything else calls the prelude's procedure: the same results
            expect(run(`(list (map (lambda (x) (* x 10)) '(1 2 3)) (let ((f (lambda (x) (* x 10)))) (map f '(1 2 3))) (map (lambda (x) x) '()))`)).toBe("((10 20 30) (10 20 30) ())")
            expect(run(`(list (filter (lambda (x) (> x 2)) '(1 5 2 7)) (filter odd? '(1 2 3 4 5)) (filter odd? '()))`)).toBe("((5 7) (1 3 5) ())")
            expect(run(`(define acc '()) (for-each (lambda (x) (set! acc (cons x acc))) '(1 2 3)) (for-each (lambda (a b) (set! acc (cons (+ a b) acc))) '(1 2) '(10 20)) acc`)).toBe("(22 11 3 2 1)")
            // several lists stop at the shortest
            expect(run(`(list (map + '(1 2 3) '(10 20)) (map list '(1 2) '(a b) '(x y)))`)).toBe("((11 22) ((1 a x) (2 b y)))")
            // an inlined body may define, and sees the call site's variables
            expect(run(`(define k 100) (map (lambda (x) (define y (* x 2)) (+ y k)) '(1 2))`)).toBe("(102 104)")
            // long lists need no deep recursion
            expect(run(`(define (mk n acc) (if (= n 0) acc (mk (- n 1) (cons n acc)))) (define xs (mk 100000 '())) (list (length (map (lambda (x) (+ x 1)) xs)) (length (map (let ((f (lambda (x) x))) f) xs)) (length (filter even? xs)))`)).toBe("(100000 100000 50000)")
            expect(() => run(`(map + '(1 2) 5)`)).toThrow("map: expected a list")
        })

        it('lists know their length; improper ones are not lists', () => {
            expect(run(`(list (length '()) (length '(1 2 3)) (length '(1 2 . 3)) (list? '(1 2)) (list? '(1 . 2)) (list? '()) (list? 5))`)).toBe("(0 3 2 #t #f #t #f)")
            expect(run(`(define (mk n acc) (if (= n 0) acc (mk (- n 1) (cons n acc)))) (define xs (mk 100000 '())) (define (f l) (length l)) (list (f xs) (f (cdr xs)) (list? xs))`)).toBe("(100000 99999 #t)")
        })

        it('cons* and cons chains build a list in one go', () => {
            expect(run(`(list (cons* 1 2 '(3 4)) (cons* 1 2 3) (cons* '(1)) (cons* 5) (length (cons* 1 2 '(3 4))) (length (cons* 1 2 3)))`)).toBe("((1 2 3 4) (1 2 . 3) (1) 5 4 2)")
            expect(run(`(list (apply cons* '(1 2 (3))) (map cons* '(1 2) '((a) (b))))`)).toBe("((1 2 3) ((1 a) (2 b)))")
            // a chain of conses is one list / cons*, with the same pairs and lengths
            expect(run(`(define xs '(8 9)) (define r (cons 1 (cons 2 (cons 3 xs)))) (list r (length r) (length (cdr r)) (eq? (cdddr r) xs) (cons 1 (cons 2 '())) (length (cons 1 (cons 2 '()))) (cons 1 (cons 2 3)) (list? (cons 1 (cons 2 3))))`)).toBe("((1 2 3 8 9) 5 4 #t (1 2) 2 (1 2 . 3) #f)")
            // arguments are evaluated left to right, as the nested calls would be
            expect(run(`(define log '()) (define (n x) (set! log (cons x log)) x) (cons (n 1) (cons (n 2) (n '()))) (reverse log)`)).toBe("(1 2 ())")
            const bc = evaluator.compileRaw(`(define (cc-f a b c) (cons a (cons b (cons c '()))))`) as ByteCode
            const fn = bc.constants.find((c: any) => c instanceof Closure)!
            const ops: OpCode[] = []
            for (let ip = 0; ip < fn.tmpl.code.inst.length; ip += INSTRUCTION_LENGTHS[fn.tmpl.code.inst[ip] as OpCode]) ops.push(fn.tmpl.code.inst[ip])
            expect(ops.filter(op => op === OpCode.CALLINT)).toHaveLength(1)
        })

        it('mutable pairs (mcons) are separate from lists', () => {
            expect(run(`(define p (mcons 1 2)) (set-mcar! p 10) (set-mcdr! p '(3)) (list (mcar p) (mcdr p) (mpair? p) (pair? p) (list? p) (mpair? '(1)))`)).toBe("(10 (3) #t #f #f #f)")
            expect(run(`(mcons 1 (mcons 2 '()))`)).toBe("(mcons 1 (mcons 2 ()))")
            // equal? compares contents, eq? identity
            expect(run(`(list (equal? (mcons 1 2) (mcons 1 2)) (eq? (mcons 1 2) (mcons 1 2)) (equal? (mcons 1 2) (cons 1 2)))`)).toBe("(#t #f #f)")
            // circular ones print and compare
            expect(run(`(define c (mcons 1 #f)) (set-mcdr! c c) c`)).toBe("(mcons 1 #<cycle>)")
            expect(run(`(define a (mcons 1 #f)) (set-mcdr! a a) (define b (mcons 1 #f)) (set-mcdr! b b) (equal? a b)`)).toBe("#t")
            expect(() => run(`(car (mcons 1 2))`)).toThrow("car: expected a pair")
            expect(() => run(`(mcar '(1 2))`)).toThrow("mcar: expected a mutable pair")
            expect(() => run(`(length (map (lambda (x) x) (mcons 1 '())))`)).toThrow()
        })

        it('map gives each continuation its own result (multi-shot call/cc inside f)', () => {
            for (const f of ["(lambda (x) (if (= x 2) (call/cc (lambda (c) (set! k c) x)) x))", "(let ((g (lambda (x) (if (= x 2) (call/cc (lambda (c) (set! k c) x)) x)))) g)"]) {
                expect(run(`(define k #f) (define results '()) (let ((r (map ${f} '(1 2 3)))) (set! results (cons r results)) (if (< (length results) 3) (k (* 10 (length results))) (reverse results)))`)).toBe("((1 2 3) (1 10 3) (1 20 3))")
            }
        })
    });

    describe('quasiquote', () => {
        it('builds lists and vectors (R7RS examples)', () => {
            expect(run("`(list ,(+ 1 2) 4)")).toBe("(list 3 4)")
            expect(run("(let ((name 'a)) `(list ,name ',name))")).toBe("(list a (quote a))")
            expect(run("`(a ,(+ 1 2) ,@(map (lambda (x) (* x x)) '(4 5 6)) b)")).toBe("(a 3 16 25 36 b)")
            expect(run("`((foo ,(- 10 3)) ,@(cdr '(c)) . ,(car '(cons)))")).toBe("((foo 7) . cons)")
            expect(run("`#(10 5 ,(* 2 1) ,@(map (lambda (x) (* x 2)) '(8 4)) 8)")).toBe("#(10 5 2 16 8 8)")
            expect(run("`(1 ,@'() 2)")).toBe("(1 2)")
            expect(run("(define xs '(3 4)) (list `(1 2 ,@xs) `(,@xs) `(0 . ,xs))")).toBe("((1 2 3 4) (3 4) (0 3 4))")
            // nothing unquoted: a constant
            expect(run("(list `(a b (c)) `sym `5 `#(1 2))")).toBe("((a b (c)) sym 5 #(1 2))")
            // the spliced list is copied, except at the end
            expect(run("(define ys '(1 2)) (list `(,@ys 3) (eq? (cdr `(0 ,@ys)) ys) (eq? `(,@ys 3) ys))")).toBe("((1 2 3) #t #f)")
        })

        it('builds only what changes', () => {
            // the constant tail after the last unquote is one shared constant
            expect(run("(define (qf x) `(a ,x b c)) (list (qf 1) (qf 2) (eq? (cddr (qf 1)) (cddr (qf 2))) (length (qf 1)))")).toBe("((a 1 b c) (a 2 b c) #t 4)")
            expect(run("(define (qs xs) `(,@xs z)) (list (qs '(1 2)) (eq? (cddr (qs '(1 2))) (cdr (qs '(3)))))")).toBe("((1 2 z) #t)")
            // a vector with nothing spliced is made directly
            const bc = evaluator.compileRaw("(define (qv x) `#(1 ,x 3))") as ByteCode
            const fn = bc.constants.find((c: any) => c instanceof Closure)!
            expect(stringifyInst(fn.tmpl.code).some((l: string) => /pos=%vector,/.test(l))).toBe(true)
            expect(stringifyInst(fn.tmpl.code).some((l: string) => /list->vector/.test(l))).toBe(false)
            evaluator.evaluateRaw(bc)
            expect(run("(qv 2)")).toBe("#(1 2 3)")
        })

        it('nests levels', () => {
            expect(run("`(a `(b ,(c ,(+ 1 2))))")).toBe("(a (quasiquote (b (unquote (c 3)))))")
            expect(run("`(a `(b ,(foo ,(+ 1 3) d) e) f)")).toBe("(a (quasiquote (b (unquote (foo 4 d)) e)) f)")
            expect(run("(let ((name1 'x) (name2 'y)) `(a `(b ,,name1 ,',name2 d) e))")).toBe("(a (quasiquote (b (unquote x) (unquote (quote y)) d)) e)")
            expect(run("(let ((xs '(1 2))) `(a `(b ,@,@xs)))")).toBe("(a (quasiquote (b (unquote-splicing 1 2))))")
        })

        it('rejects unquotes outside a quasiquote', () => {
            expect(() => run(",x")).toThrow("unquote: not in a quasiquote")
            expect(() => run("`,@x")).toThrow("unquote-splicing: not in a list")
            expect(() => run("`(1 ,@5 2)")).toThrow("append: expected a list")
            // spliced last, it is checked too, and a splice in a list's tail is refused
            expect(() => run("`(1 ,@5)")).toThrow("unquote-splicing: expected a list but got 5")
            expect(() => run("`(1 ,@'(2 . 3))")).toThrow("unquote-splicing: expected a list")
            expect(() => run("`(,@7)")).toThrow("unquote-splicing: expected a list")
            expect(() => evaluator.compileRaw("(define (qt x) `(1 . ,@x))")).toThrow("unquote-splicing: not allowed in the tail of a list")
            expect(() => evaluator.compileRaw("(define (qt x) `(1 unquote-splicing x))")).toThrow("unquote-splicing: not allowed in the tail of a list")
            // one level in, it is data
            expect(run("`(a `(b . ,@(c)))")).toBe("(a (quasiquote (b unquote-splicing (c))))")
        })
    });

    describe('Delimited continuations', () => {
        it('shift / reset', () => {
            expect(run(`(+ 1 (reset (+ 10 (shift k (k (k 100))))))`)).toBe("121")
            expect(run(`(reset (* 2 (shift k 5)))`)).toBe("5")
            // multi-shot
            expect(run(`(reset (list 1 (shift k (list (k 2) (k 3)))))`)).toBe("((1 2) (1 3))")
            expect(run(`(define k1 #f) (define r (+ 1 (reset (* 2 (shift k (begin (set! k1 k) 0)))))) (list r (k1 5) (k1 10))`)).toBe("(1 10 20)")
            // no prompt left: a continuation with no frames is the identity
            expect(run(`(reset (shift k (k 7)))`)).toBe("7")
            // many in a loop run in constant space
            expect(run(`(let loop ((i 0) (acc 0)) (if (= i 20000) acc (loop (+ i 1) (+ acc (reset (+ 1 (shift k (k i))))))))`)).toBe("200010000")
        })

        it('prompts, tags and aborts', () => {
            expect(run(`(call-with-continuation-prompt (lambda () (+ 1 (abort-current-continuation (default-continuation-prompt-tag) 5 6))) (default-continuation-prompt-tag) (lambda (a b) (list a b)))`)).toBe("(5 6)")
            expect(run(`(call-with-continuation-prompt (lambda (x y) (+ x y)) (default-continuation-prompt-tag) #f 1 2)`)).toBe("3")
            // an abort passes prompts with other tags
            expect(run(`(define t (make-continuation-prompt-tag 'outer)) (call-with-continuation-prompt (lambda () (reset (+ 1 (abort-current-continuation t 'out)))) t (lambda (v) (list 'handled v)))`)).toBe("(handled out)")
            // a composable continuation up to a tagged prompt
            expect(run(`(define t2 (make-continuation-prompt-tag)) (define kk (call-with-continuation-prompt (lambda () (+ 100 (call-with-composable-continuation (lambda (k) (abort-current-continuation t2 k)) t2))) t2 (lambda (k) k))) (list (kk 1) (kk 2) (+ 1 (kk 3)))`)).toBe("(101 102 104)")
            expect(() => run(`(abort-current-continuation (make-continuation-prompt-tag 'none) 1)`)).toThrow("no continuation prompt tagged")
            expect(() => run(`(call-with-composable-continuation (lambda (k) k) (make-continuation-prompt-tag))`)).toThrow("no continuation prompt tagged")
            expect(run(`(list (continuation-prompt-tag? (make-continuation-prompt-tag)) (continuation-prompt-tag? 1))`)).toBe("(#t #f)")
        })

        it('run dynamic-wind thunks leaving and re-entering', () => {
            expect(run(`
                (define log '())
                (define (note x) (set! log (cons x log)))
                (define k #f)
                (reset (dynamic-wind (lambda () (note 'in)) (lambda () (shift c (set! k c)) (note 'body)) (lambda () (note 'out))))
                (k 1)
                (reverse log)`)).toBe("(in out in body out)")
        })

        it('carry marks, parameters and handlers along', () => {
            // a parameterization inside the captured part comes with it; one outside it comes from where it is called
            expect(run(`(define p (make-parameter 0)) (define k (reset (parameterize ((p 1)) (shift c c) (p)))) (list (k #f) (parameterize ((p 5)) (k #f)))`)).toBe("(1 1)")
            expect(run(`(define q (make-parameter 0)) (define k (reset (shift c c) (q))) (list (k #f) (parameterize ((q 5)) (k #f)))`)).toBe("(0 5)")
            // a try inside the captured part still catches, after it is reinstated
            expect(run(`(define k (reset (try (lambda () (shift c c) (raise 'boom)) (lambda (e) (list 'caught e))))) (list (k 1) (k 2))`)).toBe("((caught boom) (caught boom))")
            // and a call/ec inside it can still escape
            expect(run(`(define k (reset (call/ec (lambda (esc) (shift c c) (esc 'escaped) 'not)))) (list (k 1) (k 2))`)).toBe("(escaped escaped)")
            // with-exception-handler around the call site sees what the reinstated part raises
            expect(run(`(define k (reset (shift c c) (raise-continuable 'r))) (with-exception-handler (lambda (e) (list 'handled e)) (lambda () (k 1)))`)).toBe("(handled r)")
        })

        it('cannot compose a continuation barrier', () => {
            expect(() => run(`(define k (reset (call-with-continuation-barrier (lambda () (shift c c) 1)))) (k 1)`)).toThrow("cannot re-enter a continuation barrier")
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
