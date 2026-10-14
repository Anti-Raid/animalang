import { describe, it, expect } from 'vitest';
import { createScheme } from '../scheme';
import { ASTStringifier } from '../scheme/printer';

// each program, compiled with the optimizer and without, gives the same value, or the same error and traceback
const PROGRAMS: string[] = [
    // assigned variables, captured and across continuations (re-entered)
    `(define (ad-make) (let ((n 0)) (define (inc) (set! n (+ n 1)) n) (inc) (inc) (list (inc) n))) (ad-make)`,
    `(define ad-k #f) (define ad-n 0)
     (define (ad-f) (let ((x 0)) (define (bump) (set! x (+ x 1))) (call/cc (lambda (k) (set! ad-k k))) (bump) (set! ad-n (+ ad-n 1)) x))
     (define ad-r (ad-f)) (if (< ad-n 3) (ad-k #f) (list ad-r ad-n))`,
    `(define (ad-lr) (define (mk) (lambda () b)) (define a (mk)) (define b 2) (a)) (ad-lr)`,
    `(letrec ((x (list (lambda () x)))) (eq? ((car x)) x))`,
    // inlined helpers around control: escapes, catch, dynamic-wind, coroutines, marks
    `(define (ad-esc l) (call/ec (lambda (k) (define (check x) (if (> x 2) (k x) #f)) (for-each check l) 'none))) (list (ad-esc '(1 5 3)) (ad-esc '(1)))`,
    `(define (ad-try x) (define (risky v) (if (number? v) (+ v 1) (raise 'bad))) (try (lambda () (risky x)) (lambda (e) (list 'caught e)))) (list (ad-try 1) (ad-try 'a))`,
    `(define ad-log '()) (define (ad-wind) (define (note x) (set! ad-log (cons x ad-log))) (dynamic-wind (lambda () (note 'in)) (lambda () (note 'body) 1) (lambda () (note 'out)))) (list (ad-wind) ad-log)`,
    `(define (ad-co) (define (step x) (coroutine-yield (* x 2))) (let ((co (coroutine-create (lambda (a) (step a) (step (+ a 1)) 'done)))) (list (coroutine-resume co 1) (coroutine-resume co) (coroutine-resume co))))
     (ad-co)`,
    `(define (ad-mark) (define (get) (continuation-mark-set-first (current-continuation-marks) 'k 'none)) (list (with-continuation-mark 'k 1 (get)) (with-continuation-mark 'k 2 (list (get))) (get))) (ad-mark)`,
    // folding and what must not be folded
    `(list (+ 1 2) (* 1.5 2) (< 1 2 3) (= 1 1.0) (eq? 'a 'a) (not #f) (length '(1 2 3)) (exact 4.0) (- 7))`,
    `(define (ad-fresh) (let loop ((i 0) (prev #f) (same 0)) (if (= i 3) same (let ((x (list 1))) (loop (+ i 1) x (if (eq? x prev) (+ same 1) same)))))) (ad-fresh)`,
    `(define (ad-vec) (let ((v (vector 1 2))) (vector-set! v 0 9) (vector-ref v 0))) (ad-vec)`,
    `(list (+ 1 'a))`,
    `(define (ad-div) (/ 1 0)) (ad-div)`,
    `(car '())`,
    // procedures: rest and apply, case-lambda, recursion, higher order
    `(define (ad-rest . xs) (define (sum l) (if (null? l) 0 (+ (car l) (sum (cdr l))))) (apply + (sum xs) xs)) (ad-rest 1 2 3)`,
    `(define ad-cl (case-lambda ((a) (list 'one a)) ((a b) (list 'two a b)) ((a . r) (list 'many a r)))) (list (ad-cl 1) (ad-cl 1 2) (ad-cl 1 2 3))`,
    `(define (ad-fib n) (define (go n) (if (< n 2) n (+ (go (- n 1)) (go (- n 2))))) (go n)) (ad-fib 15)`,
    `(define (ad-hi n) (define (twice f) (lambda (x) (f (f x)))) (define (add1 x) (+ x 1)) ((twice (twice add1)) n)) (ad-hi 10)`,
    `(define (ad-arity) (define (two a b) (+ a b)) (two 1)) (ad-arity)`,
    // tracebacks through inlined procedures, tail and not
    `(define (ad-tb) (define (inner x) (list (debug-traceback) x)) (car (inner 1))) (ad-tb)`,
    `(define (ad-tb2) (define (inner) (debug-traceback)) (define (outer) (inner)) (list (outer))) (ad-tb2)`,
    `(define (ad-err) (define (bad x) (vector-ref x 5)) (define (mid x) (list (bad x))) (mid (vector 1))) (ad-err)`,
    `(define (ad-arg) (define (f x) (list x)) (f (car '()))) (ad-arg)`,
    `(define (ad-nest) (define (h x) (car x)) (define (g x) (h x)) (define (f x) (list (g x))) (f 5)) (ad-nest)`,
    `(define (ad-tail) (define (h x) (car x)) (define (g x) (h x)) (g 5)) (list (ad-tail))`,
    `(define (ad-loop n) (define (check i) (if (= i 3) (car i) i)) (let loop ((i 0)) (check i) (loop (+ i 1)))) (ad-loop 0)`,
    `(define ad-co2 (coroutine-create (lambda () (define (deep) (list (coroutine-yield 1))) (define (mid) (list (deep))) (list (mid))))) (coroutine-resume ad-co2) (debug-traceback ad-co2)`,
    `(define ad-k2 #f) (define ad-c 0)
     (define (ad-re) (define (inner) (call/cc (lambda (k) (set! ad-k2 k))) (debug-traceback)) (list (inner)))
     (define ad-t (ad-re)) (set! ad-c (+ ad-c 1)) (if (< ad-c 2) (ad-k2 #f) ad-t)`,
    `(define (ad-set) (define (g x) (set! x (* x 2)) (list x)) (list (g 1) (g 5))) (ad-set)`,
    `(define (ad-rest) (define (g a . r) (cons a r)) (define (h . xs) (apply g xs)) (list (h 1) (h 1 2 3) (apply h '(4 5)))) (ad-rest)`,
    `(define (ad-rest-err) (define (g . xs) (apply car xs)) (g 1 2)) (ad-rest-err)`,
    `(define (ad-rest-k) (define k2 #f) (define n 0) (define (g . xs) (call/cc (lambda (k) (set! k2 k))) xs) (let ((r (g 1 2))) (set! n (+ n 1)) (if (< n 3) (k2 #f) (list r n)))) (ad-rest-k)`,
    // the prelude's map, for-each and filter inlined: errors and tracebacks in the procedure, continuations re-entering
    // it, several lists, a procedure that is a global, a redefined map, a map that is a local
    `(define (ad-m l) (map (lambda (x) (car x)) l)) (ad-m '((1) 2))`,
    `(define (ad-fe l) (for-each (lambda (x) (vector-ref x 1)) l)) (list (ad-fe (list (vector 1))))`,
    `(define (ad-fl l) (filter (lambda (x) (debug-traceback)) l)) (ad-fl '(1))`,
    `(define (ad-g x) (* x 2)) (list (map ad-g '(1 2 3)) (map + '(1 2) '(10 20)) (map (lambda (a b) (list a b)) '(1 2) '(3 4 5)))`,
    `(define ad-mk #f) (define ad-mn 0)
     (define ad-mr (map (lambda (x) (call/cc (lambda (k) (if (= x 2) (set! ad-mk k)) x))) '(1 2 3)))
     (set! ad-mn (+ ad-mn 1)) (if (< ad-mn 3) (ad-mk (* 10 ad-mn)) (list ad-mr ad-mn))`,
    `(define (ad-acc) (let ((s 0)) (for-each (lambda (x) (set! s (+ s x))) '(1 2 3)) s)) (ad-acc)`,
    `(define (ad-loc l) (let ((map (lambda (f l) 'mine))) (map (lambda (x) x) l))) (ad-loc '(1))`,
    `(define (map f l) 'redefined) (map (lambda (x) x) '(1))`,
    `(define (ad-bad) (map (lambda (x) x))) (ad-bad)`,
    // let*, let-values and shadowing through renaming
    `(let* ((a 1) (b (+ a 1)) (a (* b 10))) (list a b))`,
    `(let-values (((a b) (values 1 2)) ((c . d) (values 3 4 5))) (define (f) (list a b c d)) (f))`,
    `(define (ad-sh x) (let ((x (+ x 1))) (let ((f (lambda () x))) (let ((x 100)) (list x (f)))))) (ad-sh 1)`,
    // the values of an inlined procedure, bound with no multiple values made
    `(define (mv-a) (define (two x) (values x (+ x 1))) (let-values (((a b) (two 1))) (list a b))) (mv-a)`,
    `(define (mv-b) (define (two x) (let ((y (* x 2))) (values x y))) (let-values (((a b) (two 5))) (set! a (+ a b)) (list a b))) (mv-b)`,
    `(define (mv-c) (define (two x) (values x (car x))) (let-values (((a b) (two 1))) (list a b))) (mv-c)`,
    `(define (mv-d) (define (two x) (values x (+ x 1))) (let-values (((a b c) (two 1))) (list a b c))) (mv-d)`,
    `(define (mv-e) (define (three x) (values x x x)) (let-values (((a b) (three 1))) (list a b))) (mv-e)`,
    `(define (mv-f) (define (two x) (values x (+ x 1))) (let-values (((a b) (two 1))) (lambda () (set! b (+ b a)) b))) ((mv-f))`,
    `(define (mv-g) (define (two x) (let ((y (car x))) (values y y))) (call-with-values (lambda () (two '())) list)) (mv-g)`,
    `(define (mv-h n) (define (two x) (if (= x 0) (values 0 0) (values x (* x x)))) (let-values (((a b) (two n))) (+ a b))) (list (mv-h 0) (mv-h 3))`,
];

