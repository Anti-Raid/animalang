import { AbstractByteCode, AbstractCompiler, AbstractVM, AnimaMeta, ASP, ErrorObject, packValues, RESERVED_BUILTINS, IProcedure, isDeepEqual, isTruthy, OP_BEGIN, symGen, Table, Env } from "./common";
import { Cons } from "./list";
import { ARITHMETIC, opCons, makeList, CXR_PATHS, CXR_FNS, PREDICATES, PREDICATE_FNS } from "./ops";
import { MacroEvaluator } from "./syntransformer-v1/macro";
import { hostError } from "./errors";

/** 
 * A builtin function. 
 * 
 * Builtin functions do not have access to their own lexical scope (at least not yet) 
 * 
 * It is undefined behaviour for a builtin function to modify regs (reg's are considered readonly). Additionally, the intermediate
 * state of any BuiltinFunction must be well-defined/valid 
*/
export class BuiltinFunction extends IProcedure {
    constructor(
        public name: symbol,
        public cb: (regs: readonly any[], startReg: number, nargs: number) => any,
    ) {
        super(name.description || Symbol.keyFor(name));
    }
}

const MISSING_KEY = Symbol("missing key");

export const IBUILTINS: BuiltinFunction[] = [
    ...ARITHMETIC.map(([name, fn]) => new BuiltinFunction(Symbol.for(name), fn)),
    new BuiltinFunction(Symbol.for("values"), (regs, startReg, nargs) => packValues(regs.slice(startReg, startReg + nargs))),
    new BuiltinFunction(Symbol.for("eqv?"), (regs, startReg, nargs) => {
        // DEVIATION: normal scheme requires arity 2, anima extends this to arity >=1
        if (nargs === 0) throw hostError("eqv? requires at least 1 argument");
        
        let start = regs[startReg];
        let res = true
        for (let i = startReg+1; i < startReg+nargs; i++) {
            const val = regs[i]
            if (!Object.is(val, start)) {
                res = false
                break
            }
        }
        return res
    }),
    new BuiltinFunction(Symbol.for("equal?"), (regs, startReg, nargs) => {
        if (nargs === 0) throw hostError("equal? requires at least 1 argument");
        
        let start = regs[startReg];
        let res = true
        for (let i = startReg+1; i < startReg+nargs; i++) {
            const val = regs[i]
            if (!isDeepEqual(val, start)) {
                res = false
                break
            }
        }
        return res
    }),
    // list builtins
    new BuiltinFunction(Symbol.for("cons"), opCons),
    new BuiltinFunction(Symbol.for("list"), makeList),
    ...CXR_PATHS.map(([name], i) => new BuiltinFunction(Symbol.for(name), CXR_FNS[i])),
    ...PREDICATES.map(([name], i) => new BuiltinFunction(Symbol.for(name), PREDICATE_FNS[i])),
    new BuiltinFunction(Symbol.for("last"), (regs, startReg, nargs) => {
        if (nargs != 1) throw hostError("last requires 1 argument");
        const val = regs[startReg];
        if (val instanceof Cons) {
            let curr: any = val;
            while (curr.cdr instanceof Cons) {
                curr = curr.cdr;
            }
            return curr.cdr === null ? curr.car : curr.cdr;
        } else if (val === null) {
            throw hostError("last requires a non-empty list");
        } else {
            throw hostError("last requires a list");
        }
    }),
    new BuiltinFunction(Symbol.for("length"), (regs, startReg, nargs) => {
        if (nargs != 1) throw hostError("length requires 1 argument");
        const val = regs[startReg];
        if (val === null) {
            return 0; // empty list
        }
        if (val instanceof Cons) {
            if (val.isCyclic()) throw hostError("length: circular list has no length");
            if (val.isImproper()) {
                return val.toArray().length;
            }
            return val.length;
        }
        if (typeof val === "string") {
            return val.length;
        }
        return 0;
    }),
    new BuiltinFunction(Symbol.for("member"), (regs, startReg, nargs) => {
        if (nargs != 2) throw hostError("member requires 2 arguments");
        const list = regs[startReg];
        const item = regs[startReg+1];
        if (list === null) {
            return false;
        }
        if (!(list instanceof Cons)) throw hostError("member? requires the first argument to be a list");
        let s: any = list;
        while (s instanceof Cons) {
            if (isDeepEqual(s.car, item)) {
                return s;
            }
            s = s.cdr;
        }
        return false;
    }),
    new BuiltinFunction(Symbol.for("not"), (regs, startReg, nargs) => {
        if (nargs != 1) throw hostError("not requires 1 argument");
        return !isTruthy(regs[startReg]);
    }),
    new BuiltinFunction(Symbol.for("display"), (regs, startReg, nargs) => {
        if (nargs != 1) throw hostError("display requires 1 argument");
        console.log(regs[startReg])
        return undefined
    }),
    new BuiltinFunction(Symbol.for("error"), (regs, startReg, nargs) => {
        if (nargs != 1) throw hostError("");
        throw hostError(regs[startReg])
    }),
    new BuiltinFunction(Symbol.for("make-error-object"), (regs, startReg, nargs) => {
        if (nargs !== 1) throw hostError("make-error-object requires 1 argument");
        return new ErrorObject(regs[startReg]);
    }),
    new BuiltinFunction(Symbol.for("error-message"), (regs, startReg, nargs) => {
        if (nargs != 1) throw hostError("error-message requires 1 argument");
        if (!(regs[startReg] instanceof ErrorObject)) throw hostError("error-message requires the first argument to be an instance of ErrorObject");
        const err = regs[startReg].error;
        if (err instanceof Error) return err.message;
        if (typeof err === "string") return err;
        return err?.message?.toString() || String(err);
    }),
    // Builtin predicates
    new BuiltinFunction(Symbol.for("contains?"), (regs, startReg, nargs) => {
        if (nargs != 2) throw hostError("contains? requires 2 arguments");
        const list = regs[startReg];
        const item = regs[startReg+1];
        if (Array.isArray(list)) return list.includes(item);
        return (list instanceof Cons) ? list.includes(item) : false;
    }),
    new BuiltinFunction(Symbol.for("gensym"), (regs, startReg, nargs) => {
        if (nargs > 1) throw hostError("gensym requires 0 or 1 arguments");
        switch (nargs) {
        case 0:
            return symGen('g')
        case 1:
            if (typeof regs[startReg] !== 'string') throw hostError("gensym requires the first argument to be a string")
            return symGen(regs[startReg])
        }
    }),
    // Vector operations
    new BuiltinFunction(Symbol.for("make-vector"), (regs, startReg, nargs) => {
        if (nargs < 1 || nargs > 2) throw hostError("make-vector requires 1 or 2 arguments");
        const len = regs[startReg];
        if (typeof len !== "number" || !Number.isInteger(len) || len < 0) {
            throw hostError("make-vector: length must be a non-negative integer");
        }
        const fill = nargs === 2 ? regs[startReg + 1] : 0;
        const vec = new Array(len);
        vec.fill(fill);
        return vec;
    }),
    new BuiltinFunction(Symbol.for("vector"), (regs, startReg, nargs) => {
        const vec = new Array(nargs);
        for (let i = 0; i < nargs; i++) {
            vec[i] = regs[startReg + i];
        }
        return vec;
    }),
    new BuiltinFunction(Symbol.for("vector-length"), (regs, startReg, nargs) => {
        if (nargs !== 1) throw hostError("vector-length requires 1 argument");
        const vec = regs[startReg];
        if (!Array.isArray(vec)) throw hostError("vector-length requires a vector");
        return vec.length;
    }),
    new BuiltinFunction(Symbol.for("vector-ref"), (regs, startReg, nargs) => {
        if (nargs !== 2) throw hostError("vector-ref requires 2 arguments (vector-ref vec k)");
        const vec = regs[startReg];
        const k = regs[startReg + 1];
        if (!Array.isArray(vec)) throw hostError("vector-ref requires a vector");
        if (typeof k !== "number" || !Number.isInteger(k) || k < 0 || k >= vec.length) {
            throw hostError(`vector-ref: index ${k} out of bounds for vector of length ${vec.length}`);
        }
        return vec[k];
    }),
    new BuiltinFunction(Symbol.for("vector-set!"), (regs, startReg, nargs) => {
        if (nargs !== 3) throw hostError("vector-set! requires 3 arguments (vector-set! vec k val)");
        const vec = regs[startReg];
        const k = regs[startReg + 1];
        const val = regs[startReg + 2];
        if (!Array.isArray(vec)) throw hostError("vector-set! requires a vector");
        if (typeof k !== "number" || !Number.isInteger(k) || k < 0 || k >= vec.length) {
            throw hostError(`vector-set!: index ${k} out of bounds for vector of length ${vec.length}`);
        }
        vec[k] = val;
        return undefined;
    }),
    new BuiltinFunction(Symbol.for("vector->list"), (regs, startReg, nargs) => {
        if (nargs !== 1) throw hostError("vector->list requires 1 argument");
        const vec = regs[startReg];
        if (!Array.isArray(vec)) throw hostError("vector->list requires a vector");
        return Cons.fromArray(vec);
    }),
    new BuiltinFunction(Symbol.for("list->vector"), (regs, startReg, nargs) => {
        if (nargs !== 1) throw hostError("list->vector requires 1 argument");
        const lst = regs[startReg];
        if (lst === null) return [];
        if (lst instanceof Cons && !lst.isImproper() && !lst.isCyclic()) {
            return lst.toArray();
        }
        throw hostError("list->vector requires a proper list");
    }),
    new BuiltinFunction(Symbol.for("vector-fill!"), (regs, startReg, nargs) => {
        if (nargs !== 2) throw hostError("vector-fill! requires 2 arguments (vector-fill! vec fill)");
        const vec = regs[startReg];
        const fill = regs[startReg + 1];
        if (!Array.isArray(vec)) throw hostError("vector-fill! requires a vector");
        vec.fill(fill);
        return undefined;
    }),
    new BuiltinFunction(Symbol.for("vector-copy"), (regs, startReg, nargs) => {
        if (nargs !== 1) throw hostError("vector-copy requires 1 argument");
        const vec = regs[startReg];
        if (!Array.isArray(vec)) throw hostError("vector-copy requires a vector");
        return [...vec];
    }),
    new BuiltinFunction(Symbol.for("vector-append"), (regs, startReg, nargs) => {
        const result: any[] = [];
        for (let i = 0; i < nargs; i++) {
            const vec = regs[startReg + i];
            if (!Array.isArray(vec)) throw hostError("vector-append requires all arguments to be vectors");
            for (let j = 0; j < vec.length; j++) {
                result.push(vec[j]);
            }
        }
        return result;
    }),
    // Table operations
    new BuiltinFunction(Symbol.for("table"), (regs, startReg, nargs) => {
        if (nargs % 2 !== 0) throw hostError("table requires an even number of arguments (key-value pairs)");
        const tbl = new Table();
        for (let i = 0; i < nargs; i += 2) {
            tbl.set(regs[startReg + i], regs[startReg + i + 1]);
        }
        return tbl;
    }),
    new BuiltinFunction(Symbol.for("table-ref"), (regs, startReg, nargs) => {
        if (nargs < 2 || nargs > 3) throw hostError("table-ref requires 2 or 3 arguments (table-ref tbl key [default])");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw hostError("table-ref requires a table");
        const key = regs[startReg + 1];
        const val = tbl.lookup(key, MISSING_KEY);
        if (val !== MISSING_KEY) return val;
        if (nargs === 3) {
            return regs[startReg + 2];
        }
        throw hostError(`table-ref: key not found: ${String(key)}`);
    }),
    new BuiltinFunction(Symbol.for("table-is?"), (regs, startReg, nargs) => {
        if (nargs < 3 || nargs > 4) throw hostError("table-is? requires 3 or 4 arguments (table-is? tbl key expected [default])");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw hostError("table-is? requires a table");
        const key = regs[startReg + 1];
        const expected = regs[startReg + 2];
        let val = tbl.lookup(key, MISSING_KEY);
        if (val === MISSING_KEY) {
            if (nargs !== 4) return false;
            val = regs[startReg + 3];
        }
        return isDeepEqual(val, expected);
    }),
    new BuiltinFunction(Symbol.for("table-set!"), (regs, startReg, nargs) => {
        if (nargs !== 3) throw hostError("table-set! requires 3 arguments (table-set! tbl key val)");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw hostError("table-set! requires a table");
        tbl.set(regs[startReg + 1], regs[startReg + 2]);
        return undefined;
    }),
    new BuiltinFunction(Symbol.for("table-has?"), (regs, startReg, nargs) => {
        if (nargs !== 2) throw hostError("table-has? requires 2 arguments (table-has? tbl key)");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw hostError("table-has? requires a table");
        return tbl.has(regs[startReg + 1]);
    }),
    new BuiltinFunction(Symbol.for("table-delete!"), (regs, startReg, nargs) => {
        if (nargs !== 2) throw hostError("table-delete! requires 2 arguments (table-delete! tbl key)");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw hostError("table-delete! requires a table");
        return tbl.delete(regs[startReg + 1]);
    }),
    new BuiltinFunction(Symbol.for("table-clear!"), (regs, startReg, nargs) => {
        if (nargs !== 1) throw hostError("table-clear! requires 1 argument");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw hostError("table-clear! requires a table");
        tbl.clear();
        return undefined;
    }),
    new BuiltinFunction(Symbol.for("table-size"), (regs, startReg, nargs) => {
        if (nargs !== 1) throw hostError("table-size requires 1 argument");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw hostError("table-size requires a table");
        return tbl.size;
    }),
    new BuiltinFunction(Symbol.for("table-keys"), (regs, startReg, nargs) => {
        if (nargs !== 1) throw hostError("table-keys requires 1 argument");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw hostError("table-keys requires a table");
        return [...tbl.keys()];
    }),
    new BuiltinFunction(Symbol.for("table-values"), (regs, startReg, nargs) => {
        if (nargs !== 1) throw hostError("table-values requires 1 argument");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw hostError("table-values requires a table");
        return [...tbl.values()];
    }),
    new BuiltinFunction(Symbol.for("table-copy"), (regs, startReg, nargs) => {
        if (nargs !== 1) throw hostError("table-copy requires 1 argument");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw hostError("table-copy requires a table");
        return tbl.copy();
    }),
    new BuiltinFunction(Symbol.for("table-entries"), (regs, startReg, nargs) => {
        if (nargs !== 1) throw hostError("table-entries requires 1 argument");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw hostError("table-entries requires a table");
        return [...tbl.entries()];
    }),
    new BuiltinFunction(Symbol.for("table-freeze!"), (regs, startReg, nargs) => {
        if (nargs !== 1) throw hostError("table-freeze! requires 1 argument");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw hostError("table-freeze! requires a table");
        tbl.frozen = true;
        return tbl;
    }),
    new BuiltinFunction(Symbol.for("table-merge!"), (regs, startReg, nargs) => {
        if (nargs !== 2) throw hostError("table-merge! requires 2 arguments (table-merge! target source)");
        const target = regs[startReg];
        const source = regs[startReg + 1];
        if (!(target instanceof Table) || !(source instanceof Table)) {
            throw hostError("table-merge! requires both arguments to be tables");
        }
        for (const [k, v] of source.entries()) {
            target.set(k, v);
        }
        return target;
    }),
    new BuiltinFunction(Symbol.for("table-border"), (regs, startReg, nargs) => {
        if (nargs !== 1) throw hostError("table-border requires 1 argument");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw hostError("table-border requires a table");
        return tbl.border();
    }),
    new BuiltinFunction(Symbol.for("reverse"), (regs, startReg, nargs) => {
        if (nargs !== 1) throw hostError("reverse requires 1 argument");
        let lst = regs[startReg];
        if (lst instanceof Cons && lst.isCyclic()) throw hostError("reverse: circular list");
        let out: Cons | null = null;
        while (lst instanceof Cons) {
            out = new Cons(lst.car, out);
            lst = lst.cdr;
        }
        if (lst !== null) throw hostError("reverse requires a proper list");
        return out;
    }),
]

