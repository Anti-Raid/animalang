// Luau's os library (VM/src/loslib.cpp), over a function's arguments (an array): clock, time, difftime and date, with
// C's strftime in the C locale written out. The time zone's abbreviation (%Z) is what the host's Intl gives
import { argInvalid, numberArg, stringArg, tableArg, toInt, type Args } from "./args";
import { luauError } from "./errors";
import { str2number } from "./number";
import { LuaTable } from "./table";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const OPTIONS = "aAbBcdHIjmMpSUwWxXyYzZ%";

// C's division of ints, toward zero
const div = (a: number, b: number): number => Math.trunc(a / b);

// what C's struct tm holds, of a time read in UTC or in the host's zone
type Tm = { sec: number, min: number, hour: number, mday: number, mon: number, year: number, wday: number, yday: number, isdst: boolean, offset: number, zone: string };

const tmOf = (t: number, utc: boolean): Tm | null => {
    const d = new Date(t * 1000);
    if (Number.isNaN(d.getTime())) return null;
    if (utc) {
        const start = Date.UTC(d.getUTCFullYear(), 0, 1);
        return {
            sec: d.getUTCSeconds(), min: d.getUTCMinutes(), hour: d.getUTCHours(), mday: d.getUTCDate(), mon: d.getUTCMonth(), year: d.getUTCFullYear(),
            wday: d.getUTCDay(), yday: Math.floor((d.getTime() - start) / 86400000), isdst: false, offset: 0, zone: "UTC",
        };
    }
    const year = d.getFullYear(), offset = -d.getTimezoneOffset();
    const standard = Math.min(-new Date(year, 0, 1).getTimezoneOffset(), -new Date(year, 6, 1).getTimezoneOffset());
    const yday = Math.round((Date.UTC(year, d.getMonth(), d.getDate()) - Date.UTC(year, 0, 1)) / 86400000);
    let zone = "";
    try {
        zone = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(d).find(p => p.type === "timeZoneName")?.value ?? "";
    } catch {
        zone = "";
    }
    return { sec: d.getSeconds(), min: d.getMinutes(), hour: d.getHours(), mday: d.getDate(), mon: d.getMonth(), year, wday: d.getDay(), yday, isdst: offset !== standard, offset, zone };
};

const pad = (n: number, width: number, fill: string = "0"): string => String(n).padStart(width, fill);

const strftime = (c: string, tm: Tm): string => {
    switch (c) {
        case "a": return DAYS[tm.wday].slice(0, 3);
        case "A": return DAYS[tm.wday];
        case "b": return MONTHS[tm.mon].slice(0, 3);
        case "B": return MONTHS[tm.mon];
        case "c": return `${strftime("a", tm)} ${strftime("b", tm)} ${pad(tm.mday, 2, " ")} ${strftime("X", tm)} ${tm.year}`;
        case "d": return pad(tm.mday, 2);
        case "H": return pad(tm.hour, 2);
        case "I": return pad(tm.hour % 12 === 0 ? 12 : tm.hour % 12, 2);
        case "j": return pad(tm.yday + 1, 3);
        case "m": return pad(tm.mon + 1, 2);
        case "M": return pad(tm.min, 2);
        case "p": return tm.hour < 12 ? "AM" : "PM";
        case "S": return pad(tm.sec, 2);
        case "U": return pad(div(tm.yday + 7 - tm.wday, 7), 2);
        case "w": return String(tm.wday);
        case "W": return pad(div(tm.yday + 7 - (tm.wday + 6) % 7, 7), 2);
        case "x": return `${pad(tm.mon + 1, 2)}/${pad(tm.mday, 2)}/${strftime("y", tm)}`;
        case "X": return `${pad(tm.hour, 2)}:${pad(tm.min, 2)}:${pad(tm.sec, 2)}`;
        case "y": return pad(((tm.year % 100) + 100) % 100, 2);
        case "Y": return String(tm.year);
        case "z": return `${tm.offset < 0 ? "-" : "+"}${pad(div(Math.abs(tm.offset), 60), 2)}${pad(Math.abs(tm.offset) % 60, 2)}`;
        case "Z": return tm.zone;
        default: return "%";
    }
};

// getfield: a number (or a string that reads as one) in the date table, as an int
const dateField = (t: LuaTable, key: string, otherwise: number): number => {
    const v = t.rawget(key), n = typeof v === "number" ? v : typeof v === "string" ? str2number(v) : undefined;
    if (n !== undefined) return toInt(n);
    if (otherwise < 0) throw luauError(`field '${key}' missing in date table`);
    return otherwise;
};

// os_timegm: the seconds since 1970 of a date in UTC, or -1 before then
const timegm = (sec: number, min: number, hour: number, mday: number, mon: number, year: number): number => {
    const month = mon + 1, fullYear = year + 1900;
    const a = (mon % 12 < 2 ? 1 : 0) - div(mon, 12);
    const y = fullYear + 4800 - a, m = month + 12 * a - 3;
    const julianday = mday + div(153 * m + 2, 5) + 365 * y + div(y, 4) - div(y, 100) + div(y, 400) - 32045;
    if (julianday < 2440588) return -1;
    const seconds = julianday * 86400 + hour * 3600 + min * 60 + sec;
    return seconds < 2440588 * 86400 ? -1 : seconds - 2440588 * 86400;
};

// C's (time_t) of a number (a NaN is 0, as arm64 makes it)
const timeOf = (d: number): number => d !== d ? 0 : Math.trunc(d);

const started = typeof performance !== "undefined" ? performance.now() : Date.now();

export const OS_LIBRARY: Record<string, (a: Args) => any> = {
    clock: () => ((typeof performance !== "undefined" ? performance.now() : Date.now()) - started) / 1000,
    date: a => {
        let s = a[0] === undefined ? "%c" : stringArg(a, 1, "date");
        const t = a[1] === undefined ? Math.floor(Date.now() / 1000) : timeOf(numberArg(a, 2, "date"));
        const utc = s.charCodeAt(0) === 33;
        if (utc) s = s.slice(1);
        const tm = utc ? tmOf(t, true) : t < 0 ? null : tmOf(t, false);
        if (tm === null) return undefined;
        if (s === "*t") {
            const out = new LuaTable(0, 9);
            out.rawset("sec", tm.sec).rawset("min", tm.min).rawset("hour", tm.hour).rawset("day", tm.mday).rawset("month", tm.mon + 1).rawset("year", tm.year);
            return out.rawset("wday", tm.wday + 1).rawset("yday", tm.yday + 1).rawset("isdst", tm.isdst);
        }
        let out = "";
        for (let i = 0; i < s.length; i++) {
            if (s[i] !== "%" || i + 1 === s.length) out += s[i];
            else if (!OPTIONS.includes(s[i + 1])) throw argInvalid(1, "date", "invalid conversion specifier");
            else out += strftime(s[++i], tm);
        }
        return out;
    },
    difftime: a => timeOf(numberArg(a, 1, "difftime")) - (a[1] === undefined ? 0 : timeOf(numberArg(a, 2, "difftime"))),
    time: a => {
        if (a[0] === undefined) return Math.floor(Date.now() / 1000);
        const t = tableArg(a, 1, "time");
        const sec = dateField(t, "sec", 0), min = dateField(t, "min", 0), hour = dateField(t, "hour", 12);
        const day = dateField(t, "day", -1), month = dateField(t, "month", -1) - 1, year = dateField(t, "year", -1) - 1900;
        const r = timegm(sec, min, hour, day, month, year);
        return r === -1 ? undefined : r;
    },
};
