// Made w/ lots of help from gemini cli
import { ASTStringifier, AbstractByteCode, MissingVarError, isDeepEqual, Table, ASPParseError, BS, BSReader } from './common';
import { describe, it, expect } from 'vitest';
import { Cons } from './list';
import { ByteCode, AnimaVM, JITCompiler, OpCode } from './bytecode-rvm/vm';
import { Anima } from './anima';
import { implAot } from './bytecode-rvm/meta';
import { dumpFull, readFull, BYTECODE_VERSION } from './bytecode-rvm/utils';

const vmImpl = implAot
const bcCache: Record<string, AbstractByteCode> = {}
describe('Anima', () => {
    let evaluator = new Anima(vmImpl)
    let s = new ASTStringifier()
    evaluator.scope.set(Symbol.for("port"), 8080)
    evaluator.scope.set(Symbol.for("protocol"), "tcp")
    evaluator.scope.set(Symbol.for("is_active"), true)
    evaluator.scope.set(Symbol.for("user_role"), null)
    
    const run = (expr: string) => {
        if (bcCache[expr]) return s.stringify(evaluator.evaluateRaw(bcCache[expr]))
        const bc = evaluator.compileRaw(expr)
        console.log(expr)
        evaluator.deepPrint(bc)
        bcCache[expr] = bc
        return s.stringify(evaluator.evaluateRaw(bc));
    };

    describe('Primitives, Strings & Symbols', () => {
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
            run(`(define (bad n) (if (= n 0) (car '()) (+ 1 (bad (- n 1)))))`);
            expect(() => run("(bad 10)")).toThrow("car: list is too short");
            expect(run("(try (lambda () (bad 5)) (lambda (e) 'caught))")).toBe("caught");
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
        expect(closure.debugName).toBe("lambda");
        const restClosure = evaluator.evaluateRaw(evaluator.compileRaw(`(lambda (x . rest) x)`));
        expect(restClosure.debugName).toBe("lambda");

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
    });
})

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
    let evaluator = new Anima(vmImpl);
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
    let evaluator = new Anima(vmImpl);
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

        // Chaining
        const child = t.chained();
        expect(child.parent).toBe(t);
        expect(child.get("name")).toBe("Willow");
        child.set("name", "Luna");
        expect(child.get("name")).toBe("Luna");
        expect(t.get("name")).toBe("Willow");
        expect(child.size).toBe(4);

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

    it('supports table-chain, table-entries and table-current-entries in Scheme', () => {
        const script = `
            (let ((parent {"a" 1 "b" 2}))
              (let ((child (table-chain parent)))
                (begin
                  (table-set! child "b" 20)
                  (table-set! child "c" 30)
                  (list
                    (table-ref child "a")
                    (table-ref child "b")
                    (table-ref parent "b")
                    (table-size child)
                    (vector-length (table-current-entries child))
                    (vector-length (table-current-entries parent))
                    (vector-length (table-entries child))))))
        `;
        expect(run(script)).toBe("(1 20 2 4 2 2 4)");

        // table-chain with frozen = #t
        const frozenChildScript = `
            (let ((parent {"a" 1}))
              (let ((child (table-chain parent #t)))
                (table-frozen? child)))
        `;
        expect(run(frozenChildScript)).toBe("#t");
    });

    it('supports chained tables', () => {
        const root = new Table();
        root.set("a", 1);
        root.set("b", 2);

        const child = root.chained();
        child.set("b", 20);
        child.set("c", 30);

        expect(child.parent).toBe(root);
        expect(child.size).toBe(4);
        expect(child.has("a")).toBe(true);
        expect(child.get("a")).toBe(1);
        expect(child.get("b")).toBe(20);
        expect(root.get("b")).toBe(2);
        expect(child.get("missing")).toBeUndefined();
        expect(child.has("missing")).toBe(false);

        // grandchild chaining
        const grand = child.chained();
        expect(grand.parent).toBe(child);
        expect(grand.has("a")).toBe(true);
        expect(grand.get("a")).toBe(1);
        expect(grand.get("b")).toBe(20);
        expect(grand.get("c")).toBe(30);
        expect(grand.has("missing")).toBe(false);
        // currentEntries only returns own entries
        expect([...root.currentEntries()]).toEqual([["a", 1], ["b", 2]]);
        expect([...child.currentEntries()]).toEqual([["b", 20], ["c", 30]]);
        expect([...grand.currentEntries()]).toEqual([]);
    });
});

describe('Floats, Infinities & NaNs', () => {
    let evaluator = new Anima(vmImpl);
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

describe("JIT Compiler Runtime Compilation & Execution", () => {
    const animaScope = () => {
        const anima = new Anima(vmImpl);
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

        expect(fnCode.nativeFn).not.toBeNull();
        expect(typeof fnCode.nativeFn).toBe("function");

        expect(anima.evaluateClosure(doubleClosure, [21])).toBe(42);
        expect(anima.evaluateClosure(doubleClosure, [50])).toBe(100);
        expect(anima.evaluateClosure(doubleClosure, [100])).toBe(200);
    });

    it("executes straight-line native opcodes completely natively in AOT", () => {
        const anima = new Anima(implAot);
        const code = anima.compileRaw(`(lambda (x) x)`);
        const idClosure = anima.evaluateRaw(code);
        const fnCode = idClosure.tmpl.code as ByteCode;

        expect(fnCode.nativeFn).not.toBeNull();
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
        JITCompiler.compile(bc);

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
        JITCompiler.compile(bc);

        const vm = new AnimaVM();
        const scope = animaScope();
        expect(vm.evaluateRaw(bc, scope)).toBe(777);
        expect(scope.get(mySym)).toBe(777);
    });

    it("deoptimizes cleanly to interpreter on unhandled opcodes", () => {
        // Function with straight-line ops followed by an unhandled opcode:
        // 0: LOADU32 r1, 50
        // 3: LOADU32 r2, 60
        // 6: ARITHMETIC(+) r0, r1, r2
        // 11: RETURN r0
        const plusSym = Symbol.for("+");
        const inst = new Uint32Array([
            OpCode.LOADU32, 1, 50,
            OpCode.LOADU32, 2, 60,
            OpCode.ARITHMETIC, 0, 1, 2, 0,
            OpCode.RETURN, 0
        ]);
        const bc = new ByteCode([], inst, 4);

        // Compile it with JIT
        JITCompiler.compile(bc);
        expect(bc.nativeFn).not.toBeNull();

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

        expect(fnCode.nativeFn).not.toBeNull();
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

        expect(fnCode.nativeFn).not.toBeNull();
        expect(anima.evaluateClosure(fnClosure, [true, true])).toBe("both");
        expect(anima.evaluateClosure(fnClosure, [true, false])).toBe("only-a");
        expect(anima.evaluateClosure(fnClosure, [false, true])).toBe("only-b");
        expect(anima.evaluateClosure(fnClosure, [false, false])).toBe("neither");
    });

    it("executes TAILCALL recursively in JIT without stack overflow", () => {
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

        expect(fnCode.nativeFn).not.toBeNull();
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

        expect(fnCode.nativeFn).not.toBeNull();
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

        expect(fnCode.nativeFn).not.toBeNull();

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
