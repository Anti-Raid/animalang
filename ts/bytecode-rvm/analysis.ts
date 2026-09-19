import {
  OP_QUOTE,
  OP_LAMBDA,
  OP_SET,
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
            case OP_QUOTE:
                return; // don't touch quoted
            case OP_LAMBDA: {
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
            case OP_SET: {
                const sym = ast.cdr.car;
                const value = ast.cdr.cdr.car;
                
                scope.markMutable(sym);
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