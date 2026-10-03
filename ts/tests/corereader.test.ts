import { describe, expect, it } from 'vitest';
import { readCore } from '../bytecode-rvm/corereader';
import { Anima } from '../anima';
import { createScheme } from '../scheme';
import { ASTStringifier } from '../scheme/printer';
import { impl } from '../bytecode-rvm/meta';
import { Msg, SOURCE_POS, VMError } from '../common';

const S = Symbol.for;
const s = new ASTStringifier();

describe("The core reader", () => {
    it("reads lists as arrays, names as symbols, and VM values", () => {
        expect(readCore(`(%if #t 1 (%call f -2.5 1e3 "a\\nb\\u{41}" #f #null #void 12n))`)).toEqual(
            [S("%if"), true, 1, [S("%call"), S("f"), -2.5, 1000, "a\nbA", false, null, undefined, 12n]]);
        expect(readCore(`; nothing but a comment\n  x ; and another`)).toBe(S("x"));
        expect(readCore(`(a) (b)`)).toEqual([S("%begin"), [S("a")], [S("b")]]);
        expect(readCore(``)).toEqual([S("%begin")]);
        expect(readCore(`(%quote ((1 2) x))`)).toEqual([S("%quote"), [[1, 2], S("x")]]);
    });

    it("keeps where each list was read", () => {
        const e = readCore(`(%begin\n  (%call f\n    (g)))`, "t.core");
        expect(SOURCE_POS.get(e)).toEqual({ file: "t.core", line: 1, col: 1 });
        expect(SOURCE_POS.get(e[1])).toEqual({ file: "t.core", line: 2, col: 3 });
        expect(SOURCE_POS.get(e[1][2])).toEqual({ file: "t.core", line: 3, col: 5 });
    });

    it("reports what it cannot read, and where", () => {
        const error = (src: string) => {
            try {
                readCore(src, "t.core");
            } catch (err) {
                expect(err).toBeInstanceOf(VMError);
                const e = err as VMError;
                return [Msg[e.op], e.args, e.at?.line, e.at?.col];
            }
            throw new Error("expected an error");
        };
        expect(error(`(a\n (b)`)).toEqual(["ReadUnclosed", ["list"], 1, 1]);
        expect(error(`(a))`)).toEqual(["ReadUnexpected", [")"], 1, 4]);
        expect(error(`"abc`)).toEqual(["ReadUnclosed", ["string"], 1, 1]);
        expect(error(`"a\\qb"`)).toEqual(["ReadBadEscape", ["\\q"], 1, 3]);
        expect(error(`(#nil)`)).toEqual(["ReadBadToken", ["#nil"], 1, 2]);
    });

    it("gives quoted data to the front end's datum, and only quoted data", () => {
        const seen: any[] = [];
        const datum = (x: any) => { seen.push(x); return "D"; };
        expect(readCore(`(%call f (%quote (1 2)) (3 4) (%quote x y))`, undefined, { datum })).toEqual(
            [S("%call"), S("f"), [S("%quote"), "D"], [3, 4], [S("%quote"), S("x"), S("y")]]);
        expect(seen).toEqual([[1, 2]]);
    });

    it("compiles core text on any instance, with the front end's datum unless told otherwise", () => {
        const bare = new Anima(impl);
        expect(bare.evaluateRaw(bare.compileCore(`(%call (%lambda (() (a) r r)) 1 2 3)`))).toEqual([2, 3]);
        expect(bare.evaluateRaw(bare.compileCore(`(%quote (1 2))`))).toEqual([1, 2]);
        const scheme = createScheme(impl);
        expect(s.stringify(scheme.evaluateRaw(scheme.compileCore(`(%intcall %reverse (%quote (1 (2 3))))`)))).toBe("((2 3) 1)");
        expect(s.stringify(scheme.evaluateRaw(scheme.compileCore(`(%quote (1 2))`, "t.core", { datum: x => x })))).toBe("#(1 2)");
        expect(() => scheme.compileCore(`(%call f`, "t.core")).toThrow("read: unclosed list");
    });
});
