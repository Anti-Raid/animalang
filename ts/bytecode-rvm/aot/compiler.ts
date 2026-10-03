// The AOT compiler: splits a function's instructions into basic blocks, generates a function's JS source (resume.ts, direct.ts) and builds it,
// sharing the built source between copies of the same code; JIT_DEPS are the names generated code can use
import { Intrinsics, type TypeSystem } from "../intrinsics";
import { Env, ErrorObject, IProcedure, MissingVarError, MultipleValues, packValues } from "../../common";
import { Caught, ContinuationMarkSet, EXCEPTION_HANDLERS, Handlers, markFirst, markSet, recordTailMark } from "../../marks";
import { DirectEmitter } from "./direct";
import { ResumeEmitter } from "./resume";
import { Liveness } from "./liveness";
import { structureOf } from "./structure";
import type { AotBlock, AotInst, AotTerm, SourceUse } from "./types";
import { fitsArity } from "../arity";
import { CaseLambda, Closure, ClosureTemplate, SHARED_OPS } from "../code";
import type { Code, DirectFn, ResumeFn } from "../code";
import { ControlRequest, HostTail, applyArgs, applyIntrinsic, arrayArg, catchGuard, raiseContinuable, stackSkip } from "../coreops";
import type { VMExecutor } from "../executor";
import { OP_SIZE, blockStarts, type Op } from "../ops";
import { Box, CatchToken, EscapeContinuation, EscapedError, Frame, InterruptError, MAX_JS_DEPTH, MAX_NESTED_RESUMES, MISSING, StackSnapshot, Suspend, WindPoint, catchHere, countControlSuspend, frameInfos, restValues, tailName, unpackForBinding } from "../values";
import type { ExecutionContext } from "../values";
export const JIT_DEPS = {
    markSet,
    recordTailMark,
    tailName,
    ContinuationMarkSet,
    MultipleValues,
    unpackForBinding,
    restValues,
    IProcedure,
    ErrorObject,
    Box,
    MissingVarError,
    Closure,
    CaseLambda,
    WindPoint,
    applyArgs,
    arrayArg,
    raiseContinuable,
    catchGuard,
    stackSkip,
    packValues,
    Handlers,
    MISSING,
    MAX_JS_DEPTH,
    MAX_NESTED_RESUMES,
    Env,
    Frame,
    Suspend,
    InterruptError,
    EscapeContinuation,
    countControlSuspend,
    StackSnapshot,
    frameInfos,
    HostTail,
    ControlRequest,
    applyIntrinsic,
    CatchToken,
    Caught,
    catchHere,
    markFirst,
    EXCEPTION_HANDLERS,
};

export class AotCompiler {
    public static run(ctx: ExecutionContext, initialFrame: Frame, executor: VMExecutor): any {
        let frame: Frame | null = initialFrame;

        // one try around the loop: any error ends the run
        try {
            if (frame.ip === 0 && frame.code.directArity === 0 && !frame.code.internal && !frame.isShared(frame.ctx)) frame = this.#runDirect(frame, executor);
            while (frame !== null) {
                const frameCtx: ExecutionContext = frame.ctx;
                frame = executor.enter(frameCtx, frame);
                const resumeFn = frame.code.resumeFn ?? this.compile(frame.code, frame.closure.tmpl);
                frame = resumeFn(frameCtx, frame, executor);
            }
        } catch (err) {
            throw err instanceof EscapedError ? err.error : err;
        }

        return ctx.acc;
    }

