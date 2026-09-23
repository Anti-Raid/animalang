import {
    BS,
    BSReader,
    IProcedure,
    type SerializableBytecode,
    type AbstractByteCode,
    type AbstractClosure,
} from "../common";

export const BUILTINS_START = 2**31;

export enum OpCode {
    LOADCONST,
    LOADU32,
    NEGATE,
    LOADUPVAR,
    SETUPVAR,
    LOADGLOBAL,
    SETGLOBAL,
    HASGLOBAL,
    IF,
    ELSE,
    ENDIF,
    CALL,
    TAILCALL,
    RETURN,
    NEWCLOSURE,
    BOX,
    UNBOX,
    SETBOX,
    MOVE,
}

export const INSTRUCTION_LENGTHS: Record<OpCode, number> = {
    [OpCode.ENDIF]: 1,
    [OpCode.NEGATE]: 2,
    [OpCode.HASGLOBAL]: 2,
    [OpCode.ELSE]: 2,
    [OpCode.RETURN]: 2,
    [OpCode.LOADCONST]: 3,
    [OpCode.LOADU32]: 3,
    [OpCode.LOADGLOBAL]: 3,
    [OpCode.SETGLOBAL]: 3,
    [OpCode.IF]: 3,
    [OpCode.NEWCLOSURE]: 3,
    [OpCode.BOX]: 3,
    [OpCode.UNBOX]: 3,
    [OpCode.SETBOX]: 3,
    [OpCode.MOVE]: 3,
    [OpCode.LOADUPVAR]: 4,
    [OpCode.SETUPVAR]: 4,
    [OpCode.TAILCALL]: 4,
    [OpCode.CALL]: 5,
};

export type NativeFn = (
    ctx: any,
    frame: any,
    vm: any,
    executor: any
) => any;

export class ByteCode implements AbstractByteCode {
    public bsid = "ByteCode";
    public nativeFn: NativeFn | null = null;
    public execCount: number = 0;

    constructor(public constants: any[], public inst: Uint32Array, public numReg: number) {}

    dump(bs: BS) {
        bs.writeU32Arr(this.inst);
        bs.writeArray(this.constants);
        bs.writeU32(this.numReg);
    }

    static register(bsr: BSReader) {
        bsr.registerFactory("ByteCode", (bsr) => {
            const inst = bsr.readU32Arr();
            const constants = bsr.readArray();
            const numReg = bsr.readU32();
            return new ByteCode(constants, inst, numReg);
        });
    }
}

export type UpVarLoc = { index: number; local: boolean };

/** A template for a closure that can then be bound to a scope */
export class ClosureTemplate implements SerializableBytecode {
    public bsid = "ClosureTemplate";

    params: symbol[]; // base (individual param binds)
    remParams: symbol | null; // where the remaining params should be bound too (if any). This implicitly makes a closure variadic as well
    code: ByteCode;
    upvarLocs: UpVarLoc[]; // what upvars do we need to capture

    constructor(params: symbol[], remParams: symbol | null, code: ByteCode, upvarLocs: UpVarLoc[]) {
        this.params = params;
        this.remParams = remParams;
        this.code = code;
        this.upvarLocs = upvarLocs;
    }

    dump(bs: BS) {
        bs.writeValue(this.params);
        bs.writeValue(this.remParams);
        bs.writeValue(this.code);
        bs.writeValue(this.upvarLocs);
    }

    static register(bsr: BSReader) {
        bsr.registerFactory("ClosureTemplate", (bsr) => {
            const params = bsr.read() as symbol[];
            const remParams = bsr.read() as symbol | null;
            const code = bsr.readSerializable<ByteCode>("ByteCode");
            const upvarLocs = bsr.readArray() as UpVarLoc[];
            return new ClosureTemplate(params, remParams, code, upvarLocs);
        });
    }
}

/** An actual anima closure bound to a scope */
export class Closure extends IProcedure implements AbstractClosure {
    public bsid = "Closure";

    constructor(public tmpl: ClosureTemplate, public upvars: any[], debugName: string = "lambda") {
        super(debugName);
    }

    static fromTemplate(tmpl: ClosureTemplate, debugName: string = "lambda") {
        // Allocate enough space for the upvars from outer scopes
        const upvars = new Array(tmpl.upvarLocs.length);
        return new Closure(tmpl, upvars, debugName);
    }

    static create(tmpl: ClosureTemplate, regs: readonly any[], upvars: readonly any[], debugName: string = "lambda") {
        const closure = Closure.fromTemplate(tmpl, debugName);
        for (let i = 0; i < tmpl.upvarLocs.length; i++) {
            const loc = tmpl.upvarLocs[i];
            closure.upvars[i] = loc.local ? regs[loc.index] : upvars[loc.index];
        }
        return closure;
    }

    dump(bs: BS) {
        bs.writeValue(this.upvars);
        bs.writeValue(this.tmpl);
    }

    static register(bsr: BSReader) {
        bsr.registerFactory("Closure", (bsr) => {
            const upvars = bsr.readArray();
            const tmpl = bsr.readSerializable<ClosureTemplate>("ClosureTemplate");
            return new Closure(tmpl, upvars);
        });
    }
}

export const createRegs = (numRegs: number) => {
    return new Array(numRegs).fill(undefined);
};

export class Box {
    constructor(public val: any) {}
}


