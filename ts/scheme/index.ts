import { Cons } from "./list";
import type { AnimaOptions } from "../magicvm/meta";
import { Anima } from "../anima";
import { ASP } from "./reader";
import { schemeDatum, toCore } from "./core";
import { schemeBase } from "./base";
import { loadPrelude } from "./prelude";
import { OP_LAMBDA } from "./symbols";
import { MacroEvaluator } from "./transformer/macro";
import { registerCoreSyntax } from "./transformer/syntax";
import { registerDatumSerializer } from "../magicvm/aot/serializer";
import { registerDatumDeserializer } from "../magicvm/loader";

// Register Scheme's datum codecs for pre-compiled execution units
registerDatumSerializer("cons", v => v instanceof Cons, (v, rec) => ({ car: rec(v.car), cdr: rec(v.cdr) }));
registerDatumDeserializer("cons", (d, rec) => new Cons(rec(d.car), rec(d.cdr)));

// A new instance running Scheme: its intrinsics (registered first, always in the same order), reserved names, reader,
// macro expander and the prelude's procedures. The intrinsics stay open: register more before compiling code that uses them
export const createScheme = (options: AnimaOptions): Anima => {
    const anima = new Anima(options, schemeBase());
    const intrinsics = anima.intrinsics;

    const evaluator = new MacroEvaluator(options, intrinsics);
    registerCoreSyntax(evaluator);
    evaluator.init(loadPrelude(evaluator.expandcmp, evaluator.expandvm, intrinsics));

    const publicScope = loadPrelude(anima.compiler, anima.vm, intrinsics);
    anima.attachFrontEnd({
        read: (source, file) => evaluator.readProgram(positions => new ASP(source, true, file, positions).parse()),
        transform: ast => toCore(evaluator.transformProgram(ast), intrinsics, evaluator.positions),
        lambda: (params, body) => Cons.list(OP_LAMBDA, params, body),
        datum: schemeDatum,
    }, publicScope.chained());
    return anima;
};
