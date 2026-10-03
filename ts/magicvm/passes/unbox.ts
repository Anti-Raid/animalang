// Box removal: of the boxes the assignments pass made, keeps only those a variable needs (VariableMetadata.isBoxed:
// captured by a closure, or read after a call where a continuation could be captured; see PROOFS.md, 4); the others
// become plain variables again, assigned with %set!. It runs the analysis again on the program it is given (by then
// optimized), and gives the rest parameters a closure receives as the plain array (VariableMetadata.forwardsRest)
import { CORE_SET } from "../../common";
import { AstAnalysis, markLiveAcrossCalls } from "../analysis";
import type { Intrinsics } from "../intrinsics";
import { BOXED } from "../lambda";
import { keepPos, malformed, mapExprs } from "./lang";
import { BOX, BOX_IN_PLACE, Lconv, SET_BOX, UNBOX } from "./assignments";

export type Unboxed = { ast: any, forwards: ReadonlySet<symbol> };

export const removeBoxes = (ast: any, boxes: ReadonlySet<symbol>, intrinsics: Intrinsics): Unboxed => {
    const analysis = new AstAnalysis(intrinsics);
    const scope = analysis.analyze(ast);
    markLiveAcrossCalls(ast, analysis, scope, intrinsics);
    const { variables } = scope;
    const unneeded = (sym: any) => typeof sym === "symbol" && boxes.has(sym) && variables.get(sym)?.isBoxed !== true;
    const forwards = new Set([...variables].filter(([, meta]) => meta.forwardsRest).map(([sym]) => sym));

    const walk = (e: any): any => {
        if (!Array.isArray(e) || e.length === 0) return e;
        const op = e[0];
        if (Lconv.forms.get(op) === "quote") return e;
        if (Lconv.forms.has(op) && Lconv.forms.get(op) !== "exprs" && malformed(Lconv, e) !== null) return e;
        if (op === UNBOX && unneeded(e[1])) return e[1];
        if (op === SET_BOX && unneeded(e[1])) return keepPos([CORE_SET, e[1], walk(e[2])], e);
        // a box made in place (which may be anywhere once the optimizer has inlined a procedure) that is not needed: nothing
        if (op === BOX_IN_PLACE && e.length === 2 && unneeded(e[1])) return undefined;
        const next = mapExprs(Lconv, e, walk);
        switch (Lconv.forms.get(op)) {
            case "lambda":
                return keepPos([op, ...next.slice(1).map((c: any[]) => [c[0], c[1], c[2], ...c.slice(3).filter(x => !isUnneededBox(x))])], e);
            case "let": case "let*": case "letrec":
                return keepPos([op, next[1].map((b: any[]) => keepPos([b[0], unwrapIf(b[0], b[1])], b)), ...next.slice(2)], e);
            case "let-values":
                return keepPos([op, next[1], ...next.slice(2).filter((x: any) => !isUnneededBox(x))], e);
            default:
                return next;
        }
    };
    const isUnneededBox = (x: any) => Array.isArray(x) && x[0] === BOX_IN_PLACE && x.length === 2 && unneeded(x[1]);
    const unwrapIf = (name: any, init: any) => unneeded(name) && Array.isArray(init) && (init[0] === BOX || init[0] === BOXED) && init.length === 2 ? init[1] : init;
    return { ast: walk(ast), forwards };
};
