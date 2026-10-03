// Interrupt checks (see Intrinsics.setInterruptHandler), added to the IR when the table has interrupts on: an
// (%interrupt) at each loop's back-edge, and at the entry of each function that calls (which can recurse without end;
// one that only loops checks in its loops)
import { corePos } from "../coreops";
import { ClosureTemplateIR, type Node } from "../ir";
import type { Pass } from "./pass";

export type FunctionIR = { nodes: Node[], numRegs: number };

const check = (): Node => ({ t: "HostCall", pos: corePos("%interrupt"), startReg: 0, nargs: 0, isTail: false, destReg: undefined });

const calls = (nodes: Node[]): boolean =>
    nodes.some(n => n.t === "Call" || n.t === "TailCall" || (n.t === "HostCall" && n.pos !== corePos("%interrupt")));

const withChecks = (nodes: Node[]): Node[] => {
    const entryCheck = calls(nodes);
    const out: Node[] = [];
    for (const n of nodes) {
        if (n.t === "EndLoop") out.push(check());
        if (n.t === "FunctionEntry" && entryCheck) out.push(check());
        if (n.t === "NewClosure") {
            const t = n.template;
            out.push({ ...n, template: new ClosureTemplateIR(t.params, t.remParams, withChecks(t.code), t.numRegs, t.upvarLocs, t.name, t.rest, t.pad) });
            continue;
        }
        out.push(n);
    }
    return out;
};

export const interruptsPass: Pass<FunctionIR, FunctionIR> = {
    name: "interrupts",
    run: (ir, ctx) => ctx.intrinsics.interrupts ? { nodes: withChecks(ir.nodes), numRegs: ir.numRegs } : ir,
};
