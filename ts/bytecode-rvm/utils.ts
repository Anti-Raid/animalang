import { BS, BSReader, type SerializableBytecode } from "../common"
import { IBUILTINS } from "../std"
import { BUILTINS_START, ByteCode, Closure, ClosureTemplate, OpCode, RUNTIME } from "./exec"

const constToString = (s: any): string => {
    if (s === null) {
        return "()"
    } else if (typeof s === "symbol") {
        return `${s.description || String(s)}`
    } else if (typeof s === "string") {
        return `"${s.toString()}"`
    } else if (typeof s === "number") {
        if (s === Infinity) return "+inf.0";
        if (s === -Infinity) return "-inf.0";
        if (Number.isNaN(s)) return "+nan.0";
        return `${s}`
    } else if (typeof s === "boolean") {
        return `<${s}>`
    } else if (typeof s === "undefined") {
        return `#<void>`
    } else if (Array.isArray(s)) {
        const r = []
        for(const elem of s) {
            r.push(constToString(elem))
        }
        return `(${r.join(' ')})`
    } else if (s instanceof ClosureTemplate) {
        return `fn(${s.params.map(x => constToString(x)).join(', ')}${s.remParams ? ` . ${constToString(s.remParams)}` : ""})`
    } else if (s instanceof Closure) {
        return `c.fn(${s.tmpl.params.map(x => constToString(x)).join(', ')}${s.tmpl.remParams ? ` . ${constToString(s.tmpl.remParams)}` : ""})`
    } else {
        return `<unknown:${s}>`
    }
}

const stringifyInst = (inst: ByteCode): string[] => {
    let ops: string[] = [];
    let idx = 0;

    const padOp = (name: string) => name.padEnd(20, ' ');

    while (idx < inst.inst.length) {
        const lineNum = idx.toString().padStart(4, '0');
        const opcode: OpCode = inst.inst[idx];
        let line = `${lineNum}: `;

        switch (opcode) {
            case OpCode.RETURN:
                line += `${padOp("RETURN")} r${inst.inst[idx + 1]}`;
                idx += 2;
                break;

            case OpCode.LOADCONST: {
                const dest = inst.inst[idx + 1];
                const constIdx = inst.inst[idx + 2];
                const valStr = inst.constants ? constToString(inst.constants[constIdx]) : `[idx ${constIdx}]`;
                line += `${padOp("LOADCONST")} r${dest}, const(${valStr})`;
                idx += 3;
                break;
            }

            case OpCode.LOADU32:
                line += `${padOp("LOADU32")} r${inst.inst[idx + 1]}, ${inst.inst[idx + 2]}`;
                idx += 3;
                break;

            case OpCode.MOVE:
            case OpCode.BOX:
            case OpCode.UNBOX:
            case OpCode.SETBOX:
                line += `${padOp(OpCode[opcode])} dest=r${inst.inst[idx + 1]}, src=r${inst.inst[idx + 2]}`;
                idx += 3;
                break;

            case OpCode.LOADUPVAR:
                line += `${padOp("LOADUPVAR")} r${inst.inst[idx + 1]}, upvar(${inst.inst[idx + 2]}) andUnbox=${inst.inst[idx + 3]}`;
                idx += 4;
                break;
                
            case OpCode.SETUPVAR:
                line += `${padOp("SETUPVAR")} r${inst.inst[idx + 1]}, upvar(${inst.inst[idx + 2]}) andBox=${inst.inst[idx + 3]}`;
                idx += 4;
                break;

            case OpCode.LOADGLOBAL:
            case OpCode.SETGLOBAL: {
                line += `${padOp(OpCode[opcode])} r${inst.inst[idx + 1]}, global(${constToString(inst.constants[inst.inst[idx + 2]])})`;
                idx += 3;
                break;
            }

            case OpCode.NEWCLOSURE:
                ops.push(`${lineNum}: ${padOp("NEWCLOSURE")} r${inst.inst[idx + 1]}, tmpl(${inst.inst[idx + 2]}), closure=${constToString(inst.constants[inst.inst[idx + 2]])}`)
                const childLines = stringifyInst(inst.constants[inst.inst[idx + 2]].code)
                childLines.forEach(l => ops.push(`\t${l}`));
                idx += 3;
                continue

            case OpCode.IF:
                line += `${padOp("IF")} r${inst.inst[idx + 1]}, else=#${inst.inst[idx + 2]}`;
                idx += 3;
                break;

            case OpCode.ELSE:
                line += `${padOp("ELSE")} end=#${inst.inst[idx + 1]}`;
                idx += 2;
                break;

            case OpCode.ENDIF:
                line += `${padOp("ENDIF")}`;
                idx += 1;
                break;

            case OpCode.CALL:
            case OpCode.APPLY: {
                const proc = inst.inst[idx + 1];
                const procStr = (proc < BUILTINS_START) ? `r${proc}` : `builtin(${String(IBUILTINS[proc-BUILTINS_START].name)})`;
                line += `${padOp(OpCode[opcode])} ${procStr}, start=r${inst.inst[idx + 2]}, nargs=${inst.inst[idx + 3]}${inst.inst[idx + 4] ? ", tail" : ""}`;
                idx += 5;
                break;
            }

            case OpCode.MOVEACC:
                line += `${padOp("MOVEACC")} r${inst.inst[idx + 1]}`;
                idx += 2;
                break;

            case OpCode.CALLCC:
                line += `${padOp("CALLCC")} proc=r${inst.inst[idx + 1]}${inst.inst[idx + 2] ? ", tail" : ""}`;
                idx += 3;
                break;

            case OpCode.COYIELD:
                line += `${padOp("COYIELD")} r${inst.inst[idx + 1]}`;
                idx += 2;
                break;

            case OpCode.CORESUME:
                line += `${padOp("CORESUME")} co=r${inst.inst[idx + 1]}, args=r${inst.inst[idx + 2]}${inst.inst[idx + 3] ? ", tail" : ""}`;
                idx += 4;
                break;

            case OpCode.SETMARK:
                line += `${padOp("SETMARK")} key=r${inst.inst[idx + 1]}, value=r${inst.inst[idx + 2]}`;
                idx += 3;
                break;

            case OpCode.CALLEC:
                line += `${padOp("CALLEC")} proc=r${inst.inst[idx + 1]}, tok=r${inst.inst[idx + 2]}`;
                idx += 3;
                break;

            case OpCode.CALLCATCH:
                line += `${padOp("CALLCATCH")} proc=r${inst.inst[idx + 1]}, tok=r${inst.inst[idx + 2]}${inst.inst[idx + 3] === 0xFFFFFFFF ? "" : `, pre=r${inst.inst[idx + 3]}`}`;
                idx += 4;
                break;

            case OpCode.RAISE:
                line += `${padOp("RAISE")} r${inst.inst[idx + 1]}${inst.inst[idx + 2] ? ", continuable" : ""}`;
                idx += 3;
                break;

            case OpCode.MARKSAVE:
            case OpCode.MARKRESTORE:
            case OpCode.CURMARKS:
                line += `${padOp(OpCode[opcode])} r${inst.inst[idx + 1]}`;
                idx += 2;
                break;

            case OpCode.UNPACK:
                line += `${padOp("UNPACK")} r${inst.inst[idx + 1]} -> start=r${inst.inst[idx + 2]}, count=${inst.inst[idx + 3]}, flags=${inst.inst[idx + 4]}`;
                idx += 5;
                break;

            case OpCode.BLOCK:
            case OpCode.LOOP:
                line += `${padOp(OpCode[opcode])} end=${inst.inst[idx + 1]}`;
                idx += 2;
                break;

            case OpCode.ENDLOOP:
            case OpCode.JUMP:
                line += `${padOp(OpCode[opcode])} ${inst.inst[idx + 1]}`;
                idx += 2;
                break;

            case OpCode.CALLRT:
                line += `${padOp("CALLRT")} ${RUNTIME[inst.inst[idx + 1]][0]}, dest=r${inst.inst[idx + 2]}, start=r${inst.inst[idx + 3]}, nargs=${inst.inst[idx + 4]}`;
                idx += 5;
                break;

            default:
                let _: never = opcode
        }
        
        ops.push(line);
    }
    
    return ops
}

