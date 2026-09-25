import { AbstractCompiler, AbstractVM, AnimaMeta, ASP, ErrorObject, UnhandledSchemeError, packValues, RESERVED_BUILTINS, IProcedure, isDeepEqual, isTruthy, OP_BEGIN, symGen, Table } from "./common";
import { Cons } from "./list";
import { ARITHMETIC, opCons, makeList, CXR_PATHS, CXR_FNS, CXR_INLINES, PREDICATES, PREDICATE_FNS, PREDICATE_INLINES, listInline, consInline, type InlineFn } from "./ops";
import { MacroEvaluator } from "./syntransformer-v1/macro";

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
        public readonly inline?: InlineFn,
    ) {
        super(name.description || Symbol.keyFor(name));
    }
}

const vectorIndexOk = (v: string, k: string) => `Array.isArray(${v}) && Number.isInteger(${k}) && ${k} >= 0 && ${k} < ${v}.length`;

export const IBUILTINS: BuiltinFunction[] = [
    ...ARITHMETIC.map(([name, fn, inline]) => new BuiltinFunction(Symbol.for(name), fn, inline)),
    new BuiltinFunction(Symbol.for("values"), (regs, startReg, nargs) => packValues(regs.slice(startReg, startReg + nargs))),
    new BuiltinFunction(Symbol.for("eqv?"), (regs, startReg, nargs) => {
        // DEVIATION: normal scheme requires arity 2, anima extends this to arity >=1
        if (nargs === 0) throw new Error("eqv? requires at least 1 argument");
        
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
        if (nargs === 0) throw new Error("equal? requires at least 1 argument");
        
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
    new BuiltinFunction(Symbol.for("cons"), opCons, consInline),
    new BuiltinFunction(Symbol.for("list"), makeList, listInline),
    ...CXR_PATHS.map(([name], i) => new BuiltinFunction(Symbol.for(name), CXR_FNS[i], CXR_INLINES[i])),
    ...PREDICATES.map(([name], i) => new BuiltinFunction(Symbol.for(name), PREDICATE_FNS[i], PREDICATE_INLINES[i])),
    new BuiltinFunction(Symbol.for("last"), (regs, startReg, nargs) => {
        if (nargs != 1) throw new Error("last requires 1 argument");
        const val = regs[startReg];
        if (val instanceof Cons) {
            let curr: any = val;
            while (curr.cdr instanceof Cons) {
                curr = curr.cdr;
            }
            return curr.cdr === null ? curr.car : curr.cdr;
        } else if (val === null) {
            throw new Error("last requires a non-empty list");
        } else {
            throw new Error("last requires a list");
        }
    }),
    new BuiltinFunction(Symbol.for("length"), (regs, startReg, nargs) => {
        if (nargs != 1) throw new Error("length requires 1 argument");
        const val = regs[startReg];
        if (val === null) {
            return 0; // empty list
        }
        if (val instanceof Cons) {
            if (val.isCyclic()) throw new Error("length: circular list has no length");
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
        if (nargs != 2) throw new Error("member requires 2 arguments");
        const list = regs[startReg];
        const item = regs[startReg+1];
        if (list === null) {
            return false;
        }
        if (!(list instanceof Cons)) throw new Error("member? requires the first argument to be a list");
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
        if (nargs != 1) throw new Error("not requires 1 argument");
        return !isTruthy(regs[startReg]);
    }),
    new BuiltinFunction(Symbol.for("display"), (regs, startReg, nargs) => {
        if (nargs != 1) throw new Error("display requires 1 argument");
        console.log(regs[startReg])
        return undefined
    }),
    new BuiltinFunction(Symbol.for("error"), (regs, startReg, nargs) => {
        if (nargs != 1) throw new Error("");
        throw new Error(regs[startReg])
    }),
    new BuiltinFunction(Symbol.for("make-error-object"), (regs, startReg, nargs) => {
        if (nargs !== 1) throw new Error("make-error-object requires 1 argument");
        return new ErrorObject(regs[startReg]);
    }),
    new BuiltinFunction(Symbol.for("unhandled-error"), (regs, startReg, nargs) => {
        if (nargs !== 1 && nargs !== 2) throw new Error("unhandled-error requires 1 or 2 arguments");
        const val = regs[startReg];
        const err = val instanceof ErrorObject ? val.error : val;
        const traceback = nargs === 2 ? regs[startReg + 1] : undefined;
        if (err instanceof Error && traceback !== undefined && (err as any).animaTraceback === undefined) {
            (err as any).animaTraceback = traceback;
        }
        throw new UnhandledSchemeError(err, traceback);
    }),
    new BuiltinFunction(Symbol.for("error-message"), (regs, startReg, nargs) => {
        if (nargs != 1) throw new Error("error-message requires 1 argument");
        if (!(regs[startReg] instanceof ErrorObject)) throw new Error("error-message requires the first argument to be an instance of ErrorObject");
        const err = regs[startReg].error;
        if (err instanceof Error) return err.message;
        if (typeof err === "string") return err;
        return err?.message?.toString() || String(err);
    }),
    // Builtin predicates
    new BuiltinFunction(Symbol.for("contains?"), (regs, startReg, nargs) => {
        if (nargs != 2) throw new Error("contains? requires 2 arguments");
        const list = regs[startReg];
        const item = regs[startReg+1];
        if (Array.isArray(list)) return list.includes(item);
        return (list instanceof Cons) ? list.includes(item) : false;
    }),
    new BuiltinFunction(Symbol.for("gensym"), (regs, startReg, nargs) => {
        if (nargs > 1) throw new Error("gensym requires 0 or 1 arguments");
        switch (nargs) {
        case 0:
            return symGen('g')
        case 1:
            if (typeof regs[startReg] !== 'string') throw new Error("gensym requires the first argument to be a string")
            return symGen(regs[startReg])
        }
    }),
    // Vector operations
    new BuiltinFunction(Symbol.for("make-vector"), (regs, startReg, nargs) => {
        if (nargs < 1 || nargs > 2) throw new Error("make-vector requires 1 or 2 arguments");
        const len = regs[startReg];
        if (typeof len !== "number" || !Number.isInteger(len) || len < 0) {
            throw new Error("make-vector: length must be a non-negative integer");
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
        if (nargs !== 1) throw new Error("vector-length requires 1 argument");
        const vec = regs[startReg];
        if (!Array.isArray(vec)) throw new Error("vector-length requires a vector");
        return vec.length;
    }, ([v], slow) => v === undefined ? null : `(Array.isArray(${v}) ? ${v}.length : ${slow})`),
    new BuiltinFunction(Symbol.for("vector-ref"), (regs, startReg, nargs) => {
        if (nargs !== 2) throw new Error("vector-ref requires 2 arguments (vector-ref vec k)");
        const vec = regs[startReg];
        const k = regs[startReg + 1];
        if (!Array.isArray(vec)) throw new Error("vector-ref requires a vector");
        if (typeof k !== "number" || !Number.isInteger(k) || k < 0 || k >= vec.length) {
            throw new Error(`vector-ref: index ${k} out of bounds for vector of length ${vec.length}`);
        }
        return vec[k];
    }, (args, slow) => args.length !== 2 ? null : `(${vectorIndexOk(args[0], args[1])} ? ${args[0]}[${args[1]}] : ${slow})`),
    new BuiltinFunction(Symbol.for("vector-set!"), (regs, startReg, nargs) => {
        if (nargs !== 3) throw new Error("vector-set! requires 3 arguments (vector-set! vec k val)");
        const vec = regs[startReg];
        const k = regs[startReg + 1];
        const val = regs[startReg + 2];
        if (!Array.isArray(vec)) throw new Error("vector-set! requires a vector");
        if (typeof k !== "number" || !Number.isInteger(k) || k < 0 || k >= vec.length) {
            throw new Error(`vector-set!: index ${k} out of bounds for vector of length ${vec.length}`);
        }
        vec[k] = val;
        return undefined;
    }, (args, slow) => args.length !== 3 ? null : `(${vectorIndexOk(args[0], args[1])} ? (${args[0]}[${args[1]}] = ${args[2]}, undefined) : ${slow})`),
    new BuiltinFunction(Symbol.for("vector->list"), (regs, startReg, nargs) => {
        if (nargs !== 1) throw new Error("vector->list requires 1 argument");
        const vec = regs[startReg];
        if (!Array.isArray(vec)) throw new Error("vector->list requires a vector");
        return Cons.fromArray(vec);
    }),
    new BuiltinFunction(Symbol.for("list->vector"), (regs, startReg, nargs) => {
        if (nargs !== 1) throw new Error("list->vector requires 1 argument");
        const lst = regs[startReg];
        if (lst === null) return [];
        if (lst instanceof Cons && !lst.isImproper() && !lst.isCyclic()) {
            return lst.toArray();
        }
        throw new Error("list->vector requires a proper list");
    }),
    new BuiltinFunction(Symbol.for("vector-fill!"), (regs, startReg, nargs) => {
        if (nargs !== 2) throw new Error("vector-fill! requires 2 arguments (vector-fill! vec fill)");
        const vec = regs[startReg];
        const fill = regs[startReg + 1];
        if (!Array.isArray(vec)) throw new Error("vector-fill! requires a vector");
        vec.fill(fill);
        return undefined;
    }),
    new BuiltinFunction(Symbol.for("vector-copy"), (regs, startReg, nargs) => {
        if (nargs !== 1) throw new Error("vector-copy requires 1 argument");
        const vec = regs[startReg];
        if (!Array.isArray(vec)) throw new Error("vector-copy requires a vector");
        return [...vec];
    }),
    new BuiltinFunction(Symbol.for("vector-append"), (regs, startReg, nargs) => {
        const result: any[] = [];
        for (let i = 0; i < nargs; i++) {
            const vec = regs[startReg + i];
            if (!Array.isArray(vec)) throw new Error("vector-append requires all arguments to be vectors");
            for (let j = 0; j < vec.length; j++) {
                result.push(vec[j]);
            }
        }
        return result;
    }),
    // Table operations
    new BuiltinFunction(Symbol.for("table"), (regs, startReg, nargs) => {
        if (nargs % 2 !== 0) throw new Error("table requires an even number of arguments (key-value pairs)");
        const tbl = new Table();
        for (let i = 0; i < nargs; i += 2) {
            tbl.set(regs[startReg + i], regs[startReg + i + 1]);
        }
        return tbl;
    }),
    new BuiltinFunction(Symbol.for("table-ref"), (regs, startReg, nargs) => {
        if (nargs < 2 || nargs > 3) throw new Error("table-ref requires 2 or 3 arguments (table-ref tbl key [default])");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw new Error("table-ref requires a table");
        const key = regs[startReg + 1];
        if (tbl.has(key)) {
            return tbl.get(key);
        }
        if (nargs === 3) {
            return regs[startReg + 2];
        }
        throw new Error(`table-ref: key not found: ${String(key)}`);
    }),
    new BuiltinFunction(Symbol.for("table-is?"), (regs, startReg, nargs) => {
        if (nargs < 3 || nargs > 4) throw new Error("table-is? requires 3 or 4 arguments (table-is? tbl key expected [default])");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw new Error("table-is? requires a table");
        const key = regs[startReg + 1];
        const expected = regs[startReg + 2];
        let val: any;
        if (tbl.has(key)) {
            val = tbl.get(key);
        } else if (nargs === 4) {
            val = regs[startReg + 3];
        } else {
            return false;
        }
        return isDeepEqual(val, expected);
    }),
    new BuiltinFunction(Symbol.for("table-set!"), (regs, startReg, nargs) => {
        if (nargs !== 3) throw new Error("table-set! requires 3 arguments (table-set! tbl key val)");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw new Error("table-set! requires a table");
        tbl.set(regs[startReg + 1], regs[startReg + 2]);
        return undefined;
    }),
    new BuiltinFunction(Symbol.for("table-has?"), (regs, startReg, nargs) => {
        if (nargs !== 2) throw new Error("table-has? requires 2 arguments (table-has? tbl key)");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw new Error("table-has? requires a table");
        return tbl.has(regs[startReg + 1]);
    }),
    new BuiltinFunction(Symbol.for("table-delete!"), (regs, startReg, nargs) => {
        if (nargs !== 2) throw new Error("table-delete! requires 2 arguments (table-delete! tbl key)");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw new Error("table-delete! requires a table");
        return tbl.delete(regs[startReg + 1]);
    }),
    new BuiltinFunction(Symbol.for("table-clear!"), (regs, startReg, nargs) => {
        if (nargs !== 1) throw new Error("table-clear! requires 1 argument");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw new Error("table-clear! requires a table");
        tbl.clear();
        return undefined;
    }),
    new BuiltinFunction(Symbol.for("table-size"), (regs, startReg, nargs) => {
        if (nargs !== 1) throw new Error("table-size requires 1 argument");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw new Error("table-size requires a table");
        return tbl.size;
    }),
    new BuiltinFunction(Symbol.for("table-keys"), (regs, startReg, nargs) => {
        if (nargs !== 1) throw new Error("table-keys requires 1 argument");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw new Error("table-keys requires a table");
        return [...tbl.keys()];
    }),
    new BuiltinFunction(Symbol.for("table-values"), (regs, startReg, nargs) => {
        if (nargs !== 1) throw new Error("table-values requires 1 argument");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw new Error("table-values requires a table");
        return [...tbl.values()];
    }),
    new BuiltinFunction(Symbol.for("table-copy"), (regs, startReg, nargs) => {
        if (nargs !== 1) throw new Error("table-copy requires 1 argument");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw new Error("table-copy requires a table");
        return tbl.copy();
    }),
    new BuiltinFunction(Symbol.for("table-chain"), (regs, startReg, nargs) => {
        if (nargs < 1 || nargs > 2) throw new Error("table-chain requires 1 or 2 arguments (table-chain parent [frozen])");
        const parent = regs[startReg];
        if (!(parent instanceof Table)) throw new Error("table-chain requires a parent table");
        const frozen = nargs === 2 ? isTruthy(regs[startReg + 1]) : false;
        return parent.chained(frozen);
    }),
    new BuiltinFunction(Symbol.for("table-entries"), (regs, startReg, nargs) => {
        if (nargs !== 1) throw new Error("table-entries requires 1 argument");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw new Error("table-entries requires a table");
        return [...tbl.entries()];
    }),
    new BuiltinFunction(Symbol.for("table-current-entries"), (regs, startReg, nargs) => {
        if (nargs !== 1) throw new Error("table-current-entries requires 1 argument");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw new Error("table-current-entries requires a table");
        return [...tbl.currentEntries()];
    }),
    new BuiltinFunction(Symbol.for("table-freeze!"), (regs, startReg, nargs) => {
        if (nargs !== 1) throw new Error("table-freeze! requires 1 argument");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw new Error("table-freeze! requires a table");
        tbl.frozen = true;
        return tbl;
    }),
    new BuiltinFunction(Symbol.for("table-merge!"), (regs, startReg, nargs) => {
        if (nargs !== 2) throw new Error("table-merge! requires 2 arguments (table-merge! target source)");
        const target = regs[startReg];
        const source = regs[startReg + 1];
        if (!(target instanceof Table) || !(source instanceof Table)) {
            throw new Error("table-merge! requires both arguments to be tables");
        }
        for (const [k, v] of source.entries()) {
            target.set(k, v);
        }
        return target;
    }),
    new BuiltinFunction(Symbol.for("reverse"), (regs, startReg, nargs) => {
        if (nargs !== 1) throw new Error("reverse requires 1 argument");
        let lst = regs[startReg];
        if (lst instanceof Cons && lst.isCyclic()) throw new Error("reverse: circular list");
        let out: Cons | null = null;
        while (lst instanceof Cons) {
            out = new Cons(lst.car, out);
            lst = lst.cdr;
        }
        if (lst !== null) throw new Error("reverse requires a proper list");
        return out;
    }),
]

export const IBUILTINS_IDX_MAP = new Map<symbol, number>()
for(let i = 0; i < IBUILTINS.length; i++) {
    IBUILTINS_IDX_MAP.set(IBUILTINS[i].name, i)
    RESERVED_BUILTINS.add(IBUILTINS[i].name)
}

export const stdPreludeScope = () => new Table()

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

(define $dynamic-wind
    (lambda (before thunk after)
        (%dynamic-wind before thunk after)))

(define $debug-frames
    (lambda args
        (%call/cc (lambda (k) (%debug-frames k args)))))

(define $debug-traceback
    (lambda args
        (%call/cc (lambda (k) (%debug-traceback k args)))))

(let ((raise-proc #f)
      (with-ex-handler-proc #f)
      (raise-cont-proc #f)
      (try-proc #f))
    (set! raise-proc
        (lambda (obj)
            (let ((hs (%handlers)))
                (if (null? hs)
                    (%call/cc (lambda (k) (unhandled-error obj (%debug-traceback k (list obj)))))
                    (begin
                        (%set-handlers! (cdr hs))
                        ((car hs) obj)
                        (raise-proc (make-error-object "handler returned on non-continuable exception")))))))

    (set! with-ex-handler-proc
        (lambda (handler thunk)
            (let ((saved '()))
                (%dynamic-wind
                    (lambda ()
                        (set! saved (%handlers))
                        (%set-handlers! (cons handler saved)))
                    thunk
                    (lambda ()
                        (%set-handlers! saved))))))

    (set! raise-cont-proc
        (lambda (obj)
            (let ((hs (%handlers)))
                (if (null? hs)
                    (%call/cc (lambda (k) (unhandled-error obj (%debug-traceback k (list obj)))))
                    (%dynamic-wind
                        (lambda () (%set-handlers! (cdr hs)))
                        (lambda () ((car hs) obj))
                        (lambda () (%set-handlers! hs)))))))

    (set! try-proc
        (lambda (thunk catch-proc)
            (%call/cc
                (lambda (k)
                    (with-ex-handler-proc
                        (lambda (err) (k (catch-proc err)))
                        thunk)))))

    (%define-global $raise raise-proc)
    (%define-global $with-exception-handler with-ex-handler-proc)
    (%define-global $raise-continuable raise-cont-proc)
    (%define-global $try try-proc)
    (%define-global $try-catch try-proc)

    (%set-raise-proc raise-proc))
`

export class Bootstrapper {
    #bootstrappedPreludes: Map<string, Table> = new Map()

    /** Set up the public scope for the given vm and compiler instance */
    setupPublicScope(impl: AnimaMeta, cmp: AbstractCompiler, vm: AbstractVM, evaluator: MacroEvaluator) {
        if (this.#bootstrappedPreludes.has(impl.id)) {
            return this.#bootstrappedPreludes.get(impl.id)!
        }
        const preludeAst = new ASP(STD_PRELUDE, true, "<prelude>").parse()
        const transformExpr = evaluator.transform(preludeAst)
        // the prelude is never debug code, so its internals stay out of tracebacks' tail history
        const PRELUDE_BC = cmp.compile(transformExpr, false)

        const privScope = stdPreludeScope()
        vm.evaluateRaw(PRELUDE_BC, privScope)

        /* Base scope */
        const publicScope = new Table(); 
        const named = new Set<IProcedure>()
        for (const [sym, value] of privScope.entries()) {
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