// The instruction set, described once: everything that walks instructions without executing them (lengths, rebinding
// intrinsic operands, the disassembler, where AOT basic blocks start) is derived from OPCODES, indexed by opcode.
// The OpCode enum itself lives in exec.ts, next to the interpreter's switch: esbuild only inlines an enum's values in the
// file that declares it, and a switch over imported enum members is several times slower. OPCODES lists the opcodes in
// the enum's order, with their names (a test checks they match). Imports nothing.

// a register that is not there (an optional register operand)
export const NO_REG = 0xFFFFFFFF;

// the `tail` operand of CALL, APPLY, CALLCC, CORESUME and CALLHOST: bit 0 is set in tail position
export const TAIL = 1;
// APPLY's other `tail` bits: the last argument register holds a forwarded rest array (see ClosureTemplate.restArray),
// not a list; and, with it, for %apply-multi, the rest array's own last element is a list, spread too
export const APPLY_TAIL = TAIL;
export const APPLY_REST = 2;
export const APPLY_MULTI = 4;

// UNPACK flags
export const UNPACK_REST = 1;
export const UNPACK_STRICT = 2;

export type OperandKind =
    | "reg"       // a register
    | "optreg"    // a register, or NO_REG
    | "const"     // a constant-pool index
    | "u32"       // an immediate count or number
    | "upvar"     // an upvar index
    | "bool"      // 0 or 1
    | "ip"        // a jump target: an instruction index (always starts a basic block)
    | "intrinsic" // a position in the code's intrinsics table (remapped when the code is bound to another table)
    | "runtime"   // an index in RUNTIME
    | "tail"      // bit 0: in tail position (see TAIL); other bits by opcode, named in `bits`
    | "flags";    // bits named in `bits`

export type OpSpec = {
    readonly name: string,
    readonly operands: readonly (readonly [name: string, kind: OperandKind])[],
    // whether the instruction after this one starts a basic block (in AOT code): "always", or unless the `tail` operand
    // says it is a tail call. Jump targets always start one
    readonly split?: "always" | "nonTail",
    // names of the bits of a `tail` / `flags` operand, lowest first
    readonly bits?: readonly string[],
    readonly doc: string,
};

const TAIL_CALL = { split: "nonTail", bits: ["tail"] } as const;

