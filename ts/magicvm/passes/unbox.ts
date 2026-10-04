// Box removal: of the boxes the assignments pass made, keeps only those a variable needs (VariableMetadata.isBoxed:
// captured by a closure, or read after a call where a continuation could be captured; see PROOFS.md, 4); the others
// become plain variables again, assigned with %set!. It runs the analysis again on the program it is given (by then
// optimized), and gives the rest parameters a closure receives as the plain array (VariableMetadata.forwardsRest)
import { CORE_SET } from "../../common";
import { AstAnalysis, markLiveAcrossCalls } from "../analysis";
import type { Intrinsics } from "../intrinsics";
import { BOXED } from "../lambda";
import { malformed, mapExprs } from "./lang";
import { BOX, BOX_IN_PLACE, Lconv, SET_BOX, UNBOX } from "./assignments";

export type Unboxed = { ast: any, forwards: ReadonlySet<symbol> };

export const removeBoxes = (ast: any, boxes: ReadonlySet<symbol>, intrinsics: Intrinsics, reentrant: boolean = true): Unboxed => {
    const analysis = new AstAnalysis(intrinsics);
    const scope = analysis.analyze(ast);
    // code no continuation re-enters needs a box only for what a closure captures
    if (reentrant) markLiveAcrossCalls(ast, analysis, scope, intrinsics);
    const { variables } = scope;
    const unneeded = (sym: any) => typeof sym === "symbol" && boxes.has(sym) && variables.get(sym)?.isBoxed !== true;
    const forwards = new Set([...variables].filter(([, meta]) => meta.forwardsRest).map(([sym]) => sym));

    const walk = (e: any): any => {
        if (!Array.isArray(e) || e.length === 0) return e;
        const op = e[0], pos = e[1];
        if (Lconv.forms.get(op) === "quote") return e;
        if (Lconv.forms.has(op) && malformed(Lconv, e) !== null) return e;
        if (op === UNBOX && unneeded(e[2])) return e[2];
        if (op === SET_BOX && unneeded(e[2])) return [CORE_SET, pos, e[2], walk(e[3])];
        // a box made in place (which may be anywhere once the optimizer has inlined a procedure) that is not needed: nothing
        if (op === BOX_IN_PLACE && e.length === 3 && unneeded(e[2])) return undefined;
        const next = mapExprs(Lconv, e, walk);
        switch (Lconv.forms.get(op)) {
            case "lambda":
                return [op, pos, ...next.slice(2).map((c: any[]) => [c[0], c[1], c[2], ...c.slice(3).filter(x => !isUnneededBox(x))])];
            case "let": case "let*": case "letrec":
                return [op, pos, next[2].map((b: any[]) => [b[0], unwrapIf(b[0], b[1])]), ...next.slice(3)];
            case "let-values":
                return [op, pos, next[2], ...next.slice(3).filter((x: any) => !isUnneededBox(x))];
            default:
                return next;
        }
    };
    const isUnneededBox = (x: any) => Array.isArray(x) && x[0] === BOX_IN_PLACE && x.length === 3 && unneeded(x[2]);
    const unwrapIf = (name: any, init: any) => unneeded(name) && Array.isArray(init) && (init[0] === BOX || init[0] === BOXED) && init.length === 3 ? init[2] : init;
    return { ast: walk(ast), forwards };
};
