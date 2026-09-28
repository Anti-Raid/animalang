// `dump` shows a tree compactly
import { Local, childNodes, type Node } from "./ast";

// (Kind field=value ... child ...): names, operators, values and the locals a node binds or refers to
const SHOWN = new Set(["name", "op", "value", "index", "isConst", "self", "vararg"]);
export const dump = (node: Node): string => {
    const parts: string[] = [node.kind];
    const show = (key: string, v: any): string | null => {
        if (v instanceof Local) return `${key}=${v.name}`;
        if (Array.isArray(v) && v.length > 0 && v.every(x => x instanceof Local)) return `${key}=[${v.map((l: Local) => l.name).join(" ")}]`;
        if (SHOWN.has(key) && (typeof v === "string" || typeof v === "number" || v === true)) return `${key}=${typeof v === "string" ? JSON.stringify(v) : v}`;
        return null;
    };
    for (const [key, v] of Object.entries(node)) {
        if (key === "kind") continue;
        const s = show(key, v);
        if (s !== null) parts.push(s);
    }
    for (const c of childNodes(node)) parts.push(dump(c));
    return `(${parts.join(" ")})`;
};
