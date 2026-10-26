// Matching a Lua pattern: by a RegExp made of it once (and kept), where one gives what Luau's matcher gives, else by
// the port of Luau's matcher (pattern.ts). Both backtrack in the same order (the leftmost match; `*` and `+` the longest
// first, `-` the shortest, `?` one before none), so they find the same match. The port is used for what a RegExp cannot
// say or would say differently: `%b`, a pattern Luau finds malformed only when matching reaches the bad part (so it is
// an error for some subjects and no match for others), a back-reference to a position capture, and a pattern with
// enough captures and repetitions that Luau may find it "too complex"
import { MatchState } from "./pattern";
import { luauError } from "./errors";

// a match: where it starts and ends, and its captures (a string, or a position for `()`)
export type Found = { start: number, end: number, level: number, capture(i: number): string | number };

export interface Matcher {
    // the match at `from` (`anchored`), or the first that starts at or after it; null when there is none
    find(src: string, from: number, anchored: boolean): Found | null;
    // `src` with every match replaced by `repl` as it is, and how many there were (gsub goes on after a match as JS's
    // replace does); absent when it is to be done match by match
    replaceAll?(src: string, repl: string): [string, number];
}

// push_captures: every capture of a match, or with `whole` and no captures, the match itself
export const capturesOf = (found: Found, whole: boolean): (string | number)[] => {
    const n = found.level === 0 && whole ? 1 : found.level;
    const out: (string | number)[] = [];
    for (let i = 0; i < n; i++) out.push(found.capture(i));
    return out;
};

type Range = [number, number];
const TOP = 0xffff;

const CLASSES: Record<string, Range[]> = {
    a: [[65, 90], [97, 122]],
    c: [[0, 31], [127, 127]],
    d: [[48, 57]],
    g: [[33, 126]],
    l: [[97, 122]],
    p: [[33, 47], [58, 64], [91, 96], [123, 126]],
    s: [[9, 13], [32, 32]],
    u: [[65, 90]],
    w: [[48, 57], [65, 90], [97, 122]],
    x: [[48, 57], [65, 70], [97, 102]],
    z: [[0, 0]],
};

const complement = (ranges: Range[]): Range[] => {
    const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
    const out: Range[] = [];
    let next = 0;
    for (const [lo, hi] of sorted) {
        if (lo > next) out.push([next, lo - 1]);
        next = Math.max(next, hi + 1);
    }
    if (next <= TOP) out.push([next, TOP]);
    return out;
};

// the characters `%c` stands for (match_class): a class, or the character itself
const classOf = (c: number): Range[] => {
    const letter = String.fromCharCode(c), lower = letter.toLowerCase();
    const ranges = CLASSES[lower];
    if (ranges === undefined || !/[a-zA-Z]/.test(letter)) return [[c, c]];
    return letter === lower ? ranges : complement(ranges);
};

const hex = (c: number): string => `\\u${c.toString(16).padStart(4, "0")}`;
// a set of characters as a RegExp class (an empty one matches nothing)
const setOf = (ranges: Range[]): string => `[${ranges.map(([lo, hi]) => lo === hi ? hex(lo) : `${hex(lo)}-${hex(hi)}`).join("")}]`;
const has = (ranges: Range[], c: number): boolean => ranges.some(([lo, hi]) => lo <= c && c <= hi);

type Translated = { source: string, positions: boolean[] };

// most captures and repetitions a pattern may have and never reach Luau's limit on the depth of matching (each takes
// one level of it at most; the limit is 200)
const MAX_DEPTH = 150;
const MAX_CAPTURES = 32;

