// The direct entry of a compiled function: no frames, entered at its start
import { windowRegs } from "./liveness";
import { blockFacts, type Facts } from "./facts";
import { MAX_STRUCTURED_NESTING, STRUCTURE_MISMATCH } from "./types";
import type { AotBlock, AotTerm } from "./types";
import { corePos } from "../coreops";
import type { Arity } from "../arity";
import { type Intrinsic, type Kind } from "../intrinsics";
import { inlineDeps } from "./code-emitter";
import { FunctionEmitter } from "./function";

// the frameless entry used by direct calls: arguments arrive as js arguments and the value is returned
const VALUES_POS = corePos("%values");

export class DirectEmitter extends FunctionEmitter {
    // a self tail call restarts the function at the same depth, whose entry check may not count (see %interrupt), so it
    // counts as a loop's back-edge does (a pause resumes the restarted call, whose arguments are in place)
    #selfTailCount(): string {
        if (!(this.table?.interrupts ?? false)) return "";
        return `if (--ic < 0) { ic = 255; if ((executor.interruptLeft -= 256) <= 0) { rip = 0; executor.interruptDirect(ctx, closure, marks, mframe); } }`;
    }

    protected readonly accExpr = "acc";
    protected readonly accOne = "acc";
    protected readonly buffered = true;
    protected readonly substitutes = true;
    // how many values the calls of the entry being emitted want (Code.wanted; 0: all of them). Its tail calls ask the
    // same of what they call
    #want = 0;
    #params = 0;
    // how the Return of the block being emitted returns the (%values e ...) the block made, in an entry for a count
    #valuesReturn: string | null = null;
    protected upvarRef(idx: number): string { return `uv${idx}`; }
    protected setUpvarExpr(idx: number, val: string): string { return `closure.upvars[${idx}] = uv${idx} = ${val}`; }
    protected readonly marksVar = "marks";
    protected readonly mframeVar = "mframe";
    // this function's own arity, when a call to its own closure can call it by name (no rest parameter)
    #selfArity = -1;
    // it is only entered at its start, so what is known at each block's start holds for the whole function
    #entryFacts: Map<number, Facts> | null = null;
    protected get entryFacts(): Map<number, Facts> {
        return this.#entryFacts ??= blockFacts(this.blocks, this.table, this.constants, this.#seed);
    }
    // in the version for number parameters, what it knows on entry; and the check that picks that version, made again
    // on every self tail call (its new arguments may not be numbers)
    #seed: Facts | null = null;
    #specCheck: string | null = null;

    // the kinds of the positional parameters intrinsics want (`wants`) where they read them (directly, or through the
    // moves a parameter is usually copied by first): a version knowing them can drop their checks, which cost most in hot
    // loops over the floats computed from them. A parameter wanted as two kinds is left out
    #paramKinds(params: number): Map<number, Kind> {
        const wanted = new Map<number, Kind | null>();
        const want = (reg: number, kind: Kind) => wanted.set(reg, wanted.has(reg) && wanted.get(reg) !== kind ? null : kind);
        for (const block of this.blocks) {
            for (const x of block.insts) {
                if (x.k !== "IntCall" && x.k !== "IntApply") continue;
                const kind = this.table?.entries[x.pos]?.wants;
                if (kind !== undefined) for (const r of windowRegs(x.start, x.nargs)) want(r, kind);
            }
        }
        for (let grew = true; grew;) {
            grew = false;
            for (const block of this.blocks) {
                for (const x of block.insts) {
                    const kind = x.k === "Move" ? wanted.get(x.dst) : undefined;
                    if (x.k === "Move" && kind !== undefined && kind !== null && wanted.get(x.src) !== kind) {
                        const before = wanted.get(x.src);
                        want(x.src, kind);
                        grew = wanted.get(x.src) !== before || grew;
                    }
                }
            }
        }
        const out = new Map<number, Kind>();
        for (let i = 0; i < params; i++) {
            const kind = wanted.get(i);
            if (kind !== undefined && kind !== null) out.set(i, kind);
        }
        return out;
    }
    protected readonly endOfCode = "return undefined;";
    protected readonly siteVar = "isite";

    protected recordIp(): string {
        return "";
    }

    protected debugPos(ip: number): string {
        return `dip = ${ip};`;
    }

    protected errorSite(at: number, err: string): string {
        return `dip = ${at + 1}; derr = ${err};`;
    }

    protected windowCall(fn: string, start: number, nargs: number, withContext: boolean = false): string {
        return `${fn}([${this.argList(start, nargs)}], 0, ${nargs}${withContext ? ", ctx, executor" : ""})`;
    }

    // whether the code runs procedures the optimizer inlined (see Frame.isite)
    get #hasSites(): boolean {
        return this.blocks.some(b => b.insts.some(x => x.k === "SetSite"));
    }

    // the direct entry takes the parameters' values (the rest parameter's last) as js arguments
    emitFunction(closureArity: Arity, want: number = 0): void {
        this.#want = want;
        this.#params = closureArity.params + (closureArity.rest === "none" ? 0 : 1);
        this.#selfArity = closureArity.rest === "none" ? closureArity.params : -1;
        const arity = closureArity.params + (closureArity.rest === "none" ? 0 : 1);
        const params = Array.from({ length: arity }, (_, i) => `, a${i}`).join("");
        const locals = Array.from({ length: this.numReg }, (_, i) => i < arity ? `r${i} = a${i}` : `r${i}`);
        // a frame rebuilt from here resumes in heap code, which reads only the registers live where it can resume: reading
        // the others here would make V8 keep every temporary boxed wherever the function could throw (a float loop ran
        // three times slower)
        const resumeLive = this.liveness.entryLive;
        const allRegs = Array.from({ length: this.numReg }, (_, i) => resumeLive.has(i) ? `r${i}` : "undefined").join(", ");
        const usedUpvars = new Set<number>();
        for (const b of this.blocks) {
            for (const inst of b.insts) {
                if (inst.k === "LoadUpvar" || inst.k === "SetUpvar") usedUpvars.add(inst.idx);
                else if (inst.k === "NewClosure") {
                    for (const c of inst.captures) if (!c.local) usedUpvars.add(c.index);
                }
            }
        }
        const uvDefs = usedUpvars.size > 0
            ? `const upvars = closure.upvars;\nlet ${Array.from(usedUpvars).map(idx => `uv${idx} = upvars[${idx}]`).join(", ")};`
            : "";
        this.emit(`
            function direct$(ctx, closure, executor, depth, marks, mframe${params}) {
                let ip = 0, rip = 0, tip = -1, ic = 255, acc, tmp${this.debug ? ", dip = 0" : ", dip = -1, derr"}${this.#hasSites ? ", isite = -1" : ""};
                ${locals.length > 0 ? `let ${locals.join(", ")};` : ""}
                ${uvDefs}
        `);
        // a parameter whose kind has no check (guard) the front end can write stays checked in the body
        const types = this.table?.types ?? null;
        const guards = new Map<number, string>();
        const kinds = types === null ? new Map<number, Kind>() : this.#paramKinds(closureArity.params);
        for (const [i, kind] of kinds) {
            const test = types!.guard(kind, `r${i}`, inlineDeps({ name: "the type system", deps: this.table!.typeDeps } as Intrinsic, this.usedDeps));
            if (test !== null) guards.set(i, test);
        }
        const numeric = [...guards.keys()];
        this.#specCheck = numeric.length > 0 ? numeric.map(i => `(${guards.get(i)})`).join(" && ") : null;
        const structured = this.#structuredBody();
        const special = structured !== null && this.#specCheck !== null ? this.#structuredBody(new Map(numeric.map(i => [i, kinds.get(i)!]))) : null;
        if (special === null) this.#specCheck = null;
        this.emit(`
                ${special !== null ? `let spec = ${this.#specCheck};` : ""}
                try {
        `);
        if (structured !== null) {
            this.emit(`
                    top: for (;;) {
                        ${special !== null ? `if (spec) {
                            ${special}
                            return undefined;
                        }` : ""}
                        ${structured}
                        return undefined;
                    }
            `);
        } else {
            this.emit(`
                    top: while (true) {
                        switch (ip) {
            `);
            this.emitSwitchBody();
            this.emit(`
                            default:
                                return undefined;
                        }
                    }
            `);
        }
        this.emit(`
                } catch (e) {
                    for (ic = 16; ic > 0; ic--);
                    throw unwind(e, closure, rip === -1 ? null : [${allRegs}], rip, tip, dip, ${this.debug ? "undefined" : "derr"}, ${this.#hasSites ? "isite" : "-1"}, ctx, marks, mframe);
                }
            }
        `);
    }

    // direct-entry code never resumes mid-function, so compiled `if`s (If c else ... Else end, else: ... EndIf, end:) can be emitted as nested js if/else
    #structuredBody(seed: Facts | null = null): string | null {
        const body = new DirectEmitter(this.blocks, this.structure, this.liveness, this.numReg, this.debug, this.table, this.usedDeps, this.constants);
        body.#selfArity = this.#selfArity;
        body.#want = this.#want;
        body.#params = this.#params;
        body.#seed = seed;
        body.#specCheck = this.#specCheck;
        const index = new Map(this.blocks.map((b, i) => [b.start, i]));
        try {
            body.#walk(index, 0, this.structure.size);
        } catch (e) {
            if (e === STRUCTURE_MISMATCH) return null;
            throw e;
        }
        return body.toString();
    }

    readonly #blockLabels = new Map<number, string>();

    // how deeply the structured code nests so far; V8 fails to compile js nested thousands of levels deep, so past
    // MAX_STRUCTURED_NESTING the direct entry falls back to switch dispatch
    #nesting = 0;

    // the labels of the if chains being walked, by the ip of their end
    readonly #chains = new Map<number, string>();

    // whether the else branch of the if ending at endIp starts an elseif If of the same chain (whose then branch ends with
    // Else endIp; a nested if's chain has its own end)
    #hasElseIf(elseIp: number, endIp: number): boolean {
        const endIf = this.structure.endIfBefore.get(endIp)!;
        return this.structure.elseIfs.some(e => e.ip >= elseIp && e.ip < endIf && this.structure.elseBefore.get(e.else)?.end === endIp);
    }

    #walk(index: Map<number, number>, from: number, stop: number): void {
        let i = index.get(from);
        if (i === undefined) throw STRUCTURE_MISMATCH;
        if (++this.#nesting > MAX_STRUCTURED_NESTING) throw STRUCTURE_MISMATCH;
        try {
            this.#walkRegion(index, i, stop);
        } finally {
            this.#nesting--;
        }
    }

    #walkRegion(index: Map<number, number>, first: number, stop: number): void {
        const { blocks } = this;
        let i: number | undefined = first;
        while (i < blocks.length && blocks[i].start < stop) {
            const block = blocks[i];
            const next = i + 1 < blocks.length ? blocks[i + 1].start : this.structure.size;
            this.startBlock(this.entryFacts.get(block.start));
            this.emitInsts(block);
            const term = block.term;
            if (term.k === "Branch") {
                const elseIp = term.else;
                const thenEnd = this.structure.elseBefore.get(elseIp);
                if (term.then !== next || thenEnd === undefined) throw STRUCTURE_MISMATCH;
                const endIp = thenEnd.end, thenStop = thenEnd.at;
                const elseStop = this.structure.endIfBefore.get(endIp);
                if (elseStop === undefined) throw STRUCTURE_MISMATCH;
                // a later clause of the chain being walked: a sibling of the first, leaving the chain's block when taken
                if (term.elseif) {
                    const chain = this.#chains.get(endIp);
                    if (chain === undefined) throw STRUCTURE_MISMATCH;
                    this.emit(`if (${this.truthy(term.cond)}) {`);
                    this.#walk(index, term.then, thenStop);
                    this.emit(`break ${chain}; }`);
                    i = index.get(elseIp);
                    if (i === undefined) throw STRUCTURE_MISMATCH;
                    continue;
                }
                if (this.#hasElseIf(elseIp, endIp)) {
                    // a chain is flat: C: { if (c1) { e1; break C; } <c2> if (c2) { e2; break C; } ... else }
                    const chain = `C${block.start}`;
                    this.#chains.set(endIp, chain);
                    this.emit(`${chain}: {`);
                    this.emit(`if (${this.truthy(term.cond)}) {`);
                    this.#walk(index, term.then, thenStop);
                    this.emit(`break ${chain}; }`);
                    this.#walk(index, elseIp, elseStop);
                    this.emit(`}`);
                    this.#chains.delete(endIp);
                } else {
                    this.emit(`if (${this.truthy(term.cond)}) {`);
                    this.#walk(index, term.then, thenStop);
                    this.emit(`} else {`);
                    this.#walk(index, elseIp, elseStop);
                    this.emit(`}`);
                }
                if (endIp >= stop) return;
                i = index.get(endIp);
                if (i === undefined) throw STRUCTURE_MISMATCH;
                continue;
            }
            if (term.k === "Block" || term.k === "Loop") {
                if (term.body !== next) throw STRUCTURE_MISMATCH;
                if (term.k === "Block") {
                    // escapes to the block's end become `break` of a label unique to this block
                    const label = `B${block.start}`;
                    const outer = this.#blockLabels.get(term.end);
                    this.#blockLabels.set(term.end, label);
                    this.emit(`${label}: {`);
                    this.#walk(index, term.body, term.end);
                    this.emit(`}`);
                    if (outer === undefined) this.#blockLabels.delete(term.end);
                    else this.#blockLabels.set(term.end, outer);
                } else {
                    this.emit(`for (;;) {`);
                    this.#walk(index, term.body, term.end);
                    this.emit(`}`);
                }
                if (term.end >= stop) return;
                i = index.get(term.end);
                if (i === undefined) throw STRUCTURE_MISMATCH;
                continue;
            }
            if (term.k === "Jump") {
                if (term.escape) {
                    const label = this.#blockLabels.get(term.target);
                    if (label === undefined) throw STRUCTURE_MISMATCH;
                    this.emit(`break ${label};`);
                    i++;
                    continue;
                }
                // the back edge closing the loop being walked: the js for loop repeats by itself
                if (term.loopBack) return;
                if (term.target < stop) throw STRUCTURE_MISMATCH;
                return;
            }
            this.emitTerm(term, next);
            i++;
        }
    }

    // an entry for a count does not make the multiple values a block only returns: it returns the first of them, or
    // leaves as many as are wanted in VB
    protected fused(block: AotBlock, index: number): number {
        const inst = block.insts[index];
        if (this.#want === 0 || inst.k !== "IntCall" || inst.pos !== VALUES_POS || inst.nargs === 1 || index !== block.insts.length - 1) return 0;
        const given = windowRegs(inst.start, Math.min(inst.nargs, this.#want));
        const returns = given.length === 0 ? "return undefined;" : this.#want === 1 ? `return ${this.use(given[0])};`
            : `${given.map((r, i) => `VB[${i}] = ${this.use(r)};`).join(" ")} return MULTI;`;
        if (block.term.k === "Return" && block.term.reg === inst.dst) {
            this.#valuesReturn = returns;
            return 1;
        }
        // or the block goes on to one that only returns them (the end of the function's body): it returns here
        const target = block.term.k === "Jump" ? this.blocks.find(b => b.start === (block.term as { target: number }).target) : undefined;
        if (target === undefined || target.insts.length !== 0 || target.term.k !== "Return" || target.term.reg !== inst.dst) return 0;
        this.emit(returns);
        return 1;
    }

    // what the entry returns of `value` (an expression that may be multiple values)
    #returned(value: string, want: number = this.#want): string {
        return want === 0 ? value : want === 1 ? `oneValue(${value})` : `manyValues(${value}, ${want})`;
    }

    // a call of `proc` (in scope), leaving its value in acc, or returning it for a tail call. `args` are the argument
    // expressions, or null for the array `args` (in scope). `want`: how many values the call wants (a tail call wants what
    // this entry's calls do). Expressions go to this entry itself for the running closure, else to the entry the site's cache
    // keeps for the callee's template, else to the one the executor finds, else as executor.callArray does
    #call({ args, tail, site, want = 0, marks = "marks" }: { args: string[] | null, tail: boolean, site?: number, want?: number, marks?: string }): string {
        if (tail) want = this.#want;
        const use = tail ? "return" : "acc =";
        const frame = tail ? "mframe" : "mframe + 1";
        const array = (callee: string, list: string) => {
            const call = `executor.callArray(ctx, ${callee}, ${list}, depth + 1, ${marks}, ${frame})`;
            return this.#returned(call, want);
        };
        if (args === null) return `${use} ${array("proc", "args")};`;
        const cache = site !== undefined ? `CC${site}` : null;
        const rest = `executor, depth + 1, ${marks}, ${frame}${args.map(a => ", " + a).join("")}`;
        return `
            ${tail ? `rip = -1;${site !== undefined ? ` tip = ${site};` : ""}` : ""}
            ${!tail && args.length === this.#selfArity && want === this.#want ? `if (proc === closure && depth < MAX_JS_DEPTH) {
                acc = direct$(ctx, proc, ${rest});
            } else ` : ""}${cache !== null ? `if (proc?.tmpl === ${cache}.tmpl && ${cache}.tmpl.code.direct && depth < MAX_JS_DEPTH) {
                ${use} ${cache}.fn(ctx, proc, ${rest});
            } else ` : ""}{
                const callee = proc?.constructor === CaseLambda ? proc.select(${args.length}) : proc;
                const fn = executor.entry(callee, ${cache}, ${args.length}, depth${want !== 0 ? `, ${want}` : ""});
                ${use} fn !== null ? fn(ctx, callee, ${rest}) : ${array("callee", `[${args.join(", ")}]`)};
            }
        `;
    }

    #args(term: { start: number, nargs: number }): string[] {
        return windowRegs(term.start, term.nargs).map(r => this.use(r));
    }

    protected emitTerm(term: AotTerm, next: number): void {
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
                        const proc = ${this.use(term.proc)};
                        rip = ${term.resume};
                        ${this.#call({ args: this.#args(term), tail: false, site: term.at, want: term.one === true ? 1 : term.many ?? 0 })}
                    }
                    ${this.jump(term.resume, next)}
                `);
            case "HostCall": {
                const control = this.controlOf(term);
                if (control !== undefined) {
                    const site = { args: this.#args(term), isTail: term.isTail, resume: term.resume, loopCount: this.structure.endLoops.has(term.resume) };
                    return this.emit(`
                        ${control.setsResume ? "" : `rip = ${term.isTail ? -1 : term.resume};`}
                        ${control.direct(site, this.#call({ args: null, tail: term.isTail }), (args, marks) => this.#call({ args, tail: false, marks }))}
                        ${term.isTail ? "" : this.jump(term.resume, next)}
                    `);
                }
                return this.emit(`
                    {
                        rip = ${term.isTail ? -1 : term.resume};
                        const res = ${this.intrinsicCall(term.pos, term.start, term.nargs)};
                        if (${this.isRequest("res", "HostTail")}) {
                            ${term.isTail ? this.tailMark("res") : ""}
                            const proc = res.proc, args = res.args;
                            ${this.#call({ args: null, tail: term.isTail })}
                        } else if (${this.isRequest("res", "ControlRequest")}) {
                            ${term.isTail ? this.tailMark("res") : ""}
                            ${term.isTail ? `return ${this.#returned(`res.direct(ctx, executor, closure, marks, mframe, true)`)};` : "acc = res.direct(ctx, executor, closure, marks, mframe, false);"}
                        } else {
                            ${term.isTail ? `return ${this.#returned("res")};` : "acc = res;"}
                        }
                    }
                    ${term.isTail ? "" : this.jump(term.resume, next)}
                `);
            }
            case "TailCall":
                return this.emit(`{ const proc = ${this.use(term.proc)}; ${this.#call({ args: this.#args(term), tail: true, site: term.at })} }`);
            case "MaybeSelfTailCall":
                return this.emit(`
                    {
                        const proc = ${this.use(term.proc)};
                        if (proc === closure) {
                            ${this.selfMoves(term)}
                            ${this.#selfTailCount()}
                            ip = 0;
                            ${this.#specCheck !== null ? `spec = ${this.#specCheck};` : ""}
                            continue top;
                        }
                        ${this.#call({ args: this.#args(term), tail: true, site: term.at })}
                    }
                `);
            case "Return": {
                const made = this.#valuesReturn;
                this.#valuesReturn = null;
                if (made !== null) return this.emit(made);
                // an entry for one value returns the first of several: nothing to do where the register holds one
                const value = this.use(term.reg);
                if (this.#want === 0 || this.holdsOne(term.reg, this.#params)) return this.emit(`return ${value};`);
                if (this.#want === 1) return this.emit(`return ${this.oneOf(value)};`);
                // multiple values made elsewhere: the first few are moved here (as manyValues does), without a call
                const moves = Array.from({ length: this.#want }, (_, i) => `VB[${i}] = ${i < 2 ? `tmp[${i}]` : `tmp.length > ${i} ? tmp[${i}] : undefined`}`);
                const spill = this.#want <= 4 ? `(tmp = ${value}.values, tmp.length < 2 ? tmp[0] : (${moves.join(", ")}, MULTI))` : `manyValues(${value}, ${this.#want})`;
                return this.emit(`return ${value}?.constructor === MultipleValues ? ${spill} : ${value};`);
            }
            default: {
                const _: never = term;
            }
        }
    }
}