export const deepPrint = (bc: ByteCode) => {
    console.log(stringifyInst(bc).join("\n"))
    for (let i = 0; i < bc.constants.length; i++) {
        const c = bc.constants[i]
        if (c instanceof ClosureTemplate) {
            console.log(`Const #${i} (template):\n${stringifyInst(c.code).join("\n")}`)
        } else if (c instanceof Closure) {
            console.log(`Const #${i} (c.fn):\n${stringifyInst(c.tmpl.code).join("\n")}`)
        }
    }
}

const BYTECODE_MAGIC = 0x414E4D41

// bump whenever opcodes, builtin indices or the serialized layout change
export const BYTECODE_VERSION = 15

export const dumpFull = (b: SerializableBytecode): Uint32Array => {
    const bs = new BS()
    bs.writeValue(b)
    const body = bs.finalize()
    const out = new Uint32Array(body.length + 2)
    out[0] = BYTECODE_MAGIC
    out[1] = BYTECODE_VERSION
    out.set(body, 2)
    return out
}

export const readFull = (b: Uint32Array): SerializableBytecode => {
    if (b.length < 2 || b[0] !== BYTECODE_MAGIC) {
        throw new Error("not anima bytecode (missing header)")
    }
    if (b[1] !== BYTECODE_VERSION) {
        throw new Error(`bytecode version ${b[1]} is not supported (expected ${BYTECODE_VERSION}), recompile from source`)
    }
    const bsr = new BSReader(b.subarray(2))
    ByteCode.register(bsr)
    ClosureTemplate.register(bsr)
    Closure.register(bsr)
    return bsr.readSerializable()
}