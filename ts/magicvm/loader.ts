// Standalone Loader for MagicVM pre-compiled execution units (.animau)
import { closureArity, type RestKind } from "./arity";
import { MultipleValues, markQuoted } from "../common";
import type { Env } from "../env";
import {
    Closure,
    ClosureTemplate,
    Code,
    newCallCache,
    type CallCache,
    type DirectFn,
    type ResumeFn,
    type UpVarLoc,
    type UsedIntrinsic,
} from "./code";
import type { Intrinsics } from "./intrinsics";
import { JIT_DEPS } from "./jit-deps";
import type {
    AnimaExecutionUnit,
    UnitArity,
    UnitConstant,
    UnitIntrinsic,
    UnitMeta,
    UnitSites,
    UnitSources,
} from "./unit-types";

export type DatumDeserializer = (data: any, recurse: (c: UnitConstant) => any) => any;
export const DATUM_DESERIALIZERS = new Map<string, DatumDeserializer>();

export const registerDatumDeserializer = (
    type: string,
    deserialize: DatumDeserializer
): void => {
    DATUM_DESERIALIZERS.set(type, deserialize);
};

export const deserializeConstant = (
    c: UnitConstant,
    templates: ClosureTemplate[],
    // the symbols made so far for the unit's own (see UnitConstant's `u`)
    uniques: symbol[] = []
): any => {
    switch (c.k) {
        case "lit":
            return c.v;
        case "undef":
            return undefined;
        case "negzero":
            return -0;
        case "nan":
            return NaN;
        case "inf":
            return Infinity;
        case "-inf":
            return -Infinity;
        case "bigint":
            return BigInt(c.v);
        case "sym":
            return c.u === undefined ? Symbol.for(c.v) : (uniques[c.u] ??= Symbol(c.v));
        case "tmpl":
            return templates[c.id];
        case "clo":
            return Closure.fromTemplate(templates[c.tmpl], c.name);
        case "values":
            return new MultipleValues(c.v.map(item => deserializeConstant(item, templates, uniques)));
        case "datum": {
            const deserializer = DATUM_DESERIALIZERS.get(c.type);
            if (!deserializer) {
                throw new Error(`Unknown datum constant type: '${c.type}'`);
            }
            const datum = deserializer(c.data, child => deserializeConstant(child, templates, uniques));
            if (c.q) markQuoted(datum);
            return datum;
        }
        case "arr": {
            const array = c.v.map(item => deserializeConstant(item, templates, uniques));
            if (c.q) markQuoted(array);
            return array;
        }
        default:
            return (c as any).v;
    }
};

type UnitCacheData = {
    constants: any[];
    globalCache: Record<number, { scope: Env | null; version: number; value: any }>;
    callCache: Record<number, CallCache>;
    siteCache: Record<number, object>;
};

export class UnitLoader {
    // Optional fallback compiler (AotCompiler) if intrinsic positions moved
    public static fallbackCompiler?: {
        compileAll: (code: Code, tmpl?: ClosureTemplate) => void;
    };

