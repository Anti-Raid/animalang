import {
    OP_DEFINE, OP_BEGIN, OP_LAMBDA, OP_LET, OP_IF, OP_COND, OP_ELSE, 
    OP_SET, OP_LETREC, OP_LETSTAR, ensureCanBind,
    OP_AND,
    OP_OR,
    OP_DEFINE_GLOBAL,
    OP_QUOTE,
    CORE_IF,
    CORE_LAMBDA,
    CORE_QUOTE,
    CORE_BEGIN,
    CORE_SET,
    CORE_BLOCK,
    CORE_ESCAPE,
    CORE_LOOP,
    CORE_LET,
    CORE_LET_VALUES,
    CORE_LET_VALUES_STRICT,
    CORE_WITH_MARK,
    CORE_CURRENT_MARKS,
    SOURCE_POS,
    AbstractClosure,
    Cons
} from "../common";
import { MacroEvaluator, TransformState, type TransformResult } from "./macro";
import { CXR_PATHS, PREDICATES, ARITHMETIC } from "../ops";

const cons = (a: any, b: any) => new Cons(a, b);
const car = (p: any) => (p instanceof Cons ? p.car : null);
const cdr = (p: any) => (p instanceof Cons ? p.cdr : null);
const cadr = (p: any) => car(cdr(p));
const cddr = (p: any) => cdr(cdr(p));
const list = (...items: any[]) => Cons.list(...items);

const toArray = (p: any): any[] => {
    if (p === null) return [];
    if (p instanceof Cons) return p.toArray();
    return [p];
};

const fromArray = (arr: any[]): Cons | null => Cons.fromArray(arr);

const wrapMulti = (exprs: any): any => {
    if (exprs === null) return null;
    if (exprs instanceof Cons && exprs.cdr === null) return exprs.car;
    return cons(OP_BEGIN, exprs);
};

const removeBegin = (expr: any): any => {
    const result: any[] = [];
    let curr: any = expr;
    while (curr instanceof Cons) {
        const exp = curr.car;
        if (exp instanceof Cons && (exp.car === OP_BEGIN || exp.car === CORE_BEGIN)) {
            result.push(...toArray(removeBegin(exp.cdr)));
        } else {
            result.push(exp);
        }
        curr = curr.cdr;
    }
    return fromArray(result);
};

const normalizeDefine = (stmt: any): any => {
    if (!(stmt instanceof Cons) || !(stmt.cdr instanceof Cons) || stmt.cdr.cdr === null) {
        throw new Error(`define must be in format (define varname arg) or (define (func_name arg1 arg2... argN) body_expr...)`);
    }

    const dargs = stmt.cdr;
    const target = dargs.car;
    const valueOrBody = dargs.cdr;

    if (typeof target === "symbol") {
        if (valueOrBody.cdr !== null) throw new Error(`define must have 2 arguments`);
        ensureCanBind(target, undefined, "define");
        return stmt;
    } else if (target instanceof Cons) {
        const funcName = target.car;
        if (typeof funcName !== "symbol") throw new Error("define: missing function name");
        ensureCanBind(funcName, undefined, "define");
        const lambdaParams = target.cdr;
        return list(OP_DEFINE, funcName, cons(OP_LAMBDA, cons(lambdaParams, valueOrBody)));
    }
    throw new Error(`define syntax error`);
};

// a body (of a lambda or let) with internal defines gets them as a letrec; `build(body, done)` makes the form around
// it, `done` saying whether the body is already transformed (otherwise the result is transformed again)
const lowerBody = (evaluator: MacroEvaluator, rawBody: any, form: string, build: (body: any, done: boolean) => any): TransformResult => {
    const flat = removeBegin(rawBody);
    if (flat === null) throw new Error(`${form} body must contain at least one expression`);

    const defines: any[] = [];
    const body: any[] = [];
    for (const stmt of toArray(flat)) {
        if (stmt instanceof Cons && stmt.car === OP_DEFINE) {
            const normalizedStmt = normalizeDefine(stmt);
            defines.push(list(normalizedStmt.cdr.car, normalizedStmt.cdr.cdr.car));
        } else {
            body.push(stmt);
        }
    }

    if (defines.length === 0) {
        return { expanded: build(fromArray(body.map(stmt => evaluator.transform(stmt))), true), state: TransformState.ReturnImm };
    }
    if (body.length === 0) {
        throw new Error(`${form} body must contain at least one expression after internal/local defines etc.`);
    }
    return { expanded: build(list(cons(OP_LETREC, cons(fromArray(defines), fromArray(body)))), false), state: TransformState.Recurse };
};

