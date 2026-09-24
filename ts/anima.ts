import { AbstractByteCode, AbstractClosure, AbstractCompiler, AbstractVM, AnimaMeta, ASP, ASTStringifier, Table, OP_LAMBDA, Cons } from "./common"
import { Bootstrapper } from "./std"
import { MacroEvaluator } from "./syntransformer-v1/macro"
import { registerCoreSyntax } from "./syntransformer-v1/prelude"

export class Anima {
    #vm: AbstractVM
    #comp: AbstractCompiler
    #scope: Table
    #impl: AnimaMeta
    #bootstrapper: Bootstrapper
    #evaluator: MacroEvaluator

    get scope(): Table {
        return this.#scope
    }

    get compiler() {
        return this.#comp
    }

    get vm() {
        return this.#vm
    }

    constructor(impl: AnimaMeta, maxSteps?: number) {
        this.#impl = impl
        this.#vm = impl.vm(maxSteps || 0)
        this.#comp = impl.compiler()
        this.#evaluator = new MacroEvaluator(impl, maxSteps || 0)
        registerCoreSyntax(this.#evaluator)
        this.#evaluator.init()
        this.#bootstrapper = new Bootstrapper()
        const publicScope = this.#bootstrapper.setupPublicScope(impl, this.#comp, this.#vm, this.#evaluator)
        this.#scope = publicScope.chained()
    }

    public evaluateRaw(code: AbstractByteCode): any {
        return this.#vm.evaluateRaw(code, this.#scope)
    }

    public evaluateClosure(code: AbstractClosure, args: any[]): any {
        return this.#vm.evaluateClosure(code, this.#scope, args)
    }

    public coroutineResume(co: any, ...args: any[]): { done: boolean, value: any, values: any[] } {
        return this.#vm.resumeCoroutine(co, args)
    }

    compileToClosure(s: string, args: any, globals: Table) {
        const bast = new ASP(s, true).parse()
        return this.compileAstToClosure(bast, args, globals)
    }

    compileAstToClosure(bast: any, args: any, globals: Table): AbstractClosure {
        const ast = Cons.list(OP_LAMBDA, args, bast)
        const bc = this.compileRawAst(ast)
        const res = this.#vm.evaluateRaw(bc, globals) // Use the VM to create the closure
        return res
    }

    compileRaw(s: string) {
        const ast = new ASP(s, true).parse()
        return this.compileRawAst(ast)
    }

    compileRawAst(ast: any) {
        let trExpr = this.#evaluator.transform(ast)
        return this.#comp.compile(trExpr)
    }

    deepPrint(bc: AbstractByteCode) {
        this.#impl.deepPrint(bc)
    }
}
