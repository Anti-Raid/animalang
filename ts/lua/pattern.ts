// Lua's patterns, as Luau matches them (VM/src/lstrlib.cpp, "PATTERN MATCHING"): a port, over strings whose characters
// are bytes. A position past the end of the source or of the pattern reads as 0, as C reads the terminating NUL
import { luauError } from "./errors";

const MAXCCALLS = 200;
const MAXCAPTURES = 32;
const CAP_UNFINISHED = -1;
const CAP_POSITION = -2;

const ESC = 37; // %

const isalpha = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isdigit = (c: number) => c >= 48 && c <= 57;
const islower = (c: number) => c >= 97 && c <= 122;
const isupper = (c: number) => c >= 65 && c <= 90;
const isspace = (c: number) => c === 32 || (c >= 9 && c <= 13);
const iscntrl = (c: number) => c < 32 || c === 127;
const isgraph = (c: number) => c > 32 && c < 127;
const ispunct = (c: number) => isgraph(c) && !isalpha(c) && !isdigit(c);
const isxdigit = (c: number) => isdigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
const tolower = (c: number) => isupper(c) ? c + 32 : c;

// match_class: whether the character `c` is of the class the letter `cl` names (an upper-case letter: is not)
const matchClass = (c: number, cl: number): boolean => {
    let res: boolean;
    switch (tolower(cl)) {
        case 97: res = isalpha(c); break;
        case 99: res = iscntrl(c); break;
        case 100: res = isdigit(c); break;
        case 103: res = isgraph(c); break;
        case 108: res = islower(c); break;
        case 112: res = ispunct(c); break;
        case 115: res = isspace(c); break;
        case 117: res = isupper(c); break;
        case 119: res = isalpha(c) || isdigit(c); break;
        case 120: res = isxdigit(c); break;
        case 122: res = c === 0; break;
        default: return cl === c;
    }
    return islower(cl) ? res : !res;
};

export class MatchState {
    level = 0;
    #depth = MAXCCALLS;
    readonly #init: number[] = [];
    readonly #len: number[] = [];
    readonly #srcEnd: number;
    readonly #pEnd: number;

    constructor(readonly src: string, readonly pat: string) {
        this.#srcEnd = src.length;
        this.#pEnd = pat.length;
    }

    // reprepstate: before each attempt
    reset(): void {
        this.level = 0;
    }

