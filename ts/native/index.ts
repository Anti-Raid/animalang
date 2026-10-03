// native-scheme: the core forms as text (reader.ts) with a little sugar (transformer.ts), a front end of its own,
// separate from Scheme
import { Anima } from "../anima";
import { Env, SyntaxPositions } from "../common";
import type { AnimaOptions } from "../magicvm/meta";
import { nativeFormat } from "./messages";
import { readNative, type NativeReadOptions } from "./reader";
import { LAMBDA, SUGAR, transformNative } from "./transformer";

export { readNative, NativeReadError, type NativeReadOptions } from "./reader";
export { transformNative, NativeSyntaxError } from "./transformer";
export { nativeFormat, showValue } from "./messages";

// an instance whose language is native-scheme: the VM's core operations and the intrinsics registered on it, and arrays
// as its sequences
export const createNativeScheme = (options: AnimaOptions): Anima => {
    const anima = new Anima(options);
    anima.intrinsics.setFormatter(nativeFormat);
    // where the reader read each list, for the transformer (weakly held: a tree read and compiled leaves nothing behind)
    const where = new SyntaxPositions();
    for (const sym of SUGAR) anima.intrinsics.reserved.set(sym, "special form");
    anima.attachFrontEnd({
        read: (source, file) => readNative(source, file, { positions: where }),
        transform: ast => transformNative(ast, anima.intrinsics, where),
        lambda: (params, body) => [LAMBDA, params, body],
    }, new Env());
    return anima;
};

// native-scheme text compiled on any instance, with its table; quoted data as the instance's front end reads it unless
// `datum` says otherwise
export const compileNative = (anima: Anima, src: string, file?: string, options: NativeReadOptions = {}) => {
    const frontEnd = anima.frontEnd;
    const datum = options.datum ?? frontEnd?.datum?.bind(frontEnd);
    const where = new SyntaxPositions();
    return anima.compiler.compile(transformNative(readNative(src, file, { datum, positions: where }), anima.intrinsics, where));
};
