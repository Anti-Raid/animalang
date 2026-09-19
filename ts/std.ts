import { AbstractCompiler, AbstractVM, AnimaMeta, ASP, ErrorObject, ExposedProps, Globals, IProcedure, isDeepEqual, isTruthy, OP_BEGIN, symGen } from "./common";
import { Cons } from "./list";
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
    ) {
        super()
    }
}

// Marker for `apply` intrinsic proc
export class ApplyProc extends IProcedure {
    public name = Symbol.for("apply")
}
// Marker for `try` intrinsic proc
export class TryProc extends IProcedure {
    public name = Symbol.for("try")
}
// Marker for `call/cc` intrinsic proc
export class CallCCProc extends IProcedure {
    public name = Symbol.for("call/cc")
}

// Stores all of our builtin funcs
export const IBUILTINS: (BuiltinFunction | ApplyProc | TryProc | CallCCProc)[] = [
    new BuiltinFunction(Symbol.for("+"), (regs, startReg, nargs) => {
        let acc = 0; 
        for (let i = startReg; i < startReg+nargs; i++) {
            const val = regs[i]
            if (typeof val !== "number") throw new Error(`+ requires numbers, but received ${typeof val}`);
            acc += val
        }
        return acc
    }),
    new BuiltinFunction(Symbol.for("-"), (regs, startReg, nargs) => {
        if (nargs === 0) throw new Error("- requires at least 1 argument");
        
        if (nargs === 1) {
            const val = regs[startReg];
            if (typeof val !== "number") throw new Error(`- requires numbers, but received ${typeof val}`);
            return -val; 
        }

        let acc = regs[startReg];
        if (typeof acc !== "number") throw new Error(`- requires numbers, but received ${typeof acc}`);
        for (let i = startReg + 1; i < startReg+nargs; i++) {
            const val = regs[i]
            if (typeof val !== "number") throw new Error(`- requires numbers, but received ${typeof val}`);
            acc -= val
        }
        return acc
    }),
    new BuiltinFunction(Symbol.for("*"), (regs, startReg, nargs) => {
        let acc = 1; 
        for (let i = startReg; i < startReg+nargs; i++) {
            const val = regs[i]
            if (typeof val !== "number") throw new Error(`* requires numbers, but received ${typeof val}`);
            acc *= val
        }
        return acc
    }),
    new BuiltinFunction(Symbol.for("/"), (regs, startReg, nargs) => {
        if (nargs === 0) throw new Error("/ requires at least 1 argument");
        
        if (nargs === 1) {
            const val = regs[startReg];
            if (typeof val !== "number") throw new Error(`/ requires numbers, but received ${typeof val}`);
            if (val === 0) throw new Error("division by zero");
            return 1/val; 
        }

        let acc = regs[startReg];
        if (typeof acc !== "number") throw new Error(`/ requires numbers, but received ${typeof acc}`);
        for (let i = startReg + 1; i < startReg+nargs; i++) {
            const val = regs[i]
            if (typeof val !== "number") throw new Error(`/ requires numbers, but received ${typeof val}`);
            if (val === 0) throw new Error("division by zero");
            acc /= val
        }
        return acc
    }),
    new BuiltinFunction(Symbol.for("modulo"), (regs, startReg, nargs) => {
        if(nargs !== 2) throw new Error("modulo requires 2 arguments");
        const a = regs[startReg] 
        const b = regs[startReg+1]
        if (typeof a !== "number" || typeof b !== "number") throw new Error(`modulo: requires numbers, but received ${typeof a}/${typeof b}`);
        if (b === 0) throw new Error("modulo: division by zero");
        return ((a % b) + b) % b
    }),
    new BuiltinFunction(Symbol.for("remainder"), (regs, startReg, nargs) => {
        if(nargs !== 2) throw new Error("remainder requires 2 arguments");
        const a = regs[startReg] 
        const b = regs[startReg+1]
        if (typeof a !== "number" || typeof b !== "number") throw new Error(`remainder: requires numbers, but received ${typeof a}/${typeof b}`);
        if (b === 0) throw new Error("remainder: division by zero");
        return a % b
    }),
    new BuiltinFunction(Symbol.for("list"), (regs, startReg, nargs) => {
        let tail: any = null;
        for (let i = startReg + nargs - 1; i >= startReg; i--) {
            tail = new Cons(regs[i], tail);
        }
        return tail;
    }),
    new BuiltinFunction(Symbol.for("="), (regs, startReg, nargs) => {
        if (nargs === 0) throw new Error("= requires at least 1 argument");
        
        let start = regs[startReg];
        if (typeof start !== "number") throw new Error(`= requires numbers, but received ${typeof start}`);
        let res = true
        for (let i = startReg+1; i < startReg+nargs; i++) {
            const val = regs[i]
            if (typeof val !== "number") throw new Error(`= requires numbers, but received ${typeof val}`);
            if (val !== start) {
                res = false
                break
            }
        }
        return res
    }),
    new BuiltinFunction(Symbol.for("eq?"), (regs, startReg, nargs) => {
        // DEVIATION: normal scheme requires arity 2, anima extends this to arity >=1
        if (nargs === 0) throw new Error("eq? requires at least 1 argument");
        
        let start = regs[startReg];
        let res = true
        for (let i = startReg+1; i < startReg+nargs; i++) {
            const val = regs[i]
            if (val !== start) {
                res = false
                break
            }
        }
        return res
    }),
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
    new BuiltinFunction(Symbol.for("<"), (regs, startReg, nargs) => {
        if (nargs === 0) throw new Error("< requires at least 1 argument");
        
        let prev = regs[startReg];
        if (typeof prev !== "number") throw new Error(`< requires numbers, but received ${typeof prev}`);
        for (let i = startReg+1; i < startReg+nargs; i++) {
            const val = regs[i]
            if (typeof val !== "number") throw new Error(`< requires numbers, but received ${typeof val}`);
            if (!(prev < val)) {
                return false
            }
            prev = val
        }
        return true
    }),
    new BuiltinFunction(Symbol.for("<="), (regs, startReg, nargs) => {
        if (nargs === 0) throw new Error("<= requires at least 1 argument");
        
        let prev = regs[startReg];
        if (typeof prev !== "number") throw new Error(`<= requires numbers, but received ${typeof prev}`);
        for (let i = startReg+1; i < startReg+nargs; i++) {
            const val = regs[i]
            if (typeof val !== "number") throw new Error(`<= requires numbers, but received ${typeof val}`);
            if (!(prev <= val)) {
                return false
            }
            prev = val
        }
        return true
    }),
    new BuiltinFunction(Symbol.for(">"), (regs, startReg, nargs) => {
        if (nargs === 0) throw new Error("> requires at least 1 argument");
        
        let prev = regs[startReg];
        if (typeof prev !== "number") throw new Error(`> requires numbers, but received ${typeof prev}`);
        for (let i = startReg+1; i < startReg+nargs; i++) {
            const val = regs[i]
            if (typeof val !== "number") throw new Error(`> requires numbers, but received ${typeof val}`);
            if (!(prev > val)) {
                return false
            }
            prev = val
        }
        return true
    }),
    new BuiltinFunction(Symbol.for(">="), (regs, startReg, nargs) => {
        if (nargs === 0) throw new Error(">= requires at least 1 argument");
        
        let prev = regs[startReg];
        if (typeof prev !== "number") throw new Error(`>= requires numbers, but received ${typeof prev}`);
        for (let i = startReg+1; i < startReg+nargs; i++) {
            const val = regs[i]
            if (typeof val !== "number") throw new Error(`>= requires numbers, but received ${typeof val}`);
            if (!(prev >= val)) {
                return false
            }
            prev = val
        }
        return true
    }),
    // list builtins
    new BuiltinFunction(Symbol.for("car"), (regs, startReg, nargs) => {
        if (nargs !== 1) throw new Error("car requires 1 argument");
        const val = regs[startReg];
        if (val instanceof Cons) {
            return val.car;
        } else if (val === null) {
            throw new Error("car requires a non-empty list");
        } else {
            throw new Error("car requires a list");
        }
    }),
    new BuiltinFunction(Symbol.for("cdr"), (regs, startReg, nargs) => {
        if (nargs !== 1) throw new Error("cdr requires 1 argument");
        const val = regs[startReg];
        if (val instanceof Cons) { 
            return val.cdr;
        } else if (val === null) {
            throw new Error("cdr requires a non-empty list");
        } else {
            throw new Error(`cdr requires a list but got ${val}`);
        }
    }),
    new BuiltinFunction(Symbol.for("cons"), (regs, startReg, nargs) => {
        if (nargs != 2) throw new Error("cons requires 2 arguments [cons a d]");
        return Cons.pair(regs[startReg], regs[startReg+1])
    }),
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
    new BuiltinFunction(Symbol.for("error?"), (regs, startReg, nargs) => {
        if (nargs != 1) throw new Error("error? requires 1 argument");
        return regs[startReg] instanceof ErrorObject
    }),
    new BuiltinFunction(Symbol.for("error-message"), (regs, startReg, nargs) => {
        if (nargs != 1) throw new Error("error-message requires 1 argument");
        if(!(regs[startReg] instanceof ErrorObject)) throw new Error("error-message requires the first argument to be an instance of ErrorObject")
        return regs[startReg].error?.message?.toString() || "<unknown>"
    }),
    // Builtin predicates
    new BuiltinFunction(Symbol.for("number?"), (regs, startReg, nargs) => {
        if (nargs != 1) throw new Error("number? requires 1 argument");
        return typeof regs[startReg] == "number"
    }),
    new BuiltinFunction(Symbol.for("integer?"), (regs, startReg, nargs) => {
        if (nargs != 1) throw new Error("integer? requires 1 argument");
        return typeof regs[startReg] == "number" && Number.isInteger(regs[startReg])
    }),
    new BuiltinFunction(Symbol.for("positive?"), (regs, startReg, nargs) => {
        if (nargs != 1) throw new Error("positive? requires 1 argument");
        return typeof regs[startReg] == "number" && regs[startReg] > 0
    }),
    new BuiltinFunction(Symbol.for("negative?"), (regs, startReg, nargs) => {
        if (nargs != 1) throw new Error("negative? requires 1 argument");
        return typeof regs[startReg] == "number" && regs[startReg] < 0
    }),
    new BuiltinFunction(Symbol.for("zero?"), (regs, startReg, nargs) => {
        if (nargs != 1) throw new Error("zero? requires 1 argument");
        return typeof regs[startReg] == "number" && regs[startReg] == 0
    }),
    new BuiltinFunction(Symbol.for("even?"), (regs, startReg, nargs) => {
        if (nargs != 1) throw new Error("even? requires 1 argument");
        const val = regs[startReg];
        if (typeof val !== "number" || !Number.isInteger(val)) throw new Error("even? requires an integer");
        return val % 2 === 0;
    }),
    new BuiltinFunction(Symbol.for("odd?"), (regs, startReg, nargs) => {
        if (nargs != 1) throw new Error("odd? requires 1 argument");
        const val = regs[startReg];
        if (typeof val !== "number" || !Number.isInteger(val)) throw new Error("odd? requires an integer");
        return Math.abs(val % 2) === 1; 
    }),
    new BuiltinFunction(Symbol.for("boolean?"), (regs, startReg, nargs) => {
        if (nargs != 1) throw new Error("boolean? requires 1 argument");
        return typeof regs[startReg] == "boolean"
    }),
    new BuiltinFunction(Symbol.for("void?"), (regs, startReg, nargs) => {
        if (nargs != 1) throw new Error("void? requires 1 argument");
        return typeof regs[startReg] == "undefined"
    }),
    new BuiltinFunction(Symbol.for("list?"), (regs, startReg, nargs) => {
        if (nargs != 1) throw new Error("list? requires 1 argument");
        const val = regs[startReg];
        if (val === null) return true;
        if (val instanceof Cons) return !val.isImproper() && !val.isCyclic();
        return false;
    }),
    new BuiltinFunction(Symbol.for("pair?"), (regs, startReg, nargs) => {
        if (nargs != 1) throw new Error("pair? requires 1 argument");
        const val = regs[startReg];
        return val instanceof Cons;
    }),
    new BuiltinFunction(Symbol.for("null?"), (regs, startReg, nargs) => {
        if (nargs != 1) throw new Error("null? requires 1 argument");
        return regs[startReg] === null;
    }),
    new BuiltinFunction(Symbol.for("empty?"), (regs, startReg, nargs) => {
        if (nargs != 1) throw new Error("empty? requires 1 argument");
        return regs[startReg] === null || (typeof regs[startReg] === "string" && regs[startReg].length === 0);
    }),
    new BuiltinFunction(Symbol.for("contains?"), (regs, startReg, nargs) => {
        if (nargs != 2) throw new Error("contains? requires 2 arguments");
        const list = regs[startReg];
        const item = regs[startReg+1];
        return (list instanceof Cons) ? list.includes(item) : false;
    }),
    new BuiltinFunction(Symbol.for("symbol?"), (regs, startReg, nargs) => {
        if (nargs != 1) throw new Error("symbol? requires 1 argument");
        return typeof regs[startReg] == "symbol"
    }),
    new BuiltinFunction(Symbol.for("string?"), (regs, startReg, nargs) => {
        if (nargs != 1) throw new Error("string? requires 1 argument");
        return typeof regs[startReg] == "string"
    }),
    new BuiltinFunction(Symbol.for("procedure?"), (regs, startReg, nargs) => {
        if (nargs != 1) throw new Error("procedure? requires 1 argument");
        return regs[startReg] instanceof IProcedure
    }),
    new BuiltinFunction(Symbol.for("error?"), (regs, startReg, nargs) => {
        if (nargs != 1) throw new Error("error? requires 1 argument");
        return regs[startReg] instanceof ErrorObject
    }),
    new BuiltinFunction(Symbol.for("exposed-props?"), (regs, startReg, nargs) => {
        if (nargs != 1) throw new Error("exposed-props? requires 1 argument");
        return regs[startReg] instanceof ExposedProps
    }),
    // Exposed props
    new BuiltinFunction(Symbol.for("pget"), (regs, startReg, nargs) => {
        if (nargs != 2) throw new Error("pget requires 2 arguments (pget props key-str)");
        const props = regs[startReg]
        if (!(props instanceof ExposedProps)) throw new Error("pget requires the first argument to be an instance of ExposedProps")
        const keyStr = regs[startReg+1]
        if (typeof keyStr !== "string") throw new Error("pget requires the second argument to be a string")
        return props.get(keyStr)
    }),
    new ApplyProc(),
    new TryProc(),
    new CallCCProc(),
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
]

