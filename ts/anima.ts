import { AbstractByteCode, AbstractClosure, AbstractCompiler, AbstractVM, AnimaMeta, Env, OP_LAMBDA, Cons } from "./common"
import { Bootstrapper } from "./scheme/prelude"
import { ASP } from "./scheme/reader"
import { MacroEvaluator } from "./scheme/transformer/macro"
import { registerCoreSyntax } from "./scheme/transformer/syntax"
import { Intrinsics, type Intrinsic, type IntrinsicFn, type IntrinsicOptions } from "./bytecode-rvm/intrinsics"
import { isTakenName } from "./bytecode-rvm/core"

export class Anima {
    #vm: AbstractVM
    #comp: AbstractCompiler
    #scope: Env
    #impl: AnimaMeta
    #bootstrapper: Bootstrapper
    #evaluator: MacroEvaluator
    // shared by this instance's compiler, VM and macro evaluator
    readonly #intrinsics: Intrinsics

    get scope(): Env {
        return this.#scope
    }

    get compiler() {
        return this.#comp
    }

    get vm() {
        return this.#vm
    }

    get intrinsics(): Intrinsics {
        return this.#intrinsics
    }

    constructor(impl: AnimaMeta, maxSteps?: number) {
        this.#impl = impl
        this.#intrinsics = new Intrinsics(isTakenName)
        this.#vm = impl.vm(maxSteps || 0, this.#intrinsics)
        this.#comp = impl.compiler(this.#intrinsics)
        this.#evaluator = new MacroEvaluator(impl, maxSteps || 0, this.#intrinsics)
        registerCoreSyntax(this.#evaluator)
        this.#evaluator.init(new Bootstrapper().setupPublicScope(impl, this.#evaluator.expandcmp, this.#evaluator.expandvm, this.#evaluator, this.#intrinsics))
        this.#bootstrapper = new Bootstrapper()
        const publicScope = this.#bootstrapper.setupPublicScope(impl, this.#comp, this.#vm, this.#evaluator, this.#intrinsics)
        this.#scope = publicScope.chained()
    }

    // makes (name arg ...) call `fn` in code compiled from now on; names start with '%'
    registerIntrinsic(name: string, fn: IntrinsicFn, options?: IntrinsicOptions): Intrinsic {
        return this.#intrinsics.register(name, fn, options)
    }

    // no more intrinsics can be registered (compiling and loading are unaffected)
    freeze(): this {
        this.#intrinsics.freeze()
        return this
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

    public coroutineClose(co: any): void {
        this.#vm.closeCoroutine(co)
    }

    public traceback(co: any, msg?: string): string {
        return this.#vm.traceback(co, msg)
    }

    compileToClosure(s: string, args: any, globals: Env) {
        const bast = new ASP(s, true).parse()
        return this.compileAstToClosure(bast, args, globals)
    }

    compileAstToClosure(bast: any, args: any, globals: Env): AbstractClosure {
        const ast = Cons.list(OP_LAMBDA, args, bast)
        const bc = this.compileRawAst(ast)
        const res = this.#vm.evaluateRaw(bc, globals) // Use the VM to create the closure
        return res
    }

    compileRaw(s: string, file?: string) {
        const ast = new ASP(s, true, file).parse()
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
