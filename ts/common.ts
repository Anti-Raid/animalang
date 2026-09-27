import { Table } from "./table";
import { Env } from "./env";

export { Table, Env };

/** Returns if a value is truthy or not */
export const isTruthy = (val: any): boolean => {
    return val !== false
}   

// @internal
const DEEP_EQUAL_MISSING = Symbol("missing");

export const isDeepEqual = (a: any, b: any): boolean => {
    // If simple eqv? logic works, return true as no more work needed
    if (Object.is(a, b)) return true;

    // Tables
    if (a instanceof Table && b instanceof Table) {
        if (a.size !== b.size) return false;
        for (const [key, val] of a.entries()) {
            const other = b.lookup(key, DEEP_EQUAL_MISSING);
            if (other === DEEP_EQUAL_MISSING || !isDeepEqual(val, other)) return false;
        }
        return true;
    }

    // Vectors
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (!isDeepEqual(a[i], b[i])) return false;
        }
        return true;
    }

    if (isDatum(a)) return a.equals(b, isDeepEqual);

    // Closures/other types
    return false;
}

// What the VM and the compiler report, by op (Msg[op] names it), with its arguments. The VM words none of them: the front
// end (or the host embedding the VM) does, through its table's formatter (Intrinsics.setFormatter); `fmt` is the
// installed formatter (so a message shows values through its Msg.Value), and `at` where it happened, when known
export enum Msg {
    Value, Unhandled, TracebackHeader, TracebackFrame,
    MissingVar, NonProcedure, NonProcedureWind, Arity, ExpectedArray, ValuesCount,
    ContinuationBoundary, EscapeBoundary, ContinuationArgs, EscapeArgs, EscapeOutsideExtent, CatchOutsideExtent,
    HandlerReturned, BadContinuable, BadStackSkip, ExpectedMarkSet,
    ExpectedClosure, ExpectedFinally, ExpectedCoroutine, CannotResume, CannotClose, YieldOutside, YieldClosing,
    EmptyForm, IfArgs, QuoteArgs, FormArgs, LambdaForm, SetTarget, EscapeNoBlock, EscapeFromLambda,
    BadSyntax, ParamNotSymbol, DuplicateParam, CannotBindBuiltin, CannotBindIntrinsic, IntrinsicAsValue, ApplyNonLeaf,
    NoClause, LambdaOption, UnreachableClause, BarrierReentry, NoPrompt, ErrorInHandler, CatchGuard,
}

export type Formatter = (op: Msg, args: readonly any[], fmt: Formatter, at: SourcePos | null) => string;

// what a message is without a formatter: the op's name alone (a front end or host embedding the VM sets its own)
export const opName: Formatter = op => Msg[op];

// An error the VM or compiler reports: its message is worded when it is delivered (Anima code catching it, or the host
// getting it), by the formatter of the table the code runs with
export class VMError extends Error {
    at: SourcePos | null = null;
    #text: string | undefined;

    constructor(readonly op: Msg, readonly args: readonly any[]) {
        super();
    }

    // @ts-ignore: an accessor over Error's own message
    get message(): string {
        return this.#text ??= opName(this.op, this.args, opName, this.at);
    }

    set message(text: string) {
        this.#text = text;
    }

    #formatter: Formatter | null = null;

    // words the message with `fmt`, once
    format(fmt: Formatter): this {
        if (this.#formatter === fmt) return this;
        this.#formatter = fmt;
        this.#text = fmt(this.op, this.args, fmt, this.at);
        return this;
    }
}

// a VMError without a JS stack trace (see hostError)
export const vmError = (op: Msg, ...args: any[]): VMError => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    try {
        return new VMError(op, args);
    } finally {
        Error.stackTraceLimit = limit;
    }
};

export class MissingVarError extends VMError {
    constructor(sym: symbol) {
        super(Msg.MissingVar, [sym]);
        this.name = 'MissingVarError';
    }
}

export class ErrorObject {
    constructor(public error: any) {}
}

export class UnhandledError extends Error {
    constructor(public readonly error: any, public readonly traceback?: string, fmt: Formatter = opName) {
        super(fmt(Msg.Unhandled, [error], fmt, null));
    }
}

// Special Forms