const valuesClause = (clause: any, form: string): [any, any] => {
    if (!(clause instanceof Cons) || !(clause.cdr instanceof Cons) || clause.cdr.cdr !== null) {
        throw new Error(`${form} clause must be of form (formals expr)`);
    }
    return [clause.car, clause.cdr.car];
};

const letBindings = (form: string, bindingsCons: any): [symbol, any][] => {
    if (bindingsCons !== null && !(bindingsCons instanceof Cons)) throw new Error(`${form} bindings must be a list of form ((var expr)...)`);
    return toArray(bindingsCons).map(binding => {
        if (!(binding instanceof Cons) || !(binding.cdr instanceof Cons) || binding.cdr.cdr !== null) throw new Error(`${form} binding bad syntax`);
        if (typeof binding.car !== "symbol") throw new Error(`${form} binding name must be a symbol`);
        return [binding.car, binding.cdr.car];
    });
};

const NOT_A_LOOP = Symbol("not a loop");

// Turns a named let whose name is only ever called in tail position of its body, with the right number of arguments,
// into a %loop, so no procedure is created. Hidden carrier variables hold the next iteration's arguments; they are
// assigned right before jumping to the next iteration and read right after, so they stay plain registers. The
// parameters are bound fresh from them every iteration, as calls would. Returns null (keep the procedure) if `name` is
// used any other way: as a value, in a non-tail call, from a nested lambda, or assigned.
const namedLetAsLoop = (evaluator: MacroEvaluator, name: symbol, params: symbol[], inits: any[], body: any): any => {
    // a parameter of the same name shadows the loop in the whole body
    if (params.includes(name)) return null;
    const carriers = params.map(p => Symbol(p.description));
    const done = Symbol("done");
    const next = Symbol("next");

    const keepPos = (to: any, from: any) => {
        const pos = SOURCE_POS.get(from);
        if (pos !== undefined && to instanceof Cons) SOURCE_POS.set(to, pos);
        return to;
    };
    const binds = (formals: any): boolean => {
        while (formals instanceof Cons) {
            if (formals.car === name) return true;
            formals = formals.cdr;
        }
        return formals === name;
    };
    const mentions = (e: any): boolean =>
        e === name || (e instanceof Cons && e.car !== CORE_QUOTE && (mentions(e.car) || mentions(e.cdr)));
    type TailBlocks = ReadonlySet<symbol>;
    const seq = (exprs: any, tail: boolean, blocks: TailBlocks): any => {
        const items = toArray(exprs);
        return fromArray(items.map((e, i) => rw(e, tail && i === items.length - 1, blocks)));
    };
    // `tail`: whether e's value is the value of the loop body. `blocks`: the labels of enclosing %blocks whose value is
    // the value of the loop body, so an %escape to one of them gives its value in tail position wherever it is (this is
    // how a loop nested in this one, itself a %block, exits by calling this loop)
    const rw = (e: any, tail: boolean, blocks: TailBlocks): any => {
        if (e === name) throw NOT_A_LOOP;
        if (!(e instanceof Cons)) return e;
        const op = e.car;
        switch (op) {
            case CORE_QUOTE:
                return e;
            case CORE_LAMBDA:
                if (binds(e.cdr.car) || !mentions(e.cdr.cdr)) return e;
                throw NOT_A_LOOP;
            case CORE_IF: {
                const [cond, then, otherwise] = e.toArray().slice(1);
                return keepPos(list(CORE_IF, rw(cond, false, blocks), rw(then, tail, blocks), rw(otherwise, tail, blocks)), e);
            }
            case CORE_BEGIN:
                return keepPos(cons(CORE_BEGIN, seq(e.cdr, tail, blocks)), e);
            case CORE_SET:
                if (e.cdr.car === name) throw NOT_A_LOOP;
                return keepPos(list(CORE_SET, e.cdr.car, rw(e.cdr.cdr.car, false, blocks)), e);
            case OP_DEFINE_GLOBAL:
                return keepPos(list(op, e.cdr.car, rw(e.cdr.cdr.car, false, blocks)), e);
            case CORE_LET:
            case CORE_LET_VALUES:
            case CORE_LET_VALUES_STRICT: {
                const bindings = toArray(e.cdr.car);
                const shadowed = bindings.some(b => binds(op === CORE_LET ? list(b.car) : b.car));
                const newBindings = bindings.map(b => list(b.car, rw(b.cdr.car, false, blocks)));
                return keepPos(cons(op, cons(fromArray(newBindings), shadowed ? e.cdr.cdr : seq(e.cdr.cdr, tail, blocks))), e);
            }
            case CORE_BLOCK: {
                // a block in tail position gives the loop body's value; one that is not hides any outer block of its name
                const label = e.cdr.car;
                const inner = new Set(blocks);
                if (tail) inner.add(label);
                else inner.delete(label);
                return keepPos(cons(op, cons(label, seq(e.cdr.cdr, tail, inner))), e);
            }
            case CORE_ESCAPE:
                return e.cdr.cdr === null ? e : keepPos(list(op, e.cdr.car, rw(e.cdr.cdr.car, blocks.has(e.cdr.car), blocks)), e);
            case CORE_LOOP:
                return keepPos(cons(op, seq(e.cdr, false, blocks)), e);
        }
        if (op === name) {
            const args = toArray(e.cdr);
            if (!tail || args.length !== params.length) throw NOT_A_LOOP;
            const sets = args.map((a, i) => list(CORE_SET, carriers[i], rw(a, false, blocks)));
            return keepPos(cons(CORE_BEGIN, fromArray([...sets, list(CORE_ESCAPE, next)])), e);
        }
        // a call or intrinsic: operator and operands are all values
        return keepPos(fromArray(toArray(e).map(x => rw(x, false, blocks))), e);
    };

    const lambda = evaluator.transform(cons(OP_LAMBDA, cons(fromArray(params), body)));
    let loopBody: any;
    try {
        loopBody = seq(lambda.cdr.cdr, true, new Set());
    } catch (e) {
        if (e === NOT_A_LOOP) return null;
        throw e;
    }
    return list(CORE_LET, fromArray(carriers.map((c, i) => list(c, evaluator.transform(inits[i])))),
        list(CORE_BLOCK, done,
            list(CORE_LOOP,
                list(CORE_BLOCK, next,
                    list(CORE_LET, fromArray(params.map((p, i) => list(p, carriers[i]))),
                        list(CORE_ESCAPE, done, cons(CORE_BEGIN, loopBody)))))));
};

