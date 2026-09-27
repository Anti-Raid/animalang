import { CORE_LAMBDA } from "../common";

// [%lambda, clause ...], clause = [options, params, rest, body ...]: a closure of one clause, or with several a procedure
// that runs the first clause taking the call's argument count. `options` is a list of symbols (see PAD)
export type Clause = any[];

// a clause whose missing arguments are <#void> and whose extra ones are dropped (or go to its rest parameter): it
// takes any count
export const PAD = Symbol.for("pad");

export const isLambda = (e: any): e is any[] => Array.isArray(e) && e[0] === CORE_LAMBDA;

// a %lambda of one clause: a plain closure
export const isSingleLambda = (e: any): e is any[] => isLambda(e) && e.length === 2;

export const clausesOf = (lambda: any[]): Clause[] => lambda.slice(1);
export const optionsOf = (c: Clause): symbol[] => c[0];
export const paramsOf = (c: Clause): symbol[] => c[1];
export const restOf = (c: Clause): symbol | null => c[2];
export const bodyOf = (c: Clause): any[] => c.slice(3);
export const isPadded = (c: Clause): boolean => Array.isArray(c[0]) && c[0].includes(PAD);

// the names a clause binds
export const namesOf = (c: Clause): symbol[] => c[2] === null ? c[1] : [...c[1], c[2]];

export const accepts = (c: Clause, nargs: number): boolean =>
    isPadded(c) || (c[2] === null ? nargs === c[1].length : nargs >= c[1].length);

export const clause = (options: symbol[], params: symbol[], rest: symbol | null, body: any[]): Clause => [options, params, rest, ...body];

// a %lambda of one clause
export const lambda = (params: symbol[], rest: symbol | null, body: any[], options: symbol[] = []): any[] => [CORE_LAMBDA, clause(options, params, rest, body)];
