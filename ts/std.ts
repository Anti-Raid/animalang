import { AbstractCompiler, AbstractVM, AnimaMeta, ASP, ErrorObject, IProcedure, isDeepEqual, isTruthy, OP_BEGIN, symGen, Table } from "./common";
import { Cons } from "./list";
import { MacroEvaluator } from "./syntransformer-v1/macro";
import { UnhandledSchemeError } from "./bytecode-rvm/exec";

export type CodeEmitter = {
    emit: (str: string) => void
}

export type BuiltinCodeGenFn = (
    emitter: CodeEmitter,
    startReg: number,
    nregs: number,
    destReg?: number
) => string | void;

/** 
 * A builtin function. 
 * 
 * Builtin functions do not have access to their own lexical scope (at least not yet) 
 * 
 * It is undefined behaviour for a builtin function to modify regs (reg's are considered readonly). Additionally, the intermediate
 * state of any BuiltinFunction must be well-defined/valid 
*/
export class BuiltinFunction extends IProcedure {
    public codeGenFn?: BuiltinCodeGenFn;

    constructor(
        public name: symbol,
        public cb: (regs: readonly any[], startReg: number, nargs: number) => any,
        codeGenFn?: BuiltinCodeGenFn,
    ) {
        super(name.description || Symbol.keyFor(name));
        this.codeGenFn = codeGenFn;
    }
}

// Marker for `apply` intrinsic proc
export class ApplyProc extends IProcedure {
    public name = Symbol.for("apply")
    constructor() {
        super("apply");
    }
}

function makeNumericComparisonCodeGen(op: string) {
    return (emitter: CodeEmitter, startReg: number, nregs: number): string => {
        if (nregs === 0) {
            emitter.emit(`throw new Error("${op} requires at least 1 argument");`);
            return "false";
        }
        for (let i = 0; i < nregs; i++) {
            emitter.emit(`
                if (typeof regs[${startReg + i}] !== "number") {
                    throw new Error("${op} requires numbers, but received " + typeof regs[${startReg + i}]);
                }
            `);
        }
        if (nregs === 1) {
            return "true";
        }
        if (nregs === 2) {
            return `(regs[${startReg}] ${op} regs[${startReg + 1}])`;
        }
        const terms: string[] = [];
        for (let i = 0; i < nregs - 1; i++) {
            terms.push(`regs[${startReg + i}] ${op} regs[${startReg + i + 1}]`);
        }
        return `(${terms.join(" && ")})`;
    };
}

function makeNumericEqualityCodeGen() {
    return (emitter: CodeEmitter, startReg: number, nregs: number): string => {
        if (nregs === 0) {
            emitter.emit(`throw new Error("= requires at least 1 argument");`);
            return "false";
        }
        for (let i = 0; i < nregs; i++) {
            emitter.emit(`
                if (typeof regs[${startReg + i}] !== "number") {
                    throw new Error("= requires numbers, but received " + typeof regs[${startReg + i}]);
                }
            `);
        }
        if (nregs === 1) {
            return "true";
        }
        if (nregs === 2) {
            return `(regs[${startReg}] === regs[${startReg + 1}])`;
        }
        const terms: string[] = [];
        for (let i = 1; i < nregs; i++) {
            terms.push(`regs[${startReg}] === regs[${startReg + i}]`);
        }
        return `(${terms.join(" && ")})`;
    };
}

function makeEqCodeGen() {
    return (emitter: CodeEmitter, startReg: number, nregs: number): string => {
        if (nregs === 0) {
            emitter.emit(`throw new Error("eq? requires at least 1 argument");`);
            return "false";
        }
        if (nregs === 1) return "true";
        if (nregs === 2) return `(regs[${startReg}] === regs[${startReg + 1}])`;
        const terms: string[] = [];
        for (let i = 1; i < nregs; i++) {
            terms.push(`regs[${startReg}] === regs[${startReg + i}]`);
        }
        return `(${terms.join(" && ")})`;
    };
}

