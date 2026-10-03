// The if chains and loops of a function, from the order of its instructions, for the structured code of its direct entry
// (which emits an if as a js if/else rather than as jumps between blocks)
import type { Op } from "../ops";

export type Structure = {
    // the position after the last instruction
    readonly size: number,
    // for a position an Else is right before (an if's else branch), the end it jumps to
    readonly elseBefore: ReadonlyMap<number, number>,
    // for a position an EndIf is right before (an if chain's end), where that EndIf is
    readonly endIfBefore: ReadonlyMap<number, number>,
    // the If instructions that continue a chain, in order
    readonly elseIfs: readonly { ip: number, else: number }[],
    // where the EndLoop instructions are
    readonly endLoops: ReadonlySet<number>,
};

export const structureOf = (ops: readonly Op[], size: number): Structure => {
    const elseBefore = new Map<number, number>();
    const endIfBefore = new Map<number, number>();
    const elseIfs: { ip: number, else: number }[] = [];
    const endLoops = new Set<number>();
    ops.forEach((op, i) => {
        const next = i + 1 < ops.length ? ops[i + 1].ip : size;
        if (op.k === "Else") elseBefore.set(next, op.end);
        else if (op.k === "EndIf") endIfBefore.set(next, op.ip);
        else if (op.k === "If" && op.elseif) elseIfs.push({ ip: op.ip, else: op.else });
        else if (op.k === "EndLoop") endLoops.add(op.ip);
    });
    return { size, elseBefore, endIfBefore, elseIfs, endLoops };
};