// the core language: the only special forms the compiler accepts (besides the other % intrinsics);
// the syntax transformer lowers all surface syntax to these
export const CORE_IF = Symbol.for("%if");
export const CORE_LAMBDA = Symbol.for("%lambda");
export const CORE_QUOTE = Symbol.for("%quote");
export const CORE_BEGIN = Symbol.for("%begin");
export const CORE_SET = Symbol.for("%set!");
// structured control flow within one function: (%block name body ...), (%escape name [expr]), (%loop body ...)
export const CORE_BLOCK = Symbol.for("%block");
export const CORE_ESCAPE = Symbol.for("%escape");
export const CORE_LOOP = Symbol.for("%loop");
// (%let ((x init) ...) body ...): lexical bindings without a lambda
export const CORE_LET = Symbol.for("%let");
// (%let-values ((formals expr) ...) body ...) binds each expr's multiple values: missing values are <#void> and extra
// ones are dropped unless formals has a rest variable (Lua); %let-values/strict raises an error instead
export const CORE_LET_VALUES = Symbol.for("%let-values");
export const CORE_LET_VALUES_STRICT = Symbol.for("%let-values/strict");
export const CORE_LETREC = Symbol.for("%letrec");
export const CORE_LET_STAR = Symbol.for("%let*");
// (%with-mark key value body): body runs with a continuation mark; (%current-marks): the current continuation's marks
export const CORE_WITH_MARK = Symbol.for("%with-mark");
export const CORE_CATCH = Symbol.for("%catch");
export const OP_CURRENT_MARKS = Symbol.for("%current-marks");
// core operations (intrinsics, not forms) front ends lower to
export const OP_RAISE = Symbol.for("%raise");
export const OP_CURRENT_STACK = Symbol.for("%current-stack");
export const OP_DEFINE_GLOBAL = Symbol.for("%define-global");

export type SourcePos = { file: string, line: number, col: number };

// source positions of forms, set by the reader and by (%at file line col expr), read by the compiler
export const SOURCE_POS = new WeakMap<object, SourcePos>();

export const formatPos = (pos: SourcePos | null | undefined) => pos ? `${pos.file}:${pos.line}:${pos.col}` : "?";

// the core forms: they cannot be bound (a front end reserves its own keywords through its intrinsics table)
export const SPECIAL_FORMS = new Set([
    CORE_IF,
    CORE_LAMBDA,
    CORE_QUOTE,
    CORE_BEGIN,
    CORE_SET,
    CORE_BLOCK,
    CORE_ESCAPE,
    CORE_LOOP,
    CORE_LET,
    CORE_LET_VALUES,
    CORE_LET_VALUES_STRICT,
    CORE_LETREC,
    CORE_LET_STAR,
    CORE_WITH_MARK,
    CORE_CATCH,
    OP_CURRENT_MARKS,
    OP_DEFINE_GLOBAL,
])

// Marker class that all procs should extend from
export class MultipleValues {
    constructor(public readonly values: any[]) {}
}

export const packValues = (vals: any[]): any => vals.length === 1 ? vals[0] : new MultipleValues(vals);

export const unpackValues = (val: any): any[] => val instanceof MultipleValues ? val.values : [val];

export const DATUM = Symbol("datum");

// a front end's own kind of data (e.g. a list type): how it is compared, printed, copied and serialized. Marked by a
// property rather than a base class, as V8 does not inline a derived class's constructor
export interface Datum extends SerializableBytecode {
    readonly [DATUM]: true;
    equals(other: any, equal: (a: any, b: any) => boolean): boolean;
    stringify(stringify: (v: any) => string): string;
    copy(copy: (v: any) => any): any;
}

export const isDatum = (v: any): v is Datum => typeof v === "object" && v !== null && v[DATUM] === true;

export abstract class OpaqueValue {
    abstract get typeName(): string;
}

export class IProcedure {
    constructor(public debugName?: string) {}
}

// Normalizes an expression
export const normalizeExpr = (expr: any): any =>{
    if (isDatum(expr)) return expr.copy(normalizeExpr);
    if (Array.isArray(expr)) {
        return expr.map(normalizeExpr);
    }
    return expr;
}

export const ensureCanBind = (param: any, seen: Set<symbol> | undefined, syntaxCtx: string) => {
    if (typeof param !== "symbol") throw new VMError(Msg.ParamNotSymbol, [syntaxCtx, param]);
    if (seen) {
        if (seen.has(param)) throw new VMError(Msg.DuplicateParam, [syntaxCtx, param]);
        seen.add(param)
    }
    if (SPECIAL_FORMS.has(param)) throw new VMError(Msg.BadSyntax, [param]);
}

