import { Env, CORE_LAMBDA } from "./common"
import { Intrinsics, type Intrinsic, type IntrinsicFn, type IntrinsicOptions } from "./magicvm/intrinsics"
import type { CaseLambda } from "./magicvm/code"
import { newIntrinsics } from "./magicvm/core"
import { Compiler } from "./magicvm/compiler"
import { AnimaVM } from "./magicvm/vm"
import type { Code, Closure, ClosureTemplate } from "./magicvm/exec"
import type { AnimaOptions } from "./magicvm/meta"
import { UnitLoader } from "./magicvm/loader"
import type { AnimaExecutionUnit, UnitMeta } from "./magicvm/unit-types"

// A language on top of the core: reads source into its syntax tree and lowers that to the core forms (each carrying
// where it comes from, see magicvm/forms.ts)
export interface FrontEnd {
    read(source: string, file?: string): any
    transform(ast: any): any
    // a procedure of `params` whose body is `body`, in the front end's syntax
    lambda(params: any, body: any): any
    // what quoted data in native-scheme text means to it (see native/reader.ts)
    datum?(x: any): any
}

// A compiler and VM with their intrinsics. On its own it compiles core forms; a front end (see createScheme) adds a
// language: its syntax, intrinsics and global scope
export class Anima {
    #vm: AnimaVM
    #comp: Compiler
    #scope: Env = new Env()
    #options: AnimaOptions
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

    get frontEnd(): FrontEnd | null {
        return this.#frontEnd
    }

    get options(): AnimaOptions {
        return this.#options
    }

    // `base`: intrinsics (and reserved names) to start with, e.g. a front end's (made with newIntrinsics)
    constructor(options: AnimaOptions, base?: Intrinsics) {
        this.#options = options
        this.#intrinsics = newIntrinsics(base)
        this.#vm = new AnimaVM(this.#intrinsics)
        this.#comp = new Compiler(this.#intrinsics, options.debug, options.optimize, options.reentrant ?? true)
    }

    // gives the instance a language: `scope` is where its code runs
    attachFrontEnd(frontEnd: FrontEnd, scope: Env): void {
        if (this.#frontEnd !== null) throw new Error("this instance already has a front end")
        this.#frontEnd = frontEnd
        this.#scope = scope
    }

    // for an intrinsic that works long: an interrupt check of its own (see Intrinsics.setInterruptHandler), counting `work`
    // against the instance's count. It returns to go on, throws an InterruptError to stop (which the intrinsic lets go),
    // and a pause happens once the intrinsic has returned
    checkInterrupt(work: number = 1): void {
        this.#vm.executor.checkInterrupt(work)
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

    public evaluateRaw(code: Code): any {
        return this.#vm.evaluateRaw(this.#ownKind(code), this.#scope)
    }

    public loadUnit(json: string | AnimaExecutionUnit): { code: Code, meta: UnitMeta, template: ClosureTemplate } {
        const unit = this.#vm.loadUnit(json)
        this.#ownKind(unit.code)
        return unit
    }

    public evaluateUnit(json: string | AnimaExecutionUnit): any {
        return this.evaluateRaw(this.loadUnit(json).code)
    }

    // An instance runs code of its own kind alone (AnimaOptions.reentrant): code that is not re-entrant relies on no
    // continuation ever holding one of its frames, which re-entrant code beside it could make
    #ownKind(code: Code): Code {
        const reentrant = this.#options.reentrant ?? true
        if (code.reentrant !== reentrant) {
            throw new Error(`this code was compiled as ${code.reentrant ? "re-entrant" : "not re-entrant"}, and the instance's code is ${reentrant ? "re-entrant" : "not re-entrant"}`)
        }
        return code
    }

    public evaluateClosure(code: Closure | CaseLambda, args: any[]): any {
        return this.#vm.evaluateClosure(code, this.#scope, args)
    }

    public coroutineResume(co: any, ...args: any[]): { done: boolean, value: any, values: any[] } {
        return this.#vm.resumeCoroutine(co, args)
    }

    // resumes `co` with its pending yield raising `obj` (as a raise inside the coroutine, so its handlers see it)
    public coroutineRaise(co: any, obj: any): { done: boolean, value: any, values: any[] } {
        return this.#vm.resumeCoroutine(co, [obj], true)
    }

    public coroutineClose(co: any): void {
        this.#vm.closeCoroutine(co)
    }

    public currentCoroutine(): any {
        return this.#vm.currentCoroutine()
    }

    public coroutineYieldable(): boolean {
        return this.#vm.coroutineYieldable()
    }

    public traceback(co: any, msg?: string): string {
        return this.#vm.traceback(co, msg)
    }

    compileToClosure(s: string, args: any, globals: Env) {
        return this.compileAstToClosure(this.#requireFrontEnd().read(s), args, globals)
    }

    // without a front end, `args` is the lambda's parameters (an array of symbols) and `bast` its body, a core form
    compileAstToClosure(bast: any, args: any, globals: Env): Closure {
        const ast = this.#frontEnd !== null ? this.#frontEnd.lambda(args, bast) : [CORE_LAMBDA, null, [[], args, null, bast]]
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

    #requireFrontEnd(): FrontEnd {
        if (this.#frontEnd === null) throw new Error("this instance has no front end to read source with (see createScheme)")
        return this.#frontEnd
    }
}
