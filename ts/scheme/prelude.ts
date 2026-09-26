import { AbstractByteCode, AbstractCompiler, AbstractVM, IProcedure, Env } from "../common";
import type { Intrinsics } from "../bytecode-rvm/intrinsics";
import { ASP } from "./reader";
import { BUILTIN_WRAPPERS } from "./intrinsics";
import { schemeBase } from "./base";
import type { MacroEvaluator } from "./transformer/macro";

export const stdPreludeScope = () => new Env()

export const STD_PRELUDE = `
(define $coroutine-create (lambda (proc) (%coroutine-create proc)))
(define $coroutine-resume (lambda (co . vals) (%coroutine-resume-list co vals)))
(define $coroutine-yield (lambda vals (%coroutine-yield-list vals)))
(define $call-with-values (lambda (producer consumer) (apply consumer (%values->list (producer)))))
(define $coroutine-status (lambda (co) (%coroutine-status co)))
(define $coroutine-close (lambda (co) (%coroutine-close co)))


(let ((apply-proc #f)
      (map-proc #f))
    (set! apply-proc
        (lambda (proc . lst)
            (%apply-multi proc lst)))

    (set! map-proc
        (lambda (f list1 . more)
            (if (null? more)
                (let loop ((lst list1))
                    (if (null? lst)
                        '()
                        (cons (f (car lst)) (loop (cdr lst)))))
                (let loop ((lists (cons list1 more)))
                    (let check ((lsts lists))
                        (if (null? lsts)
                            (cons (apply-proc f (let get-cars ((lsts lists))
                                                  (if (null? lsts)
                                                      '()
                                                      (cons (car (car lsts)) (get-cars (cdr lsts))))))
                                  (loop (let get-cdrs ((lsts lists))
                                          (if (null? lsts)
                                              '()
                                              (cons (cdr (car lsts)) (get-cdrs (cdr lsts)))))))
                            (if (null? (car lsts))
                                '()
                                (check (cdr lsts)))))))))

    (%define-global $apply apply-proc)
    (%define-global $map map-proc))

(define $call/cc
    (lambda (proc)
        (%call/cc proc)))

(define $call-with-current-continuation $call/cc)

(define $call/ec
    (lambda (proc)
        (%call/ec proc)))

(define $call-with-escape-continuation $call/ec)

(define $dynamic-wind
    (lambda (before thunk after)
        (%dynamic-wind before thunk after)))

(define $current-continuation-marks
    (lambda () (%current-marks)))

(define $continuation-mark-set-first
    (lambda (set key . none)
        (%marks-first (if set set (%current-marks)) key (if (null? none) #f (car none)))))

(define $continuation-mark-set->list
    (lambda (set key) (%marks->list set key)))

(define $debug-frames
    (lambda args
        (%debug-frames (%current-stack 1) args)))

(define $debug-traceback
    (lambda args
        (%debug-traceback (%current-stack 1) args)))

; raising and catching are core forms (%raise, %catch) the VM delivers; handlers are a continuation mark under
; (%handler-key): a list, innermost first, of handler procedures and catch tokens
(%define-global $raise (lambda (obj) (%raise obj)))
(%define-global $raise-continuable (lambda (obj) (%raise obj #t)))
(%define-global $with-exception-handler
    (lambda (handler thunk)
        (with-continuation-mark (%handler-key) (cons handler (continuation-mark-set-first #f (%handler-key) '()))
            (thunk))))
(%define-global $try (lambda (thunk catch-proc) (%catch thunk catch-proc)))
(%define-global $try-catch $try)
(%define-global $pcall (lambda (f . args) (%catch (lambda () (%values-cons #t (apply f args))) (lambda (e) (values #f e)))))
`

// compiled once per implementation; each VM runs its own copy, with its own adaptive state, whose AOT code is built from
// source generated once
// compiled once, for every implementation (the prelude is never debug code, and AOT code is built from bytecode later, per
// VM), and bound to the frozen Scheme base table, so the cache holds no instance's intrinsics; each instance runs its own
// copy, bound by name, sharing the closures that call the same intrinsics through its table (every builtin's wrapper)
let PRELUDE_CODE: AbstractByteCode | null = null

// Runs the prelude with `vm` and returns the scope of its $ exports (under their public names), which the instance's
// code cannot rebind
export const loadPrelude = (cmp: AbstractCompiler, vm: AbstractVM, evaluator: MacroEvaluator, intrinsics: Intrinsics): Env => {
    if (PRELUDE_CODE === null) {
        const preludeAst = new ASP(`${BUILTIN_WRAPPERS}\n${STD_PRELUDE}`, true, "<prelude>").parse()
        const compiled = cmp.compile(evaluator.transform(preludeAst), false)
        PRELUDE_CODE = compiled.fresh?.(new Map(), schemeBase()) ?? compiled
    }

    const privScope = stdPreludeScope()
    vm.evaluateRaw(PRELUDE_CODE.fresh?.(new Map(), intrinsics) ?? PRELUDE_CODE, privScope)

    const publicScope = new Env();
    const named = new Set<IProcedure>()
    for (const [sym, value] of privScope.ownEntries()) {
        const symName = Symbol.keyFor(sym) || sym.description || "%Unknown";
        // If the func starts with a $, its public
        if (symName.startsWith("$")) {
            const publicSym = Symbol.for(symName.replace('$', ''));
            if (value instanceof IProcedure && !named.has(value)) {
                value.debugName = publicSym.description
                named.add(value)
            }
            publicScope.set(publicSym, value);
            intrinsics.reserved.set(publicSym, "builtin");
        }
    }
    publicScope.frozen = true;
    return publicScope
}
