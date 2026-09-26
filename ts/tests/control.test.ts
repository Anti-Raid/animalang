import { ASTStringifier } from '../common';
import { describe, it, expect, beforeEach } from 'vitest';
import { createScheme } from '../scheme';
import { ByteCode } from '../bytecode-rvm/vm';
import { Anima } from '../anima';
import { impl, implAot } from '../bytecode-rvm/meta';
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

})
})
