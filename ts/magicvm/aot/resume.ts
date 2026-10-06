// The resume entry of a compiled function: heap frames, entered at any block
import { windowRegs } from "./liveness";
import type { AotBlock, AotTerm } from "./types";
import { DIRECT_SUSPEND_LIMIT } from "../values";
import { FunctionEmitter } from "./function";

// the frame-based entry the driver loop uses: registers live in locals and are spilled to frame.regs whenever control may leave
export class ResumeEmitter extends FunctionEmitter {
    protected readonly accExpr = "ctx.acc";
    protected readonly accOne = "oneValue(ctx.acc)";
    protected readonly endOfCode = "return null;";
    protected readonly siteVar = "frame.isite";
    // resume functions run from the driver loop, at the base of the js stack
    protected upvarRef(idx: number): string { return `upvars[${idx}]`; }
    protected setUpvarExpr(idx: number, val: string): string { return `upvars[${idx}] = ${val}`; }
    protected readonly marksVar = "frame.marks";
    protected readonly mframeVar = "frame.mframe";
    // follows jumps through empty blocks (left by loops and blocks) to where control really goes, saving dispatches
    #thread(target: number): number {
        if (this.debug) return target;
        const byStart = this.#blocksByStart ??= new Map(this.blocks.map(b => [b.start, b]));
        const seen: number[] = [];
        let end = target;
        for (let steps = 0; steps < this.blocks.length; steps++) {
            const known = this.#threaded.get(end);
            if (known !== undefined) {
                end = known;
                break;
            }
            const block = byStart.get(end);
            if (block === undefined || block.insts.length !== 0) break;
            const term = block.term;
            let next: number;
            if (term.k === "Jump") next = term.target;
            else if (term.k === "Block" || term.k === "Loop") next = term.body;
            else break;
            seen.push(end);
            end = next;
        }
        for (const start of seen) this.#threaded.set(start, end);
        return end;
    }

    #blocksByStart: Map<number, AotBlock> | null = null;
    readonly #threaded = new Map<number, number>();

    protected jump(target: number, next: number): string {
        return super.jump(this.#thread(target), next);
    }

    protected branch(term: Extract<AotTerm, { k: "Branch" }>, next: number): string {
        return super.branch({ ...term, then: this.#thread(term.then), else: this.#thread(term.else) }, next);
    }

    protected recordIp(ip: number): string {
        return `frame.ip = ${ip};`;
    }

    protected debugPos(ip: number): string {
        return `frame.posIp = ${ip};`;
    }

    protected errorSite(at: number): string {
        return `frame.posIp = ${at + 1};`;
    }

    protected windowCall(fn: string, start: number, nargs: number, withContext: boolean = false): string {
        const spills = windowRegs(start, nargs).map(r => `regs[${r}] = r${r}`);
        return `(${[...spills, `${fn}(regs, ${start}, ${nargs}${withContext ? ", ctx, executor" : ""})`].join(", ")})`;
    }

    #spills(regs: number[]): string {
        return regs.map(r => `regs[${r}] = r${r};`).join(" ");
    }

    #directCall(call: string): string {
        return `
            try {
                ctx.acc = ${call};
            } catch (e) {
                if (!(e instanceof Suspend)) throw e;
                e.push(frame);
                return executor.resumeSuspend(ctx, e);
            }
        `;
    }

    // A tail call from heap code: through the callee's direct entry when it has one (the js stack does not grow, since
    // this returns right after), else a heap frame replacing this one. A Suspend out of the direct callee rebuilds its
    // frames on top of this frame's caller, as the call is a tail call.
    #tailCall(proc: string, args: string, nargs: string, heapCall: string): string {
        return `
            const fn = frame.code.tailSuspends < ${DIRECT_SUSPEND_LIMIT} ? executor.entry(${proc}, null, ${nargs}, 0) : null;
            if (fn !== null) {
                let val;
                try {
                    val = fn(ctx, ${proc}, executor, 1, frame.marks, frame.mframe${args === "" ? "" : ", " + args});
                } catch (e) {
                    if (!(e instanceof Suspend)) throw e;
                    frame.code.tailSuspends++;
                    if (frame.parent !== null) e.push(frame.parent);
                    return executor.resumeSuspend(ctx, e);
                }
                return executor.setRetVal(ctx, frame.parent, val);
            }
            ${heapCall}
        `;
    }

    emitFunction(): void {
        const locals = Array.from({ length: this.numReg }, (_, i) => this.liveness.entryLive.has(i) ? `r${i} = regs[${i}]` : `r${i}`);
        this.emit(`
            function(ctx, frame, executor) {
                const regs = frame.regs;
                const upvars = frame.upvars;
                let ip = frame.ip, tmp;
                ${locals.length > 0 ? `let ${locals.join(", ")};` : ""}
                try {
                    top: while (true) {
                        switch (ip) {
        `);
        this.emitSwitchBody();
        this.emit(`
                            default:
                                return null;
                        }
                    }
                } catch (err) {
                    ${this.#spills(this.liveness.written)}
                    return executor.handleHostException(ctx, frame, err);
                }
            }
        `);
    }

    protected emitTerm(term: AotTerm, next: number): void {
        const live = this.liveness;
        if (this.debug) this.emit(this.debugHooks(term, this.tailProcOf(term)));
        switch (term.k) {
            case "Jump":
                return this.emit(this.jump(term.target, next));
            case "Branch":
                return this.emit(this.branch(term, next));
            case "Block":
            case "Loop":
                return this.emit(this.jump(term.body, next));
            case "Call":
                return this.emit(`
                    {
                        const proc = r${term.proc};
                        frame.ip = ${term.resume};
                        ${this.#spills(live.spillsFor(term.resume, windowRegs(term.start, term.nargs)))}
                        const fn = executor.entry(proc, null, ${term.nargs}, 0);
                        if (fn !== null) {
                            ${this.#directCall(`fn(ctx, proc, executor, 1, frame.marks, frame.mframe + 1${term.nargs > 0 ? ", " + this.argList(term.start, term.nargs) : ""})`)}
                        } else {
                            return executor.invoke(ctx, proc, frame, regs, ${term.start}, ${term.nargs}, false);
                        }
                    }
                    ${this.jump(term.resume, next)}
                `);
            case "HostCall": {
                const control = this.controlOf(term);
                if (control !== undefined) {
                    const site = { args: windowRegs(term.start, term.nargs).map(r => `r${r}`), isTail: term.isTail, resume: term.resume, loopCount: false };
                    return this.emit(`
                        ${control.setsResume ? "" : `frame.ip = ${term.resume};`}
                        ${term.isTail || control.continues ? "" : this.#spills(live.spillsFor(term.resume))}
                        ${control.heap(site, this.#spills(live.spillsFor(term.resume)))}
                        ${control.continues ? this.jump(term.resume, next) : ""}
                    `);
                }
                return this.emit(`
                    frame.ip = ${term.resume};
                    {
                        const res = ${this.intrinsicCall(term.pos, term.start, term.nargs)};
                        if (${this.isRequest("res", "ControlRequest")}) {
                            ${term.isTail ? this.tailMark("res") : this.#spills(live.spillsFor(term.resume))}
                            return res.run(ctx, executor, frame, ${term.isTail});
                        }
                        ctx.acc = res;
                        ${term.isTail ? "return executor.setRetVal(ctx, frame.parent, res);" : ""}
                    }
                    ${term.isTail ? "" : this.jump(term.resume, next)}
                `);
            }
            case "TailCall":
                return this.emit(`
                    {
                        const proc = r${term.proc};
                        ${this.#tailCall("proc", this.argList(term.start, term.nargs), `${term.nargs}`, `
                            frame.ip = ${term.ip};
                            ${this.#spills(windowRegs(term.start, term.nargs))}
                            return executor.invoke(ctx, proc, frame, regs, ${term.start}, ${term.nargs}, true);
                        `)}
                    }
                `);
            case "MaybeSelfTailCall":
                return this.emit(`
                    {
                        const proc = r${term.proc};
                        if (proc === frame.closure && !frame.isShared(ctx)) {
                            ${this.selfMoves(term)}
                            ip = 0;
                            continue top;
                        }
                        ${this.#tailCall("proc", this.argList(term.start, term.nargs), `${term.nargs}`, `
                            frame.ip = ${term.ip};
                            ${this.#spills(windowRegs(term.start, term.nargs))}
                            return executor.invoke(ctx, proc, frame, regs, ${term.start}, ${term.nargs}, true);
                        `)}
                    }
                `);
            case "Return":
                return this.emit(`
                    ctx.acc = r${term.reg};
                    return executor.setRetVal(ctx, frame.parent, ctx.acc);
                `);
            default: {
                const _: never = term;
            }
        }
    }
}