/**
 * Bytecode storage
 * Internal format:
 * <objtype><data>
 */
export class BS {
    #buffer: Uint32Array;
    #length: number = 0;
    #textEncoder = new TextEncoder();

    #lastUniqueSym: number = 1;
    #uniqueSymMap: Map<symbol, number> = new Map();

    #f64 = new Float64Array(1);
    #u32 = new Uint32Array(this.#f64.buffer);

    static readonly U32 = 0x01
    static readonly U32ARR = 0x02
    static readonly STR = 0x03
    static readonly SYMBOL = 0x04
    static readonly ARR = 0x05
    static readonly MAP = 0x06
    static readonly OBJ = 0x07
    static readonly NULL = 0x08
    static readonly BOOL = 0x09
    static readonly CLASS = 0x0A
    static readonly UNIQUESYMBOL = 0x0B
    static readonly F64 = 0x0C
    static readonly UNDEFINED = 0xFF

    constructor(initialCapacity: number = 1024) {
        this.#buffer = new Uint32Array(initialCapacity);
    }

    // Ensures we have enough space, doubling the buffer if necessary
    #ensureCapacity(needed: number) {
        if (this.#length + needed > this.#buffer.length) {
            const newSize = Math.max(this.#buffer.length * 2, this.#length + needed);
            const newBuffer = new Uint32Array(newSize);
            newBuffer.set(this.#buffer);
            this.#buffer = newBuffer;
        }
    }

    /** Write a single 32-bit word (e.g., an opcode or register index) 
     * 
     * Format: <U32><val>
    */
    writeU32(val: number): void {
        this.#ensureCapacity(2);
        this.#buffer[this.#length++] = BS.U32
        this.#buffer[this.#length++] = val
    }

    /** Write a 64-bit IEEE-754 floating point number
     * 
     * Format: <F64><word0><word1>
     */
    writeF64(val: number): void {
        this.#ensureCapacity(3);
        this.#buffer[this.#length++] = BS.F64;
        this.#f64[0] = val;
        this.#buffer[this.#length++] = this.#u32[0];
        this.#buffer[this.#length++] = this.#u32[1];
    }

    /** Write an array of 32-bit words
     * 
     * Format: <U32ARR><length><arr>
     */
    writeU32Arr(arr: Uint32Array): void {
        this.#ensureCapacity(2 + arr.length);
        this.#buffer[this.#length++] = BS.U32ARR
        this.#buffer[this.#length++] = arr.length
        this.#buffer.set(arr, this.#length);
        this.#length += arr.length;
    }

    /** Writes a string */
    writeString(str: string): void {
        return this.#writeString(str, BS.STR)
    }

    #internUniqueSymbol(sym: symbol): number {
        let old = this.#uniqueSymMap.get(sym)
        if(old) return old
        let newId = this.#lastUniqueSym++
        this.#uniqueSymMap.set(sym, newId)
        return newId
    }

    /** Writes a symbol */
    writeSymbol(sym: symbol): void {
        const str = Symbol.keyFor(sym);
        if (str === undefined) {
            return this.#writeString(sym.description || String(sym), BS.UNIQUESYMBOL, this.#internUniqueSymbol(sym))
        }
        return this.#writeString(str, BS.SYMBOL)
    }

    /** * Writes a string (for symbols/constants). 
     * Format: <STR (op)><length><[if unique symbol, the symbol id]><utf8 packed into 32-bit words>
     */
    #writeString(str: string, strop: number, symbolid?: number): void {
        const bytes = this.#textEncoder.encode(str);
        const wordsNeeded = Math.ceil(bytes.length / 4);
        this.#ensureCapacity(2 + wordsNeeded);
        this.#buffer[this.#length++] = strop
        if(strop === BS.UNIQUESYMBOL) {
            if (!symbolid) throw new Error("no symbol id found for uniquesymbol")
            this.#buffer[this.#length++] = symbolid
        }
        this.#buffer[this.#length++] = bytes.length
        
