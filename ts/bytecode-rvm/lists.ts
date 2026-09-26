import { Cons } from "../list";
import { packValues, unpackValues } from "../common";
import { hostError } from "../errors";

// lists and multiple values, as the VM and its runtime operations use them

export const makeList = (regs: readonly any[], start: number, nargs: number) => {
    let tail: Cons | null = null;
    for (let i = start + nargs - 1; i >= start; i--) tail = new Cons(regs[i], tail);
    return tail;
};

export const valuesToList = (regs: readonly any[], start: number, nargs: number) => {
    if (nargs !== 1) throw hostError("%values->list requires 1 argument");
    return Cons.fromArray(unpackValues(regs[start]));
};

export const listToArray = (lst: Cons | null): any[] => lst === null ? [] : [...lst];

const spliceLast = (args: any[]): any[] => {
    const finalArg = args.pop();
    if (finalArg instanceof Cons) {
        let p: any = finalArg;
        for (; p instanceof Cons; p = p.cdr) args.push(p.car);
        if (p !== null) throw hostError(`apply: last argument must be a list but got ${String(finalArg)}`);
    } else if (finalArg !== null) {
        throw hostError(`apply: last argument must be a list but got ${String(finalArg)}`);
    }
    return args;
};

export const windowApplyArgs = (regs: readonly any[], startReg: number, nargs: number): any[] => {
    return spliceLast(regs.slice(startReg, startReg + nargs));
};

export const applyArgsList = (regs: readonly any[], start: number, nargs: number) => {
    if (nargs !== 1) throw hostError("%apply-args requires 1 argument");
    const lst = regs[start];
    return Cons.fromArray(spliceLast(lst === null ? [] : [...lst]));
};

export const listToValues = (regs: readonly any[], start: number, nargs: number) => {
    if (nargs !== 1) throw hostError("%list->values requires 1 argument");
    return packValues(listToArray(regs[start]));
};
