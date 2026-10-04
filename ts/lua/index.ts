// Luau: an instance whose language is Luau (syntax/ parses it, lower.ts lowers it to core forms, ops.ts has its operators)
import { Anima } from "../anima";
import { Env } from "../common";
import type { AnimaOptions } from "../magicvm/meta";
import { LuauSyntaxError, lowerLuau } from "./lower";
import { luauFormat } from "./messages";
import { LUAU_TYPES, registerLuauOps } from "./ops";
import { parseLuau } from "./syntax/parser";
import type { ParseResult } from "./syntax/ast";

export { LuauSyntaxError } from "./lower";
export { luauFormat, toString, typeName } from "./messages";

type Read = { parsed: ParseResult, file: string, source: string };

export const createLuau = (options: AnimaOptions): Anima => {
    // Luau has no re-entrant continuations (coroutines resume their one suspended frame)
    const anima = new Anima({ ...options, reentrant: false });
    anima.intrinsics.setFormatter(luauFormat);
    anima.intrinsics.setTypes(LUAU_TYPES);
    registerLuauOps(anima.intrinsics);
    anima.attachFrontEnd({
        read: (source: string, file: string = "chunk"): Read => {
            const parsed = parseLuau(source);
            const error = parsed.errors[0];
            if (error !== undefined) {
                const { line, column } = parsed.lines.pos(error.from);
                throw new LuauSyntaxError({ file, line: line + 1, col: column + 1 }, error.message);
            }
            return { parsed, file, source };
        },
        transform: ({ parsed, file, source }: Read) => lowerLuau(parsed, file, source),
        lambda: () => { throw new Error("Luau has no procedure syntax for the host to compile"); },
    }, new Env(null, false, { unbound: undefined }));
    return anima;
};