        for (let i = 0; i < bytes.length; i += 4) {
            let word = 0;
            word |= (bytes[i] || 0);
            word |= (bytes[i + 1] || 0) << 8;
            word |= (bytes[i + 2] || 0) << 16;
            word |= (bytes[i + 3] || 0) << 24;
            this.#buffer[this.#length++] = word >>> 0;
        }
    }

    /** 
     * Writes a heterogeneous array containing any supported types 
     * 
     * Format: <ARR><LEN><VALS>
    */
    writeArray(arr: any[]): void {
        this.#ensureCapacity(2);
        this.#buffer[this.#length++] = BS.ARR;
        this.#buffer[this.#length++] = arr.length;
        for (const item of arr) {
            this.writeValue(item);
        }
    }

    /** Writes a Map (key-value pairs) */
    writeMap(map: Map<any, any>): void {
        this.#ensureCapacity(2);
        this.#buffer[this.#length++] = BS.MAP;
        this.#buffer[this.#length++] = map.size;
        for (const [key, val] of map.entries()) {
            this.writeValue(key);
            this.writeValue(val);
        }
    }

    /** Writes a plain JavaScript Object (Record<string, any>) */
    writeObject(obj: Record<string, any>): void {
        const entries = Object.entries(obj);
        this.#ensureCapacity(2);
        this.#buffer[this.#length++] = BS.OBJ;
        this.#buffer[this.#length++] = entries.length;
        for (const [key, val] of entries) {
            this.writeValue(key);
            this.writeValue(val);
        }
    }

    /** Writes a boolean value */
    writeBool(val: boolean): void {
        this.#ensureCapacity(2);
        this.#buffer[this.#length++] = BS.BOOL;
        this.#buffer[this.#length++] = val ? 1 : 0;
    }

    /** Writes a null value */
    writeNull(): void {
        this.#ensureCapacity(1);
        this.#buffer[this.#length++] = BS.NULL;
    }

    /** Writes a undefined value */
    writeUndefined(): void {
        this.#ensureCapacity(1);
        this.#buffer[this.#length++] = BS.UNDEFINED;
    }

    /** Writes a custom class implementing SerializableBytecode */
    writeSerializable(obj: SerializableBytecode): void {
        this.#ensureCapacity(1);
        this.#buffer[this.#length++] = BS.CLASS;
        this.writeString(obj.bsid);
        obj.dump(this);
    }


    /** Helper to dynamically write any supported type */
    writeValue(val: any): void {
        if (val === null) {
            this.writeNull();
        } else if (val === undefined) {
            this.writeUndefined()
        } else if (typeof val === 'number') {
            if (Number.isInteger(val) && val >= 0 && val <= 0xFFFFFFFF && !Object.is(val, -0)) {
                this.writeU32(val);
            } else {
                this.writeF64(val);
            }
        } else if (typeof val === 'string') {
            this.writeString(val);
        } else if (typeof val === 'symbol') {
            this.writeSymbol(val);
        } else if (typeof val === 'boolean') {
            this.writeBool(val);
        } else if (val instanceof Uint32Array) {
            this.writeU32Arr(val);
        } else if (Array.isArray(val)) {
            this.writeArray(val);
        } else if (val instanceof Map) {
            this.writeMap(val);
        } else if (typeof val === 'object' && 'bsid' in val && 'dump' in val && typeof val.dump === 'function') {
            this.writeSerializable(val as SerializableBytecode);
        } else if (typeof val === 'object') {
            this.writeObject(val);
        } else {
            throw new Error(`Unsupported type for serialization: ${typeof val}`);
        }
    }

    /** Returns the final dumped bytecode array */
    finalize(): Uint32Array {
        return this.#buffer.slice(0, this.#length);
    }
}

export class BSReader {
    #buffer: Uint32Array;
    #cursor: number = 0;
    #textDecoder = new TextDecoder();
    static readonly #types = new Map<string, (r: BSReader) => any>();
    #factories = new Map<string, (r: BSReader) => any>();
    #uniqueSymbolIds = new Map<number, symbol>()

    #f64 = new Float64Array(1);
    #u32 = new Uint32Array(this.#f64.buffer);

    constructor(buffer: Uint32Array) {
        this.#buffer = buffer;
    }

    get hasMore(): boolean {
        return this.#cursor < this.#buffer.length;
    }