export const OPCODES: readonly OpSpec[] = Object.freeze([
    { name: "LOADCONST", operands: [["dst", "reg"], ["const", "const"]], doc: "reg[dst] = constants[const]" },
    { name: "LOADU32", operands: [["dst", "reg"], ["n", "u32"]], doc: "reg[dst] = n (a small non-negative integer)" },
    { name: "LOADUPVAR", operands: [["dst", "reg"], ["upvar", "upvar"], ["unbox", "bool"]], doc: "reg[dst] = upvars[upvar] (its box's value if unbox)" },
    { name: "SETUPVAR", operands: [["src", "reg"], ["upvar", "upvar"], ["box", "bool"]], doc: "upvars[upvar] = reg[src] (in a new box if box)" },
    { name: "LOADGLOBAL", operands: [["dst", "reg"], ["name", "const"]], doc: "reg[dst] = the global named constants[name]" },
    { name: "SETGLOBAL", operands: [["src", "reg"], ["name", "const"]], doc: "the global named constants[name] = reg[src]" },
    { name: "IF", operands: [["cond", "reg"], ["else", "ip"]], split: "always", doc: "jump to else if reg[cond] is false" },
    { name: "ELSE", operands: [["end", "ip"]], doc: "end of a then branch: jump past the rest of the if" },
    { name: "ENDIF", operands: [], doc: "marks the end of an if (for structured AOT code)" },
    { name: "CALL", operands: [["proc", "reg"], ["start", "reg"], ["nargs", "u32"], ["tail", "tail"]], ...TAIL_CALL, doc: "call reg[proc] on reg[start .. start+nargs)" },
    { name: "RETURN", operands: [["src", "reg"]], doc: "return reg[src] from the function" },
    { name: "NEWCLOSURE", operands: [["dst", "reg"], ["tmpl", "const"]], doc: "reg[dst] = a closure of the template constants[tmpl], capturing its upvars" },
    { name: "BOX", operands: [["dst", "reg"], ["src", "reg"]], doc: "reg[dst] = a new box holding reg[src]" },
    { name: "UNBOX", operands: [["dst", "reg"], ["src", "reg"]], doc: "reg[dst] = the value of the box reg[src]" },
    { name: "SETBOX", operands: [["box", "reg"], ["src", "reg"]], doc: "the box reg[box] now holds reg[src]" },
    { name: "MOVE", operands: [["dst", "reg"], ["src", "reg"]], doc: "reg[dst] = reg[src]" },
    { name: "CALLCC", operands: [["proc", "reg"], ["tail", "tail"]], ...TAIL_CALL, doc: "call reg[proc] with the current continuation" },
    { name: "APPLY",
        operands: [["proc", "reg"], ["start", "reg"], ["nargs", "u32"], ["tail", "tail"]], split: "nonTail", bits: ["tail", "rest-array", "multi"],
        doc: "like CALL, with the last argument a list spread into the arguments (see APPLY_REST / APPLY_MULTI)",
    },
    { name: "MOVEACC", operands: [["dst", "reg"]], doc: "reg[dst] = the accumulator (the last call's result)" },
    { name: "COYIELD", operands: [["val", "reg"]], split: "always", doc: "yield reg[val] (already packed multiple values) from the running coroutine" },
    { name: "CALLRT", operands: [["rt", "runtime"], ["dst", "reg"], ["start", "reg"], ["nargs", "u32"]], doc: "reg[dst] = RUNTIME[rt] applied to reg[start .. start+nargs)" },
    { name: "CORESUME", operands: [["co", "reg"], ["list", "reg"], ["tail", "tail"]], ...TAIL_CALL, doc: "resume the coroutine reg[co] with the values in the list reg[list]" },
    { name: "BLOCK", operands: [["end", "ip"]], split: "always", doc: "start of a %block ending at end (for structured AOT code)" },
    { name: "LOOP", operands: [["end", "ip"]], split: "always", doc: "start of a %loop ending at end; its body starts after this" },
    { name: "ENDLOOP", operands: [["head", "ip"]], split: "always", doc: "end of a %loop's body: jump back to head" },
    { name: "JUMP", operands: [["target", "ip"]], split: "always", doc: "an %escape: jump to target (the end of a %block)" },
    { name: "UNPACK",
        operands: [["src", "reg"], ["start", "reg"], ["count", "u32"], ["flags", "flags"]], bits: ["rest", "strict"],
        doc: "spread reg[src]'s multiple values over reg[start .. start+count) (+ a rest list; see UNPACK_*)",
    },
    { name: "SETMARK", operands: [["key", "reg"], ["val", "reg"]], doc: "set the continuation mark reg[key] = reg[val] on the current frame" },
    { name: "MARKSAVE", operands: [["dst", "reg"]], doc: "reg[dst], reg[dst+1] = the current marks and logical frame, then start a new logical frame" },
    { name: "MARKRESTORE", operands: [["src", "reg"]], doc: "marks and logical frame = reg[src], reg[src+1]" },
    { name: "CURMARKS", operands: [["dst", "reg"]], doc: "reg[dst] = the current continuation marks, as a mark set" },
    { name: "CALLEC", operands: [["proc", "reg"], ["tok", "reg"]], split: "always", doc: "reg[tok] = a new escape continuation; call reg[proc] with it" },
    { name: "CALLCATCH",
        operands: [["proc", "reg"], ["tok", "reg"], ["pre", "optreg"]], split: "always",
        doc: "reg[tok] = a new catch token; call reg[proc] with it as the innermost exception handler (reg[pre], if any, runs on the error before unwinding)",
    },
    { name: "RAISE", operands: [["obj", "reg"], ["continuable", "bool"]], split: "always", doc: "deliver reg[obj] to the innermost exception handler" },
    { name: "CURSTACK", operands: [["skip", "u32"]], split: "always", doc: "a snapshot of the current stack, minus its innermost skip frames" },
    { name: "CALLHOST",
        operands: [["pos", "intrinsic"], ["start", "reg"], ["nargs", "u32"], ["tail", "tail"]], ...TAIL_CALL,
        doc: "call the non-leaf intrinsic at pos in the code's table on reg[start .. start+nargs); a HostTail result is called in its place",
    },
    { name: "CALLINT", operands: [["pos", "intrinsic"], ["dst", "reg"], ["start", "reg"], ["nargs", "u32"]], doc: "reg[dst] = the leaf intrinsic at pos in the code's table applied to reg[start .. start+nargs)" },
    { name: "APPLYINT", operands: [["pos", "intrinsic"], ["dst", "reg"], ["start", "reg"], ["nargs", "u32"]], doc: "like CALLINT, with the last argument a list spread into the arguments (the count is checked here)" },
    { name: "ELSEIF", operands: [["cond", "reg"], ["else", "ip"]], split: "always", doc: "like IF, for a later condition of the same chain (IF ... ELSE end; ELSEIF ... ELSE end; ... ENDIF)" },
    { name: "APPLYINTR", operands: [["pos", "intrinsic"], ["dst", "reg"], ["start", "reg"], ["nargs", "u32"]], doc: "like APPLYINT, with the last argument a forwarded rest array (see ClosureTemplate.restArray)" },
]);

export const INSTRUCTION_LENGTHS: readonly number[] = Object.freeze(OPCODES.map(spec => 1 + spec.operands.length));

// each opcode's operand offsets (from the opcode) of a kind
const offsetsOf = (kind: OperandKind): readonly (readonly number[])[] =>
    Object.freeze(OPCODES.map(spec => spec.operands.flatMap(([, k], i) => k === kind ? [i + 1] : [])));

export const INTRINSIC_OPERANDS = offsetsOf("intrinsic");
const IP_OPERANDS = offsetsOf("ip");
const TAIL_OPERANDS = offsetsOf("tail");

// the start of each basic block: the first instruction, every jump target, and the instruction after one that splits
export const basicBlockStarts = (inst: Uint32Array): number[] => {
    const starts = new Set<number>([0]);
    for (let ip = 0; ip < inst.length;) {
        const op = inst[ip];
        const spec = OPCODES[op];
        if (spec === undefined) throw new Error(`unknown opcode ${op} at ${ip}`);
        const next = ip + 1 + spec.operands.length;
        for (const off of IP_OPERANDS[op]) starts.add(inst[ip + off]);
        if (spec.split === "always" || (spec.split === "nonTail" && (inst[ip + TAIL_OPERANDS[op][0]] & TAIL) === 0)) starts.add(next);
        ip = next;
    }
    return Array.from(starts).sort((a, b) => a - b);
};