export const IBUILTINS_IDX_MAP = new Map<symbol, number>()
for(let i = 0; i < IBUILTINS.length; i++) {
    IBUILTINS_IDX_MAP.set(IBUILTINS[i].name, i)
}

export const stdPreludeScope = () => Globals.newWith({})

export const STD_PRELUDE = `
(define $map
    (lambda (f list1 . more)
        (if (null? more)
            (let loop ((lst list1))
                (if (null? lst)
                    '()
                    (cons (f (car lst)) (loop (cdr lst)))))
            (let loop ((lists (cons list1 more)))
                (let check ((lsts lists))
                    (if (null? lsts)
                        (cons (apply f (let get-cars ((lsts lists))
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
`

export class Bootstrapper {
    #bootstrappedPreludes: Map<string, Globals> = new Map()

    /** Set up the public scope for the given vm and compiler instance */
    setupPublicScope(impl: AnimaMeta, cmp: AbstractCompiler, vm: AbstractVM, evaluator: MacroEvaluator) {
        if (this.#bootstrappedPreludes.has(impl.id)) {
            return this.#bootstrappedPreludes.get(impl.id)!
        }
        const preludeAst = new ASP(STD_PRELUDE, true).parse()
        const transformExpr = evaluator.transform(preludeAst)
        const PRELUDE_BC = cmp.compile(transformExpr)

        const privScope = stdPreludeScope()
        vm.evaluateRaw(PRELUDE_BC, privScope)

        /* Base scope */
        const publicScope = Globals.newWith({}, true); 
        for (const [sym, value] of privScope.data.entries()) {
            const symName = Symbol.keyFor(sym) || sym.description || "%Unknown";
        
            // If the func starts with a $, its public
            if (symName.startsWith("$")) {
                publicScope.data.set(Symbol.for(symName.replace('$', '')), value);
            }
        }

        // finally, export the builtins
        for(const builtin of IBUILTINS) {
            publicScope.data.set(builtin.name, builtin)
        }

        this.#bootstrappedPreludes.set(impl.id, publicScope)
        return publicScope
    }
}