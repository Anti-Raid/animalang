// comparing what Luau programs give here with what a Luau binary (the LUAU environment variable) gives
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Anima } from '../anima';
import { MultipleValues } from '../common';
import { toString } from '../lua';

// a value on one line: a string with what is not a letter, a digit or a space as \ddd
const escaped = (s: string) => s.replace(/[^A-Za-z0-9 ]/g, c => "\\" + String(c.charCodeAt(0)).padStart(3, "0"));
const show = (v: any) => typeof v === "string" ? `<${escaped(v)}>` : typeof v === "object" && v !== null ? "table" : toString(v).replace(/^function: .*/, "function");

const header = [
    "local function esc(s) return (s:gsub('[^%w ]', function(c) return string.format('\\\\%03d', c:byte()) end)) end",
    "local function shown(v) if type(v) == 'string' then return '<' .. esc(v) .. '>' elseif type(v) == 'table' then return 'table' elseif type(v) == 'function' then return 'function' end return tostring(v) end",
];

// what each program returns (or its error), from Luau
const theirs = (programs: string[]): string[] => {
    const lua = [...header, ...programs.map(p => `do local f, err = loadstring(${JSON.stringify(p)}, "=t") if not f then print("error: " .. esc(err)) else local r = table.pack(pcall(f)) if r[1] then local out = {} for i = 2, r.n do out[#out + 1] = shown(r[i]) end print(table.concat(out, " ")) else print("error: " .. esc(tostring(r[2]))) end end end`)];
    const file = join(mkdtempSync(join(tmpdir(), "luau-")), "programs.luau");
    writeFileSync(file, lua.join("\n"));
    return execFileSync(process.env.LUAU!, [file], { encoding: "utf8", maxBuffer: 1 << 26, timeout: 60000 }).split("\n").slice(0, programs.length);
};

// a Luau string literal of `s`
export const lit = (s: string) => `"${escaped(s)}"`;

// the programs that give something else here than in Luau, each with both results
export const comparer = (luau: Anima) => (programs: string[]): string[] => {
    const ours = (src: string): string => {
        try {
            const r = luau.evaluateRaw(luau.compileRaw(src, "t"));
            return (r instanceof MultipleValues ? r.values : [r]).map(show).join(" ");
        } catch (e: any) {
            return "error: " + escaped(String(e.message));
        }
    };
    const expected = theirs(programs);
    return programs.flatMap((p, i) => { const a = ours(p); return a === expected[i] ? [] : [`${p}\n--- ours:   ${a}\n--- Luau's: ${expected[i]}`]; });
};
