// Assignment conversion: the variables the analysis boxes (see VariableMetadata.isBoxed) become explicit boxes, so code
// generation never asks which variables are boxed:
//  - a boxed parameter, or %let-values variable, is boxed in place where its body starts: (%box! x)
//  - a boxed %let or %let* variable is bound to (%box init)
//  - a boxed %letrec name is bound around the %letrec to (%box <void>), and its init sets the box: (%set-box! x init). A
//    lambda's is set before the other inits run (a %letrec makes its lambdas first), from a lambda binding of its own
//  - a use of a boxed variable is (%unbox x), and (%set! x v) is (%set-box! x v)
// Its output is in Lconv, the core forms with the box forms; it also gives the rest parameters a closure receives as
// the plain array (see VariableMetadata.forwardsRest)
import { CORE_SET } from "../../common";
import { isSingleLambda } from "../lambda";
import type { VariableMetadata } from "../scope";
import { Lsrc, extend, keepPos, malformed, mapExprs } from "./lang";

export const Lconv = extend(Lsrc, "Lconv", { add: { "%box": "exprs", "%unbox": "exprs", "%box!": "exprs", "%set-box!": "assign" } });

const BOX = Symbol.for("%box");
const UNBOX = Symbol.for("%unbox");
const BOX_IN_PLACE = Symbol.for("%box!");
const SET_BOX = Symbol.for("%set-box!");

export type Converted = { ast: any, forwards: ReadonlySet<symbol> };

export const convertAssignments = (ast: any, variables: ReadonlyMap<symbol, VariableMetadata>): Converted => {
    const boxed = (sym: any) => typeof sym === "symbol" && variables.get(sym)?.isBoxed === true;
    const forwards = new Set([...variables].filter(([, meta]) => meta.forwardsRest).map(([sym]) => sym));
    const boxInPlace = (names: any[]) => names.filter(boxed).map(x => [BOX_IN_PLACE, x]);

    const walk = (e: any): any => {
        if (typeof e === "symbol") return boxed(e) ? [UNBOX, e] : e;
        if (!Array.isArray(e) || e.length === 0) return e;
        const op = e[0];
        const shape = Lsrc.forms.get(op);
        if (shape !== undefined && shape !== "exprs" && malformed(Lsrc, e) !== null) return e;
        switch (shape) {
            case "quote":
                return e;
            case "lambda":
                return keepPos([op, ...e.slice(1).map((c: any[]) =>
                    [c[0], c[1], c[2], ...boxInPlace(c[2] === null ? c[1] : [...c[1], c[2]]), ...c.slice(3).map(walk)])], e);
            case "let":
            case "let*":
                return keepPos([op, e[1].map((b: any[]) => keepPos([b[0], boxed(b[0]) ? [BOX, walk(b[1])] : walk(b[1])], b)), ...e.slice(2).map(walk)], e);
            case "let-values": {
                const names = e[1].flatMap((c: any[]) => c[1] === null ? c[0] : [...c[0], c[1]]);
                return keepPos([op, e[1].map((c: any[]) => [c[0], c[1], walk(c[2])]), ...boxInPlace(names), ...e.slice(2).map(walk)], e);
            }
            case "letrec": {
                const bindings: any[][] = e[1];
                const body = e.slice(2).map(walk);
                if (!bindings.some(b => boxed(b[0]))) return keepPos([op, bindings.map(b => keepPos([b[0], walk(b[1])], b)), ...body], e);
                // a boxed lambda stays a lambda binding, under a name of its own, and is put in its box before the other inits
                // run; a boxed value's init puts its value in the box
                const sets: any[][] = [];
                const inner = bindings.map(b => {
                    if (!boxed(b[0])) return keepPos([b[0], walk(b[1])], b);
                    const own = Symbol(b[0].description);
                    if (isSingleLambda(b[1])) {
                        sets.push([Symbol(b[0].description), [SET_BOX, b[0], own]]);
                        return keepPos([own, walk(b[1])], b);
                    }
                    return keepPos([own, [SET_BOX, b[0], walk(b[1])]], b);
                });
                const lambdas = inner.filter(b => isSingleLambda(b[1]));
                const values = inner.filter(b => !isSingleLambda(b[1]));
                const boxes = bindings.filter(b => boxed(b[0])).map(b => [b[0], [BOX, undefined]]);
                return keepPos([Symbol.for("%let"), boxes, keepPos([op, [...lambdas, ...sets, ...values], ...body], e)], e);
            }
            case "assign":
                return keepPos([op === CORE_SET && boxed(e[1]) ? SET_BOX : op, e[1], walk(e[2])], e);
            default:
                return mapExprs(Lsrc, e, walk);
        }
    };
    return { ast: walk(ast), forwards };
};
