import type { Anima } from '../anima';
import { hostTailFrom } from '../magicvm/exec';
import { IProcedure } from '../common';
import { Code, type UsedIntrinsic } from '../magicvm/code';
import { CORE_INTRINSICS } from '../magicvm/coreops';
import type { DistributiveOmit, Op } from '../magicvm/ops';
import { hostError } from '../errors';
import { compileNative } from '../native';

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

// native-scheme text run on an instance (a Scheme one, say, with its table and its lists for quoted data)
export const runNative = (anima: Anima, src: string, file?: string): any => anima.evaluateRaw(compileNative(anima, src, file));

// a procedure for each intrinsic, named without its %, as an embedder would define one
export const expose = (anima: Anima, ...names: string[]) =>
    runNative(anima, names.map(name => `(define-intrinsic ${name.slice(1)} ${name})`).join("\n"), "<exposed>");