// the RegExp source for a Lua pattern (from `start` on), and which of its captures are positions; null when it is the
// port's to match. It reads the pattern as Luau's matcher does (match, classend, matchbracketclass in lstrlib.cpp)
const translate = (pat: string, start: number): Translated | null => {
    const end = pat.length;
    const at = (i: number) => i < end ? pat.charCodeAt(i) : 0;
    let out = "", depth = 0;
    const positions: boolean[] = [];
    // each capture so far: open, or closed
    const closed: boolean[] = [];
    // the set whose `[` is at `p`: its characters, and where the pattern goes on; null when it has no `]`
    const set = (p: number): { ranges: Range[], next: number } | null => {
        let q = p + 1;
        if (at(q) === 94) q++;
        do {
            if (q === end) return null;
            if (at(q++) === 37 && q < end) q++;
        } while (at(q) !== 93);
        const ec = q;
        let i = p, negated = false;
        if (at(i + 1) === 94) {
            negated = true;
            i++;
        }
        const ranges: Range[] = [];
        while (++i < ec) {
            if (at(i) === 37) {
                i++;
                ranges.push(...classOf(at(i)));
            } else if (at(i + 1) === 45 && i + 2 < ec) {
                i += 2;
                if (at(i - 2) <= at(i)) ranges.push([at(i - 2), at(i)]);
            } else ranges.push([at(i), at(i)]);
        }
        return { ranges: negated ? complement(ranges) : ranges, next: ec + 1 };
    };
    for (let p = start; p < end;) {
        const c = at(p);
        if (c === 40) {
            if (closed.length >= MAX_CAPTURES) return null;
            depth++;
            if (at(p + 1) === 41) {
                out += "()";
                positions.push(true);
                closed.push(true);
                p += 2;
            } else {
                out += "(";
                positions.push(false);
                closed.push(false);
                p++;
            }
            continue;
        }
        if (c === 41) {
            const open = closed.lastIndexOf(false);
            if (open === -1) return null;
            closed[open] = true;
            depth++;
            out += ")";
            p++;
            continue;
        }
        if (c === 36 && p + 1 === end) {
            out += "$";
            p++;
            continue;
        }
        if (c === 37) {
            const next = at(p + 1);
            if (next === 98) return null;
            if (next === 102) {
                if (at(p + 2) !== 91) return null;
                const s = set(p + 2);
                if (s === null) return null;
                // before it a character not of the set, at it one of the set; outside the subject is the character 0
                const zero = has(s.ranges, 0);
                out += zero ? `(?<=${setOf(complement(s.ranges))})` : `(?<!${setOf(s.ranges)})`;
                out += zero ? `(?=${setOf(s.ranges)}|$)` : `(?=${setOf(s.ranges)})`;
                p = s.next;
                continue;
            }
            if (next >= 48 && next <= 57) {
                const l = next - 49;
                if (l < 0 || l >= closed.length || !closed[l] || positions[l]) return null;
                out += `(?:\\${l + 1})`;
                p += 2;
                continue;
            }
        }
        // one character's worth, and what may follow it
        let item: string, ep: number;
        if (c === 37) {
            if (p + 1 === end) return null;
            item = setOf(classOf(at(p + 1)));
            ep = p + 2;
        } else if (c === 91) {
            const s = set(p);
            if (s === null) return null;
            item = setOf(s.ranges);
            ep = s.next;
        } else {
            item = c === 46 ? "[^]" : hex(c);
            ep = p + 1;
        }
        const suffix = at(ep);
        if (suffix === 42 || suffix === 43 || suffix === 63 || suffix === 45) {
            depth++;
            out += item + (suffix === 45 ? "*?" : String.fromCharCode(suffix));
            p = ep + 1;
        } else {
            out += item;
            p = ep;
        }
    }
    if (closed.includes(false) || depth >= MAX_DEPTH) return null;
    return { source: out, positions };
};

class RegExpMatcher implements Matcher {
    readonly #anchored: RegExp;
    readonly #scanning: RegExp;
    readonly #positions: boolean[];

    constructor({ source, positions }: Translated) {
        // (the positions of captures are only asked for when a capture is one)
        const flags = positions.includes(true) ? "d" : "";
        this.#anchored = new RegExp(source, flags + "y");
        this.#scanning = new RegExp(source, flags + "g");
        this.#positions = positions;
    }

    replaceAll(src: string, repl: string): [string, number] {
        let n = 0;
        const out = src.replace(this.#scanning, () => {
            n++;
            return repl;
        });
        return [out, n];
    }

    find(src: string, from: number, anchored: boolean): Found | null {
        const re = anchored ? this.#anchored : this.#scanning;
        re.lastIndex = from;
        const m = re.exec(src);
        if (m === null) return null;
        const positions = this.#positions;
        return {
            start: m.index, end: m.index + m[0].length, level: positions.length,
            capture: i => {
                if (i >= positions.length) {
                    if (i === 0) return m[0];
                    throw luauError("invalid capture index");
                }
                return positions[i] ? m.indices![i + 1]![0] + 1 : m[i + 1];
            },
        };
    }
}

// Luau's matcher, tried at each position in turn (str_find_aux, gmatch_aux)
export class PortMatcher implements Matcher {
    constructor(readonly pat: string, readonly start: number) {}

    find(src: string, from: number, anchored: boolean): Found | null {
        const ms = new MatchState(src, this.pat);
        let s = from;
        do {
            ms.reset();
            const e = ms.match(s, this.start);
            if (e !== -1) return { start: s, end: e, level: ms.level, capture: i => ms.capture(i, s, e) };
        } while (s++ < src.length && !anchored);
        return null;
    }
}

const CACHE_SIZE = 512;
const caches = [new Map<string, Matcher>(), new Map<string, Matcher>()];

// the matcher of `pat` from `start` on (0, or 1 past a leading `^`, which the caller handles: it is the anchor only for
// find, match and gsub)
export const matcherOf = (pat: string, start: number = 0): Matcher => {
    const cache = caches[start];
    let m = cache.get(pat);
    if (m === undefined) {
        const translated = translate(pat, start);
        try {
            m = translated === null ? new PortMatcher(pat, start) : new RegExpMatcher(translated);
        } catch {
            m = new PortMatcher(pat, start);
        }
        if (cache.size >= CACHE_SIZE) cache.clear();
        cache.set(pat, m);
    }
    return m;
};

// (for tests) whether a pattern is matched by a RegExp
export const usesRegExp = (pat: string, start: number = 0): boolean => matcherOf(pat, start) instanceof RegExpMatcher;
