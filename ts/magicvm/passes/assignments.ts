// Assignment conversion: every assigned local variable (VariableMetadata.mutable: one %set! assigns, or a %letrec value a
// closure may copy before its init has run) becomes a box, so no local is assigned after it, which the optimizer
// relies on (passes/cp0.ts); the unbox pass then keeps only the boxes that are needed (passes/unbox.ts):
//  - an assigned parameter, or %let-values variable, is boxed in place where its body starts: (%box! x)
//  (the forms it makes take their enclosing form's position: their position slot is null)
//  - an assigned %let or %let* variable is bound to (%box init)
//  - an assigned %letrec name's init is (%boxed init): the name holds a box from the start of the %letrec, which its
//    init sets (when the init runs, as for any init)
//  - a use is (%unbox x), and (%set! x v) is (%set-box! x v)
// Its output is in Lconv, the core forms with the box forms
import { CORE_SET } from "../../common";
import { BOXED } from "../lambda";
import type { VariableMetadata } from "../scope";
import { Lsrc, extend, malformed, mapExprs } from "./lang";

export const Lconv = extend(Lsrc, "Lconv", { add: { "%box": "exprs", "%unbox": "exprs", "%box!": "exprs", "%set-box!": "assign", "%boxed": "exprs", "%inlined": "label", "%tail-inlined": "label" } });

export const BOX = Symbol.for("%box");
export const UNBOX = Symbol.for("%unbox");
export const BOX_IN_PLACE = Symbol.for("%box!");
export const SET_BOX = Symbol.for("%set-box!");

// the converted program, and the variables it made boxes of
export type Converted = { ast: any, boxes: ReadonlySet<symbol> };

export const convertAssignments = (ast: any, variables: ReadonlyMap<symbol, VariableMetadata>): Converted => {
    const boxes = new Set<symbol>();
    const boxed = (sym: any): sym is symbol => {
        if (typeof sym !== "symbol" || variables.get(sym)?.mutable !== true) return false;
        boxes.add(sym);
        return true;
    };
    const boxInPlace = (names: any[]) => names.filter(boxed).map(x => [BOX_IN_PLACE, null, x]);

    const walk = (e: any): any => {
        if (typeof e === "symbol") return boxed(e) ? [UNBOX, null, e] : e;
        if (!Array.isArray(e) || e.length === 0) return e;
        const op = e[0], pos = e[1];
        const shape = Lsrc.forms.get(op);
        if (shape !== undefined && malformed(Lsrc, e) !== null) return e;
        switch (shape) {
            case "quote":
                return e;
            case "lambda":
                return [op, pos, ...e.slice(2).map((c: any[]) =>
                    [c[0], c[1], c[2], ...boxInPlace(c[2] === null ? c[1] : [...c[1], c[2]]), ...c.slice(3).map(walk)])];
            case "let":
            case "let*":
                return [op, pos, e[2].map((b: any[]) => [b[0], boxed(b[0]) ? [BOX, null, walk(b[1])] : walk(b[1])]), ...e.slice(3).map(walk)];
            case "let-values": {
                const names = e[2].flatMap((c: any[]) => c[1] === null ? c[0] : [...c[0], c[1]]);
                return [op, pos, e[2].map((c: any[]) => [c[0], c[1], walk(c[2])]), ...boxInPlace(names), ...e.slice(3).map(walk)];
            }
            case "letrec":
                return [op, pos, e[2].map((b: any[]) => [b[0], boxed(b[0]) ? [BOXED, null, walk(b[1])] : walk(b[1])]), ...e.slice(3).map(walk)];
            case "assign":
                return [op === CORE_SET && boxed(e[2]) ? SET_BOX : op, pos, e[2], walk(e[3])];
            default:
                return mapExprs(Lsrc, e, walk);
        }
    };
    return { ast: walk(ast), boxes };
};
