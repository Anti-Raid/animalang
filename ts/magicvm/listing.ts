// A readable listing of compiled code: one line per instruction, `ip: Kind field=value, ...`; the code of a
// NewClosure's template follows it, indented
import { isDatum } from "../common";
import { Closure, ClosureTemplate, type Code } from "./code";
import { UNPACK_REST, UNPACK_STRICT, type Op } from "./ops";

const REGS = new Set(["dst", "src", "clo", "cond", "proc", "start", "key", "val", "reg"]);
const IPS = new Set(["else", "end", "head", "target"]);

const paramsToString = (tmpl: ClosureTemplate): string =>
    `(${[tmpl.params.map(constToString).join(", "), tmpl.remParams === null ? "" : `. ${constToString(tmpl.remParams)}`].filter(part => part !== "").join(" ")})`;

const constToString = (c: any): string => {
    if (typeof c === "symbol") return c.description || String(c);
    if (typeof c === "string") return `"${c}"`;
    if (Array.isArray(c)) return `[${c.map(constToString).join(", ")}]`;
    if (isDatum(c)) return c.stringify(constToString);
    if (c instanceof ClosureTemplate) return `fn${paramsToString(c)}`;
    if (c instanceof Closure) return `c.fn${paramsToString(c.tmpl)}`;
    return String(c);
};

const fieldToString = (code: Code, op: Op, name: string, value: any): string => {
    if (REGS.has(name)) return `r${value}`;
    if (IPS.has(name)) return `#${value}`;
    if (name === "pos") return code.intrinsics.find(used => used.pos === value)?.name ?? `#${value}`;
    if ((op.k === "LoadConst" && name === "idx") || name === "sym" || name === "tmpl") return constToString(code.constants[value]);
    if (op.k === "Unpack" && name === "flags") return [value & UNPACK_REST ? "rest" : "", value & UNPACK_STRICT ? "strict" : ""].filter(f => f !== "").join("|") || "-";
    return String(value);
};

export const listing = (code: Code): string[] => {
    const lines: string[] = [];
    for (const op of code.ops) {
        const fields = Object.entries(op).filter(([name]) => name !== "k" && name !== "ip" && name !== "where").map(([name, value]) => `${name}=${fieldToString(code, op, name, value)}`);
        lines.push(`${op.ip.toString().padStart(4, "0")}: ${op.k.padEnd(12, " ")}${fields.join(", ")}`.trimEnd());
        if (op.k === "NewClosure") for (const line of listing((code.constants[op.tmpl] as ClosureTemplate).code)) lines.push(`\t${line}`);
    }
    return lines;
};
