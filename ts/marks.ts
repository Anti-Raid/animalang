import { OpaqueValue } from "./common";

// Continuation marks: an immutable list, newest first, of (key, value) entries tagged with the logical frame they belong
// to. A frame's own entries are always at the front, since deeper frames' entries are dropped when they return.
export class MarkEntry {
    constructor(readonly key: any, readonly value: any, readonly frame: number, readonly next: MarkEntry | null) {}
}

export type Marks = MarkEntry | null;

// sets `key` on frame `frame` (the current, innermost frame), replacing that frame's previous value for it
export const markSet = (marks: Marks, frame: number, key: any, value: any): Marks => {
    let own: MarkEntry[] | null = null;
    for (let e = marks; e !== null && e.frame === frame; e = e.next) {
        if (e.key === key) {
            // rebuild the entries of this frame in front of the replaced one
            let rest = e.next;
            for (let i = own === null ? -1 : own.length - 1; i >= 0; i--) rest = new MarkEntry(own![i].key, own![i].value, frame, rest);
            return new MarkEntry(key, value, frame, rest);
        }
        (own ??= []).push(e);
    }
    return new MarkEntry(key, value, frame, marks);
};

// the value for `key` in frame `frame` only, or `none`
export const markOwn = (marks: Marks, frame: number, key: any, none: any): any => {
    for (let e = marks; e !== null && e.frame === frame; e = e.next) {
        if (e.key === key) return e.value;
    }
    return none;
};

// the value of `key` in the innermost frame that has one, or `none`
export const markFirst = (marks: Marks, key: any, none: any): any => {
    for (let e = marks; e !== null; e = e.next) {
        if (e.key === key) return e.value;
    }
    return none;
};

// the values of `key`, one per frame, innermost first
export const markValues = (marks: Marks, key: any): any[] => {
    const out: any[] = [];
    for (let e = marks; e !== null; e = e.next) {
        if (e.key === key) out.push(e.value);
    }
    return out;
};

// the marks of a continuation, as a Scheme value
export class ContinuationMarkSet extends OpaqueValue {
    constructor(readonly marks: Marks) {
        super();
    }

    get typeName() {
        return "continuation-mark-set";
    }
}

// Debug code records tail calls in a mark on the frame they replace: a short list of callees, oldest first, with
// repeats collapsed. It travels with the frame, so continuations and coroutines keep it.
export const TAIL_TRAIL = Symbol("tail calls");
const TAIL_TRAIL_SIZE = 16;
export type TailTrail = readonly { name: string, count: number }[];

export const recordTailMark = (marks: Marks, frame: number, name: string): Marks => {
    const trail: TailTrail = markOwn(marks, frame, TAIL_TRAIL, []);
    const last = trail[trail.length - 1];
    const next = last !== undefined && last.name === name
        ? [...trail.slice(0, -1), { name, count: last.count + 1 }]
        : [...trail, { name, count: 1 }].slice(-TAIL_TRAIL_SIZE);
    return markSet(marks, frame, TAIL_TRAIL, next);
};
