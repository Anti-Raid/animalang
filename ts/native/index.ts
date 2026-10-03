// native-scheme: the core forms as text (reader.ts), a front end of its own, separate from Scheme
import type { Anima } from "../anima";
import { readNative, type NativeReadOptions } from "./reader";

export { readNative, NativeReadError, type NativeReadOptions } from "./reader";

// native-scheme text compiled on any instance, with its table; quoted data as the instance's front end reads it unless
// `datum` says otherwise
export const compileNative = (anima: Anima, src: string, file?: string, options: NativeReadOptions = {}) => {
    const frontEnd = anima.frontEnd;
    const datum = options.datum ?? frontEnd?.datum?.bind(frontEnd);
    return anima.compiler.compile(readNative(src, file, { datum }));
};