// programs where the optimizer removes a call entirely: an error after it in the same frame reports where it is, not the
// call (in code that is not debug code, a frame's position is that of the last call it made); the frames are the same
const CALLS_REMOVED: string[] = [
    `(define (ad-after) (define (f x) (list x)) (f 1) (car '())) (ad-after)`,
    `(define (ad-fold) (define (sq x) (* x x)) (list (sq 4) (car '()))) (ad-fold)`,
];

describe("The optimizer", () => {
    const s = new ASTStringifier();
    const outcome = (src: string, optimize: boolean) => {
        const anima = createScheme({ debug: false, optimize });
        try {
            return `value ${s.stringify(anima.evaluateRaw(anima.compileRaw(src, "t.anima")))}`;
        } catch (e: any) {
            return `error ${e?.message}\n${e?.animaTraceback ?? ""}`;
        }
    };

    it("changes no program's value, error or traceback", () => {
        for (const src of PROGRAMS) expect(outcome(src, true), src).toBe(outcome(src, false));
    });

    it("keeps the frames of tracebacks where it removes calls", () => {
        const frames = (out: string) => out.replace(/\S+:\d+:\d+ in /g, "in ");
        for (const src of CALLS_REMOVED) expect(frames(outcome(src, true)), src).toBe(frames(outcome(src, false)));
    });
});
