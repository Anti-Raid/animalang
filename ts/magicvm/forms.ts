// A core form is [op, pos, operand ...]: `pos` is where it comes from (a SourcePos), or null to take the enclosing form's.
// Every form has the slot, so the forms carry their own positions and nothing else has to
import type { SourcePos } from "../common";

export const isPosSlot = (x: any): x is SourcePos | null =>
    x === null || (typeof x === "object" && typeof x.file === "string" && typeof x.line === "number" && typeof x.col === "number");

// the position of a form, or null (an atom has none)
export const posOf = (e: any): SourcePos | null => Array.isArray(e) && e.length >= 2 && isPosSlot(e[1]) ? e[1] : null;
