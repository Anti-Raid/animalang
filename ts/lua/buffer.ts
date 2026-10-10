// Luau's buffer (VM/src/lbuflib.cpp): a fixed-size block of bytes, little-endian. The library's functions take numbers
// as Luau's C casts them (to int, or to unsigned through int64, saturating as on arm64, NaN being 0); checking that an
// argument is a number (or a string that reads as one) is the caller's
import { DATUM, type Datum } from "../common";
import { luauError } from "./errors";

const MAX_BUFFER_SIZE = 2 ** 30;

const toInt = (d: number): number => d !== d ? 0 : d >= 2147483647 ? 2147483647 : d <= -2147483648 ? -2147483648 : Math.trunc(d);

const toInt64 = (d: number): number => d !== d ? 0 : d >= 2 ** 63 ? 2 ** 63 - 1 : d <= -(2 ** 63) ? -(2 ** 63) : Math.trunc(d);

const toUnsigned = (d: number): number => {
    if (d !== d) return 0;
    if (d >= 2 ** 63) return 0xffffffff;
    if (d < -(2 ** 63)) return 0;
    const r = Math.trunc(d) % 2 ** 32;
    return r < 0 ? r + 2 ** 32 : r;
};

const outOfBounds = (): Error => luauError("buffer access out of bounds");

export class LuaBuffer implements Datum {
    readonly bytes: Uint8Array;
    readonly #view: DataView;

    private constructor(bytes: Uint8Array) {
        this.bytes = bytes;
        this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }

    static create(size: number): LuaBuffer {
        const n = toInt(size);
        if (n < 0) throw luauError("invalid argument #1 to 'create' (size)");
        if (n > MAX_BUFFER_SIZE) throw luauError("memory allocation error: block too big");
        return new LuaBuffer(new Uint8Array(n));
    }

    static fromstring(s: string): LuaBuffer {
        if (s.length > MAX_BUFFER_SIZE) throw luauError("memory allocation error: block too big");
        const bytes = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
        return new LuaBuffer(bytes);
    }

    get len(): number {
        return this.bytes.length;
    }

    tostring(): string {
        return bytesToString(this.bytes);
    }

    #at(offset: number, size: number): number {
        const o = toInt(offset);
        if (o < 0 || o + size > this.bytes.length) throw outOfBounds();
        return o;
    }

    readi8(offset: number): number { return this.#view.getInt8(this.#at(offset, 1)); }
    readu8(offset: number): number { return this.bytes[this.#at(offset, 1)]; }
    readi16(offset: number): number { return this.#view.getInt16(this.#at(offset, 2), true); }
    readu16(offset: number): number { return this.#view.getUint16(this.#at(offset, 2), true); }
    readi32(offset: number): number { return this.#view.getInt32(this.#at(offset, 4), true); }
    readu32(offset: number): number { return this.#view.getUint32(this.#at(offset, 4), true); }
    readf32(offset: number): number { return this.#view.getFloat32(this.#at(offset, 4), true); }
    readf64(offset: number): number { return this.#view.getFloat64(this.#at(offset, 8), true); }

    readinteger(offset: number): bigint { return this.#view.getBigInt64(this.#at(offset, 8), true); }
    writeinteger(offset: number, value: bigint): void { this.#view.setBigInt64(this.#at(offset, 8), value, true); }

    writei8(offset: number, value: number): void { this.#view.setUint8(this.#at(offset, 1), toUnsigned(value) & 0xff); }
    writeu8(offset: number, value: number): void { this.writei8(offset, value); }
    writei16(offset: number, value: number): void { this.#view.setUint16(this.#at(offset, 2), toUnsigned(value) & 0xffff, true); }
    writeu16(offset: number, value: number): void { this.writei16(offset, value); }
    writei32(offset: number, value: number): void { this.#view.setUint32(this.#at(offset, 4), toUnsigned(value), true); }
    writeu32(offset: number, value: number): void { this.writei32(offset, value); }
    writef32(offset: number, value: number): void { this.#view.setFloat32(this.#at(offset, 4), value, true); }
    writef64(offset: number, value: number): void { this.#view.setFloat64(this.#at(offset, 8), value, true); }

    readstring(offset: number, size: number): string {
        const n = toInt(size);
        if (n < 0) throw luauError("invalid argument #3 to 'readstring' (size)");
        const o = this.#at(offset, n);
        return bytesToString(this.bytes.subarray(o, o + n));
    }

    writestring(offset: number, s: string, count?: number): void {
        const n = count === undefined ? s.length : toInt(count);
        if (n < 0) throw luauError("invalid argument #4 to 'writestring' (count)");
        if (n > s.length) throw luauError("string length overflow");
        const o = this.#at(offset, n);
        for (let i = 0; i < n; i++) this.bytes[o + i] = s.charCodeAt(i);
    }

    // buffer.copy (`copy` being the Datum's)
    copyFrom(toffset: number, source: LuaBuffer, soffset?: number, count?: number): void {
        const so = soffset === undefined ? 0 : toInt(soffset);
        const n = count === undefined ? source.len - so : toInt(count);
        if (n < 0 || so < 0 || so + n > source.len) throw outOfBounds();
        const to = this.#at(toffset, n);
        this.bytes.set(source.bytes.subarray(so, so + n), to);
    }

    fill(offset: number, value: number, count?: number): void {
        const o = toInt(offset);
        const n = count === undefined ? this.bytes.length - o : toInt(count);
        if (n < 0) throw outOfBounds();
        this.#at(o, n);
        this.bytes.fill(toUnsigned(value) & 0xff, o, o + n);
    }

    #bits(bitoffset: number, bitcount: number): [number, number] {
        const bit = toInt64(bitoffset);
        const n = toInt(bitcount);
        if (bit < 0) throw outOfBounds();
        if (n < 0 || n > 32) throw luauError("bit count is out of range of [0; 32]");
        if (bit + n > this.bytes.length * 8) throw outOfBounds();
        return [bit, n];
    }

    readbits(bitoffset: number, bitcount: number): number {
        let [bit, n] = this.#bits(bitoffset, bitcount);
        let r = 0, scale = 1;
        while (n > 0) {
            const sh = bit % 8, take = Math.min(8 - sh, n);
            r += ((this.bytes[(bit - sh) / 8] >> sh) & ((1 << take) - 1)) * scale;
            scale *= 2 ** take;
            bit += take;
            n -= take;
        }
        return r;
    }

    writebits(bitoffset: number, bitcount: number, value: number): void {
        let [bit, n] = this.#bits(bitoffset, bitcount);
        let v = toUnsigned(value);
        while (n > 0) {
            const sh = bit % 8, take = Math.min(8 - sh, n), i = (bit - sh) / 8;
            const mask = ((1 << take) - 1) << sh;
            this.bytes[i] = (this.bytes[i] & ~mask) | ((v << sh) & mask);
            v = Math.floor(v / 2 ** take);
            bit += take;
            n -= take;
        }
    }

    get [DATUM](): true {
        return true;
    }

    equals(other: any): boolean {
        return other === this;
    }

    stringify(): string {
        return `buffer(${this.bytes.length})`;
    }

    copy(): LuaBuffer {
        return this;
    }
}

const bytesToString = (bytes: Uint8Array): string => {
    let s = "";
    for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return s;
};
