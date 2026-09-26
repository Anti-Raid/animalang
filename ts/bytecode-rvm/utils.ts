import { ASTStringifier, BS, BSReader, type SerializableBytecode } from "../common"
import { ByteCode, Closure, ClosureTemplate, OpCode, RUNTIME } from "./exec"
import { INSTRUCTION_LENGTHS, NO_REG, OPCODES, type OpSpec, type OperandKind } from "./opcodes"
import type { Intrinsics } from "./intrinsics"

const intrinsicName = (code: ByteCode, pos: number): string => code.intrinsics.find(used => used.pos === pos)?.name ?? `#${pos}`

const STRINGIFIER = new ASTStringifier()

// (a, b . rest)
const paramsToString = (tmpl: ClosureTemplate): string =>
    `(${[tmpl.params.map(p => constToString(p)).join(", "), tmpl.remParams === null ? "" : `. ${constToString(tmpl.remParams)}`].filter(part => part !== "").join(" ")})`

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
        return `fn${paramsToString(s)}`
    } else if (s instanceof Closure) {
        return `c.fn${paramsToString(s.tmpl)}`
    } else {
        return STRINGIFIER.stringify(s)
    }
}

const operandToString = (code: ByteCode, spec: OpSpec, kind: OperandKind, value: number): string => {
    switch (kind) {
        case "reg": return `r${value}`
        case "optreg": return value === NO_REG ? "-" : `r${value}`
        case "const": return constToString(code.constants[value])
        case "u32": case "bool": return `${value}`
        case "upvar": return `upvar(${value})`
        case "ip": return `#${value}`
        case "intrinsic": return intrinsicName(code, value)
        case "runtime": return RUNTIME[value]?.name ?? `#${value}`
        case "tail": case "flags": {
            const names = (spec.bits ?? []).filter((_, bit) => (value & (1 << bit)) !== 0)
            return names.length === 0 ? "-" : names.join("|")
        }
    }
}

// one line per instruction, `ip: NAME operand=value, ...`; the code of a NEWCLOSURE's template follows it, indented
const stringifyInst = (code: ByteCode): string[] => {
    const lines: string[] = []
    for (let ip = 0; ip < code.inst.length; ip += INSTRUCTION_LENGTHS[code.inst[ip] as OpCode]) {
        const op = code.inst[ip] as OpCode
        const spec = OPCODES[op]
        if (spec === undefined) throw new Error(`unknown opcode ${op} at ${ip}`)
        const operands = spec.operands.map(([name, kind], i) => `${name}=${operandToString(code, spec, kind, code.inst[ip + 1 + i])}`)
        lines.push(`${ip.toString().padStart(4, "0")}: ${spec.name.padEnd(12, " ")}${operands.join(", ")}`.trimEnd())
        if (op === OpCode.NEWCLOSURE) for (const line of stringifyInst(code.constants[code.inst[ip + 2]].code)) lines.push(`\t${line}`)
    }
    return lines
}

export { stringifyInst }

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
export const BYTECODE_VERSION = 21

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

// the code is bound to `intrinsics` by name: an error if it uses one that is missing or registered differently (see ByteCode.bind)
export const readFull = (b: Uint32Array, intrinsics: Intrinsics | null = null): SerializableBytecode => {
    if (b.length < 2 || b[0] !== BYTECODE_MAGIC) {
        throw new Error("not anima bytecode (missing header)")
    }
    if (b[1] !== BYTECODE_VERSION) {
        throw new Error(`bytecode version ${b[1]} is not supported (expected ${BYTECODE_VERSION}), recompile from source`)
    }
    const bsr = new BSReader(b.subarray(2))
    ByteCode.register(bsr, intrinsics)
    ClosureTemplate.register(bsr)
    Closure.register(bsr)
    return bsr.readSerializable()
}