export const registerCoreSyntax = (evaluator: MacroEvaluator) => {
    // surface forms that map one to one onto core forms (the core form itself is accepted too, e.g. from a transpiler)
    const lowerTo = (core: symbol, validate: (orig: Cons) => void, state = TransformState.DoChildren) => (evaluator: MacroEvaluator, expr: any, orig: any) => {
        validate(orig);
        return { expanded: cons(core, expr), state };
    };
    const coreForm = (surface: symbol, core: symbol, validate: (orig: Cons) => void, state?: TransformState) => {
        evaluator.registerTransform(surface, lowerTo(core, validate, state));
        evaluator.registerTransform(core, lowerTo(core, validate, state));
    };

    coreForm(OP_IF, CORE_IF, orig => {
        if (orig.length !== 4) {
            throw new Error(`if condition must be in format ["if", condition, true_expr, false_expr] but only have ${orig.length - 1} arguments`);
        }
    });
    coreForm(OP_BEGIN, CORE_BEGIN, () => {});
    // quoted data is never transformed
    coreForm(OP_QUOTE, CORE_QUOTE, orig => {
        if (orig.length !== 2) throw new Error(`quote must be in format ["quote", expr] but have ${orig.length - 1} arguments`);
    }, TransformState.ReturnImm);
    const blockName = (form: string, orig: Cons) => {
        if (!(orig.cdr instanceof Cons) || typeof orig.cdr.car !== "symbol") throw new Error(`${form} requires a block name symbol`);
    };
    for (const [core, validate] of [
        [CORE_BLOCK, (orig: Cons) => blockName("%block", orig)],
        [CORE_ESCAPE, (orig: Cons) => {
            blockName("%escape", orig);
            if (orig.length > 3) throw new Error("%escape must be in format (%escape name [value])");
        }],
        [CORE_LOOP, () => {}],
    ] as const) {
        evaluator.registerTransform(core, lowerTo(core, validate));
    }
    coreForm(Symbol.for("with-continuation-mark"), CORE_WITH_MARK, orig => {
        if (orig.length !== 4) throw new Error("with-continuation-mark must be in format (with-continuation-mark key value body)");
    });
    // direct calls skip the prelude procedure (and its optional-argument list); a #f set means the current marks
    evaluator.registerTransform(Symbol.for("continuation-mark-set-first"), (evaluator, expr, orig) => {
        const args = toArray(expr);
        if (args.length < 2 || args.length > 3) throw new Error("continuation-mark-set-first requires 2 or 3 arguments");
        const [set, key, none] = args;
        const current = list(CORE_CURRENT_MARKS);
        const setExpr = set === false ? current : (() => {
            const tmp = Symbol("marks");
            return list(CORE_LET, list(list(tmp, set)), list(CORE_IF, tmp, tmp, current));
        })();
        return { expanded: list(Symbol.for("%marks-first"), setExpr, key, args.length === 3 ? none : false), state: TransformState.Recurse };
    });
    evaluator.registerTransform(Symbol.for("current-continuation-marks"), lowerTo(CORE_CURRENT_MARKS, orig => {
        if (orig.length !== 1) throw new Error("current-continuation-marks takes no arguments");
    }));
    evaluator.registerTransform(CORE_CURRENT_MARKS, lowerTo(CORE_CURRENT_MARKS, orig => {
        if (orig.length !== 1) throw new Error("%current-marks takes no arguments");
    }));
    coreForm(OP_SET, CORE_SET, orig => {
        if (orig.length !== 3) throw new Error(`set! must have 2 arguments`);
        if (typeof orig.cdr.car !== "symbol") throw new Error(`${String(orig.cdr.car)} not symbol`);
        ensureCanBind(orig.cdr.car, undefined, "set!");
    });

    evaluator.registerTransform(CORE_LET, (evaluator, expr, orig) => {
        if (!(orig instanceof Cons) || orig.length < 3) throw new Error(`let bad syntax`);
        const bindings = letBindings("let", expr.car);
        return lowerBody(evaluator, expr.cdr, "let", (body, done) => {
            const inits = bindings.map(([name, init]) => list(name, done ? evaluator.transform(init) : init));
            return cons(CORE_LET, cons(fromArray(inits), body));
        });
    });

    for (const core of [CORE_LET_VALUES, CORE_LET_VALUES_STRICT]) {
        evaluator.registerTransform(core, (evaluator, expr, orig) => {
            if (!(orig instanceof Cons) || orig.length < 3) throw new Error("let-values must be of form (let-values ((formals expr) ...) body...)");
            const clauses = toArray(expr.car).map(c => {
                const [formals, init] = valuesClause(c, "let-values");
                let f = formals;
                while (f instanceof Cons) {
                    if (typeof f.car !== "symbol") throw new Error("let-values formals must be symbols");
                    f = f.cdr;
                }
                if (f !== null && typeof f !== "symbol") throw new Error("let-values formals must be symbols");
                return [formals, init];
            });
            return lowerBody(evaluator, expr.cdr, "let-values", (body, done) => {
                const transformed = clauses.map(([formals, init]) => list(formals, done ? evaluator.transform(init) : init));
                return cons(core, cons(fromArray(transformed), body));
            });
        });
    }

    // an immediately applied lambda is just a let
    evaluator.setApplicationTransform((evaluator, expr) => {
        const head = expr.car;
        if (!(head instanceof Cons) || (head.car !== OP_LAMBDA && head.car !== CORE_LAMBDA) || !(head.cdr instanceof Cons) || head.cdr.cdr === null) return null;
        const args = toArray(expr.cdr);
        const bindings: any[] = [];
        let params: any = head.cdr.car;
        while (params instanceof Cons) {
            if (bindings.length >= args.length) return null;
            bindings.push(list(params.car, args[bindings.length]));
            params = params.cdr;
        }
        if (params === null) {
            if (bindings.length !== args.length) return null;
        } else if (typeof params === "symbol") {
            bindings.push(list(params, cons(Symbol.for("list"), fromArray(args.slice(bindings.length)))));
        } else {
            return null;
        }
        return { expanded: cons(CORE_LET, cons(fromArray(bindings), head.cdr.cdr)), state: TransformState.Recurse };
    });

    evaluator.registerTransform(OP_COND, (evaluator, expr, orig) => {
        if (expr === null) return { expanded: undefined, state: TransformState.ReturnImm };

        const clauses = toArray(expr);
        let result: any = undefined; 
        for (let i = clauses.length - 1; i >= 0; i--) {
            const clause = clauses[i];
            if (!(clause instanceof Cons) || !(clause.cdr instanceof Cons)) {
                throw new Error(`cond clause must be a list of at least 2 elements: (condition expr...)`);
            }

            const condition = clause.car;
            const resultExpr = wrapMulti(clause.cdr);

            if (condition === OP_ELSE) {
                if (i !== clauses.length - 1) throw new Error("else must be the final clause in a cond statement");
                result = resultExpr;
            } else {
                result = list(OP_IF, condition, resultExpr, result);
            }
        }
        return { expanded: result, state: TransformState.Recurse };
    });

    evaluator.registerTransform(OP_LET, (evaluator, expr, orig) => {        
        if (!(orig instanceof Cons) || orig.length < 3) throw new Error(`let bad syntax`);

        let loopName: symbol | null = null;
        let bindingsCons: any = expr.car;
        let bodyCons: any = expr.cdr;

        if (typeof expr.car === "symbol") {
            loopName = expr.car;
            bindingsCons = cadr(expr);
            bodyCons = cddr(expr);
            if (orig.length < 4) throw new Error(`named let must include bindings and a body`);
        }

        if (bindingsCons !== null && !(bindingsCons instanceof Cons)) {
            throw new Error(`${loopName ? "named let" : "let"} bindings must be a list of form ((var expr)...)`);
        }

        const bindings = toArray(bindingsCons);
        const params: symbol[] = [];
        const exprs: any[] = [];

        for (const binding of bindings) {
            if (!(binding instanceof Cons) || !(binding.cdr instanceof Cons) || binding.cdr.cdr !== null) {
                throw new Error(`let binding bad syntax`);
            }
            if (typeof binding.car !== "symbol") throw new Error("let binding name must be a symbol");
            params.push(binding.car);
            exprs.push(binding.cdr.car);
        }

        const paramsList = fromArray(params);
        const exprsList = fromArray(exprs);

        if (loopName) {
            const loop = namedLetAsLoop(evaluator, loopName, params, exprs, bodyCons);
            if (loop !== null) return { expanded: loop, state: TransformState.ReturnImm };
            const lambdaExpr = cons(OP_LAMBDA, cons(paramsList, bodyCons));
            const letrecBindings = list(list(loopName, lambdaExpr));
            const letrecExpr = list(OP_LETREC, letrecBindings, loopName);
            const namedLetExpr = cons(letrecExpr, exprsList);
            return { expanded: namedLetExpr, state: TransformState.Recurse };
        }
        
        return { expanded: cons(CORE_LET, cons(fromArray(params.map((p, i) => list(p, exprs[i]))), bodyCons)), state: TransformState.Recurse };
    });

    evaluator.registerTransform(OP_LETSTAR, (evaluator, expr, orig) => {
        if (!(orig instanceof Cons) || orig.length < 3) throw new Error(`let*: bad syntax`);
        const bindingsCons = expr.car;
        const body = expr.cdr;

        if (bindingsCons !== null && !(bindingsCons instanceof Cons)) {
            throw new Error(`let* bindings must be a list of form ((var expr)...)`);
        }

        // No bindings
        if (bindingsCons === null) {
            return { expanded: cons(CORE_LET, cons(null, body)), state: TransformState.Recurse };
        }

        const bindings = toArray(bindingsCons);
        let currentExpr = body; 
        for (let i = bindings.length - 1; i >= 0; i--) {
            const binding = bindings[i];
            if (!(binding instanceof Cons) || !(binding.cdr instanceof Cons) || binding.cdr.cdr !== null) {
                throw new Error(`let* binding bad syntax`);
            }
            if (typeof binding.car !== "symbol") throw new Error("let* binding name must be a symbol");
            currentExpr = list(cons(CORE_LET, cons(list(list(binding.car, binding.cdr.car)), currentExpr)));
        }
        return { expanded: currentExpr.car, state: TransformState.Recurse };
    });

    evaluator.registerTransform(OP_LETREC, (evaluator, expr, orig) => {
        if (!(orig instanceof Cons) || orig.length < 3) throw new Error(`letrec: bad syntax`);
        const bindingsCons = expr.car;
        const body = expr.cdr;

        if (bindingsCons !== null && !(bindingsCons instanceof Cons)) {
            throw new Error(`letrec bindings must be a list of form ((var expr)...)`);
        }

        const bindings = toArray(bindingsCons);
        const params: symbol[] = [];
        const setExprs: any[] = [];  

        for (const binding of bindings) {
            if (!(binding instanceof Cons) || !(binding.cdr instanceof Cons) || binding.cdr.cdr !== null) {
                throw new Error(`letrec binding bad syntax`);
            }

            if (typeof binding.car !== "symbol") throw new Error("letrec binding name must be a symbol");
            params.push(binding.car);
            setExprs.push(list(OP_SET, binding.car, binding.cdr.car)); 
        }

        const allBody = fromArray([...setExprs, ...toArray(body)]);
        return { expanded: cons(CORE_LET, cons(fromArray(params.map(p => list(p, undefined))), allBody)), state: TransformState.Recurse };
    });

    evaluator.registerTransform(OP_DEFINE, (evaluator, expr, orig) => {
        const normalized = normalizeDefine(orig);
        const sym = normalized.cdr.car;
        const val = normalized.cdr.cdr.car;
        return {
            expanded: list(OP_DEFINE_GLOBAL, sym, val),
            state: TransformState.Recurse
        };
    });

    evaluator.registerTransform(OP_DEFINE_GLOBAL, (evaluator, expr, orig) => {
        if (!(orig instanceof Cons) || orig.length !== 3) {
            throw new Error("%define-global syntax error: expected (%define-global var value)");
        }
        const sym = expr.car;
        if (typeof sym !== "symbol") {
            throw new Error("%define-global syntax error: variable must be a symbol");
        }
        return {
            expanded: orig,
            state: TransformState.DoChildren
        };
    });

    const lambdaTransform = (evaluator: MacroEvaluator, expr: any, orig: any) => {
        if (!(orig instanceof Cons) || orig.length < 3) throw new Error(`lambda syntax error`);
        const args = expr.car;
        return lowerBody(evaluator, expr.cdr, "lambda", body => cons(CORE_LAMBDA, cons(args, body)));
    };
    evaluator.registerTransform(OP_LAMBDA, lambdaTransform);
    evaluator.registerTransform(CORE_LAMBDA, lambdaTransform);

    evaluator.registerTransform(OP_AND, (evaluator, expr, orig) => {
        if (expr === null) {
            return { expanded: true, state: TransformState.ReturnImm };
        }
        if (expr.cdr === null) {
            return { expanded: expr.car, state: TransformState.Recurse };
        }

        const args = toArray(expr);
        let result = args[args.length - 1];

        for (let i = args.length - 2; i >= 0; i--) {
            result = list(OP_IF, args[i], result, false);
        }

        return { expanded: result, state: TransformState.Recurse };
    });

    evaluator.registerTransform(OP_OR, (evaluator, expr, orig) => {
        if (expr === null) {
            return { expanded: false, state: TransformState.ReturnImm };
        }
        if (expr.cdr === null) {
            return { expanded: expr.car, state: TransformState.Recurse };
        }

        const args = toArray(expr);
        let result = args[args.length - 1];

        for (let i = args.length - 2; i >= 0; i--) {
            const tmp = Symbol("or_tmp");
            result = list(
                OP_LET,
                list(list(tmp, args[i])),
                list(OP_IF, tmp, tmp, result)
            );
        }

        return { expanded: result, state: TransformState.Recurse };
    });

    // (anima-macro onsym macrofn)
    evaluator.registerTransform(Symbol.for("anima-macro"), (evaluator, expr, orig) => {
        if (!(orig instanceof Cons) || orig.length < 3) throw new Error(`anima-macro syntax error`);
        let onsym = expr.car;
        if (typeof onsym !== "symbol") throw new Error(`anima-macro onsym must be a constant symbol right now`);
        let cmpexpr = list(OP_LAMBDA, list(Symbol.for("orig")), expr.cdr.car);
        let trCmpExpr = evaluator.transform(cmpexpr);
        let cmpExprBc = evaluator.expandcmp.compile(trCmpExpr);
        const res: AbstractClosure = evaluator.expandvm.evaluateRaw(cmpExprBc, evaluator.scope);
        evaluator.registerTransform(onsym, (evaluator, expr, orig) => {
            const resp = evaluator.expandvm.evaluateClosure(res, evaluator.scope, [orig]);
            return { expanded: resp, state: TransformState.Recurse };
        });

        return { expanded: undefined, state: TransformState.ReturnImm };
    });

    evaluator.registerTransform(Symbol.for("guard"), (evaluator, expr, orig) => {
        if (!(orig instanceof Cons) || orig.length < 3) {
            throw new Error("guard syntax error: expected (guard (var clause ...) body ...)");
        }
        if (!(expr.car instanceof Cons)) {
            throw new Error("guard syntax error: expected (var clause ...)");
        }
        const varSym = expr.car.car;
        if (typeof varSym !== "symbol") {
            throw new Error("guard syntax error: variable must be a symbol");
        }

        const rawClauses = toArray(expr.car.cdr);
        const lastClause = rawClauses.length > 0 ? rawClauses[rawClauses.length - 1] : null;
        const hasElse = lastClause instanceof Cons && lastClause.car === OP_ELSE;

        const guard_k = Symbol("guard_k");
        const guard_r = Symbol("guard_r");
        const guard_err = Symbol("guard_err");
        const guard_val = Symbol("guard_val");

        const condClauses: any[] = [...rawClauses];
        if (!hasElse) {
            condClauses.push(
                list(
                    OP_ELSE,
                    list(
                        guard_r,
                        list(OP_LAMBDA, null, list(Symbol.for("raise-continuable"), guard_err))
                    )
                )
            );
        }

        const thunkBody = list(
            OP_LET,
            list(list(varSym, guard_err)),
            list(OP_COND, ...condClauses)
        );

        const handlerBody = list(
            list(
                Symbol.for("call/cc"),
                list(
                    OP_LAMBDA,
                    list(guard_r),
                    list(guard_k, list(OP_LAMBDA, null, thunkBody))
                )
            )
        );

        const bodyExprs = toArray(expr.cdr);
        const bodyLambda = list(
            OP_LAMBDA,
            null,
            list(
                OP_LET,
                list(list(guard_val, wrapMulti(fromArray(bodyExprs)))),
                list(OP_LAMBDA, null, guard_val)
            )
        );

        const expanded = list(
            list(
                Symbol.for("call/cc"),
                list(
                    OP_LAMBDA,
                    list(guard_k),
                    list(
                        Symbol.for("with-exception-handler"),
                        list(OP_LAMBDA, list(guard_err), handlerBody),
                        bodyLambda
                    )
                )
            )
        );

        return { expanded, state: TransformState.Recurse };
    });

    evaluator.registerTransform(Symbol.for("call/cc"), (evaluator, expr, orig) => {
        return { expanded: cons(Symbol.for("%call/cc"), expr), state: TransformState.DoChildren };
    });

    evaluator.registerTransform(Symbol.for("call-with-current-continuation"), (evaluator, expr, orig) => {
        return { expanded: cons(Symbol.for("%call/cc"), expr), state: TransformState.DoChildren };
    });

    evaluator.registerTransform(Symbol.for("apply"), (evaluator, expr, orig) => {
        return { expanded: cons(Symbol.for("%apply"), expr), state: TransformState.DoChildren };
    });

    evaluator.registerTransform(Symbol.for("dynamic-wind"), (evaluator, expr, orig) => {
        return { expanded: cons(Symbol.for("%dynamic-wind"), expr), state: TransformState.DoChildren };
    });

    for (const name of ["list", "cons", "vector-ref", "vector-set!", "vector-length", "table-ref", "table-set!", "table-has?", "table-border", "coroutine-create", "coroutine-resume", "coroutine-yield", "coroutine-status", "coroutine-close"]) {
        evaluator.registerTransform(Symbol.for(name), (evaluator, expr, orig) => {
            return { expanded: cons(Symbol.for(`%${name}`), expr), state: TransformState.DoChildren };
        });
    }

    evaluator.registerTransform(Symbol.for("receive"), (evaluator, expr, orig) => {
        if (!(orig instanceof Cons) || orig.length < 4) throw new Error("receive must be of form (receive formals expr body...)");
        return { expanded: cons(CORE_LET_VALUES_STRICT, cons(list(list(expr.car, cadr(expr))), cddr(expr))), state: TransformState.Recurse };
    });

    // receive / let-values / let*-values keep Scheme's strict value counts; use %let-values for Lua-style padding
    evaluator.registerTransform(Symbol.for("let*-values"), (evaluator, expr, orig) => {
        if (!(orig instanceof Cons) || orig.length < 3) throw new Error("let*-values must be of form (let*-values (clause...) body...)");
        const clauses = toArray(expr.car);
        if (clauses.length === 0) return { expanded: cons(CORE_LET, cons(null, expr.cdr)), state: TransformState.Recurse };
        let inner: any = expr.cdr;
        for (let i = clauses.length - 1; i >= 0; i--) inner = list(cons(CORE_LET_VALUES_STRICT, cons(list(clauses[i]), inner)));
        return { expanded: inner.car, state: TransformState.Recurse };
    });

    evaluator.registerTransform(Symbol.for("let-values"), (evaluator, expr, orig) => {
        if (!(orig instanceof Cons) || orig.length < 3) throw new Error("let-values must be of form (let-values (clause...) body...)");
        return { expanded: cons(CORE_LET_VALUES_STRICT, expr), state: TransformState.Recurse };
    });

    for (const [name] of [...CXR_PATHS, ...PREDICATES, ...ARITHMETIC]) {
        evaluator.registerTransform(Symbol.for(name), (evaluator, expr, orig) => {
            return { expanded: cons(Symbol.for(`%${name}`), expr), state: TransformState.DoChildren };
        });
    }
};
