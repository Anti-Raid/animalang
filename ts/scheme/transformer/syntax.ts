import {
    ensureCanBind as ensureCanBindCore,
    VMError,
    OP_DEFINE_GLOBAL,
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
    CORE_LETREC,
    CORE_LET_STAR,
    CORE_WITH_MARK,
    CORE_CATCH,
    OP_RAISE,
    OP_CURRENT_MARKS,
    OP_CURRENT_STACK,
    SOURCE_POS,
} from "../../common";
import { Cons } from "../list";
import { toCore } from "../core";
import { schemeFormat } from "../messages";
import { MacroEvaluator, TransformState, type TransformResult } from "./macro";
import { OP_CASE_LAMBDA, OP_DEFINE, OP_BEGIN, OP_LAMBDA, OP_LET, OP_IF, OP_COND, OP_ELSE, OP_SET, OP_LETREC, OP_LETREC_STAR, OP_LETSTAR, OP_AND, OP_OR, OP_QUOTE } from "../symbols";
import { SCHEME_ALIASES } from "../builtins";
import type { Closure } from "../../bytecode-rvm/exec";

const OP_APPLY = Symbol.for("apply");

const ensureCanBind = (param: any, seen: Set<symbol> | undefined, ctx: string) => {
    try {
        ensureCanBindCore(param, seen, ctx);
    } catch (err) {
        throw err instanceof VMError ? err.format(schemeFormat) : err;
    }
};
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

const OP_DEFINE_VALUES = Symbol.for("define-values");
const OP_ARROW = Symbol.for("=>");

// (define-values formals expr): the values go into a hidden vector, then each variable is defined from it, so in a body
// they are letrec* bindings in order like any define
const defineValues = (orig: any): any[] => {
    if (!(orig instanceof Cons) || orig.length !== 3) throw new Error("define-values must be of form (define-values formals expr)");
    const formals = orig.cdr.car;
    const names: any[] = [];
    let rest: any = formals;
    for (; rest instanceof Cons; rest = rest.cdr) names.push(rest.car);
    if (rest !== null && typeof rest !== "symbol") throw new Error("define-values: bad formals");
    const all = rest === null ? names : [...names, rest];
    const temps = all.map(() => Symbol("value"));
    let tempFormals: any = rest === null ? null : temps[temps.length - 1];
    for (let i = names.length - 1; i >= 0; i--) tempFormals = cons(temps[i], tempFormals);
    const vec = Symbol("values");
    return [
        list(OP_DEFINE, vec, list(Symbol.for("receive"), tempFormals, orig.cdr.cdr.car, cons(Symbol.for("vector"), fromArray(temps)))),
        ...all.map((name, i) => list(OP_DEFINE, name, list(Symbol.for("vector-ref"), vec, i))),
    ];
};

