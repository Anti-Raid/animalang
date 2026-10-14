// Accumulates generated JS, and what an intrinsic's inline template is given
import type { Intrinsic } from "../intrinsics";

export const MAX_INDENT = 16;
export const INDENTS = Array.from({ length: MAX_INDENT + 1 }, (_, i) => "    ".repeat(i));

// accumulates generated js, re-indenting it by brace depth
export class CodeEmitter {
    private lines: string[] = [];
    private depth: number = 0;
    // deeper code is not indented further: indenting by depth makes the output quadratic in deeply nested code

    emit(str: string): void {
        const rawLines = str.split("\n");
        for (const raw of rawLines) {
            const trimmed = raw.trim();
            if (!trimmed) continue;

            let lineDepth = this.depth;
            if (trimmed.startsWith("}") || trimmed.startsWith("]")) {
                lineDepth = Math.max(0, this.depth - 1);
            }

            this.lines.push(INDENTS[Math.min(lineDepth, MAX_INDENT)] + trimmed);

            for (const ch of trimmed) {
                if (ch === "{" || ch === "[") this.depth++;
                else if (ch === "}" || ch === "]") this.depth = Math.max(0, this.depth - 1);
            }
        }
    }

    toString(): string {
        return this.lines.join("\n");
    }
}

// the `d` an intrinsic's inline template gets: the local names of its deps (recorded in `used`, as only those are set up),
// where a name it did not declare is an error
export const inlineDeps = (entry: Intrinsic, used: Set<string>): Readonly<Record<string, string>> => new Proxy(entry.deps, {
    get(target, key) {
        if (typeof key !== "string") return undefined;
        if (!Object.hasOwn(target, key)) throw new Error(`the inline template of '${entry.name}' uses '${key}', which is not in its deps`);
        used.add(target[key]);
        return target[key];
    },
});
