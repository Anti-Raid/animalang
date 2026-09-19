// Made w/ lots of help from gemini cli
import { ASTStringifier, AbstractByteCode, MissingVarError, isDeepEqual } from './common';
import { describe, it, expect } from 'vitest';
import { Cons } from './list';
import { Anima } from './anima';
import { impl } from './bytecode-rvm/meta';

const vmImpl = impl
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
    });

    describe('Try/Catch', () => {
        it('basic try-catch', () => {
            expect(run("(try (lambda () + abc) '())")).toContain("Variable 'Symbol(abc)' is not defined");
            expect(run(`
                (define x (lambda ()
                    (try (lambda (a) + abc) '(1)))) 
                (x)
            `)).toContain("Variable 'Symbol(abc)' is not defined");
            expect(run(`(try / 1 0 '())`)).toContain("division by zero");
            expect(run(`
                (define x (lambda ()
                    (try (lambda (a) (/ 1 0)) '(1)))) 
                (x)
            `)).toContain("division by zero");
            expect(run(`
;; A function that loops 100000 times using tail calls, then crashes
(define (deep-dive n)
  (if (= n 0)
      (error "Hit rock bottom")
      (deep-dive (- n 1))))

;; Wrap it in a single try block
(try deep-dive 100000 '()) 
            `)).toContain("Hit rock bottom")

            expect(run(`
(define (level-1)
  (error "Level 1 failure"))

(define (level-2)
  (let ((res (try level-1 '())))
    (if (error? res)
        (error "Escalated to Level 2") ;; Throwing from inside error-handling logic!
        "Success")))

(try level-2 '())
        `)).toContain("Escalated to Level 2")

            expect(run(`
(define (risky-math a b c)
  (if (= c 0)
      (error "Div by zero")
      (/ (+ a b) c)))

;; Using apply inside a try!
(define result (try apply risky-math '(10 20 0) '()))
result
        `)).toContain("Div by zero")

            expect(run(`
(define (ping n)
  (if (= n 0)
      (error "Ping Crash!")
      ;; Ping wraps its call to pong in a try block
      (try (lambda () (pong (- n 1))) '())))

(define (pong n)
  (if (= n 0)
      (error "Pong Crash!")
      ;; Pong does a standard tail-call to ping
      (ping (- n 1))))

(error-message (ping 1000))        
    `)).toBe('"Ping Crash!"')

expect(run(`
(define (long-chain n)
  (if (= n 0)
      (error "Second failure")
      (long-chain (- n 1))))

(define (level-1)
  (error "First failure"))

(define (level-2)
  (let ((res (try level-1 '())))
    (if (error? res)
        (long-chain 1000) ;; NOT wrapped in its own try -- must be caught
                           ;; by whatever try wraps level-2 itself, after
                           ;; running 1000 tail calls under the OUTER scope
        "unreachable")))

(try level-2 '())
`)).toContain("Second failure")

expect(run(`
(define (safe-add a b) (+ a b))
(define (crash) (error "Boom"))

(define (test)
  (let ((ok (try safe-add 1 2 '())))
    (if (= ok 3)
        (crash)      ;; must be caught by outer try, not confused by prior success
        "wrong")))

(error-message (try test '()))
`)).toBe('"Boom"')
        });

        it('survives tail-call trapdoor inheritance', () => {
            // What it tests: If a function inside a `try` tail-calls another function,
            // the TAILCALL opcode replaces the current CallFrame. Does the new 
            // CallFrame correctly inherit the trySpot?
            expect(run(`
                (define (crash-later) (error "Delayed Boom"))
                (define (tailcaller) (crash-later)) ;; Tailcall!
                
                (define (test)
                    (try tailcaller '()))
                    
                (error-message (test))
            `)).toBe('"Delayed Boom"');
        });

        it('prevents Zombie Trapdoors in escaping closures', () => {
            // What it tests: If a closure is CREATED inside a try block, but 
            // EXECUTED outside of it, it must NOT use the dead try block's trapdoor. 
            // It must use the trapdoor of its execution context.
            expect(run(`
                (define (make-bomb)
                    (try (lambda () 
                            (lambda () (error "Zombie Boom"))) 
                        '()))
                        
                (define bomb (make-bomb)) ;; The inner try is now DEAD.
                
                (define (test)
                    (let ((res (try bomb '()))) ;; Wrapped in a NEW outer try
                        (error-message res)))
                        
                (test)
            `)).toBe('"Zombie Boom"');
        });

        it('clears success paths after multiple nested closure & builtin tries', () => {
            expect(run(`
                (define (safe-mul a b) (* a b))
                (define (safe-add a b) (+ a b))
                (define (crash) (error "Core Meltdown"))

                (define (test)
                    (let ((x (try safe-add 10 20 '()))) ;; Sync builtin success
                        (let ((y (try (lambda () (safe-mul x 2)) '()))) ;; Async closure success
                            (if (= y 60)
                                (crash) ;; Outer try must catch this!
                                "Math failed"))))

                (error-message (try test '()))
            `)).toBe('"Core Meltdown"');
        });

        it('intercepts synchronous builtin crashes (Pre-emptive catch)', () => {
            // What it tests: The specific local try/catch block we added inside TryProc.
            // If a JS builtin is passed bad arguments directly inside a try block, 
            // it crashes instantly in JS, bypassing the VM's OpCode loop.
            expect(run(`
                ;; + is a builtin. We pass it a string to force a JS-level type error.
                (define (test)
                    (try + 1 "a" '()))
                    
                (error? (test))
            `)).toBe('#t');
        });

        it('handles top-level tailcall returns and crashes cleanly', () => {
            // What it tests: When destReg is undefined and parent is null.
            // Ensures the fallback to "TOP_LEVEL" correctly exits the VM 
            // instead of throwing an unhandled JS exception.
            
            // Success path
            expect(run(`(try + 10 20 '())`)).toBe('30');
            expect(run(`(error-message (try / 10 "b" '()))`)).toContain("requires numbers"); 
        });
    })

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