export const IBUILTINS: (BuiltinFunction | ApplyProc)[] = [
    new BuiltinFunction(
        Symbol.for("+"),
        (regs, startReg, nargs) => {
            let acc = 0; 
            for (let i = startReg; i < startReg+nargs; i++) {
                const val = regs[i]
                if (typeof val !== "number") throw new Error(`+ requires numbers, but received ${typeof val}`);
                acc += val
            }
            return acc
        },
        (emitter, startReg, nregs) => {
            if (nregs === 0) {
                return "0";
            }
            for (let i = 0; i < nregs; i++) {
                emitter.emit(`
                    if (typeof regs[${startReg + i}] !== "number") {
                        throw new Error("+ requires numbers, but received " + typeof regs[${startReg + i}]);
                    }
                `);
            }
            if (nregs === 1) {
                return `regs[${startReg}]`;
            }
            const terms: string[] = [];
            for (let i = 0; i < nregs; i++) {
                terms.push(`regs[${startReg + i}]`);
            }
            return `(${terms.join(" + ")})`;
        }
    ),
    new BuiltinFunction(
        Symbol.for("-"),
        (regs, startReg, nargs) => {
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
        },
        (emitter, startReg, nregs) => {
            if (nregs === 0) {
                emitter.emit(`throw new Error("- requires at least 1 argument");`);
                return "0";
            }
            for (let i = 0; i < nregs; i++) {
                emitter.emit(`
                    if (typeof regs[${startReg + i}] !== "number") {
                        throw new Error("- requires numbers, but received " + typeof regs[${startReg + i}]);
                    }
                `);
            }
            if (nregs === 1) {
                return `(-regs[${startReg}])`;
            }
            const terms: string[] = [];
            for (let i = 0; i < nregs; i++) {
                terms.push(`regs[${startReg + i}]`);
            }
            return `(${terms.join(" - ")})`;
        }
    ),
    new BuiltinFunction(
        Symbol.for("*"),
        (regs, startReg, nargs) => {
            let acc = 1; 
            for (let i = startReg; i < startReg+nargs; i++) {
                const val = regs[i]
                if (typeof val !== "number") throw new Error(`* requires numbers, but received ${typeof val}`);
                acc *= val
            }
            return acc
        },
        (emitter, startReg, nregs) => {
            if (nregs === 0) {
                return "1";
            }
            for (let i = 0; i < nregs; i++) {
                emitter.emit(`
                    if (typeof regs[${startReg + i}] !== "number") {
                        throw new Error("* requires numbers, but received " + typeof regs[${startReg + i}]);
                    }
                `);
            }
            if (nregs === 1) {
                return `regs[${startReg}]`;
            }
            const terms: string[] = [];
            for (let i = 0; i < nregs; i++) {
                terms.push(`regs[${startReg + i}]`);
            }
            return `(${terms.join(" * ")})`;
        }
    ),
    new BuiltinFunction(
        Symbol.for("/"),
        (regs, startReg, nargs) => {
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
        },
        (emitter, startReg, nregs) => {
            if (nregs === 0) {
                emitter.emit(`throw new Error("/ requires at least 1 argument");`);
                return "0";
            }
            for (let i = 0; i < nregs; i++) {
                emitter.emit(`
                    if (typeof regs[${startReg + i}] !== "number") {
                        throw new Error("/ requires numbers, but received " + typeof regs[${startReg + i}]);
                    }
                `);
            }
            if (nregs === 1) {
                emitter.emit(`
                    if (regs[${startReg}] === 0) throw new Error("division by zero");
                `);
                return `(1 / regs[${startReg}])`;
            }
            for (let i = 1; i < nregs; i++) {
                emitter.emit(`
                    if (regs[${startReg + i}] === 0) throw new Error("division by zero");
                `);
            }
            const terms: string[] = [];
            for (let i = 0; i < nregs; i++) {
                terms.push(`regs[${startReg + i}]`);
            }
            return `(${terms.join(" / ")})`;
        }
    ),
    new BuiltinFunction(
        Symbol.for("modulo"),
        (regs, startReg, nargs) => {
            if(nargs !== 2) throw new Error("modulo requires 2 arguments");
            const a = regs[startReg] 
            const b = regs[startReg+1]
            if (typeof a !== "number" || typeof b !== "number") throw new Error(`modulo: requires numbers, but received ${typeof a}/${typeof b}`);
            if (b === 0) throw new Error("modulo: division by zero");
            return ((a % b) + b) % b
        },
        (emitter, startReg, nregs) => {
            if (nregs !== 2) {
                emitter.emit(`throw new Error("modulo requires 2 arguments");`);
                return "0";
            }
            emitter.emit(`
                if (typeof regs[${startReg}] !== "number" || typeof regs[${startReg + 1}] !== "number") {
                    throw new Error("modulo: requires numbers, but received " + typeof regs[${startReg}] + "/" + typeof regs[${startReg + 1}]);
                }
                if (regs[${startReg + 1}] === 0) {
                    throw new Error("modulo: division by zero");
                }
            `);
            return `(((regs[${startReg}] % regs[${startReg + 1}]) + regs[${startReg + 1}]) % regs[${startReg + 1}])`;
        }
    ),
    new BuiltinFunction(
        Symbol.for("remainder"),
        (regs, startReg, nargs) => {
            if(nargs !== 2) throw new Error("remainder requires 2 arguments");
            const a = regs[startReg] 
            const b = regs[startReg+1]
            if (typeof a !== "number" || typeof b !== "number") throw new Error(`remainder: requires numbers, but received ${typeof a}/${typeof b}`);
            if (b === 0) throw new Error("remainder: division by zero");
            return a % b
        },
        (emitter, startReg, nregs) => {
            if (nregs !== 2) {
                emitter.emit(`throw new Error("remainder requires 2 arguments");`);
                return "0";
            }
            emitter.emit(`
                if (typeof regs[${startReg}] !== "number" || typeof regs[${startReg + 1}] !== "number") {
                    throw new Error("remainder: requires numbers, but received " + typeof regs[${startReg}] + "/" + typeof regs[${startReg + 1}]);
                }
                if (regs[${startReg + 1}] === 0) {
                    throw new Error("remainder: division by zero");
                }
            `);
            return `(regs[${startReg}] % regs[${startReg + 1}])`;
        }
    ),
    new BuiltinFunction(Symbol.for("list"), (regs, startReg, nargs) => {
        let tail: any = null;
        for (let i = startReg + nargs - 1; i >= startReg; i--) {
            tail = new Cons(regs[i], tail);
        }
        return tail;
    }),
    new BuiltinFunction(
        Symbol.for("="),
        (regs, startReg, nargs) => {
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
        },
        makeNumericEqualityCodeGen()
    ),
    new BuiltinFunction(
        Symbol.for("eq?"),
        (regs, startReg, nargs) => {
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
        },
        makeEqCodeGen()
    ),
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
    new BuiltinFunction(
        Symbol.for("<"),
        (regs, startReg, nargs) => {
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
        },
        makeNumericComparisonCodeGen("<")
    ),
    new BuiltinFunction(
        Symbol.for("<="),
        (regs, startReg, nargs) => {
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
        },
        makeNumericComparisonCodeGen("<=")
    ),
    new BuiltinFunction(
        Symbol.for(">"),
        (regs, startReg, nargs) => {
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
        },
        makeNumericComparisonCodeGen(">")
    ),
    new BuiltinFunction(
        Symbol.for(">="),
        (regs, startReg, nargs) => {
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
        },
        makeNumericComparisonCodeGen(">=")
    ),
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
    new BuiltinFunction(Symbol.for("make-error-object"), (regs, startReg, nargs) => {
        if (nargs !== 1) throw new Error("make-error-object requires 1 argument");
        return new ErrorObject(regs[startReg]);
    }),
    new BuiltinFunction(Symbol.for("unhandled-error"), (regs, startReg, nargs) => {
        if (nargs !== 1) throw new Error("unhandled-error requires 1 argument");
        const val = regs[startReg];
        const err = val instanceof ErrorObject ? val.error : val;
        throw new UnhandledSchemeError(err);
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
    new BuiltinFunction(Symbol.for("infinite?"), (regs, startReg, nargs) => {
        if (nargs != 1) throw new Error("infinite? requires 1 argument");
        const val = regs[startReg];
        return typeof val === "number" && (val === Infinity || val === -Infinity);
    }),
    new BuiltinFunction(Symbol.for("finite?"), (regs, startReg, nargs) => {
        if (nargs != 1) throw new Error("finite? requires 1 argument");
        const val = regs[startReg];
        return typeof val === "number" && Number.isFinite(val);
    }),
    new BuiltinFunction(Symbol.for("nan?"), (regs, startReg, nargs) => {
        if (nargs != 1) throw new Error("nan? requires 1 argument");
        const val = regs[startReg];
        return typeof val === "number" && Number.isNaN(val);
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
        const val = regs[startReg];
        return val === null || (Array.isArray(val) && val.length === 0) || (typeof val === "string" && val.length === 0) || (val instanceof Table && val.size === 0);
    }),
    new BuiltinFunction(Symbol.for("contains?"), (regs, startReg, nargs) => {
        if (nargs != 2) throw new Error("contains? requires 2 arguments");
        const list = regs[startReg];
        const item = regs[startReg+1];
        if (Array.isArray(list)) return list.includes(item);
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
    new ApplyProc(),
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
    new BuiltinFunction(Symbol.for("vector?"), (regs, startReg, nargs) => {
        if (nargs !== 1) throw new Error("vector? requires 1 argument");
        return Array.isArray(regs[startReg]);
    }),
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
    }),
    new BuiltinFunction(Symbol.for("vector-ref"), (regs, startReg, nargs) => {
        if (nargs !== 2) throw new Error("vector-ref requires 2 arguments (vector-ref vec k)");
        const vec = regs[startReg];
        const k = regs[startReg + 1];
        if (!Array.isArray(vec)) throw new Error("vector-ref requires a vector");
        if (typeof k !== "number" || !Number.isInteger(k) || k < 0 || k >= vec.length) {
            throw new Error(`vector-ref: index ${k} out of bounds for vector of length ${vec.length}`);
        }
        return vec[k];
    }),
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
    }),
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
    new BuiltinFunction(Symbol.for("vector-empty?"), (regs, startReg, nargs) => {
        if (nargs !== 1) throw new Error("vector-empty? requires 1 argument");
        const vec = regs[startReg];
        if (!Array.isArray(vec)) throw new Error("vector-empty? requires a vector");
        return vec.length === 0;
    }),
    // Table operations
    new BuiltinFunction(Symbol.for("table?"), (regs, startReg, nargs) => {
        if (nargs !== 1) throw new Error("table? requires 1 argument");
        return regs[startReg] instanceof Table;
    }),
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
    new BuiltinFunction(Symbol.for("table-empty?"), (regs, startReg, nargs) => {
        if (nargs !== 1) throw new Error("table-empty? requires 1 argument");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw new Error("table-empty? requires a table");
        return tbl.size === 0;
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
    new BuiltinFunction(Symbol.for("table-frozen?"), (regs, startReg, nargs) => {
        if (nargs !== 1) throw new Error("table-frozen? requires 1 argument");
        const tbl = regs[startReg];
        if (!(tbl instanceof Table)) throw new Error("table-frozen? requires a table");
        return tbl.frozen;
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
]

export const IBUILTINS_IDX_MAP = new Map<symbol, number>()
for(let i = 0; i < IBUILTINS.length; i++) {
    IBUILTINS_IDX_MAP.set(IBUILTINS[i].name, i)
}

export const stdPreludeScope = () => new Table()

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

(define $call/cc
    (lambda (proc)
        (%call/cc proc)))

(define $call-with-current-continuation $call/cc)

(define $dynamic-wind
    (lambda (before thunk after)
        (%dynamic-wind before thunk after)))

(let ((current-handlers '())
      (raise-proc #f)
      (with-ex-handler-proc #f)
      (raise-cont-proc #f)
      (try-proc #f))
    (set! raise-proc
        (lambda (obj)
            (if (null? current-handlers)
                (unhandled-error obj)
                (let ((h (car current-handlers)))
                    (set! current-handlers (cdr current-handlers))
                    (h obj)
                    (raise-proc (make-error-object "handler returned on non-continuable exception"))))))

    (set! with-ex-handler-proc
        (lambda (handler thunk)
            (let ((prev current-handlers))
                (%dynamic-wind
                    (lambda ()
                        (set! current-handlers (cons handler current-handlers)))
                    thunk
                    (lambda ()
                        (set! current-handlers prev))))))

    (set! raise-cont-proc
        (lambda (obj)
            (if (null? current-handlers)
                (unhandled-error obj)
                (let ((h (car current-handlers))
                      (prev current-handlers))
                    (%dynamic-wind
                        (lambda () (set! current-handlers (cdr prev)))
                        (lambda () (h obj))
                        (lambda () (set! current-handlers prev)))))))

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

    (%set-raise-proc raise-proc))
`

export class Bootstrapper {
    #bootstrappedPreludes: Map<string, Table> = new Map()

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
        const publicScope = new Table(); 
        for (const [sym, value] of privScope.entries()) {
            const symName = Symbol.keyFor(sym) || sym.description || "%Unknown";
        
            // If the func starts with a $, its public
            if (symName.startsWith("$")) {
                publicScope.set(Symbol.for(symName.replace('$', '')), value);
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