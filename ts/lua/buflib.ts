// Luau's buffer and vector libraries (VM/src/lbuflib.cpp, lveclib.cpp) over a function's arguments (an array): the
// checks of the arguments, in Luau's order, around LuaBuffer's and vector's own operations. buffer.readinteger and
// writeinteger (of the integer type) are not here
import { MultipleValues } from "../common";
import { argError, numberArg, stringArg, type Args } from "./args";
import { LuaBuffer } from "./buffer";
import { LuaVector, vector } from "./vector";

const NONE = new MultipleValues([]);

const bufferArg = (a: Args, n: number, name: string): LuaBuffer => {
    if (!(a[n - 1] instanceof LuaBuffer)) throw argError(a, n, name, "buffer");
    return a[n - 1];
};
const optNumber = (a: Args, n: number, name: string): number | undefined => a[n - 1] === undefined ? undefined : numberArg(a, n, name);

type Reader = "readi8" | "readu8" | "readi16" | "readu16" | "readi32" | "readu32" | "readf32" | "readf64";
type Writer = "writei8" | "writeu8" | "writei16" | "writeu16" | "writei32" | "writeu32" | "writef32" | "writef64";
const READERS: Reader[] = ["readi8", "readu8", "readi16", "readu16", "readi32", "readu32", "readf32", "readf64"];
const WRITERS: Writer[] = ["writei8", "writeu8", "writei16", "writeu16", "writei32", "writeu32", "writef32", "writef64"];

export const BUFFER_LIBRARY: Record<string, (a: Args) => any> = {
    create: a => LuaBuffer.create(numberArg(a, 1, "create")),
    fromstring: a => LuaBuffer.fromstring(stringArg(a, 1, "fromstring")),
    tostring: a => bufferArg(a, 1, "tostring").tostring(),
    len: a => bufferArg(a, 1, "len").len,
    readstring: a => {
        const b = bufferArg(a, 1, "readstring"), offset = numberArg(a, 2, "readstring");
        return b.readstring(offset, numberArg(a, 3, "readstring"));
    },
    writestring: a => {
        const b = bufferArg(a, 1, "writestring"), offset = numberArg(a, 2, "writestring"), s = stringArg(a, 3, "writestring");
        b.writestring(offset, s, optNumber(a, 4, "writestring"));
        return NONE;
    },
    copy: a => {
        const target = bufferArg(a, 1, "copy"), toffset = numberArg(a, 2, "copy"), source = bufferArg(a, 3, "copy");
        const soffset = optNumber(a, 4, "copy");
        target.copyFrom(toffset, source, soffset, optNumber(a, 5, "copy"));
        return NONE;
    },
    fill: a => {
        const b = bufferArg(a, 1, "fill"), offset = numberArg(a, 2, "fill"), value = numberArg(a, 3, "fill");
        b.fill(offset, value, optNumber(a, 4, "fill"));
        return NONE;
    },
    readbits: a => {
        const b = bufferArg(a, 1, "readbits"), offset = numberArg(a, 2, "readbits");
        return b.readbits(offset, numberArg(a, 3, "readbits"));
    },
    writebits: a => {
        const b = bufferArg(a, 1, "writebits"), offset = numberArg(a, 2, "writebits"), count = numberArg(a, 3, "writebits");
        b.writebits(offset, count, numberArg(a, 4, "writebits"));
        return NONE;
    },
    ...Object.fromEntries(READERS.map(name => [name, (a: Args) => bufferArg(a, 1, name)[name](numberArg(a, 2, name))])),
    ...Object.fromEntries(WRITERS.map(name => [name, (a: Args) => {
        const b = bufferArg(a, 1, name), offset = numberArg(a, 2, name);
        b[name](offset, numberArg(a, 3, name));
        return NONE;
    }])),
};

const vectorArg = (a: Args, n: number, name: string): LuaVector => {
    if (!(a[n - 1] instanceof LuaVector)) throw argError(a, n, name, "vector");
    return a[n - 1];
};
const vectors = (a: Args, name: string): LuaVector[] => {
    const first = vectorArg(a, 1, name), out = [first];
    for (let i = 2; i <= a.length; i++) out.push(vectorArg(a, i, name));
    return out;
};
const one = (name: "magnitude" | "normalize" | "floor" | "ceil" | "abs" | "sign") => (a: Args) => vector[name](vectorArg(a, 1, name));
const two = (name: "cross" | "dot") => (a: Args) => vector[name](vectorArg(a, 1, name), vectorArg(a, 2, name));

export const VECTOR_LIBRARY: Record<string, (a: Args) => any> = {
    create: a => {
        const x = numberArg(a, 1, "create"), y = numberArg(a, 2, "create");
        return vector.create(x, y, a.length >= 3 ? numberArg(a, 3, "create") : 0);
    },
    magnitude: one("magnitude"), normalize: one("normalize"), floor: one("floor"), ceil: one("ceil"), abs: one("abs"), sign: one("sign"),
    cross: two("cross"), dot: two("dot"),
    angle: a => {
        const x = vectorArg(a, 1, "angle"), y = vectorArg(a, 2, "angle");
        return vector.angle(x, y, a[2] === undefined ? undefined : vectorArg(a, 3, "angle"));
    },
    clamp: a => {
        const v = vectorArg(a, 1, "clamp"), min = vectorArg(a, 2, "clamp");
        return vector.clamp(v, min, vectorArg(a, 3, "clamp"));
    },
    min: a => { const [v, ...rest] = vectors(a, "min"); return vector.min(v, ...rest); },
    max: a => { const [v, ...rest] = vectors(a, "max"); return vector.max(v, ...rest); },
    lerp: a => {
        const x = vectorArg(a, 1, "lerp"), y = vectorArg(a, 2, "lerp");
        return vector.lerp(x, y, numberArg(a, 3, "lerp"));
    },
};

export const VECTOR_CONSTANTS = { zero: vector.create(0, 0, 0), one: vector.create(1, 1, 1) };