    #internUniqueSymbolFromId(id: number, desc: string) {
        let sym = this.#uniqueSymbolIds.get(id)
        if (sym) return sym
        let newSym = Symbol(desc)
        this.#uniqueSymbolIds.set(id, newSym)
        return newSym
    }

    /**
     * Registers a factory function capable of deserializing a specific class type.
     * @param bsid The unique identifier matching the SerializableBytecode.bsid
     * @param factory A function that reads from the reader and returns the constructed class
     */
    registerFactory(bsid: string, factory: (r: BSReader) => any): void {
        this.#factories.set(bsid, factory);
    }

    // a factory for every reader: for data types (see Datum)
    static registerType(bsid: string, factory: (r: BSReader) => any): void {
        BSReader.#types.set(bsid, factory);
    }

    /**
     * Peeks at the tag of the next value without advancing the cursor.
     */
    peekTag(): number {
        if (!this.hasMore) throw new Error("Unexpected end of bytecode");
        return this.#buffer[this.#cursor];
    }

    /**
     * Reads the next dynamically typed value based on its tag.
     */
    read(): number | Uint32Array | string | symbol | boolean | null | undefined | any[] | Map<any, any> | Record<string, any> {
        if (!this.hasMore) throw new Error("Unexpected end of bytecode");

        const tag = this.#buffer[this.#cursor++];

        switch (tag) {
            case BS.U32:
                return this.#buffer[this.#cursor++];

            case BS.F64: {
                this.#u32[0] = this.#buffer[this.#cursor++];
                this.#u32[1] = this.#buffer[this.#cursor++];
                return this.#f64[0];
            }
            
            case BS.U32ARR: {
                const len = this.#buffer[this.#cursor++];
                // We use slice to give a detached copy of the array chunk
                const arr = this.#buffer.slice(this.#cursor, this.#cursor + len);
                this.#cursor += len;
                return arr;
            }
            
            case BS.STR:
            case BS.SYMBOL: 
            case BS.UNIQUESYMBOL: {
                let symId = -1
                if (tag === BS.UNIQUESYMBOL) symId = this.#buffer[this.#cursor++];
                const byteLen = this.#buffer[this.#cursor++];
                const wordsToRead = Math.ceil(byteLen / 4);
                const bytes = new Uint8Array(byteLen);
                
                let byteIndex = 0;
                for (let i = 0; i < wordsToRead; i++) {
                    const word = this.#buffer[this.#cursor++];
                    if (byteIndex < byteLen) bytes[byteIndex++] = word & 0xFF;
                    if (byteIndex < byteLen) bytes[byteIndex++] = (word >> 8) & 0xFF;
                    if (byteIndex < byteLen) bytes[byteIndex++] = (word >> 16) & 0xFF;
                    if (byteIndex < byteLen) bytes[byteIndex++] = (word >> 24) & 0xFF;
                }
                
                const str = this.#textDecoder.decode(bytes);
                return tag === BS.UNIQUESYMBOL ? this.#internUniqueSymbolFromId(symId, str) : tag === BS.SYMBOL ? Symbol.for(str) : str;
            }

            case BS.ARR: {
                const len = this.#buffer[this.#cursor++];
                const arr = new Array(len);
                for (let i = 0; i < len; i++) {
                    arr[i] = this.read();
                }
                return arr;
            }

            case BS.MAP: {
                const len = this.#buffer[this.#cursor++];
                const map = new Map();
                for (let i = 0; i < len; i++) {
                    const key = this.read();
                    const val = this.read();
                    map.set(key, val);
                }
                return map;
            }

            case BS.OBJ: {
                const len = this.#buffer[this.#cursor++];
                const obj: Record<string, any> = Object.create(null);
                for (let i = 0; i < len; i++) {
                    const key = this.read();
                    const val = this.read();
                    obj[key as string] = val;
                }
                return obj;
            }

            case BS.NULL:
                return null;
            
            case BS.BOOL:
                return this.#buffer[this.#cursor++] === 1;

            case BS.CLASS: {
                // Read the class ID using the STR tag deserializer logic
                const bsid = this.readString();
                const factory = this.#factories.get(bsid) ?? BSReader.#types.get(bsid);
                if (!factory) {
                    throw new Error(`no factory registered for SerializableBytecode class '${bsid}'`);
                }
                // The factory is expected to read its own internal state from the reader
                return factory(this);
            }

            case BS.UNDEFINED: {
                return undefined;
            }

            default:
                throw new Error(`Unknown data tag encountered: 0x${tag.toString(16)} at offset ${this.#cursor - 1}`);
        }
    }

    /** Helper to explicitly expect a U32 */
    readU32(): number {
        if (this.peekTag() !== BS.U32) throw new Error("Expected U32");
        const val = this.read();
        return val as number;
    }

    /** Helper to explicitly expect an F64 */
    readF64(): number {
        if (this.peekTag() !== BS.F64) throw new Error("Expected F64");
        return this.read() as number;
    }

    /** Helper to explicitly expect a Uint32Array */
    readU32Arr(): Uint32Array {
        if (this.peekTag() !== BS.U32ARR) throw new Error("Expected Uint32Array");
        return this.read() as Uint32Array;
    }

    /** Helper to explicitly expect a string */
    readString(): string {
        if (this.peekTag() !== BS.STR) throw new Error("Expected string");
        return this.read() as string;
    }

    /** Helper to explicitly expect a string */
    readSymbol(): symbol {
        if (this.peekTag() !== BS.SYMBOL && this.peekTag() !== BS.UNIQUESYMBOL) throw new Error("Expected symbol");
        return this.read() as symbol;
    }

    /** Helper to explicitly expect an Array */
    readArray(): any[] {
        if (this.peekTag() !== BS.ARR) throw new Error("Expected Array");
        return this.read() as any[];
    }

    /** Helper to explicitly expect a Map */
    readMap(): Map<any, any> {
        if (this.peekTag() !== BS.MAP) throw new Error("Expected Map");
        return this.read() as Map<any, any>;
    }

    /** Helper to explicitly expect an object */
    readObject(): Record<string, any> {
        if (this.peekTag() !== BS.OBJ) throw new Error("Expected Object");
        return this.read() as Record<string, any>;
    }

    /** Helper to explicitly expect an boolean */
    readBool(): boolean {
        if (this.peekTag() !== BS.BOOL) throw new Error("Expected bool");
        return this.read() as boolean;
    }

    /** Helper to explicitly expect an null */
    readNull(): null {
        if (this.peekTag() !== BS.NULL) throw new Error("Expected null");
        return this.read() as null;
    }

    /** Helper to explicitly expect an null */
    readUndefined(): undefined {
        if (this.peekTag() !== BS.UNDEFINED) throw new Error("Expected undefined");
        return this.read() as undefined;
    }

    /** Helper to explicitly expect a serializable */
    readSerializable<T extends SerializableBytecode>(expectedBsid?: string): T {
        if (this.peekTag() !== BS.CLASS) throw new Error("Expected class");
        const res = this.read() as T;
        if (expectedBsid !== undefined && res.bsid != expectedBsid) throw new Error(`Expected ${expectedBsid} but got ${res.bsid}`)
        return res
    }
}

