import type { Anima } from '../anima';
import { hostTail } from '../bytecode-rvm/exec';
import { IProcedure } from '../common';
import { hostError } from '../errors';

// intrinsics belong to an instance, so every instance that uses these registers them
export const registerTestIntrinsics = (anima: Anima) => {
    anima.registerIntrinsic("%test-add", (regs, s) => regs[s] + regs[s + 1], {
        args: [2, 2],
        leaf: true,
        inline: ([a, b], slow) => `(typeof ${a} === "number" && typeof ${b} === "number" ? ${a} + ${b} : ${slow})`,
    });
    anima.registerIntrinsic("%test-call-or", (regs, s, n) => regs[s] instanceof IProcedure ? hostTail(regs[s], ...regs.slice(s + 1, s + n)) : regs[s], { args: [1, Infinity] });
    anima.registerIntrinsic("%test-fail", (regs, s) => { throw hostError(regs[s]) }, { args: [1, 1], leaf: true });
};
