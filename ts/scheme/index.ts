import { Cons, type AnimaMeta } from "../common";
import { Anima } from "../anima";
import { ASP } from "./reader";
import { schemeBase } from "./base";
import { loadPrelude } from "./prelude";
import { OP_LAMBDA } from "./symbols";
import { MacroEvaluator } from "./transformer/macro";
import { registerCoreSyntax } from "./transformer/syntax";

// A new instance running Scheme: its intrinsics (registered first, always in the same order), reserved names, reader,
// macro expander and the prelude's procedures. The intrinsics stay open: register more before compiling code that uses them
export const createScheme = (impl: AnimaMeta, maxSteps: number = 0): Anima => {
    const anima = new Anima(impl, maxSteps, schemeBase());
    const intrinsics = anima.intrinsics;

    const evaluator = new MacroEvaluator(impl, maxSteps, intrinsics);
    registerCoreSyntax(evaluator);
    evaluator.init(loadPrelude(evaluator.expandcmp, evaluator.expandvm, evaluator, intrinsics));

    const publicScope = loadPrelude(anima.compiler, anima.vm, evaluator, intrinsics);
    anima.attachFrontEnd({
        read: (source, file) => new ASP(source, true, file).parse(),
        transform: ast => evaluator.transform(ast),
        lambda: (params, body) => Cons.list(OP_LAMBDA, params, body),
    }, publicScope.chained());
    return anima;
};