    public static load(
        input: string | AnimaExecutionUnit,
        table: Intrinsics
    ): { code: Code; meta: UnitMeta; template: ClosureTemplate } {
        const unit: AnimaExecutionUnit =
            typeof input === "string" ? JSON.parse(input) : input;

        // 1. Strict metadata check
        if (!unit.id || !unit.version || !unit.scriptname) {
            throw new Error("Invalid execution unit: missing id, version, or scriptname");
        }
        const meta: UnitMeta = {
            id: unit.id,
            version: unit.version,
            scriptname: unit.scriptname,
        };

        // 2. Validate each code's intrinsics against the host table. They are kept as the unit recorded them: Code.bind
        //    then moves the instructions' positions to the table's, by name
        let needsRecompile = false;
        const hostPositions = new Set<number>();
        const usedOf = (list: UnitIntrinsic[] | undefined): UsedIntrinsic[] => (list ?? []).map(used => {
            const entry = table.byName(used.name);
            if (entry === undefined) {
                throw new Error(
                    `Unit '${unit.id}' uses intrinsic '${used.name}', which is not registered in the host table`
                );
            }
            if (entry.leaf !== used.leaf) {
                throw new Error(
                    `Unit '${unit.id}' was compiled with '${used.name}' as ${used.leaf ? "a leaf" : "not a leaf"}, but host registered it as ${entry.leaf ? "a leaf" : "not a leaf"}`
                );
            }
            if (used.pos !== undefined && entry.pos !== used.pos) needsRecompile = true;
            hostPositions.add(entry.pos);
            return { pos: used.pos ?? entry.pos, name: used.name, leaf: used.leaf };
        });
        const codeOf = (def: { ops?: Code["ops"]; numRegs: number; intrinsics: UnitIntrinsic[]; restPos?: number; inlines?: Code["inlines"] }): Code => {
            const code = new Code([], def.ops ?? [], def.numRegs, unit.debug ?? false, null, usedOf(def.intrinsics));
            code.interrupts = unit.interrupts ?? false;
            code.reentrant = unit.reentrant ?? true;
            code.restPos = def.restPos ?? -1;
            code.inlines = def.inlines ?? [];
            code.bind(table);
            return code;
        };

        // 3. Reconstruct child template skeletons (templates 0..N-1)
        const numTemplates = unit.templates?.length ?? 0;
        const templateSkeletons: { tmpl: ClosureTemplate; code: Code }[] = [];
        for (let i = 0; i < numTemplates; i++) {
            const tDef = unit.templates[i];
            const tCode = codeOf(tDef);

            const tRest: RestKind = tDef.arity.rest === null ? "none" : tDef.arity.rest;
            const tParams = (tDef.params ?? []).map(p => Symbol.for(p));
            const tRemParams = tDef.remParams ? Symbol.for(tDef.remParams) : null;
            const tUpvars: UpVarLoc[] = (tDef.upvars ?? []).map(u => ({
                index: u.index,
                local: u.local,
            }));
            const tmpl = new ClosureTemplate(
                tParams,
                tRemParams,
                tCode,
                tUpvars,
                tDef.name ?? null,
                tRest === "none" ? "array" : tRest,
                tDef.arity.pad
            );
            templateSkeletons.push({ tmpl, code: tCode });
        }
        const templates = templateSkeletons.map(s => s.tmpl);

        // 4. Reconstruct root Code and ClosureTemplate
        const rootCode = codeOf(unit);

        const rootRest: RestKind = unit.arity.rest === null ? "none" : unit.arity.rest;
        const rootParams = (unit.params ?? []).map(p => Symbol.for(p));
        const rootRemParams = unit.remParams ? Symbol.for(unit.remParams) : null;
        const rootUpvars: UpVarLoc[] = (unit.upvars ?? []).map(u => ({
            index: u.index,
            local: u.local,
        }));
        const rootTemplate = new ClosureTemplate(
            rootParams,
            rootRemParams,
            rootCode,
            rootUpvars,
            unit.name ?? meta.scriptname,
            rootRest === "none" ? "array" : rootRest,
            unit.arity.pad
        );

        // 5. Populate constants for root and all templates
        const uniques: symbol[] = [];
        rootCode.constants = unit.constants.map(c => deserializeConstant(c, templates, uniques));
        for (let i = 0; i < numTemplates; i++) {
            const tDef = unit.templates[i];
            templateSkeletons[i].code.constants = tDef.constants.map(c =>
                deserializeConstant(c, templates, uniques)
            );
        }

        // 6. Fast Single-Batch Hydration
        if (!needsRecompile && unit.sources) {
            const makeCacheData = (constants: any[], sites: UnitSites): UnitCacheData => {
                const globalCache: Record<number, { scope: Env | null; version: number; value: any }> = {};
                for (const ip of sites.globals) globalCache[ip] = { scope: null, version: -1, value: undefined };
                const callCache: Record<number, CallCache> = {};
                for (const ip of sites.calls) callCache[ip] = newCallCache();
                const siteCache: Record<number, object> = {};
                for (const { ip, pos } of sites.intrinsics ?? []) {
                    siteCache[ip] = table.entries[pos]?.site?.() ?? {};
                }
                return { constants, globalCache, callCache, siteCache };
            };

            const unitsData: UnitCacheData[] = [
                makeCacheData(rootCode.constants, unit.sites),
                ...templateSkeletons.map((s, i) =>
                    makeCacheData(s.code.constants, unit.templates[i].sites)
                ),
            ];

            // Common intrinsic locals & dependencies across all sub-units (every code's intrinsics, not the root's alone)
            const allIntrinsicPositions = hostPositions;
            const allDeps = new Set<string>();
            for (const d of unit.usedDeps ?? []) allDeps.add(d);
            for (const t of unit.templates ?? []) {
                for (const d of t.usedDeps ?? []) allDeps.add(d);
            }

            const header = [
                ...[...allIntrinsicPositions].map(pos => `const I${pos} = RT[${pos}];`),
                ...[...allDeps].map(d => `const ${d} = DEPS[${d.slice(1)}];`),
            ].join("\n");

            const emitSubUnit = (idx: number, sites: UnitSites, sources: UnitSources) => {
                const gcBinds = sites.globals.map(ip => `const GC${ip} = GLOBAL_CACHE[${ip}];`).join("\n");
                const ccBinds = sites.calls.map(ip => `const CC${ip} = CALL_CACHE[${ip}];`).join("\n");
                const scBinds = (sites.intrinsics ?? []).map(({ ip }) => `const SC${ip} = SITE_CACHE[${ip}];`).join("\n");
                return `(function(CONSTANTS, GLOBAL_CACHE, CALL_CACHE, SITE_CACHE) {
                    ${gcBinds}
                    ${ccBinds}
                    ${scBinds}
                    return {
                        resume: ${sources.resume},
                        direct: ${sources.direct ?? "null"}
                    };
                })(UNITS[${idx}].constants, UNITS[${idx}].globalCache, UNITS[${idx}].callCache, UNITS[${idx}].siteCache)`;
            };

            const subUnits = [
                emitSubUnit(0, unit.sites, unit.sources),
                ...unit.templates.map((t, i) => emitSubUnit(i + 1, t.sites, t.sources)),
            ];

            const factoryBody = `${header}\nreturn [\n${subUnits.join(",\n")}\n];`;
            const factory = new Function(
                ...Object.keys(JIT_DEPS),
                "RT",
                "DEPS",
                "UNITS",
                factoryBody
            );

            const compiledUnits = factory(
                ...Object.values(JIT_DEPS),
                table.fns ?? [],
                table.deps ?? [],
                unitsData
            ) as { resume: ResumeFn; direct: DirectFn | null }[];

            // Assign compiled functions to root
            rootCode.resumeFn = compiledUnits[0].resume;
            rootCode.directFn = compiledUnits[0].direct;
            rootCode.arity = rootTemplate.arity;
            rootCode.direct = compiledUnits[0].direct !== null;

            // Assign compiled functions to child templates
            for (let i = 0; i < numTemplates; i++) {
                const s = templateSkeletons[i];
                s.code.resumeFn = compiledUnits[i + 1].resume;
                s.code.directFn = compiledUnits[i + 1].direct;
                s.code.arity = s.tmpl.arity;
                s.code.direct = compiledUnits[i + 1].direct !== null;
            }
        } else {
            // Fallback compilation if intrinsic positions differed or sources missing: from the instructions, which
            // Code.bind has moved to the host table's positions
            if (UnitLoader.fallbackCompiler) {
                UnitLoader.fallbackCompiler.compileAll(rootCode, rootTemplate);
            } else {
                throw new Error(
                    `Unit '${unit.id}' requires recompilation due to changed intrinsic layout, but no compiler is registered.`
                );
            }
        }

        return {
            code: rootCode,
            meta,
            template: rootTemplate,
        };
    }
}
