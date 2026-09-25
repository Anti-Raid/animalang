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
    AbstractClosure,
    Cons
} from "../common";
import { MacroEvaluator, TransformState } from "./macro";
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
    coreForm(OP_SET, CORE_SET, orig => {
        if (orig.length !== 3) throw new Error(`set! must have 2 arguments`);
        if (typeof orig.cdr.car !== "symbol") throw new Error(`${String(orig.cdr.car)} not symbol`);
        ensureCanBind(orig.cdr.car, undefined, "set!");
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
            const lambdaExpr = cons(OP_LAMBDA, cons(paramsList, bodyCons));
            const letrecBindings = list(list(loopName, lambdaExpr));
            const letrecExpr = list(OP_LETREC, letrecBindings, loopName);
            const namedLetExpr = cons(letrecExpr, exprsList);
            return { expanded: namedLetExpr, state: TransformState.Recurse };
        }
        
        const lambdaExpr = cons(OP_LAMBDA, cons(paramsList, bodyCons));
        return { expanded: cons(lambdaExpr, exprsList), state: TransformState.Recurse };
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
            return { expanded: list(cons(OP_LAMBDA, cons(null, body))), state: TransformState.Recurse };
        }

        const bindings = toArray(bindingsCons);
        let currentExpr = body; 
        for (let i = bindings.length - 1; i >= 0; i--) {
            const binding = bindings[i];
            if (!(binding instanceof Cons) || !(binding.cdr instanceof Cons) || binding.cdr.cdr !== null) {
                throw new Error(`let* binding bad syntax`);
            }
            if (typeof binding.car !== "symbol") throw new Error("let* binding name must be a symbol");
            const lambda = cons(OP_LAMBDA, cons(list(binding.car), currentExpr));
            currentExpr = list(list(lambda, binding.cdr.car));
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
        const dummyVals: any[] = []; 
        const setExprs: any[] = [];  

        for (const binding of bindings) {
            if (!(binding instanceof Cons) || !(binding.cdr instanceof Cons) || binding.cdr.cdr !== null) {
                throw new Error(`letrec binding bad syntax`);
            }

            if (typeof binding.car !== "symbol") throw new Error("letrec binding name must be a symbol");
            params.push(binding.car);
            dummyVals.push(undefined); 
            setExprs.push(list(OP_SET, binding.car, binding.cdr.car)); 
        }

        const allBody = fromArray([...setExprs, ...toArray(body)]);
        const lambdaExpr = cons(OP_LAMBDA, cons(fromArray(params), allBody));
        return { expanded: cons(lambdaExpr, fromArray(dummyVals)), state: TransformState.Recurse };
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
        const rawBody = removeBegin(expr.cdr);
        if (rawBody === null) throw new Error("lambda body must contain at least one expression");

        const defines: any[] = [];
        const body: any[] = [];

        let curr: any = rawBody;
        while (curr instanceof Cons) {
            const stmt = curr.car;
            if (stmt instanceof Cons && stmt.car === OP_DEFINE) {
                const normalizedStmt = normalizeDefine(stmt);
                defines.push(list(normalizedStmt.cdr.car, normalizedStmt.cdr.cdr.car));
            } else {
                body.push(stmt);
            }
            curr = curr.cdr;
        }

        if (defines.length === 0) {
            const transformedBody = fromArray(toArray(rawBody).map(stmt => evaluator.transform(stmt)));
            return { expanded: cons(CORE_LAMBDA, cons(args, transformedBody)), state: TransformState.ReturnImm };
        }

        if (body.length === 0) {
            throw new Error("lambda body must contain at least one expression after internal/local defines etc.");
        }

        // Keep the outer lambda and put the letrec inside its body!
        const letrecExpr = cons(OP_LETREC, cons(fromArray(defines), fromArray(body)));
        return { 
            expanded: list(OP_LAMBDA, args, letrecExpr), 
            state: TransformState.Recurse 
        };
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

    for (const name of ["list", "cons", "vector-ref", "vector-set!", "vector-length", "coroutine-create", "coroutine-resume", "coroutine-yield", "coroutine-status", "coroutine-close"]) {
        evaluator.registerTransform(Symbol.for(name), (evaluator, expr, orig) => {
            return { expanded: cons(Symbol.for(`%${name}`), expr), state: TransformState.DoChildren };
        });
    }

    const callWithValues = (producerExpr: any, formals: any, body: any) =>
        list(Symbol.for("call-with-values"), list(OP_LAMBDA, null, producerExpr), cons(OP_LAMBDA, cons(formals, body)));

    const valuesClause = (clause: any, form: string): [any, any] => {
        if (!(clause instanceof Cons) || !(clause.cdr instanceof Cons) || clause.cdr.cdr !== null) {
            throw new Error(`${form} clause must be of form (formals expr)`);
        }
        return [clause.car, clause.cdr.car];
    };

    evaluator.registerTransform(Symbol.for("receive"), (evaluator, expr, orig) => {
        if (!(orig instanceof Cons) || orig.length < 4) throw new Error("receive must be of form (receive formals expr body...)");
        return { expanded: callWithValues(cadr(expr), expr.car, cddr(expr)), state: TransformState.Recurse };
    });

    evaluator.registerTransform(Symbol.for("let*-values"), (evaluator, expr, orig) => {
        if (!(orig instanceof Cons) || orig.length < 3) throw new Error("let*-values must be of form (let*-values (clause...) body...)");
        const clauses = toArray(expr.car);
        const body = expr.cdr;
        if (clauses.length === 0) return { expanded: cons(OP_LET, cons(null, body)), state: TransformState.Recurse };
        const [formals, init] = valuesClause(clauses[0], "let*-values");
        const rest = cons(Symbol.for("let*-values"), cons(fromArray(clauses.slice(1)), body));
        return { expanded: callWithValues(init, formals, list(rest)), state: TransformState.Recurse };
    });

    evaluator.registerTransform(Symbol.for("let-values"), (evaluator, expr, orig) => {
        if (!(orig instanceof Cons) || orig.length < 3) throw new Error("let-values must be of form (let-values (clause...) body...)");
        const renames: any[] = [];
        const rename = (formals: any): any => {
            if (formals === null) return null;
            if (typeof formals === "symbol") {
                const tmp = Symbol(`lv_${formals.description}`);
                renames.push(list(formals, tmp));
                return tmp;
            }
            if (formals instanceof Cons) return cons(rename(formals.car), rename(formals.cdr));
            throw new Error("let-values formals must be symbols");
        };
        const clauses = toArray(expr.car).map(c => valuesClause(c, "let-values")).map(([formals, init]) => [rename(formals), init]);
        let inner: any = cons(OP_LET, cons(fromArray(renames), expr.cdr));
        for (let i = clauses.length - 1; i >= 0; i--) {
            inner = callWithValues(clauses[i][1], clauses[i][0], list(inner));
        }
        return { expanded: inner, state: TransformState.Recurse };
    });

    for (const [name] of [...CXR_PATHS, ...PREDICATES, ...ARITHMETIC]) {
        evaluator.registerTransform(Symbol.for(name), (evaluator, expr, orig) => {
            return { expanded: cons(Symbol.for(`%${name}`), expr), state: TransformState.DoChildren };
        });
    }
};