export const IBUILTINS_IDX_MAP = new Map<symbol, number>()
for(let i = 0; i < IBUILTINS.length; i++) {
    IBUILTINS_IDX_MAP.set(IBUILTINS[i].name, i)
    RESERVED_BUILTINS.add(IBUILTINS[i].name)
}

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
const PRELUDE_CODE = new Map<string, AbstractByteCode>()

export class Bootstrapper {
    #bootstrappedPreludes: Map<string, Env> = new Map()

    /** Set up the public scope for the given vm and compiler instance */
    setupPublicScope(impl: AnimaMeta, cmp: AbstractCompiler, vm: AbstractVM, evaluator: MacroEvaluator) {
        if (this.#bootstrappedPreludes.has(impl.id)) {
            return this.#bootstrappedPreludes.get(impl.id)!
        }
        let PRELUDE_BC = PRELUDE_CODE.get(impl.id)
        if (PRELUDE_BC === undefined) {
            const preludeAst = new ASP(STD_PRELUDE, true, "<prelude>").parse()
            // the prelude is never debug code, so its internals stay out of tracebacks' tail history
            PRELUDE_BC = cmp.compile(evaluator.transform(preludeAst), false)
            PRELUDE_CODE.set(impl.id, PRELUDE_BC)
        }

        const privScope = stdPreludeScope()
        vm.evaluateRaw(PRELUDE_BC.fresh?.() ?? PRELUDE_BC, privScope)

        /* Base scope */
        const publicScope = new Env();
        const named = new Set<IProcedure>()
        for (const [sym, value] of privScope.ownEntries()) {
            const symName = Symbol.keyFor(sym) || sym.description || "%Unknown";
        
            // If the func starts with a $, its public
            if (symName.startsWith("$")) {
                const publicSym = Symbol.for(symName.replace('$', ''));
                if (value instanceof IProcedure && !(value instanceof BuiltinFunction) && !named.has(value)) {
                    value.debugName = publicSym.description
                    named.add(value)
                }
                publicScope.set(publicSym, value);
                RESERVED_BUILTINS.add(publicSym);
            }
        }

        // finally, export the builtins
        for(const builtin of IBUILTINS) {
            publicScope.set(builtin.name, builtin)
        }

        publicScope.frozen = true;

        this.#bootstrappedPreludes.set(impl.id, publicScope)
        return publicScope
    }
}