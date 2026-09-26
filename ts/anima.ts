import { AbstractByteCode, AbstractClosure, AbstractCompiler, AbstractVM, AnimaMeta, Env, Cons, CORE_LAMBDA } from "./common"
import { Intrinsics, type Intrinsic, type IntrinsicFn, type IntrinsicOptions } from "./bytecode-rvm/intrinsics"
import { isCompilerIntrinsic } from "./bytecode-rvm/core"

// A language on top of the core: reads source into its syntax tree and lowers that to the core forms
export interface FrontEnd {
    read(source: string, file?: string): any
    transform(ast: any): any
    // a procedure of `params` whose body is `body`, in the front end's syntax
    lambda(params: any, body: any): any
}

// A compiler and VM with their intrinsics. On its own it compiles core forms; a front end (see createScheme) adds a
// language: its syntax, intrinsics and global scope
export class Anima {
    #vm: AbstractVM
    #comp: AbstractCompiler
    #scope: Env = new Env()
    #impl: AnimaMeta
    #frontEnd: FrontEnd | null = null
    // shared by this instance's compiler and VM (and its front end's)
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

    get impl(): AnimaMeta {
        return this.#impl
    }

    // `base`: intrinsics (and reserved names) to start with, e.g. a front end's
    constructor(impl: AnimaMeta, readonly maxSteps: number = 0, base?: Intrinsics) {
        this.#impl = impl
        this.#intrinsics = new Intrinsics(isCompilerIntrinsic, base)
        this.#vm = impl.vm(maxSteps, this.#intrinsics)
        this.#comp = impl.compiler(this.#intrinsics)
    }

    // gives the instance a language: `scope` is where its code runs
    attachFrontEnd(frontEnd: FrontEnd, scope: Env): void {
        if (this.#frontEnd !== null) throw new Error("this instance already has a front end")
        this.#frontEnd = frontEnd
        this.#scope = scope
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
        return this.compileAstToClosure(this.#requireFrontEnd().read(s), args, globals)
    }

    compileAstToClosure(bast: any, args: any, globals: Env): AbstractClosure {
        const ast = this.#frontEnd !== null ? this.#frontEnd.lambda(args, bast) : Cons.list(CORE_LAMBDA, args, bast)
        const bc = this.compileRawAst(ast)
        return this.#vm.evaluateRaw(bc, globals) // Use the VM to create the closure
    }

    compileRaw(s: string, file?: string) {
        return this.compileRawAst(this.#requireFrontEnd().read(s, file))
    }

    // the front end's syntax tree, or core forms if there is no front end
    compileRawAst(ast: any) {
        return this.#comp.compile(this.#frontEnd !== null ? this.#frontEnd.transform(ast) : ast)
    }

    deepPrint(bc: AbstractByteCode) {
        this.#impl.deepPrint(bc)
    }

    #requireFrontEnd(): FrontEnd {
        if (this.#frontEnd === null) throw new Error("this instance has no front end to read source with (see createScheme)")
        return this.#frontEnd
    }
}
