// Types for the standalone Anima/MagicVM pre-compiled execution unit JSON format (.animau)
import type { InlineSite, UpVarLoc } from "./code";
import type { Op } from "./ops";

export type UnitMeta = {
    id: string;
    version: string;
    scriptname: string;
};

export type UnitArity = {
    params: number;
    rest: null | "array" | "packed";
    pad: boolean;
};

export type UnitConstant =
    | { k: "lit"; v: string | number | boolean | null }
    | { k: "nan" }
    | { k: "inf" }
    | { k: "-inf" }
    | { k: "negzero" }
    | { k: "undef" }
    | { k: "bigint"; v: string }
    // `u`: a symbol that is not of the global registry, by its number among the unit's: every place the unit holds it
    // gets one new symbol when the unit is loaded
    | { k: "sym"; v: string; u?: number }
    | { k: "tmpl"; id: number }
    | { k: "clo"; tmpl: number; name?: string }
    | { k: "values"; v: UnitConstant[] }
    // the unit's imports (code.ts, Imports): one object for the unit, made when it is loaded
    | { k: "imports"; n: number }
    // `q`: a constant the program quoted (see isQuotedConstant), marked again when loaded
    // `id`: the object's number among the unit's constants, by which { k: "same" } is that very object again (a
    // constant several of the unit's functions hold)
    | { k: "arr"; v: UnitConstant[]; q?: boolean; id?: number }
    | { k: "datum"; type: string; data: any; q?: boolean; id?: number }
    | { k: "same"; id: number };

export type UnitSites = {
    calls: number[];
    globals: number[];
    intrinsics?: { ip: number; pos: number }[];
};

export type UnitSources = {
    direct: string | null;
    resume: string;
};

export type UnitIntrinsic = {
    name: string;
    leaf: boolean;
    pos?: number;
};

export type UnitTemplate = {
    id: number;
    name: string | null;
    arity: UnitArity;
    numRegs: number;
    // its own code's, as the root's are the root code's
    restPos?: number;
    inlines?: InlineSite[];
    intrinsics: UnitIntrinsic[];
    upvars: UpVarLoc[];
    params?: string[];
    remParams?: string | null;
    sites: UnitSites;
    usedDeps: string[];
    constants: UnitConstant[];
    ops?: Op[];
    sources: UnitSources;
};

export type AnimaExecutionUnit = UnitMeta & {
    arity: UnitArity;
    numRegs: number;
    debug?: boolean;
    reentrant?: boolean;
    interrupts?: boolean;
    restPos?: number;
    inlines?: InlineSite[];
    intrinsics: UnitIntrinsic[];
    sites: UnitSites;
    usedDeps: string[];
    constants: UnitConstant[];
    templates: UnitTemplate[];
    ops?: Op[];
    sources: UnitSources;
    name?: string | null;
    params?: string[];
    remParams?: string | null;
    upvars?: UpVarLoc[];
};