export interface SerializableBytecode {
    bsid: string
    // Returns the underlying bytecode instructions as a Uint32array
    dump(w: BS): void;
}

/** A simple structure for registering constants */
export class ConstPool {
    #known: Map<unknown, number>;
    public constants: any[]
    constructor() {
        this.constants = []
        this.#known = new Map()

        // pre-reserve constants
        this.push(false)
        this.push(true)
        this.push(null)
        this.push(undefined)
    }

    // Register a object with the constant pool
    push(s: unknown) {
        // Try to deduplicate anything
        if (s === null || typeof s !== "object") {
            const idx = this.#known.get(s)
            if(idx !== undefined) {
                return idx
            } else {
                const idx = this.constants.push(s) - 1
                this.#known.set(s, idx)
                return idx
            }
        }

        // TODO: Deduplicate stuff later
        return this.constants.push(this.#freezeObj(s)) - 1
    }

    mutPush(s: unknown) {
        return this.constants.push(s) - 1
    }

    #freezeObj(obj: any) {
        if (typeof obj !== "object" || obj === null || isDatum(obj) || obj instanceof Table) return obj;
        Object.keys(obj).forEach(prop => {
            if (typeof obj[prop] === 'object' && !Object.isFrozen(obj[prop])) {
                this.#freezeObj(obj[prop]);
            }
        });
        return Object.freeze(obj);
    }
}

let n = 0
export const symGen = (base: string) => {
    return Symbol(`${base}${n++}`)
}