    #p(i: number): number {
        return i < this.#pEnd ? this.pat.charCodeAt(i) : 0;
    }

    #s(i: number): number {
        return i < this.#srcEnd ? this.src.charCodeAt(i) : 0;
    }

    #checkCapture(l: number): number {
        l -= 49;
        if (l < 0 || l >= this.level || this.#len[l] === CAP_UNFINISHED) throw luauError(`invalid capture index %${l + 1}`);
        return l;
    }

    #captureToClose(): number {
        for (let level = this.level - 1; level >= 0; level--) if (this.#len[level] === CAP_UNFINISHED) return level;
        throw luauError("invalid pattern capture");
    }

    #classEnd(p: number): number {
        const c = this.#p(p++);
        if (c === ESC) {
            if (p === this.#pEnd) throw luauError("malformed pattern (ends with '%')");
            return p + 1;
        }
        if (c === 91) {
            if (this.#p(p) === 94) p++;
            do {
                if (p === this.#pEnd) throw luauError("malformed pattern (missing ']')");
                if (this.#p(p++) === ESC && p < this.#pEnd) p++;
            } while (this.#p(p) !== 93);
            return p + 1;
        }
        return p;
    }

    // whether `c` is in the set that starts at `p` (its '[') and ends at `ec` (its ']')
    #matchBracketClass(c: number, p: number, ec: number): boolean {
        let sig = true;
        if (this.#p(p + 1) === 94) {
            sig = false;
            p++;
        }
        while (++p < ec) {
            if (this.#p(p) === ESC) {
                p++;
                if (matchClass(c, this.#p(p))) return sig;
            } else if (this.#p(p + 1) === 45 && p + 2 < ec) {
                p += 2;
                if (this.#p(p - 2) <= c && c <= this.#p(p)) return sig;
            } else if (this.#p(p) === c) return sig;
        }
        return !sig;
    }

    #singleMatch(s: number, p: number, ep: number): boolean {
        if (s >= this.#srcEnd) return false;
        const c = this.src.charCodeAt(s);
        switch (this.#p(p)) {
            case 46: return true;
            case ESC: return matchClass(c, this.#p(p + 1));
            case 91: return this.#matchBracketClass(c, p, ep - 1);
            default: return this.#p(p) === c;
        }
    }

    #matchBalance(s: number, p: number): number {
        if (p >= this.#pEnd - 1) throw luauError("malformed pattern (missing arguments to '%b')");
        if (this.#s(s) !== this.#p(p)) return -1;
        const b = this.#p(p), e = this.#p(p + 1);
        let cont = 1;
        while (++s < this.#srcEnd) {
            const c = this.src.charCodeAt(s);
            if (c === e) {
                if (--cont === 0) return s + 1;
            } else if (c === b) cont++;
        }
        return -1;
    }

    #maxExpand(s: number, p: number, ep: number): number {
        let i = 0;
        while (this.#singleMatch(s + i, p, ep)) i++;
        while (i >= 0) {
            const res = this.match(s + i, ep + 1);
            if (res !== -1) return res;
            i--;
        }
        return -1;
    }

    #minExpand(s: number, p: number, ep: number): number {
        for (;;) {
            const res = this.match(s, ep + 1);
            if (res !== -1) return res;
            if (this.#singleMatch(s, p, ep)) s++;
            else return -1;
        }
    }

    #startCapture(s: number, p: number, what: number): number {
        const level = this.level;
        if (level >= MAXCAPTURES) throw luauError("too many captures");
        this.#init[level] = s;
        this.#len[level] = what;
        this.level = level + 1;
        const res = this.match(s, p);
        if (res === -1) this.level--;
        return res;
    }

    #endCapture(s: number, p: number): number {
        const l = this.#captureToClose();
        this.#len[l] = s - this.#init[l];
        const res = this.match(s, p);
        if (res === -1) this.#len[l] = CAP_UNFINISHED;
        return res;
    }

    #matchCapture(s: number, l: number): number {
        l = this.#checkCapture(l);
        const len = this.#len[l];
        return this.#srcEnd - s >= len && this.src.startsWith(this.src.substr(this.#init[l], len), s) ? s + len : -1;
    }

    // where a match of the pattern from `p` on, at `s` in the source, ends; -1 when there is none
    match(s: number, p: number): number {
        if (this.#depth-- === 0) throw luauError("pattern too complex");
        while (p !== this.#pEnd) {
            const c = this.#p(p);
            if (c === 40) {
                s = this.#p(p + 1) === 41 ? this.#startCapture(s, p + 2, CAP_POSITION) : this.#startCapture(s, p + 1, CAP_UNFINISHED);
                break;
            }
            if (c === 41) {
                s = this.#endCapture(s, p + 1);
                break;
            }
            if (c === 36 && p + 1 === this.#pEnd) {
                s = s === this.#srcEnd ? s : -1;
                break;
            }
            if (c === ESC) {
                const next = this.#p(p + 1);
                if (next === 98) {
                    s = this.#matchBalance(s, p + 2);
                    if (s === -1) break;
                    p += 4;
                    continue;
                }
                if (next === 102) {
                    p += 2;
                    if (this.#p(p) !== 91) throw luauError("missing '[' after '%f' in pattern");
                    const ep = this.#classEnd(p);
                    const previous = s === 0 ? 0 : this.src.charCodeAt(s - 1);
                    if (!this.#matchBracketClass(previous, p, ep - 1) && this.#matchBracketClass(this.#s(s), p, ep - 1)) {
                        p = ep;
                        continue;
                    }
                    s = -1;
                    break;
                }
                if (isdigit(next)) {
                    s = this.#matchCapture(s, next);
                    if (s === -1) break;
                    p += 2;
                    continue;
                }
            }
            // a single character class, and what may follow it
            const ep = this.#classEnd(p);
            const suffix = this.#p(ep);
            if (!this.#singleMatch(s, p, ep)) {
                if (suffix === 42 || suffix === 63 || suffix === 45) {
                    p = ep + 1;
                    continue;
                }
                s = -1;
                break;
            }
            if (suffix === 63) {
                const res = this.match(s + 1, ep + 1);
                if (res !== -1) {
                    s = res;
                    break;
                }
                p = ep + 1;
                continue;
            }
            if (suffix === 43) {
                s = this.#maxExpand(s + 1, p, ep);
                break;
            }
            if (suffix === 42) {
                s = this.#maxExpand(s, p, ep);
                break;
            }
            if (suffix === 45) {
                s = this.#minExpand(s, p, ep);
                break;
            }
            s++;
            p = ep;
        }
        this.#depth++;
        return s;
    }

    // push_onecapture: capture `i` of a match from `s` to `e`, which is the whole match when there are no captures
    capture(i: number, s: number, e: number): string | number {
        if (i >= this.level) {
            if (i === 0) return this.src.slice(s, e);
            throw luauError("invalid capture index");
        }
        const l = this.#len[i];
        if (l === CAP_UNFINISHED) throw luauError("unfinished capture");
        return l === CAP_POSITION ? this.#init[i] + 1 : this.src.substr(this.#init[i], l);
    }

    // push_captures: every capture, or the whole match (`whole`: find gives none then)
    captures(s: number, e: number, whole: boolean): (string | number)[] {
        const n = this.level === 0 && whole ? 1 : this.level;
        return Array.from({ length: n }, (_, i) => this.capture(i, s, e));
    }
}

// whether a pattern has none of the characters that mean something
export const noSpecials = (p: string): boolean => !/[\^$*+?.([%-]/.test(p);
