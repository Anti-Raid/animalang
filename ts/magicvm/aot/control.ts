// The AOT code of the core control operations (CONTROL_AOT)
import { DIRECT_SUSPEND_LIMIT } from "../values";

// AOT code for the core control operations: what carrying out their requests does (see ControlRequest), written out at
// the call so there is no request to make and dispatch on, which shows in tight coroutine and call/cc loops. The
// other requests carry themselves out (ControlRequest.run). `args` are the arguments' registers (as js expressions): the count
// was checked when compiling.
//  - heap: resume code, after frame.ip is set (and, unless in tail position or `continues`, the live registers are
//    spilled): statements that return the frame to run next, or with `continues`, set ctx.acc and carry on. `spills`
//    spills the live registers, for a `continues` operation that leaves the frame only sometimes
//  - direct: direct code, after rip is set: statements that throw a Suspend, or set acc (return it, in tail position),
//    or declare `proc` and `args` and then run `callArray`, which calls proc with args (see DirectEmitter.#call)
//    or `call`, which calls `proc` (in scope) with args, leaving its value in acc
//  - tailProc: in tail position, the first argument is what debug code records as the tail call
// `resume`: the ip after the call, which the emitter stores (frame.ip, rip) before the template unless `setsResume`;
// `loopCount`: in direct code, the call is at a loop's back-edge (its next instruction is EndLoop), where a function can
// count in its local `ic` (a loop there runs within one call of the function)
// `reentrant`: whether the code may be re-entered by a continuation (Code.reentrant)
export type ControlSite = { args: string[], isTail: boolean, resume: number, loopCount: boolean, reentrant: boolean };
export type ControlAot = {
    heap: (s: ControlSite, spills: string) => string,
    direct: (s: ControlSite, callArray: string, call: (args: string[], marks: string) => string) => string,
    continues?: boolean,
    tailProc?: boolean,
    // the template stores the resume point itself, only on a path that needs it
    setsResume?: boolean,
};
export const valuesOf = (args: string[]) => args.length === 1 ? args[0] : `packValues([${args.join(", ")}])`;
export const resumeArgs = (name: string, args: string[]) => name === "%coroutine-resume" ? `[${args.slice(1).join(", ")}]` : `arrayArg("%coroutine-resume-array", ${args[1]}).slice()`;
export const applyArgsOf = (name: string, args: string[]) => name === "%apply-fresh" ? `arrayArg("%apply", ${args[1]})` : `applyArgs([${args.slice(1).join(", ")}], 0, ${args.length - 1})`;
// counting an interrupt check in the function's local `ic` (see %interrupt below)
const LOOP_COUNT = "--ic < 0 && (ic = 255, (executor.interruptLeft -= 256) <= 0)";
// a catch in direct code that is not re-entrant, around `call` (which leaves the value in acc): no token and no mark, its
// place is on the context's stack (ExecutionContext.catches) while the call runs
const stackCatch = (call: string) => `{
    const at = ctx.ncatch;
    ctx.catches[at] = marks === null ? null : markFirst(marks, EXCEPTION_HANDLERS, null);
    ctx.catches[at + 1] = ctx.wind;
    ctx.ncatch = at + 2;
    try {
        ${call}
        ctx.ncatch = at;
    } catch (e) {
        const caught = caughtAt(e, at, ctx);
        if (caught === null) throw executor.pushCatch(e, at, marks, mframe);
        countControlSuspend(closure.tmpl.code);
        acc = caught;
    }
}`;
export const CONTROL_AOT: ReadonlyMap<string, ControlAot> = new Map<string, ControlAot>([
    ["%call/cc", {
        heap: s => `return executor.callCC(ctx, ${s.args[0]}, frame, ${s.isTail});`,
        direct: s => `throw Suspend.callCC(${s.args[0]});`,
        tailProc: true,
    }],
    ["%call/ec", {
        heap: s => `return executor.callEscape(ctx, ${s.args[0]}, frame);`,
        direct: (s, callArray, call) => `{
            const tok = new EscapeContinuation(ctx.id, ctx.wind);
            try {
                const proc = ${s.args[0]};
                ${call(["tok"], "marks")}
            } catch (e) {
                if (!(e instanceof Suspend && e.escape === tok && ctx.wind === tok.wind)) throw executor.pushEscape(e, tok, marks, mframe);
                countControlSuspend(closure.tmpl.code);
                acc = e.escapeVal;
            }
        }`,
    }],
    ["%call-catching", {
        heap: s => s.args.length === 1 && !s.reentrant ? `return executor.callCatchStack(ctx, ${s.args[0]}, frame);`
            : `return executor.callCatch(ctx, ${s.args[0]}, frame, ${s.args[1] ?? "null"}, ${s.args.length === 3 ? `catchGuard(${s.args[2]})` : "false"});`,
        direct: (s, callArray, call) => s.args.length === 1 && !s.reentrant ? stackCatch(`const proc = ${s.args[0]}; ${call([], "marks")}`) : `{
            const tok = new CatchToken(ctx.id, ctx.wind, ${s.args[1] ?? "null"}, ${s.args.length === 3 ? `catchGuard(${s.args[2]})` : "false"});
            const handlers = markSet(marks, mframe + 1, EXCEPTION_HANDLERS, new Handlers(tok, markFirst(marks, EXCEPTION_HANDLERS, null)));
            try {
                const proc = ${s.args[0]};
                ${call([], "handlers")}
            } catch (e) {
                const caught = catchHere(e, tok, ctx);
                if (caught === null) throw executor.pushEscape(e, tok, handlers, mframe);
                countControlSuspend(closure.tmpl.code);
                acc = caught;
            }
        }`,
    }],
    ["%apply-catching", {
        heap: s => s.reentrant ? `return executor.callCatch(ctx, ${s.args[0]}, frame, null, false, arrayArg("%apply-catching", ${s.args[1]}));`
            : `return executor.callCatchStack(ctx, ${s.args[0]}, frame, arrayArg("%apply-catching", ${s.args[1]}));`,
        direct: s => !s.reentrant ? stackCatch(`acc = executor.callArray(ctx, ${s.args[0]}, arrayArg("%apply-catching", ${s.args[1]}), depth + 1, marks, mframe + 1);`) : `{
            const tok = new CatchToken(ctx.id, ctx.wind, null, false);
            const handlers = markSet(marks, mframe + 1, EXCEPTION_HANDLERS, new Handlers(tok, markFirst(marks, EXCEPTION_HANDLERS, null)));
            try {
                acc = executor.callArray(ctx, ${s.args[0]}, arrayArg("%apply-catching", ${s.args[1]}), depth + 1, handlers, mframe + 1);
            } catch (e) {
                const caught = catchHere(e, tok, ctx);
                if (caught === null) throw executor.pushEscape(e, tok, handlers, mframe);
                countControlSuspend(closure.tmpl.code);
                acc = caught;
            }
        }`,
    }],
    ["%coroutine-yield", { heap: s => `return executor.coYield(ctx, frame, ${valuesOf(s.args)});`, direct: s => `throw Suspend.yield(${valuesOf(s.args)});` }],
    ...["%coroutine-resume", "%coroutine-resume-array"].map((name): [string, ControlAot] => [name, {
        heap: s => `return executor.coResume(ctx, ${s.isTail ? "frame.parent" : "frame"}, ${s.args[0]}, ${resumeArgs(name, s.args)}, frame.marks, frame.mframe);`,
        // inside a coroutine, its frames must stay on the heap, where it can be traced while it waits
        direct: s => s.isTail
            ? `throw Suspend.resume(${s.args[0]}, ${resumeArgs(name, s.args)}, marks, mframe);`
            : `if (ctx.coroutine !== null || executor.nestedResumes >= MAX_NESTED_RESUMES || ++closure.tmpl.code.nestedResumes > ${DIRECT_SUSPEND_LIMIT}) throw Suspend.resume(${s.args[0]}, ${resumeArgs(name, s.args)}, marks, mframe);
               acc = executor.coResumeNested(ctx, ${s.args[0]}, ${resumeArgs(name, s.args)});`,
        tailProc: true,
    }]),
    ["%raise", {
        heap: s => `return executor.raise(ctx, frame, ${s.args[0]}, ${s.args.length === 2 ? `raiseContinuable(${s.args[1]})` : "false"});`,
        direct: s => `throw Suspend.raise(${s.args[0]}, ${s.args.length === 2 ? `raiseContinuable(${s.args[1]})` : "false"}, marks, ctx);`,
    }],
    // An interrupt check: the count, and only when it runs out, the handler (see VMExecutor.interruptSlow). Heap code
    // counts every check. Direct code counts cheaply, as interrupts only have to come eventually:
    //  - at a loop's back-edge it counts in its local `ic`, taking 256 from the instance's count once every 256 rounds (a
    //    loop there runs within one call of the function)
    //  - at a function's entry it counts only at even depths: a call from an odd depth lands at an even one, so between
    //    counted checks runs at most about one function body (loops aside). A self tail call, which restarts the function
    //    at the same depth, counts in `ic` on its own path (see #selfTailCount); a tail call to another function passes
    //    depth + 1, so the depth alternates, and past the JS depth limit it goes on in heap code
    //  - the slow path is a call of its own (executor.interruptDirect): written into the function, it slows it even
    //    when it never runs
    ["%interrupt", {
        heap: (s, spills) => `if (--executor.interruptLeft <= 0) { frame.ip = ${s.resume}; const res = executor.interruptSlow(ctx); if (res !== undefined) { ${spills} return res.run(ctx, executor, frame, false); } }`,
        // (a pause or stop in direct code throws: nothing comes back to keep)
        direct: s => `if (${s.loopCount ? LOOP_COUNT : "(depth & 1) === 0 && --executor.interruptLeft <= 0"}) { rip = ${s.resume}; executor.interruptDirect(ctx, closure, marks, mframe); }`,
        continues: true,
        setsResume: true,
    }],
    ["%current-stack", {
        heap: s => `ctx.acc = new StackSnapshot(frameInfos(frame, ${s.args.length === 1 ? `stackSkip(${s.args[0]})` : "0"}));`,
        direct: s => `throw Suspend.stack(${s.args.length === 1 ? `stackSkip(${s.args[0]})` : "0"});`,
        continues: true,
    }],
    // a call of the VM's helper, with (before after thunk): no request is made
    ["%dynamic-wind", {
        heap: s => `return executor.invoke(ctx, executor.dynamicWind, frame, [${s.args[0]}, ${s.args[2]}, ${s.args[1]}], 0, 3, ${s.isTail});`,
        direct: (s, callArray) => `{ const proc = executor.dynamicWind, args = [${s.args[0]}, ${s.args[2]}, ${s.args[1]}]; ${callArray} }`,
    }],
    ...["%apply-array", "%apply-fresh"].map((name): [string, ControlAot] => [name, {
        heap: s => `{ const args = ${applyArgsOf(name, s.args)}; return executor.invoke(ctx, ${s.args[0]}, frame, args, 0, args.length, ${s.isTail}); }`,
        direct: (s, callArray) => `{ const proc = ${s.args[0]}, args = ${applyArgsOf(name, s.args)}; ${callArray} }`,
        tailProc: true,
    }]),
]);