    // a fresh zero-argument frame (top-level code) runs through its direct entry, falling back to heap frames on a Suspend
    static #runDirect(frame: Frame, executor: VMExecutor): Frame | null {
        const ctx = frame.ctx;
        let val;
        try {
            val = frame.code.directFn!(ctx, frame.closure, executor, 1, frame.marks, frame.mframe);
        } catch (e) {
            if (!(e instanceof Suspend)) throw e;
            if (frame.parent !== null) e.push(frame.parent);
            return executor.resumeSuspend(ctx, e);
        }
        return executor.setRetVal(ctx, frame.parent, val);
    }

    public static compileAll(code: Code, tmpl?: ClosureTemplate): void {
        if (code.resumeFn === null) {
            this.compile(code, tmpl);
        }
        for (const c of code.constants) {
            if (c instanceof ClosureTemplate) {
                this.compileAll(c.code, c);
            } else if (c instanceof Closure) {
                this.compileAll(c.tmpl.code, c.tmpl);
            }
        }
    }

    public static compile(code: Code, tmpl?: ClosureTemplate): ResumeFn {
        const { resume, direct } = this.generateFunction(code, tmpl);
        code.resumeFn = resume;
        if (direct !== null && tmpl !== undefined) {
            code.directFn = direct;
            if (tmpl.arity.rest === "none") code.directArity = tmpl.arity.params;
            else code.directRestArity = tmpl.arity.params;
            code.directPad = tmpl.arity.pad && tmpl.arity.rest === "none";
        }
        return resume;
    }

    // the compiled source of shared instruction lists: copies of a Code (Code.fresh) only build their own functions.
    // Source that calls intrinsics also depends on what they generate: their positions, inline templates and deps' locals.
    // Instances that register the same intrinsics the same way (e.g. from the same front end) share it
    static readonly #sources = new WeakMap<readonly Op[], { uses: readonly SourceUse[], types: TypeSystem | null, factory: Function }[]>();

    static #sameUses(a: readonly SourceUse[], b: readonly SourceUse[]): boolean {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            const x = a[i], y = b[i];
            // name and bounds are written into the source of IntApply
            // and the type facts rules, which the source relies on
            if (x.pos !== y.pos || x.inline !== y.inline || x.name !== y.name || x.min !== y.min || x.max !== y.max || !Intrinsics.sameFacts(x, y)) return false;
            const dx = Object.entries(x.deps), dy = y.deps;
            if (dx.length !== Object.keys(dy).length || dx.some(([k, v]) => dy[k] !== v)) return false;
        }
        return true;
    }

    public static generateFunction(code: Code, tmpl?: ClosureTemplate): { resume: ResumeFn, direct: DirectFn | null } {
        const uses: SourceUse[] = code.intrinsics.map(({ pos }) => { const { inline, deps, name, min, max, returns, wants, refineArgs, branchNarrow, invertBranch } = code.table!.entries[pos]; return { pos, inline, deps, name, min, max, returns, wants, refineArgs, branchNarrow, invertBranch }; });
        let variants = this.#sources.get(code.ops);
        const types = code.table?.types ?? null;
        let factory = variants?.find(v => v.types === types && this.#sameUses(v.uses, uses))?.factory;
        if (factory === undefined) {
            // parsing the source is most of the cost, so copies share the factory and only call it for their own functions
            factory = new Function(...Object.keys(JIT_DEPS), "CONSTANTS", "GLOBAL_CACHE", "CALL_CACHE", "RT", "DEPS", this.generateSource(code, tmpl));
            if (SHARED_OPS.has(code.ops)) {
                if (variants === undefined) this.#sources.set(code.ops, variants = []);
                variants.push({ uses, types, factory });
            }
        }
        const globalCache: Record<number, { scope: Env | null, version: number, value: any }> = {};
        for (const ip of this.#globalLoads(code)) globalCache[ip] = { scope: null, version: -1, value: undefined };
        const callCache: Record<number, { tmpl: ClosureTemplate | null, directFn: DirectFn | null }> = {};
        for (const ip of this.#callSites(code)) callCache[ip] = { tmpl: null, directFn: null };
        return factory(...Object.values(JIT_DEPS), code.constants, globalCache, callCache, code.table?.fns ?? [], code.table?.deps ?? []);
    }

    // called with each step's output when generating source: the blocks, their liveness, the resume and direct entries
    static trace?: (step: string, output: unknown) => void;

    static #step<T>(name: string, run: () => T): T {
        const output = run();
        this.trace?.(name, output);
        return output;
    }

    public static generateSource(code: Code, tmpl?: ClosureTemplate): string {
        if (code.intrinsics.length > 0 && code.table === null) throw new Error("internal error: compiling code that uses intrinsics without a table");
        const blocks = this.#step("blocks", () => this.buildAot(code, tmpl));
        const liveness = this.#step("liveness", () => new Liveness(blocks, code.numReg));
        const usedDeps = new Set<string>();
        const structure = structureOf(code.ops, code.size);
        const resume = this.#step("resume", () => {
            const out = new ResumeEmitter(blocks, structure, liveness, code.numReg, code.debug, code.table, usedDeps, code.constants);
            out.emitFunction();
            return out.toString();
        });
        const direct = tmpl === undefined ? "null" : this.#step("direct", () => {
            const out = new DirectEmitter(blocks, structure, liveness, code.numReg, code.debug, code.table, usedDeps, code.constants);
            out.emitFunction(tmpl.arity);
            return out.toString();
        });
        const caches = this.#globalLoads(code).map(ip => `const GC${ip} = GLOBAL_CACHE[${ip}];\n`).join("");
        const callCaches = this.#callSites(code).map(ip => `const CC${ip} = CALL_CACHE[${ip}];\n`).join("");
        // positions never change once registered, so each intrinsic's function and deps are read once, into locals
        const used = code.intrinsics.map(({ pos }) => code.table!.entries[pos]);
        const fns = used.map(({ pos }) => `const I${pos} = RT[${pos}];\n`).join("");
        const deps = [...usedDeps].map(d => `const ${d} = DEPS[${d.slice(1)}];\n`).join("");
        return `${caches}${callCaches}${fns}${deps}return {\nresume: ${resume},\ndirect: ${direct}\n};`;
    }

    static #globalLoads(code: Code): number[] {
        return code.ops.filter(op => op.k === "LoadGlobal").map(op => op.ip);
    }

    static #callSites(code: Code): number[] {
        return code.ops.filter(op => op.k === "Call" || op.k === "HostCall").map(op => op.ip);
    }

    public static buildAot(code: Code, tmpl?: ClosureTemplate): AotBlock[] {
        const starts = blockStarts(code.ops);
        const blocks: AotBlock[] = [];
        let o = 0;
        for (let b = 0; b < starts.length; b++) {
            const end = b + 1 < starts.length ? starts[b + 1] : code.size;
            const insts: AotInst[] = [];
            let term: AotTerm | null = null;
            let ip = starts[b];
            while (o < code.ops.length && code.ops[o].ip < ip) o++;
            while (ip < end && term === null) {
                const op = code.ops[o++];
                const at = op.ip;
                ip = at + OP_SIZE[op.k];
                switch (op.k) {
                    case "LoadConst": insts.push({ k: "LoadConst", dst: op.dst, idx: op.idx, at }); break;
                    case "LoadInt": insts.push({ k: "LoadInt", dst: op.dst, value: op.value, at }); break;
                    case "LoadUpvar": insts.push({ k: "LoadUpvar", dst: op.dst, idx: op.idx, unbox: op.unbox, at }); break;
                    case "SetUpvar": insts.push({ k: "SetUpvar", src: op.src, idx: op.idx, box: op.box, at }); break;
                    case "FixUpvar": insts.push({ k: "FixUpvar", clo: op.clo, idx: op.idx, src: op.src, at }); break;
                    case "LoadGlobal": insts.push({ k: "LoadGlobal", dst: op.dst, sym: op.sym, ip: at, at }); break;
                    case "SetGlobal": insts.push({ k: "SetGlobal", src: op.src, sym: op.sym, at }); break;
                    case "Move": case "Box": case "Unbox": case "SetBox": insts.push({ k: op.k, dst: op.dst, src: op.src, at }); break;
                    case "NewClosure": insts.push({ k: "NewClosure", dst: op.dst, tmpl: op.tmpl, captures: (code.constants[op.tmpl] as ClosureTemplate).upvarLocs, at }); break;
                    case "MoveAcc": insts.push({ k: "MoveAcc", dst: op.dst, at }); break;
                    case "Unpack": insts.push({ k: "Unpack", src: op.src, start: op.start, count: op.count, flags: op.flags, at }); break;
                    case "SetMark": insts.push({ k: "SetMark", key: op.key, val: op.val, at }); break;
                    case "MarkSave": case "MarkRestore": insts.push({ k: op.k, reg: op.reg, at }); break;
                    case "CurMarks": insts.push({ k: "CurMarks", dst: op.dst, at }); break;
                    case "IntCall": case "IntApply": insts.push({ k: op.k, pos: op.pos, dst: op.dst, start: op.start, nargs: op.nargs, at }); break;
                    case "If": term = { k: "Branch", cond: op.cond, then: ip, else: op.else, elseif: op.elseif, at }; break;
                    case "Else": term = { k: "Jump", target: op.end, at }; break;
                    case "EndIf": term = { k: "Jump", target: ip, at }; break;
                    case "Block": case "Loop": term = { k: op.k, body: ip, end: op.end, at }; break;
                    case "EndLoop": term = { k: "Jump", target: op.head, loopBack: true, at }; break;
                    case "Jump": term = { k: "Jump", target: op.target, escape: true, at }; break;
                    case "Call":
                        term = !op.tail ? { k: "Call", proc: op.proc, start: op.start, nargs: op.nargs, resume: ip, at }
                            : tmpl !== undefined && fitsArity(tmpl.arity, op.nargs)
                            ? { k: "MaybeSelfTailCall", proc: op.proc, start: op.start, nargs: op.nargs, ip, arity: tmpl.arity, restPos: tmpl.code.restPos, at }
                            : { k: "TailCall", proc: op.proc, start: op.start, nargs: op.nargs, ip, at };
                        break;
                    case "HostCall": term = { k: "HostCall", pos: op.pos, start: op.start, nargs: op.nargs, isTail: op.tail, resume: ip, at }; break;
                    case "Return": term = { k: "Return", reg: op.src, at }; break;
                    default: {
                        const _: never = op;
                    }
                }
            }
            blocks.push({ start: starts[b], insts, term: term ?? { k: "Jump", target: ip } });
        }
        return blocks;
    }
}
