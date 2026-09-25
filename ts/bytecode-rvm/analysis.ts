import {
  CORE_QUOTE,
  CORE_LAMBDA,
  CORE_SET,
  CORE_BLOCK,
  CORE_ESCAPE,
  CORE_LET,
  CORE_LET_VALUES,
  CORE_LET_VALUES_STRICT,
  OP_DEFINE_GLOBAL,
  unpackLambdaExprArgs,
  Cons,
} from "../common";
import { AnalysisScope } from "./scope";

// Analyzes a fully transformed AST to handle scoping prior to actual compilation. This lets us avoid boxing of primitives
export class AstAnalysis {
    scopeMap = new WeakMap<object, AnalysisScope>();
    
    analyze(ast: any) {
        const baseScope = new AnalysisScope(null);
        if (ast instanceof Cons) this.scopeMap.set(ast, baseScope);
        this.visit(ast, baseScope);
        return baseScope;
    }

    private visit(ast: any, scope: AnalysisScope) {       
        // Symbols simulate a read into the value
        if (typeof ast === 'symbol') {
            scope.readVar(ast); 
            return;
        }
        
        // Base cases: primitives, strings, symbols, or null
        if (ast === null || typeof ast !== "object") {
            return;
        }

        if (!(ast instanceof Cons)) return;

        const op = ast.car;
        switch (op) {
            case CORE_QUOTE:
                return; // don't touch quoted
            case CORE_LAMBDA: {
                const body = ast.cdr.cdr;
                
                const lambdaScope = new AnalysisScope(scope);
                
                const extractedParams = unpackLambdaExprArgs(ast);
                for (const p of extractedParams.params) {
                    lambdaScope.define(p); 
                }
                if (extractedParams.remParams) {
                    lambdaScope.define(extractedParams.remParams); 
                }

                this.scopeMap.set(ast, lambdaScope);

                // Visit children (yes scope change)
                let curr: any = body;
                while (curr instanceof Cons) {
                    this.visit(curr.car, lambdaScope);
                    curr = curr.cdr;
                }
                if (curr !== null) {
                    this.visit(curr, lambdaScope);
                }
                return;
            }
            case CORE_SET: {
                const sym = ast.cdr.car;
                const value = ast.cdr.cdr.car;
                
                scope.markMutable(sym);
                this.visit(value, scope);
                return;
            }
            // (%let ((x init) ...) body ...): inits are evaluated outside, body inside a block scope
            case CORE_LET: {
                const letScope = new AnalysisScope(scope, false);
                let binding: any = ast.cdr.car;
                while (binding instanceof Cons) {
                    this.visit(binding.car.cdr.car, scope);
                    letScope.define(binding.car.car);
                    binding = binding.cdr;
                }
                this.scopeMap.set(ast, letScope);
                let curr: any = ast.cdr.cdr;
                while (curr instanceof Cons) {
                    this.visit(curr.car, letScope);
                    curr = curr.cdr;
                }
                return;
            }
            // (%let-values ((formals expr) ...) body ...): like %let, binding every variable in each formals
            case CORE_LET_VALUES:
            case CORE_LET_VALUES_STRICT: {
                const letScope = new AnalysisScope(scope, false);
                let clause: any = ast.cdr.car;
                while (clause instanceof Cons) {
                    this.visit(clause.car.cdr.car, scope);
                    let formals: any = clause.car.car;
                    while (formals instanceof Cons) {
                        letScope.define(formals.car);
                        formals = formals.cdr;
                    }
                    if (typeof formals === "symbol") letScope.define(formals);
                    clause = clause.cdr;
                }
                this.scopeMap.set(ast, letScope);
                let curr: any = ast.cdr.cdr;
                while (curr instanceof Cons) {
                    this.visit(curr.car, letScope);
                    curr = curr.cdr;
                }
                return;
            }
            // block names are labels, not variables
            case CORE_BLOCK:
            case CORE_ESCAPE: {
                let curr: any = ast.cdr.cdr;
                while (curr instanceof Cons) {
                    this.visit(curr.car, scope);
                    curr = curr.cdr;
                }
                return;
            }
            case OP_DEFINE_GLOBAL: {
                const value = ast.cdr.cdr.car;
                this.visit(value, scope);
                return;
            }
        }
        // Visit children (no scope change)
        let curr: any = ast;
        while (curr instanceof Cons) {
            this.visit(curr.car, scope);
            curr = curr.cdr;
        }
        if (curr !== null) {
            this.visit(curr, scope);
        }
    }
}