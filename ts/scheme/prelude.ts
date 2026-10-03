import { IProcedure, Env } from "../common";
import { TWINNED } from "./transformer/syntax";
import type { Compiler } from "../magicvm/compiler";
import type { AnimaVM } from "../magicvm/vm";
import type { Code } from "../magicvm/exec";
import type { Intrinsics } from "../magicvm/intrinsics";
import { readNative, transformNative } from "../native";
import { schemeDatum } from "./core";
import { ALIAS_WRAPPERS } from "./builtins";
import { schemeBase } from "./base";

export const stdPreludeScope = () => new Env()

// in native-scheme (see native/README.md): calls are written out, (%call f x) and (%intcall %name x), so what each one
// calls is plain; Scheme's own procedures are the intrinsics they alias
export const STD_PRELUDE = `
(define-global $coroutine-resume (lambda (co . vals) (%intcall %coroutine-resume-array co (%intcall %spread vals))))
(define-global $coroutine-yield (lambda vals (%intcall %coroutine-yield (%intapply %values (%intcall %spread vals)))))
(define-global $call-with-values (lambda (producer consumer) (%apply consumer (%intcall %values->array (%call producer)))))

(define-global ($apply proc . lst)
    (%apply proc (%intapply %apply-args (%intcall %spread lst))))

;; iterative, so long lists need no deep recursion; the result is built reversed, then copied in order (reversing it in
;; place would change a list a continuation captured inside f still holds)
(define-global ($map f list1 . more)
    (%if (%intcall %null? more)
        (let loop ((lst list1) (acc '()))
            (%if (%intcall %null? lst)
                (%intcall %reverse acc)
                (%call loop (%intcall %cdr lst) (%intcall %cons (%call f (%intcall %car lst)) acc))))
        (let loop ((lists (%intcall %cons list1 more)) (acc '()))
            (let ((cars (%intcall %map-cars lists)))
                (%if cars
                    (%call loop (%intcall %map-cdrs lists) (%intcall %cons (%apply f cars) acc))
                    (%intcall %reverse acc))))))

(define-global ($for-each f list1 . more)
    (%if (%intcall %null? more)
        (let loop ((lst list1))
            (unless (%intcall %null? lst)
                (%call f (%intcall %car lst))
                (%call loop (%intcall %cdr lst))))
        (let loop ((lists (%intcall %cons list1 more)))
            (let ((cars (%intcall %map-cars lists)))
                (when cars
                    (%apply f cars)
                    (%call loop (%intcall %map-cdrs lists)))))))

(define-global ($filter pred lst)
    (let loop ((lst lst) (acc '()))
        (%if (%intcall %null? lst)
            (%intcall %reverse acc)
            (%call loop (%intcall %cdr lst) (%if (%call pred (%intcall %car lst)) (%intcall %cons (%intcall %car lst) acc) acc)))))

(define-global $current-continuation-marks
    (lambda () (%current-marks)))

(define-global $continuation-mark-set-first
    (lambda (set key . none)
        (%intcall %marks-first (%if set set (%current-marks)) key (%if (%intcall %null? none) #f (%intcall %car none)))))

(define-global $continuation-mark-set->list
    (lambda (set key) (%intcall %vector->list (%intcall %marks->array set key))))

(define-global $current-coroutine
    (lambda () (%intcall %current-coroutine #f)))

(define-global $debug-frames
    (lambda args
        (%intcall %vector->list (%intcall %debug-frames (%intcall %current-stack 1) (%intcall %list->vector args) #f))))

(define-global $debug-traceback
    (lambda args
        (%intcall %debug-traceback (%intcall %current-stack 1) (%intcall %list->vector args))))

; raising and catching are core forms (%raise, %catch) the VM delivers; handlers are a continuation mark under
; (%handler-key): handler procedures and catch tokens, innermost first
(define-global $raise-continuable (lambda (obj) (%intcall %raise obj #t)))
(define-global $with-exception-handler
    (lambda (handler thunk)
        (%with-mark (%intcall %handler-key) (%intcall %push-handler handler (%intcall %marks-first (%current-marks) (%intcall %handler-key) '()))
            (%call thunk))))
(define-global $try (lambda (thunk catch-proc) (%catch thunk catch-proc)))
(define-global $try-catch $try)
;; R7RS promises: forcing a delay-force chain replaces each promise's state with the next one's (sharing its box), so
;; the chain is forced in a loop, in constant space
(define-global ($force p)
    (%if (%intcall %promise? p)
        (let loop ()
            (%if (%intcall %promise-done? p)
                (%intcall %promise-value p)
                (let ((next (%call (%intcall %promise-value p))))
                    (unless (%intcall %promise-done? p) (%intcall %promise-update! next p))
                    (%call loop))))
        p))

;; R7RS parameters: a parameter's value is a continuation mark under its key (parameterize sets it), else its initial
;; value; the converter applies to both
(define-global ($make-parameter value . converter)
    (let* ((convert (%if (%intcall %null? converter) #f (%intcall %car converter)))
           (key (%intcall %parameter-key-new convert))
           (init (%if convert (%call convert value) value)))
        (%intcall %parameter-bind! (lambda () (%intcall %marks-first (%current-marks) key init)) key)))

;; the thunk runs under the barrier, not in tail position, so its continuation is inside it
(define-global ($call-with-continuation-barrier thunk)
    (%intapply %values (%intcall %values->array (%with-mark (%intcall %barrier-key) (%intcall %vector) (%call thunk)))))

;; Racket's delimited continuations over the VM's prompts (%call-with-prompt, %call/comp, %abort). A prompt's default
;; handler takes a thunk and calls it in tail position
(define-global ($call-with-continuation-prompt proc . rest)
    (let* ((tag (%if (%intcall %null? rest) (%intcall %default-continuation-prompt-tag) (%intcall %car rest)))
           (more (%if (%intcall %null? rest) '() (%intcall %cdr rest)))
           (handler (%if (or (%intcall %null? more) (%intcall %not (%intcall %car more))) (lambda (thunk) (%call thunk)) (%intcall %car more)))
           (args (%if (%intcall %null? more) '() (%intcall %cdr more))))
        (%intcall %call-with-prompt tag (lambda () (%apply proc (%intcall %spread args))) handler)))

(define-global ($abort-current-continuation tag . vals)
    (%intcall %abort tag (%intcall %spread vals)))

(define-global ($call-with-composable-continuation proc . tag)
    (%intcall %call/comp proc (%if (%intcall %null? tag) (%intcall %default-continuation-prompt-tag) (%intcall %car tag))))

(define-global $pcall (lambda (f . args) (%catch (lambda () (%intcall %values-cons #t (%apply f (%intcall %spread args)))) (lambda (e) (%intcall %values #f e)))))
`