// a body (of a lambda or let) with internal defines gets them as a letrec; `build(body, done)` makes the form around
// it, `done` saying whether the body is already transformed (otherwise the result is transformed again)
const lowerBody = (evaluator: MacroEvaluator, rawBody: any, form: string, build: (body: any, done: boolean) => any): TransformResult => {
    const flat = removeBegin(rawBody);
    if (flat === null) throw new Error(`${form} body must contain at least one expression`);

    const defines: any[] = [];
    const body: any[] = [];
    for (const stmt of toArray(flat).flatMap(stmt => stmt instanceof Cons && stmt.car === OP_DEFINE_VALUES ? defineValues(stmt) : [stmt])) {
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
                // conditions are values, branches (and the final else) are in the %if's tail position
                const args = e.toArray().slice(1);
                const isBranch = (i: number) => i % 2 === 1 || i === args.length - 1;
                return keepPos(cons(CORE_IF, fromArray(args.map((a, i) => rw(a, tail && isBranch(i), blocks)))), e);
            }
            case CORE_BEGIN:
                return keepPos(cons(CORE_BEGIN, seq(e.cdr, tail, blocks)), e);
            case CORE_SET:
                if (e.cdr.car === name) throw NOT_A_LOOP;
                return keepPos(list(CORE_SET, e.cdr.car, rw(e.cdr.cdr.car, false, blocks)), e);
            case OP_DEFINE_GLOBAL:
                return keepPos(list(op, e.cdr.car, rw(e.cdr.cdr.car, false, blocks)), e);
            case CORE_LET_STAR: {
                // each init sees the names before it: once one is the loop's, the rest are left alone
                const bindings = toArray(e.cdr.car);
                const at = bindings.findIndex(b => b.car === name);
                const newBindings = bindings.map((b, i) => at !== -1 && i > at ? b : list(b.car, rw(b.cdr.car, false, blocks)));
                return keepPos(cons(op, cons(fromArray(newBindings), at !== -1 ? e.cdr.cdr : seq(e.cdr.cdr, tail, blocks))), e);
            }
            case CORE_LETREC: {
                // the names are in scope in the inits (lambdas) too
                const bindings = toArray(e.cdr.car);
                if (bindings.some(b => b.car === name)) return e;
                const newBindings = bindings.map(b => list(b.car, rw(b.cdr.car, false, blocks)));
                return keepPos(cons(op, cons(fromArray(newBindings), seq(e.cdr.cdr, tail, blocks))), e);
            }
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
            // every value is computed before any carrier is assigned (the last one first, from its value, the others from
            // temporaries), so no carrier is assigned before a call and read after it: it needs no box, and a continuation
            // captured in the loop keeps each iteration's values, as a named let's fresh bindings would
            const vals = args.map(a => rw(a, false, blocks));
            const temps = vals.slice(0, -1).map(() => Symbol("arg"));
            const sets = [
                ...(vals.length > 0 ? [list(CORE_SET, carriers[vals.length - 1], vals[vals.length - 1])] : []),
                ...temps.map((t, i) => list(CORE_SET, carriers[i], t)),
            ];
            const jump = cons(CORE_BEGIN, fromArray([...sets, list(CORE_ESCAPE, next)]));
            return keepPos(temps.length === 0 ? jump : list(CORE_LET, fromArray(temps.map((t, i) => list(t, vals[i]))), jump), e);
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

    evaluator.registerTransform(OP_IF, lowerTo(CORE_IF, orig => {
        if (orig.length !== 4) {
            throw new Error(`if condition must be in format ["if", condition, true_expr, false_expr] but only have ${orig.length - 1} arguments`);
        }
    }));
    // (%if c1 e1 c2 e2 ... [else]), e.g. from a transpiler's if/elseif/else
    evaluator.registerTransform(CORE_IF, lowerTo(CORE_IF, orig => {
        if (orig.length < 3) throw new Error(`%if requires at least a condition and a branch: (%if c1 e1 c2 e2 ... [else])`);
    }));
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
        const current = list(OP_CURRENT_MARKS);
        const setExpr = set === false ? current : (() => {
            const tmp = Symbol("marks");
            return list(CORE_LET, list(list(tmp, set)), list(CORE_IF, tmp, tmp, current));
        })();
        return { expanded: list(Symbol.for("%marks-first"), setExpr, key, args.length === 3 ? none : false), state: TransformState.Recurse };
    });
    evaluator.registerTransform(Symbol.for("current-continuation-marks"), lowerTo(OP_CURRENT_MARKS, orig => {
        if (orig.length !== 1) throw new Error("current-continuation-marks takes no arguments");
    }));
    // direct calls take the snapshot in the caller itself, so no prelude frame shows in it
    for (const name of ["debug-frames", "debug-traceback"]) {
        evaluator.registerTransform(Symbol.for(name), (evaluator, expr, orig) => {
            const call = name === "debug-frames"
                ? list(Symbol.for("%debug-frames"), list(OP_CURRENT_STACK), cons(Symbol.for("%vector"), expr), false)
                : list(Symbol.for("%debug-traceback"), list(OP_CURRENT_STACK), cons(Symbol.for("%vector"), expr));
            return { expanded: name === "debug-frames" ? list(Symbol.for("%vector->list"), call) : call, state: TransformState.DoChildren };
        });
    }
    evaluator.registerTransform(Symbol.for("current-coroutine"), (evaluator, expr) => {
        if (toArray(expr).length !== 0) throw new Error("current-coroutine takes no arguments");
        return { expanded: list(Symbol.for("%current-coroutine"), false), state: TransformState.Recurse };
    });
    evaluator.registerTransform(OP_CURRENT_MARKS, lowerTo(OP_CURRENT_MARKS, orig => {
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

    evaluator.registerTransform(CORE_LETREC, (evaluator, expr, orig) => {
        if (!(orig instanceof Cons) || orig.length < 3) throw new Error(`letrec bad syntax`);
        const bindings = letBindings("letrec", expr.car);
        return lowerBody(evaluator, expr.cdr, "letrec", (body, done) => {
            const inits = bindings.map(([name, init]) => list(name, done ? evaluator.transform(init) : init));
            return cons(CORE_LETREC, cons(fromArray(inits), body));
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

        // (test => proc) and (test) clauses need the test's value: those conds nest, from the last clause back
        if (toArray(expr).some(clause => clause instanceof Cons && (clause.cdr === null || cadr(clause) === OP_ARROW))) {
            const clauses = toArray(expr);
            let tail: any = undefined;
            for (let i = clauses.length - 1; i >= 0; i--) {
                const clause = clauses[i];
                if (!(clause instanceof Cons)) throw new Error("cond clause must be a list: (test expr ...), (test => proc) or (test)");
                if (clause.car === OP_ELSE) {
                    if (i !== clauses.length - 1) throw new Error("else must be the final clause in a cond statement");
                    tail = wrapMulti(clause.cdr);
                } else if (clause.cdr === null) {
                    tail = list(OP_OR, clause.car, tail);
                } else if (cadr(clause) === OP_ARROW) {
                    if (cddr(clause) === null || cddr(clause).cdr !== null) throw new Error("cond: expected (test => proc)");
                    const t = Symbol("test");
                    tail = list(OP_LET, list(list(t, clause.car)), list(CORE_IF, t, list(car(cddr(clause)), t), tail));
                } else {
                    tail = list(CORE_IF, clause.car, wrapMulti(clause.cdr), tail);
                }
            }
            return { expanded: tail, state: TransformState.Recurse };
        }

        // one flat (%if c1 e1 c2 e2 ... [else]), however many clauses
        const clauses = toArray(expr);
        const args: any[] = [];
        for (let i = 0; i < clauses.length; i++) {
            const clause = clauses[i];
            if (!(clause instanceof Cons) || !(clause.cdr instanceof Cons)) {
                throw new Error(`cond clause must be a list of at least 2 elements: (condition expr...)`);
            }
            if (clause.car === OP_ELSE) {
                if (i !== clauses.length - 1) throw new Error("else must be the final clause in a cond statement");
                args.push(wrapMulti(clause.cdr));
            } else {
                args.push(clause.car, wrapMulti(clause.cdr));
            }
        }
        // a cond of only an else clause is just its body
        if (args.length === 1) return { expanded: args[0], state: TransformState.Recurse };
        return { expanded: cons(CORE_IF, fromArray(args)), state: TransformState.Recurse };
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

        if (loopName) {
            const loop = namedLetAsLoop(evaluator, loopName, params, exprs, bodyCons);
            if (loop !== null) return { expanded: loop, state: TransformState.ReturnImm };
            // the initial values are evaluated outside the letrec (fresh names hold them), so the procedure is only ever
            // called, which lets it be lifted
            const lambdaExpr = cons(OP_LAMBDA, cons(paramsList, bodyCons));
            const temps = exprs.map(() => Symbol("init"));
            const letrecExpr = list(OP_LETREC, list(list(loopName, lambdaExpr)), cons(loopName, fromArray(temps)));
            return { expanded: list(OP_LET, fromArray(temps.map((t, i) => list(t, exprs[i]))), letrecExpr), state: TransformState.Recurse };
        }
        
        return { expanded: cons(CORE_LET, cons(fromArray(params.map((p, i) => list(p, exprs[i]))), bodyCons)), state: TransformState.Recurse };
    });

    evaluator.registerTransform(OP_LETSTAR, (evaluator, expr, orig) => {
        if (!(orig instanceof Cons) || orig.length < 3) throw new Error(`let*: bad syntax`);
        letBindings("let*", expr.car);
        return { expanded: cons(CORE_LET_STAR, expr), state: TransformState.Recurse };
    });

    evaluator.registerTransform(CORE_LET_STAR, (evaluator, expr, orig) => {
        if (!(orig instanceof Cons) || orig.length < 3) throw new Error(`let* bad syntax`);
        const bindings = letBindings("let*", expr.car);
        return lowerBody(evaluator, expr.cdr, "let*", (body, done) => {
            const inits = bindings.map(([name, init]) => list(name, done ? evaluator.transform(init) : init));
            return cons(CORE_LET_STAR, cons(fromArray(inits), body));
        });
    });

    // %letrec runs the inits in order, so letrec and letrec* are the same
    for (const [op, form] of [[OP_LETREC, "letrec"], [OP_LETREC_STAR, "letrec*"]] as const) {
        evaluator.registerTransform(op, (evaluator, expr, orig) => {
            if (!(orig instanceof Cons) || orig.length < 3) throw new Error(`${form}: bad syntax`);
            letBindings(form, expr.car);
            return { expanded: cons(CORE_LETREC, expr), state: TransformState.Recurse };
        });
    }

    evaluator.registerTransform(OP_DEFINE, (evaluator, expr, orig) => {
        const normalized = normalizeDefine(orig);
        const sym = normalized.cdr.car;
        const val = normalized.cdr.cdr.car;
        return {
            expanded: list(OP_DEFINE_GLOBAL, sym, val),
            state: TransformState.Recurse
        };
    });

    evaluator.registerTransform(OP_DEFINE_VALUES, (evaluator, expr, orig) => ({ expanded: cons(OP_BEGIN, fromArray(defineValues(orig))), state: TransformState.Recurse }));

    // (case-lambda (formals body ...) ...)
    evaluator.registerTransform(Symbol.for("case-lambda"), (evaluator, expr, orig) => {
        const clauses = toArray(expr);
        if (clauses.length === 0 || clauses.some(c => !(c instanceof Cons) || !(c.cdr instanceof Cons))) throw new Error("case-lambda must be of form (case-lambda (formals body ...) ...)");
        return { expanded: cons(OP_CASE_LAMBDA, fromArray(clauses.map(c => cons(OP_LAMBDA, c)))), state: TransformState.Recurse };
    });
    evaluator.registerTransform(OP_CASE_LAMBDA, (evaluator, expr, orig) => ({ expanded: orig, state: TransformState.DoChildren }));

    // (reset e ...) and (shift k e ...) under the default prompt tag: shift aborts to the reset with a thunk that runs
    // its body, where k reinstates the continuation up to the reset, itself inside a reset
    const defaultTag = () => list(Symbol.for("default-continuation-prompt-tag"));
    evaluator.registerTransform(Symbol.for("reset"), (evaluator, expr, orig) => {
        if (!(orig instanceof Cons) || orig.length < 2) throw new Error("reset must be of form (reset expr ...)");
        const thunk = Symbol("thunk");
        return { expanded: list(Symbol.for("%call-with-prompt"), defaultTag(), cons(OP_LAMBDA, cons(null, expr)), list(OP_LAMBDA, list(thunk), list(thunk))), state: TransformState.Recurse };
    });
    evaluator.registerTransform(Symbol.for("shift"), (evaluator, expr, orig) => {
        if (!(orig instanceof Cons) || orig.length < 3 || typeof expr.car !== "symbol") throw new Error("shift must be of form (shift k expr ...)");
        const k = Symbol("k"), vals = Symbol("vals");
        const reinstate = list(OP_LAMBDA, vals, list(Symbol.for("reset"), list(Symbol.for("apply"), k, vals)));
        const body = list(OP_LAMBDA, null, cons(OP_LET, cons(list(list(expr.car, reinstate)), expr.cdr)));
        const capture = list(OP_LAMBDA, list(k), list(Symbol.for("%abort"), defaultTag(), list(Symbol.for("vector"), body)));
        return { expanded: list(Symbol.for("%call/comp"), capture, defaultTag()), state: TransformState.Recurse };
    });

    // (map (lambda (x) body ...) lst), and the same with for-each and filter: a loop with the body inline, as the prelude's
    // procedures run it (the result built reversed, then copied in order), with no closure made or called
    const inlineOver = (name: string, loop: (l: symbol, acc: symbol, elem: symbol, body: any, next: symbol) => any) =>
        evaluator.registerTransform(Symbol.for(name), (evaluator, expr, orig) => {
            const f = car(expr);
            const oneParam = f instanceof Cons && f.car === OP_LAMBDA && f.cdr instanceof Cons && f.cdr.car instanceof Cons
                && typeof f.cdr.car.car === "symbol" && f.cdr.car.cdr === null && f.cdr.cdr instanceof Cons;
            if (!(orig instanceof Cons) || orig.length !== 3 || !oneParam) return { expanded: orig, state: TransformState.DoChildren };
            const l = Symbol("list"), acc = Symbol("acc"), next = Symbol("loop");
            const body = cons(OP_LET, cons(null, f.cdr.cdr));
            return { expanded: list(OP_LET, next, list(list(l, cadr(expr)), list(acc, null)), loop(l, acc, f.cdr.car.car, body, next)), state: TransformState.Recurse };
        });
    const step = (l: symbol, elem: symbol, then: any) => list(OP_LET, list(list(elem, list(Symbol.for("car"), l))), then);
    const rest = (l: symbol) => list(Symbol.for("cdr"), l);
    inlineOver("map", (l, acc, x, body, next) =>
        list(CORE_IF, list(Symbol.for("null?"), l), list(Symbol.for("reverse"), acc), step(l, x, list(next, rest(l), list(Symbol.for("cons"), body, acc)))));
    inlineOver("for-each", (l, acc, x, body, next) =>
        list(CORE_IF, list(Symbol.for("null?"), l), undefined, step(l, x, list(OP_BEGIN, body, list(next, rest(l), acc)))));
    inlineOver("filter", (l, acc, x, body, next) =>
        list(CORE_IF, list(Symbol.for("null?"), l), list(Symbol.for("reverse"), acc), step(l, x, list(next, rest(l), list(CORE_IF, body, list(Symbol.for("cons"), x, acc), acc)))));

    // `x (R7RS quasiquote, nested levels too): lists and vectors are built with list, cons*, append and list->vector from
    // their parts, and any part with nothing unquoted in it stays a quoted constant
    const QUASIQUOTE = Symbol.for("quasiquote"), UNQUOTE = Symbol.for("unquote"), SPLICE = Symbol.for("unquote-splicing");
    const isForm = (x: any, sym: symbol) => x instanceof Cons && x.car === sym && x.length === 2;
    const unquotes = (x: any, depth: number): boolean => {
        if (Array.isArray(x)) return x.some(e => unquotes(e, depth));
        if (!(x instanceof Cons)) return false;
        if (isForm(x, UNQUOTE) || isForm(x, SPLICE)) return depth === 1 || unquotes(cadr(x), depth - 1);
        if (isForm(x, QUASIQUOTE)) return unquotes(cadr(x), depth + 1);
        return unquotes(x.car, depth) || unquotes(x.cdr, depth);
    };
    const quasi = (x: any, depth: number): any => {
        if (!unquotes(x, depth)) return list(OP_QUOTE, x);
        if (Array.isArray(x)) {
            // with nothing spliced, the vector is made directly from its elements
            if (depth > 1 || !x.some(e => isForm(e, SPLICE))) return cons(Symbol.for("vector"), fromArray(x.map(e => quasi(e, depth))));
            return list(Symbol.for("list->vector"), quasi(Cons.fromArray(x), depth));
        }
        if (isForm(x, UNQUOTE) && depth === 1) return cadr(x);
        if (isForm(x, SPLICE) && depth === 1) throw new Error("unquote-splicing: not in a list");
        // a nested one is its keyword and its operand, a list at the level inside (so a ,@ there splices into it)
        if (isForm(x, UNQUOTE) || isForm(x, SPLICE) || isForm(x, QUASIQUOTE)) {
            return list(Symbol.for("cons*"), list(OP_QUOTE, x.car), quasi(x.cdr, x.car === QUASIQUOTE ? depth + 1 : depth - 1));
        }
        // the elements, in runs of plain ones (a list, or a cons* onto what follows) and spliced ones, then the tail. From
        // the last element with something unquoted on, the rest of the list is constant, and shared as a quoted tail
        const segments: any[] = [];
        let run: any[] = [];
        let p: any = x;
        for (; p instanceof Cons && !isForm(p, UNQUOTE) && !isForm(p, SPLICE) && unquotes(p, depth); p = p.cdr) {
            if (depth === 1 && isForm(p.car, SPLICE)) {
                if (run.length > 0) segments.push(cons(Symbol.for("list"), fromArray(run)));
                run = [];
                segments.push(cadr(p.car));
            } else {
                run.push(quasi(p.car, depth));
            }
        }
        // (a . ,@x) splices nothing into anything
        if (depth === 1 && isForm(p, SPLICE)) throw new Error("unquote-splicing: not allowed in the tail of a list");
        const tail = p === null ? null : unquotes(p, depth) ? quasi(p, depth) : list(OP_QUOTE, p);
        if (segments.length === 0) return tail === null ? cons(Symbol.for("list"), fromArray(run)) : cons(Symbol.for("cons*"), fromArray([...run, tail]));
        const last = run.length === 0 ? tail : tail === null ? cons(Symbol.for("list"), fromArray(run)) : cons(Symbol.for("cons*"), fromArray([...run, tail]));
        // append checks the lists it copies; one spliced last is checked on its own, as it is shared rather than copied
        if (last === null) segments[segments.length - 1] = list(Symbol.for("%splice-list"), segments[segments.length - 1]);
        return cons(Symbol.for("append"), fromArray(last === null ? segments : [...segments, last]));
    };
    evaluator.registerTransform(QUASIQUOTE, (evaluator, expr, orig) => {
        if (!(orig instanceof Cons) || orig.length !== 2) throw new Error("quasiquote must be of form (quasiquote datum)");
        return { expanded: quasi(expr.car, 1), state: TransformState.Recurse };
    });
    for (const [sym, name] of [[UNQUOTE, "unquote"], [SPLICE, "unquote-splicing"]] as const) {
        evaluator.registerTransform(sym, () => { throw new Error(`${name}: not in a quasiquote`); });
    }

    evaluator.registerTransform(Symbol.for("when"), (evaluator, expr, orig) => {
        if (!(orig instanceof Cons) || orig.length < 3) throw new Error("when must be of form (when test expr ...)");
        return { expanded: list(CORE_IF, expr.car, cons(OP_BEGIN, expr.cdr)), state: TransformState.Recurse };
    });
    evaluator.registerTransform(Symbol.for("unless"), (evaluator, expr, orig) => {
        if (!(orig instanceof Cons) || orig.length < 3) throw new Error("unless must be of form (unless test expr ...)");
        return { expanded: list(CORE_IF, expr.car, undefined, cons(OP_BEGIN, expr.cdr)), state: TransformState.Recurse };
    });

    // (case key ((datum ...) expr ...) ... [(else expr ...)]), where a clause's exprs may be `=> proc`, called with the key
    evaluator.registerTransform(Symbol.for("case"), (evaluator, expr, orig) => {
        if (!(orig instanceof Cons) || orig.length < 2) throw new Error("case must be of form (case key clause ...)");
        const key = Symbol("key");
        const clauses = toArray(expr.cdr);
        const body = (clause: any) => {
            if (!(clause.cdr instanceof Cons)) throw new Error("case clause must be of form ((datum ...) expr ...)");
            if (clause.cdr.car !== OP_ARROW) return wrapMulti(clause.cdr);
            if (clause.cdr.cdr === null || clause.cdr.cdr.cdr !== null) throw new Error("case: expected ((datum ...) => proc)");
            return list(clause.cdr.cdr.car, key);
        };
        const args: any[] = [];
        clauses.forEach((clause, i) => {
            if (!(clause instanceof Cons)) throw new Error("case clause must be of form ((datum ...) expr ...)");
            if (clause.car === OP_ELSE) {
                if (i !== clauses.length - 1) throw new Error("else must be the final clause in a case");
                args.push(body(clause));
                return;
            }
            const test = cons(OP_OR, fromArray(toArray(clause.car).map(d => list(Symbol.for("eqv?"), key, list(OP_QUOTE, d)))));
            args.push(test, body(clause));
        });
        const dispatch = args.length === 0 ? undefined : args.length === 1 ? args[0] : cons(CORE_IF, fromArray(args));
        return { expanded: list(OP_LET, list(list(key, expr.car)), dispatch), state: TransformState.Recurse };
    });

    // (do ((var init [step]) ...) (test result ...) command ...): a named let
    evaluator.registerTransform(Symbol.for("do"), (evaluator, expr, orig) => {
        if (!(orig instanceof Cons) || orig.length < 3 || !(cadr(orig.cdr) instanceof Cons)) throw new Error("do must be of form (do ((var init [step]) ...) (test result ...) command ...)");
        const specs = toArray(expr.car).map(spec => {
            if (!(spec instanceof Cons) || !(spec.cdr instanceof Cons) || (spec.cdr.cdr !== null && spec.cdr.cdr.cdr !== null)) throw new Error("do: expected (var init [step])");
            return { name: spec.car, init: spec.cdr.car, step: spec.cdr.cdr === null ? spec.car : spec.cdr.cdr.car };
        });
        const loop = Symbol("do");
        const [test, ...results] = toArray(cadr(orig.cdr));
        const next = list(OP_BEGIN, ...toArray(cddr(expr)), cons(loop, fromArray(specs.map(s => s.step))));
        const done = results.length === 0 ? undefined : cons(OP_BEGIN, fromArray(results));
        return { expanded: list(OP_LET, loop, fromArray(specs.map(s => list(s.name, s.init))), list(CORE_IF, test, done, next)), state: TransformState.Recurse };
    });

    evaluator.registerTransform(Symbol.for("delay-force"), (evaluator, expr, orig) => {
        if (!(orig instanceof Cons) || orig.length !== 2) throw new Error("delay-force must be of form (delay-force expr)");
        return { expanded: list(Symbol.for("%make-lazy"), list(OP_LAMBDA, null, expr.car)), state: TransformState.Recurse };
    });
    evaluator.registerTransform(Symbol.for("delay"), (evaluator, expr, orig) => {
        if (!(orig instanceof Cons) || orig.length !== 2) throw new Error("delay must be of form (delay expr)");
        return { expanded: list(Symbol.for("%make-lazy"), list(OP_LAMBDA, null, list(Symbol.for("make-promise"), expr.car))), state: TransformState.Recurse };
    });

    // (parameterize ((param value) ...) body ...): the params and values are evaluated, then the values converted, then
    // the body runs with each param's continuation mark set
    evaluator.registerTransform(Symbol.for("parameterize"), (evaluator, expr, orig) => {
        if (!(orig instanceof Cons) || orig.length < 3) throw new Error("parameterize must be of form (parameterize ((param value) ...) body ...)");
        const bindings = toArray(expr.car).map(binding => {
            if (!(binding instanceof Cons) || !(binding.cdr instanceof Cons) || binding.cdr.cdr !== null) throw new Error("parameterize: expected (param value)");
            return { param: binding.car, value: binding.cdr.car, key: Symbol("key"), raw: Symbol("value"), conv: Symbol("converted") };
        });
        let body: any = cons(OP_LET, cons(null, expr.cdr));
        for (let i = bindings.length - 1; i >= 0; i--) body = list(CORE_WITH_MARK, bindings[i].key, bindings[i].conv, body);
        const convert = (b: typeof bindings[number]) => {
            const c = Symbol("converter");
            return list(OP_LET, list(list(c, list(Symbol.for("%parameter-converter"), b.key))), list(CORE_IF, c, list(c, b.raw), b.raw));
        };
        const evaluated = fromArray(bindings.flatMap(b => [list(b.key, list(Symbol.for("%parameter-key"), b.param)), list(b.raw, b.value)]));
        const converted = fromArray(bindings.map(b => list(b.conv, convert(b))));
        return { expanded: list(OP_LET, evaluated, list(OP_LET, converted, body)), state: TransformState.Recurse };
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
        let cmpExprBc = evaluator.expandcmp.compile(toCore(trCmpExpr));
        const res: Closure = evaluator.expandvm.evaluateRaw(cmpExprBc, evaluator.scope);
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
                Symbol.for("call/ec"),
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

    const catchForm = (name: string) => lowerTo(CORE_CATCH, orig => {
        if (orig.length !== 3) throw new Error(`${name} must be of form (${name} thunk handler)`);
    });
    evaluator.registerTransform(CORE_CATCH, lowerTo(CORE_CATCH, orig => {
        if (orig.length < 3 || orig.length > 5) throw new Error("%catch must be of form (%catch thunk handler [pre [guarded]])");
    }));
    evaluator.registerTransform(Symbol.for("raise-continuable"), (evaluator, expr, orig) => {
        if (!(orig instanceof Cons) || orig.length !== 2) throw new Error("raise-continuable takes 1 argument");
        return { expanded: list(OP_RAISE, expr.car, true), state: TransformState.DoChildren };
    });
    evaluator.registerTransform(Symbol.for("try"), catchForm("try"));
    evaluator.registerTransform(Symbol.for("try-catch"), catchForm("try-catch"));

    // (pcall f arg ...): (values #t result ...), or (values #f err) if calling f raises; f and the arguments are evaluated first
    evaluator.registerTransform(Symbol.for("pcall"), (evaluator, expr, orig) => {
        if (!(orig instanceof Cons) || orig.length < 2) throw new Error("pcall must be of form (pcall f arg ...)");
        const vars = toArray(expr).map((_, i) => Symbol(`pcall_${i}`));
        const call = fromArray(vars);
        const thunk = list(OP_LAMBDA, null, list(Symbol.for("%values-cons"), true, call));
        const e = Symbol("pcall_e");
        const handler = list(OP_LAMBDA, list(e), list(Symbol.for("values"), false, e));
        return { expanded: list(OP_LET, fromArray(vars.map((v, i) => list(v, toArray(expr)[i]))), list(CORE_CATCH, thunk, handler)), state: TransformState.Recurse };
    });

    evaluator.registerTransform(Symbol.for("let/ec"), (evaluator, expr, orig) => {
        if (!(orig instanceof Cons) || orig.length < 3 || typeof expr.car !== "symbol") throw new Error("let/ec must be of form (let/ec name body...)");
        return { expanded: list(Symbol.for("%call/ec"), cons(OP_LAMBDA, cons(list(expr.car), expr.cdr))), state: TransformState.Recurse };
    });

    // (call-with-values (lambda () p ...) (lambda formals c ...)) binds the values directly, like receive; anything else
    // calls the prelude procedure
    evaluator.registerTransform(Symbol.for("call-with-values"), (evaluator, expr, orig) => {
        const isLambda = (x: any) => x instanceof Cons && (x.car === OP_LAMBDA || x.car === CORE_LAMBDA) && x.cdr instanceof Cons && x.cdr.cdr instanceof Cons;
        if (orig instanceof Cons && orig.length === 3 && isLambda(expr.car) && expr.car.cdr.car === null && isLambda(cadr(expr))) {
            const producer = expr.car, consumer = cadr(expr);
            return { expanded: cons(Symbol.for("receive"), cons(consumer.cdr.car, cons(cons(OP_LET, cons(null, producer.cdr.cdr)), consumer.cdr.cdr))), state: TransformState.Recurse };
        }
        return { expanded: orig, state: TransformState.DoChildren };
    });

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

    // (name arg ...) of a builtin or another aliased procedure calls its target directly when the argument count fits;
    // otherwise it stays an ordinary call of the prelude's procedure, which reports the wrong count when (and if) it runs
    // (cons a (cons b ... tail)): one (list a b ...) when tail is '(), else one (cons* a b ... tail), so each pair's
    // length is known as it is made rather than read from the pair after it
    const OP_CONS = Symbol.for("cons");
    const isCons = (e: any) => e instanceof Cons && e.car === OP_CONS && e.length === 3;
    const isNull = (e: any) => e === null || (e instanceof Cons && e.car === OP_QUOTE && e.length === 2 && e.cdr.car === null);
    const consChain = (orig: any): any => {
        const heads: any[] = [];
        let e = orig;
        for (; isCons(e); e = cadr(e.cdr)) heads.push(e.cdr.car);
        if (isNull(e)) return cons(Symbol.for("list"), fromArray(heads));
        return heads.length > 1 ? cons(Symbol.for("cons*"), fromArray([...heads, e])) : null;
    };

    for (const [name, { target, min, max }] of SCHEME_ALIASES) {
        evaluator.registerTransform(name, (evaluator, expr, orig) => {
            if (name === OP_CONS && isCons(orig)) {
                const chain = consChain(orig);
                if (chain !== null) return { expanded: chain, state: TransformState.Recurse };
            }
            const nargs = expr === null ? 0 : expr instanceof Cons && !expr.isImproper() ? expr.length : -1;
            if (nargs < min || nargs > max) return { expanded: orig, state: TransformState.DoChildren };
            if (name !== OP_APPLY) return { expanded: cons(target, expr), state: TransformState.DoChildren };
            const args = toArray(expr);
            return { expanded: fromArray([target, ...args.slice(0, -1), list(Symbol.for("%spread"), args[args.length - 1])]), state: TransformState.DoChildren };
        });
    }
};
