// `show` writes a form as an s-expression, without its offset: 1 + 2 * 3 is (+ 1 (* 2 3))
import { L, isForm } from "./ast";

export const show = (v: unknown): string => {
    if (v === L.NIL) return "nil";
    if (typeof v === "symbol") return v.description ?? "?";
    if (typeof v === "string") return JSON.stringify(v);
    if (isForm(v)) return `(${[v[0], ...v.slice(1, -1)].map(show).join(" ")})`;
    if (Array.isArray(v)) return `[${v.map(show).join(" ")}]`;
    return String(v);
};
