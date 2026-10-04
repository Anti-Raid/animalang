// Luau's vector (3-wide; VM/src/lveclib.cpp, and the arithmetic in lvmutils.cpp): an immutable value of three float32
// components, computed in float32 as Luau computes them. Equal vectors (component-wise ==, so -0 equals 0 and NaN
// equals nothing) are one table key
import { DATUM, type Datum } from "../common";
import { luauError } from "./errors";
import { num2str } from "./number";

const f = Math.fround;

export class LuaVector implements Datum {
    readonly x: number;
    readonly y: number;
    readonly z: number;

    constructor(x: number, y: number, z: number = 0) {
        this.x = f(x);
        this.y = f(y);
        this.z = f(z);
    }

    static readonly zero = new LuaVector(0, 0, 0);
    static readonly one = new LuaVector(1, 1, 1);

    get hasNaN(): boolean {
        return this.x !== this.x || this.y !== this.y || this.z !== this.z;
    }

    // v.x / v.X and so on
    index(name: string): number {
        if (name.length === 1) {
            const ic = (name.charCodeAt(0) | 32) - 120;
            if (ic === 0) return this.x;
            if (ic === 1) return this.y;
            if (ic === 2) return this.z;
        }
        throw luauError(`attempt to index vector with '${name}'`);
    }

    tostring(): string {
        return `${num2str(this.x)}, ${num2str(this.y)}, ${num2str(this.z)}`;
    }

    get [DATUM](): true {
        return true;
    }

    equals(other: any): boolean {
        return other instanceof LuaVector && this.x === other.x && this.y === other.y && this.z === other.z;
    }

    stringify(): string {
        return this.tostring();
    }

    copy(): LuaVector {
        return this;
    }
}

const V = (x: number, y: number, z: number) => new LuaVector(x, y, z);
const dot3 = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => f(f(f(ax * bx) + f(ay * by)) + f(az * bz));
const idiv = (a: number, b: number) => Math.floor(a / b);

// the arithmetic Luau has on vectors: v+v, v-v, -v, and v*v, s*v, v*s, likewise / and //
export const vadd = (a: LuaVector, b: LuaVector) => V(a.x + b.x, a.y + b.y, a.z + b.z);
export const vsub = (a: LuaVector, b: LuaVector) => V(a.x - b.x, a.y - b.y, a.z - b.z);
export const vunm = (a: LuaVector) => V(-a.x, -a.y, -a.z);

const scaled = (op: (a: number, b: number) => number) => (a: LuaVector | number, b: LuaVector | number): LuaVector => {
    if (typeof a === "number") {
        const s = f(a), v = b as LuaVector;
        return V(op(s, v.x), op(s, v.y), op(s, v.z));
    }
    if (typeof b === "number") {
        const s = f(b);
        return V(op(a.x, s), op(a.y, s), op(a.z, s));
    }
    return V(op(a.x, b.x), op(a.y, b.y), op(a.z, b.z));
};

export const vmul = scaled((a, b) => a * b);
export const vdiv = scaled((a, b) => a / b);
export const vidiv = scaled(idiv);

// the vector library
export const vector = {
    create: (x: number, y: number, z: number = 0) => V(x, y, z),
    magnitude: (v: LuaVector) => f(Math.sqrt(dot3(v.x, v.y, v.z, v.x, v.y, v.z))),
    normalize: (v: LuaVector) => {
        const inv = f(1 / f(Math.sqrt(dot3(v.x, v.y, v.z, v.x, v.y, v.z))));
        return V(v.x * inv, v.y * inv, v.z * inv);
    },
    cross: (a: LuaVector, b: LuaVector) => V(f(a.y * b.z) - f(a.z * b.y), f(a.z * b.x) - f(a.x * b.z), f(a.x * b.y) - f(a.y * b.x)),
    dot: (a: LuaVector, b: LuaVector) => dot3(a.x, a.y, a.z, b.x, b.y, b.z),
    angle: (a: LuaVector, b: LuaVector, axis?: LuaVector) => {
        const c = vector.cross(a, b);
        const angle = Math.atan2(Math.sqrt(dot3(c.x, c.y, c.z, c.x, c.y, c.z)), dot3(a.x, a.y, a.z, b.x, b.y, b.z));
        return axis !== undefined && dot3(c.x, c.y, c.z, axis.x, axis.y, axis.z) < 0 ? -angle : angle;
    },
    floor: (v: LuaVector) => V(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)),
    ceil: (v: LuaVector) => V(Math.ceil(v.x), Math.ceil(v.y), Math.ceil(v.z)),
    abs: (v: LuaVector) => V(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)),
    sign: (v: LuaVector) => V(sign(v.x), sign(v.y), sign(v.z)),
    clamp: (v: LuaVector, min: LuaVector, max: LuaVector) => {
        for (const c of ["x", "y", "z"] as const) {
            if (!(min[c] <= max[c])) throw luauError(`invalid argument #3 to 'clamp' (max.${c} must be greater than or equal to min.${c})`);
        }
        return V(clamp(v.x, min.x, max.x), clamp(v.y, min.y, max.y), clamp(v.z, min.z, max.z));
    },
    max: (v: LuaVector, ...rest: LuaVector[]) => {
        let { x, y, z } = v;
        for (const b of rest) {
            if (b.x > x) x = b.x;
            if (b.y > y) y = b.y;
            if (b.z > z) z = b.z;
        }
        return V(x, y, z);
    },
    min: (v: LuaVector, ...rest: LuaVector[]) => {
        let { x, y, z } = v;
        for (const b of rest) {
            if (b.x < x) x = b.x;
            if (b.y < y) y = b.y;
            if (b.z < z) z = b.z;
        }
        return V(x, y, z);
    },
    lerp: (a: LuaVector, b: LuaVector, t: number) => {
        const s = f(t);
        const lerp = (p: number, q: number) => s === 1 ? q : f(p + f(f(q - p) * s));
        return V(lerp(a.x, b.x), lerp(a.y, b.y), lerp(a.z, b.z));
    },
};

const sign = (v: number) => v > 0 ? 1 : v < 0 ? -1 : 0;

const clamp = (v: number, min: number, max: number) => {
    const r = v < min ? min : v;
    return r > max ? max : r;
};
