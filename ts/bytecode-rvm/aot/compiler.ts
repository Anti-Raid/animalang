// The AOT compiler: decodes bytecode into basic blocks, generates a function's JS source (see emit.ts) and builds it,
// sharing the built source between copies of the same code; JIT_DEPS are the names generated code can use
import { Env, ErrorObject, IProcedure, MissingVarError, MultipleValues, Table, isTruthy, packValues } from "../../common";
import { Cons } from "../../list";
import { Caught, ContinuationMarkSet, EXCEPTION_HANDLERS, markFirst, markSet, recordTailMark } from "../../marks";
import { DirectEmitter, ResumeEmitter } from "./emit";
import type { AotBlock, AotInst, AotTerm, SourceUse } from "./types";
import { fitsArity } from "../arity";
import { Closure, ClosureTemplate, SHARED_INSTS } from "../bytecode";
import type { ByteCode, DirectFn, ResumeFn } from "../bytecode";
import { ControlRequest, HostTail, applyIntrinsic, raiseContinuable, restArrayArgs, stackSkip } from "../coreops";
import type { VMExecutor } from "../executor";
import { OpCode } from "../interpreter";
import { listToArray, listToValues, windowApplyArgs, windowRestArgs } from "../lists";
import { INSTRUCTION_LENGTHS, basicBlockStarts } from "../opcodes";
import { Box, CatchToken, EscapeContinuation, EscapedError, Frame, MAX_JS_DEPTH, MAX_NESTED_RESUMES, MISSING, StackSnapshot, Suspend, WindPoint, catchHere, countControlSuspend, frameInfos, restValues, tailName, unpackForBinding } from "../values";
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
    isTruthy,
    Box,
    MissingVarError,
    Closure,
    WindPoint,
    windowApplyArgs,
    windowRestArgs,
    restArrayArgs,
    raiseContinuable,
    stackSkip,
    packValues,
    listToValues,
    listToArray,
    Cons,
    MISSING,
    MAX_JS_DEPTH,
    MAX_NESTED_RESUMES,
    Table,
    Env,
    Frame,
    Suspend,
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
            if (frame.ip === 0 && frame.code.directArity === 0 && !frame.isShared(frame.ctx)) frame = this.#runDirect(frame, executor);
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

    public static compileAll(code: ByteCode, tmpl?: ClosureTemplate): void {
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

    public static compile(code: ByteCode, tmpl?: ClosureTemplate): ResumeFn {
        const { resume, direct } = this.generateFunction(code, tmpl);
        code.resumeFn = resume;
        if (direct !== null && tmpl !== undefined) {
            code.directFn = direct;
            if (tmpl.arity.rest === "none") code.directArity = tmpl.arity.min;
            else code.directRestArity = tmpl.arity.min;
        }
        return resume;
    }

    // the compiled source of shared instruction arrays: copies of a ByteCode (ByteCode.fresh) only build their own functions.
    // Source that calls intrinsics also depends on what they generate: their positions, inline templates and deps' locals.
    // Instances that register the same intrinsics the same way (e.g. from the same front end) share it
    static readonly #sources = new WeakMap<Uint32Array, { uses: readonly SourceUse[], factory: Function }[]>();

    static #sameUses(a: readonly SourceUse[], b: readonly SourceUse[]): boolean {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            const x = a[i], y = b[i];
            if (x.pos !== y.pos || x.inline !== y.inline) return false;
            const dx = Object.entries(x.deps), dy = y.deps;
            if (dx.length !== Object.keys(dy).length || dx.some(([k, v]) => dy[k] !== v)) return false;
        }
        return true;
    }

    public static generateFunction(code: ByteCode, tmpl?: ClosureTemplate): { resume: ResumeFn, direct: DirectFn | null } {
        const uses: SourceUse[] = code.intrinsics.map(({ pos }) => { const { inline, deps } = code.table!.entries[pos]; return { pos, inline, deps }; });
        let variants = this.#sources.get(code.inst);
        let factory = variants?.find(v => this.#sameUses(v.uses, uses))?.factory;
        if (factory === undefined) {
            // parsing the source is most of the cost, so copies share the factory and only call it for their own functions
            factory = new Function(...Object.keys(JIT_DEPS), "CONSTANTS", "GLOBAL_CACHE", "RT", "DEPS", this.generateSource(code, tmpl));
            if (SHARED_INSTS.has(code.inst)) {
                if (variants === undefined) this.#sources.set(code.inst, variants = []);
                variants.push({ uses, factory });
            }
        }
        const globalCache: Record<number, { scope: Env | null, version: number, value: any }> = {};
        for (const ip of this.#globalLoads(code)) globalCache[ip] = { scope: null, version: -1, value: undefined };
        return factory(...Object.values(JIT_DEPS), code.constants, globalCache, code.table?.fns ?? [], code.table?.deps ?? []);
    }

    public static generateSource(code: ByteCode, tmpl?: ClosureTemplate): string {
        if (code.intrinsics.length > 0 && code.table === null) throw new Error("internal error: compiling code that uses intrinsics without a table");
        const blocks = this.buildAot(code, tmpl);
        const usedDeps = new Set<string>();
        const resume = new ResumeEmitter(blocks, code.inst, code.numReg, code.debug, code.table, usedDeps);
        resume.emitFunction();
        let direct = "null";
        if (tmpl !== undefined) {
            const out = new DirectEmitter(blocks, code.inst, code.numReg, code.debug, code.table, usedDeps);
            out.emitFunction(tmpl.arity);
            direct = out.toString();
        }
        const caches = this.#globalLoads(code).map(ip => `const GC${ip} = GLOBAL_CACHE[${ip}];\n`).join("");
        // positions never change once registered, so each intrinsic's function and deps are read once, into locals
        const used = code.intrinsics.map(({ pos }) => code.table!.entries[pos]);
        const fns = used.map(({ pos }) => `const I${pos} = RT[${pos}];\n`).join("");
        const deps = [...usedDeps].map(d => `const ${d} = DEPS[${d.slice(1)}];\n`).join("");
        return `${caches}${fns}${deps}return {\nresume: ${resume.toString()},\ndirect: ${direct}\n};`;
    }

    static #globalLoads(code: ByteCode): number[] {
        const ips: number[] = [];
        for (let ip = 0; ip < code.inst.length; ip += INSTRUCTION_LENGTHS[code.inst[ip] as OpCode]) {
            if (code.inst[ip] === OpCode.LOADGLOBAL) ips.push(ip);
        }
        return ips;
    }

    public static buildAot(code: ByteCode, tmpl?: ClosureTemplate): AotBlock[] {
        const inst = code.inst;
        const starts = basicBlockStarts(inst);
        const blocks: AotBlock[] = [];

        for (let b = 0; b < starts.length; b++) {
            const end = b + 1 < starts.length ? starts[b + 1] : inst.length;
            const insts: AotInst[] = [];
            let term: AotTerm | null = null;
            let ip = starts[b];

            while (ip < end && term === null) {
                const opIp = ip;
                const numInsts = insts.length;
                const opcode: OpCode = inst[ip++];
                switch (opcode) {
                    case OpCode.LOADCONST:
                        insts.push({ k: "LoadConst", dst: inst[ip++], idx: inst[ip++] });
                        break;
                    case OpCode.LOADU32:
                        insts.push({ k: "LoadInt", dst: inst[ip++], value: inst[ip++] });
                        break;
                    case OpCode.LOADUPVAR:
                        insts.push({ k: "LoadUpvar", dst: inst[ip++], idx: inst[ip++], unbox: inst[ip++] !== 0 });
                        break;
                    case OpCode.SETUPVAR:
                        insts.push({ k: "SetUpvar", src: inst[ip++], idx: inst[ip++], box: inst[ip++] !== 0 });
                        break;
                    case OpCode.LOADGLOBAL:
                        insts.push({ k: "LoadGlobal", dst: inst[ip++], sym: inst[ip++], ip: opIp });
                        break;
                    case OpCode.SETGLOBAL:
                        insts.push({ k: "SetGlobal", src: inst[ip++], sym: inst[ip++] });
                        break;
                    case OpCode.MOVE:
                        insts.push({ k: "Move", dst: inst[ip++], src: inst[ip++] });
                        break;
                    case OpCode.BOX:
                        insts.push({ k: "Box", dst: inst[ip++], src: inst[ip++] });
                        break;
                    case OpCode.UNBOX:
                        insts.push({ k: "Unbox", dst: inst[ip++], src: inst[ip++] });
                        break;
                    case OpCode.SETBOX:
                        insts.push({ k: "SetBox", dst: inst[ip++], src: inst[ip++] });
                        break;
                    case OpCode.NEWCLOSURE: {
                        const dst = inst[ip++];
                        const tmplIdx = inst[ip++];
                        insts.push({ k: "NewClosure", dst, tmpl: tmplIdx, captures: (code.constants[tmplIdx] as ClosureTemplate).upvarLocs });
                        break;
                    }
                    case OpCode.IF:
                    case OpCode.ELSEIF: {
                        const cond = inst[ip++];
                        const elseIp = inst[ip++];
                        term = { k: "Branch", cond, then: ip, else: elseIp, elseif: opcode === OpCode.ELSEIF };
                        break;
                    }
                    case OpCode.ELSE:
                        term = { k: "Jump", target: inst[ip++] };
                        break;
                    case OpCode.ENDIF:
                        term = { k: "Jump", target: ip };
                        break;
                    case OpCode.BLOCK:
                    case OpCode.LOOP: {
                        const end = inst[ip++];
                        term = { k: opcode === OpCode.BLOCK ? "Block" : "Loop", body: ip, end };
                        break;
                    }
                    case OpCode.ENDLOOP:
                        term = { k: "Jump", target: inst[ip++], loopBack: true };
                        break;
                    case OpCode.JUMP:
                        term = { k: "Jump", target: inst[ip++], escape: true };
                        break;
                    case OpCode.CALL: {
                        const procIdx = inst[ip++];
                        const start = inst[ip++];
                        const nargs = inst[ip++];
                        const isTail = inst[ip++] !== 0;
                        if (!isTail) {
                            term = { k: "Call", proc: procIdx, start, nargs, resume: ip };
                            break;
                        }
                        term = tmpl !== undefined && fitsArity(tmpl.arity, nargs)
                            ? { k: "MaybeSelfTailCall", proc: procIdx, start, nargs, ip, arity: tmpl.arity }
                            : { k: "TailCall", proc: procIdx, start, nargs, ip };
                        break;
                    }
                    case OpCode.MOVEACC:
                        insts.push({ k: "MoveAcc", dst: inst[ip++] });
                        break;
                    case OpCode.UNPACK:
                        insts.push({ k: "Unpack", src: inst[ip++], start: inst[ip++], count: inst[ip++], flags: inst[ip++] });
                        break;
                    case OpCode.SETMARK:
                        insts.push({ k: "SetMark", key: inst[ip++], val: inst[ip++] });
                        break;
                    case OpCode.MARKSAVE:
                        insts.push({ k: "MarkSave", reg: inst[ip++] });
                        break;
                    case OpCode.MARKRESTORE:
                        insts.push({ k: "MarkRestore", reg: inst[ip++] });
                        break;
                    case OpCode.CURMARKS:
                        insts.push({ k: "CurMarks", dst: inst[ip++] });
                        break;
                    case OpCode.CALLINT:
                    case OpCode.CALLCTX:
                        insts.push({ k: "IntCall", pos: inst[ip++], dst: inst[ip++], start: inst[ip++], nargs: inst[ip++] });
                        break;
                    case OpCode.APPLYINT:
                    case OpCode.APPLYINTR:
                        insts.push({ k: inst[opIp] === OpCode.APPLYINT ? "IntApply" : "IntApplyRest", pos: inst[ip++], dst: inst[ip++], start: inst[ip++], nargs: inst[ip++] });
                        break;
                    case OpCode.CALLEC: {
                        const proc = inst[ip++];
                        term = { k: "CallEC", proc, tok: inst[ip++], resume: ip };
                        break;
                    }
                    case OpCode.CALLCATCH: {
                        const proc = inst[ip++];
                        const tok = inst[ip++];
                        term = { k: "CallCatch", proc, tok, pre: inst[ip++], resume: ip };
                        break;
                    }
                    case OpCode.CALLHOST: {
                        const pos = inst[ip++];
                        const start = inst[ip++];
                        const nargs = inst[ip++];
                        term = { k: "HostCall", pos, start, nargs, isTail: inst[ip++] !== 0, resume: ip };
                        break;
                    }
                    case OpCode.RETURN:
                        term = { k: "Return", reg: inst[ip++] };
                        break;
                    default: {
                        const _: never = opcode;
                        throw new Error(`Unhandled opcode in JIT: ${opcode}`);
                    }
                }
                if (insts.length > numInsts) insts[insts.length - 1].at = opIp;
                if (term !== null) term.at = opIp;
            }

            blocks.push({ start: starts[b], insts, term: term ?? { k: "Jump", target: ip } });
        }

        return blocks;
    }
}
