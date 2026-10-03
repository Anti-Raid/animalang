import type { Anima } from '../anima';
import { hostTailFrom } from '../bytecode-rvm/exec';
import { IProcedure } from '../common';
import { Code, type UsedIntrinsic } from '../bytecode-rvm/code';
import { CORE_INTRINSICS } from '../bytecode-rvm/coreops';
import type { DistributiveOmit, Op } from '../bytecode-rvm/ops';
import { hostError } from '../errors';

// intrinsics belong to an instance, so every instance that uses these registers them
export const registerTestIntrinsics = (anima: Anima) => {
    anima.registerIntrinsic("%test-add", (regs, s) => regs[s] + regs[s + 1], {
        args: [2, 2],
        leaf: true,
        inline: ([a, b], slow) => `(typeof ${a} === "number" && typeof ${b} === "number" ? ${a} + ${b} : ${slow})`,
    });
    anima.registerIntrinsic("%test-call-or", (regs, s, n) => regs[s] instanceof IProcedure ? hostTailFrom(regs[s], regs, s + 1, n - 1) : regs[s], { args: [1, Infinity] });
    anima.registerIntrinsic("%test-fail", (regs, s) => { throw hostError(regs[s]) }, { args: [1, 1], leaf: true });
};

// the kinds of a function's instructions, in order (an If continuing a chain as "ElseIf")
export const opKinds = (code: Code): string[] => code.ops.map(op => op.k === "If" && op.elseif ? "ElseIf" : op.k);

// code made from instructions written out (positions filled in), as the compiler would lower them
export const codeOf = (constants: any[], body: DistributiveOmit<Op, "ip">[], numReg: number, used: UsedIntrinsic[] = []): Code => {
    const ops = body.map((op, ip) => ({ ...op, ip }) as Op);
    return new Code(constants, ops, numReg, undefined, undefined, false, used.length > 0 ? CORE_INTRINSICS : null, used);
};