// compiled once, for every instance (the prelude is never debug code, and its JS is generated later, per VM), and bound to the frozen Scheme base table, so the cache holds no instance's intrinsics; each instance runs its own
// copy, bound by name, sharing the closures that call the same intrinsics through its table (every builtin's wrapper)
let PRELUDE_CODE: Code | null = null
// the prelude's procedures, as core forms, the optimizer may inline (see Intrinsics.defineKnown): the public name of each,
// and its %lambda
let KNOWN: [string, any][] = []

const CORE_BEGIN = Symbol.for("%begin"), CORE_LAMBDA = Symbol.for("%lambda"), DEFINE_GLOBAL = Symbol.for("%define-global")
const knownIn = (core: any): [string, any][] => {
    if (!Array.isArray(core)) return []
    if (core[0] === CORE_BEGIN) return core.slice(1).flatMap(knownIn)
    const name: string | undefined = core[0] === DEFINE_GLOBAL && typeof core[1] === "symbol" ? core[1].description : undefined
    const value = core[2]
    return name?.startsWith("$") && Array.isArray(value) && value[0] === CORE_LAMBDA && value.length === 2 ? [[name.slice(1), value]] : []
}

// Runs the prelude with `vm` and returns the scope of its $ exports (under their public names), which the instance's
// code cannot rebind
export const loadPrelude = (cmp: Compiler, vm: AnimaVM, intrinsics: Intrinsics): Env => {
    if (PRELUDE_CODE === null) {
        const core = transformNative(readNative(`${ALIAS_WRAPPERS}\n${STD_PRELUDE}`, "<prelude>", { datum: schemeDatum }))
        KNOWN = knownIn(core)
        const compiled = cmp.compile(core, false)
        PRELUDE_CODE = compiled.fresh(new Map(), schemeBase())
    }

    for (const [name, lambda] of KNOWN) {
        intrinsics.defineKnown(Symbol.for(name), lambda, name)
        if (TWINNED.has(name)) intrinsics.defineKnown(Symbol.for(`@${name}`), lambda, name)
    }

    const privScope = stdPreludeScope()
    vm.evaluateRaw(PRELUDE_CODE.fresh(new Map(), intrinsics), privScope)

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
            // what the transformer emits refers to it by this, which code cannot bind or redefine
            if (TWINNED.has(publicSym.description!)) {
                const twin = Symbol.for(`@${publicSym.description}`);
                publicScope.set(twin, value);
                intrinsics.reserved.set(twin, "builtin");
            }
        }
    }
    publicScope.frozen = true;
    return publicScope
}
