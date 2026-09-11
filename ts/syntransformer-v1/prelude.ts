import {
    OP_DEFINE, OP_BEGIN, OP_LAMBDA, OP_LET, OP_IF, OP_COND, OP_ELSE, 
    OP_SET, OP_LETREC, OP_LETSTAR, DottedPair, ensureCanBind,
    OP_AND,
    OP_OR,
    AbstractClosure
} from "../common";
import { MacroEvaluator, TransformState } from "./macro"; // update with your path

const wrapMulti = (exprs: any[]) => {
    if (exprs.length === 0) return []; 
    if (exprs.length === 1) return exprs[0];
    return [OP_BEGIN, ...exprs];
};

const removeBegin = (expr: any[]): any[] => {
    const newExpr: any[] = [];
    for (const exp of expr) {
        if (Array.isArray(exp) && exp[0] === OP_BEGIN) {
            newExpr.push(...removeBegin(exp.slice(1)));
        } else {
            newExpr.push(exp);
        }
    }
    return newExpr;
};

const normalizeDefine = (stmt: any[]): any[] => {
    if(stmt.length < 3) throw new Error(`define must be in format ["define" varname arg] or [define (func_name arg1 arg2... argN) body_expr...] but have ${stmt.length-1} arguments`)
    
    if(typeof stmt[1] === "symbol") {
        if(stmt.length !== 3) throw new Error(`define must have 2 arguments`);
        ensureCanBind(stmt[1], undefined, "define");
        return stmt;
    } else if (Array.isArray(stmt[1])) { 
        if (stmt[1].length === 0) throw new Error("define: missing function name");
        const funcName = stmt[1][0];
        ensureCanBind(funcName, undefined, "define");
        return [OP_DEFINE, funcName, [OP_LAMBDA, stmt[1].slice(1), ...stmt.slice(2)]];
    } else if (stmt[1] instanceof DottedPair) {
        if (stmt[1].items.length === 0) throw new Error("define: missing function name");
        const funcName = stmt[1].items[0];
        ensureCanBind(funcName, undefined, "define");
        const params = stmt[1].items.slice(1);
        const lambdaArgs = params.length === 0 ? stmt[1].rest : new DottedPair(params, stmt[1].rest);
        return [OP_DEFINE, funcName, [OP_LAMBDA, lambdaArgs, ...stmt.slice(2)]];
    }
    throw new Error(`define syntax error`);
};

export const registerCoreSyntax = (evaluator: MacroEvaluator) => {
    evaluator.registerTransform(OP_COND, (evaluator, expr, orig) => {
        if (expr.length === 0) return { expanded: undefined, state: TransformState.ReturnImm };

        let result: any = undefined; 
        for (let i = expr.length - 1; i >= 0; i--) {
            const clause = expr[i];
            if (!Array.isArray(clause) || clause.length < 2) throw new Error(`cond clause must be a list of exactly 2 elements: [condition, expr...]`);

            const condition = clause[0];
            const resultExpr = wrapMulti(clause.slice(1));

            if (condition === OP_ELSE) {
                if (i !== expr.length - 1) throw new Error("else must be the final clause in a cond statement");
                result = resultExpr;
            } else {
                result = [OP_IF, condition, resultExpr, result];
            }
        }
        return { expanded: result, state: TransformState.Recurse };
    });

    evaluator.registerTransform(OP_LET, (evaluator, expr, orig) => {        
        if (orig.length < 3) throw new Error(`let bad syntax`);

        let loopName: symbol | null = null;
        let bindingsIdx = 0;

        if (typeof expr[0] === "symbol") {
            loopName = expr[0];
            bindingsIdx = 1;
            if (orig.length < 4) throw new Error(`named let must include bindings and a body`);
        }

        const bindings = expr[bindingsIdx];
        if (!Array.isArray(bindings) && bindings !== null) throw new Error(`${loopName ? "named let" : "let"} bindings must be a list of form [[var expr]...]`);

        const body = expr.slice(bindingsIdx + 1);
        const params: symbol[] = [];
        const exprs: any[] = [];

        if (bindings !== null) {
            for (const binding of bindings) {
                if (!Array.isArray(binding) || binding.length !== 2) throw new Error(`let binding bad syntax`);
                if (typeof binding[0] !== "symbol") throw new Error("let binding name must be a symbol");
                params.push(binding[0]);
                exprs.push(binding[1]);
            }
        }

        if (loopName) {
            const letrecExpr = [OP_LETREC, [ [loopName, [OP_LAMBDA, params, ...body]] ], loopName]
            const namedLetExpr = [letrecExpr, ...exprs]
            return { expanded: namedLetExpr, state: TransformState.Recurse };
        }
        
        return { expanded: [[OP_LAMBDA, params, ...body], ...exprs], state: TransformState.Recurse };
    });

    evaluator.registerTransform(OP_LETSTAR, (evaluator, expr, orig) => {
        if (orig.length < 3) throw new Error(`let*: bad syntax`);
        const bindings = expr[0];
        const body = expr.slice(1);
        if (!Array.isArray(bindings) && bindings !== null) {
            throw new Error(`let* bindings must be a list of form [[var expr]...]`);
        }

        // No bindings
        if (bindings === null || bindings.length === 0) {
            return { expanded: [[OP_LAMBDA, [], ...body]], state: TransformState.Recurse };
        }

        // Start with innermost expr and work our way outwards (similar to cond)
        let currentExpr = body; 
        for (let i = bindings.length - 1; i >= 0; i--) {
            const binding = bindings[i];
            if (!Array.isArray(binding) || binding.length !== 2) throw new Error(`let* binding bad syntax`);
            if (typeof binding[0] !== "symbol") throw new Error("let* binding name must be a symbol");
            currentExpr = [ [[OP_LAMBDA, [binding[0]], ...currentExpr], binding[1]] ];
        }
        return { expanded: currentExpr[0], state: TransformState.Recurse };
    });

    evaluator.registerTransform(OP_LETREC, (evaluator, expr, orig) => {
        if (orig.length < 3) throw new Error(`letrec: bad syntax`);
        const bindings = expr[0];
        if (!Array.isArray(bindings) && bindings !== null) {
            throw new Error(`letrec bindings must be a list of form [[var expr]...]`);
        }

        const body = expr.slice(1);
        const params: symbol[] = [];
        const dummyVals: any[] = []; 
        const setExprs: any[] = [];  

        if (bindings !== null) {
            for (const binding of bindings) {
                if (!Array.isArray(binding) || binding.length !== 2) {
                    throw new Error(`letrec binding \`${binding}\` must be a list of form [var expr]`);
                }

                if (typeof binding[0] !== "symbol") throw new Error("letrec binding name must be a symbol");
                params.push(binding[0]);
                dummyVals.push(undefined); 
                setExprs.push([OP_SET, binding[0], binding[1]]); 
            }
        }

        return { expanded: [[OP_LAMBDA, params, ...setExprs, ...body], ...dummyVals], state: TransformState.Recurse };
    });

    evaluator.registerTransform(OP_SET, (evaluator, expr, orig) => {
        if(orig.length != 3) throw new Error(`set! must have 2 arguments`);
        if(typeof expr[0] !== "symbol") throw new Error(`${String(expr[0])} not symbol`);
        ensureCanBind(expr[0], undefined, "set!");
        
        return { expanded: orig, state: TransformState.DoChildren };
    });

    evaluator.registerTransform(OP_DEFINE, (evaluator, expr, orig) => {
        const normalized = normalizeDefine(orig);
        
        if (normalized === orig) {
            return { expanded: orig, state: TransformState.DoChildren };
        }
        
        return { expanded: normalized, state: TransformState.Recurse };
    });

    evaluator.registerTransform(OP_LAMBDA, (evaluator, expr, orig) => {
        if (orig.length < 3) throw new Error(`lambda syntax error`);
        const args = expr[0];
        const rawBody = removeBegin(expr.slice(1));
        if (rawBody.length === 0) throw new Error("lambda body must contain at least one expression");

        const defines: any[][] = [];
        const body: any[] = [];

        for (let stmt of rawBody) {
            if (Array.isArray(stmt) && stmt[0] === OP_DEFINE) {
                const normalizedStmt = normalizeDefine(stmt);
                defines.push([normalizedStmt[1], normalizedStmt[2]]);
            } else {
                body.push(stmt);
            }
        }

        if (defines.length === 0) {
            return { expanded: [OP_LAMBDA, args, ...rawBody], state: TransformState.DoChildren };
        }

        if (body.length === 0)
            throw new Error("lambda body must contain at least one expression after internal/local defines etc.");

        // Keep the outer lambda and put the letrec inside its body!
        const letrecExpr = [OP_LETREC, defines, ...body]
        return { 
            expanded: [OP_LAMBDA, args, letrecExpr], 
            state: TransformState.Recurse 
        };
    });

    evaluator.registerTransform(OP_AND, (evaluator, expr, orig) => {
        if (expr.length === 0) {
            return { expanded: true, state: TransformState.ReturnImm };
        }
        if (expr.length === 1) {
            return { expanded: expr[0], state: TransformState.Recurse };
        }

        // Similar to cond, start with last expr and keep wrapping in OP_IF's
        let result = expr[expr.length - 1];

        for (let i = expr.length - 2; i >= 0; i--) {
            result = [OP_IF, expr[i], result, false];
        }

        return { expanded: result, state: TransformState.Recurse };
    });

    evaluator.registerTransform(OP_OR, (evaluator, expr, orig) => {
        if (expr.length === 0) {
            return { expanded: false, state: TransformState.ReturnImm };
        }
        if (expr.length === 1) {
            return { expanded: expr[0], state: TransformState.Recurse };
        }

        // Similar to cond, start with last expr and keep wrapping in OP_IF's
        //
        // Because or short circuits, we need to use a OP_LET
        let result = expr[expr.length - 1];

        for (let i = expr.length - 2; i >= 0; i--) {
            const tmp = Symbol("or_tmp");
            result = [
                OP_LET,
                [[tmp, expr[i]]],
                [OP_IF, tmp, tmp, result]
            ];
        }

        return { expanded: result, state: TransformState.Recurse };
    });

    // (anima-macro onsym macrofn)
    evaluator.registerTransform(Symbol.for("anima-macro"), (evaluator, expr, orig) => {
        if (expr.length < 2) throw new Error(`anima-macro syntax error`);
        let onsym = expr[0]
        if (typeof onsym !== "symbol") throw new Error(`anima-macro onsym must be a constant symbol right now`);
        let cmpexpr = [OP_LAMBDA, [Symbol.for("orig")], expr[1]]
        let trCmpExpr = evaluator.transform(cmpexpr)
        let cmpExprBc = evaluator.expandcmp.compile(trCmpExpr)
        const res: AbstractClosure = evaluator.expandvm.evaluateRaw(cmpExprBc, evaluator.scope) // Use the VM to create the closure
        evaluator.registerTransform(onsym, (evaluator, expr, orig) => {
            const resp = evaluator.expandvm.evaluateClosure(res, evaluator.scope, [orig])
            return { expanded: resp, state: TransformState.Recurse };
        })

        return { expanded: undefined, state: TransformState.ReturnImm };
    });
}
