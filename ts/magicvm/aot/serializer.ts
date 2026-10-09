// Serializer for MagicVM pre-compiled execution units (.animau)
import { MultipleValues, isQuotedConstant } from "../../common";
import { Closure, ClosureTemplate, type Code } from "../code";
import type {
    AnimaExecutionUnit,
    UnitArity,
    UnitConstant,
    UnitMeta,
    UnitTemplate,
} from "../unit-types";
import { AotCompiler } from "./compiler";

export type DatumSerializer = (val: any, recurse: (c: any) => UnitConstant) => any;
export const DATUM_SERIALIZERS = new Map<string, { test: (v: any) => boolean; serialize: DatumSerializer }>();

export const registerDatumSerializer = (
    type: string,
    test: (v: any) => boolean,
    serialize: DatumSerializer
): void => {
    DATUM_SERIALIZERS.set(type, { test, serialize });
};

export const serializeConstant = (
    c: any,
    templateMap: Map<ClosureTemplate, number>,
    // the unit's symbols that are not of the global registry, numbered as they are met
    uniques: Map<symbol, number> = new Map()
): UnitConstant => {
    if (typeof c === "boolean" || typeof c === "string") {
        return { k: "lit", v: c };
    }
    if (typeof c === "number") {
        if (Object.is(c, -0)) return { k: "negzero" };
        if (Number.isNaN(c)) return { k: "nan" };
        if (c === Infinity) return { k: "inf" };
        if (c === -Infinity) return { k: "-inf" };
        return { k: "lit", v: c };
    }
    if (c === null) {
        return { k: "lit", v: null };
    }
    if (c === undefined) {
        return { k: "undef" };
    }
    if (typeof c === "bigint") {
        return { k: "bigint", v: c.toString() };
    }
    if (typeof c === "symbol") {
        const key = Symbol.keyFor(c);
        if (key !== undefined) return { k: "sym", v: key };
        let u = uniques.get(c);
        if (u === undefined) uniques.set(c, u = uniques.size);
        return { k: "sym", v: c.description ?? "", u };
    }
    if (c instanceof ClosureTemplate) {
        const id = templateMap.get(c);
        if (id === undefined) {
            throw new Error(`Unregistered closure template in constant pool: ${c.name ?? "anonymous"}`);
        }
        return { k: "tmpl", id };
    }
    if (c instanceof Closure) {
        const id = templateMap.get(c.tmpl);
        if (id === undefined) {
            throw new Error(`Unregistered closure in constant pool: ${c.debugName}`);
        }
        return { k: "clo", tmpl: id, name: c.debugName };
    }
    if (c instanceof MultipleValues) {
        return { k: "values", v: c.values.map(item => serializeConstant(item, templateMap, uniques)) };
    }
    for (const [type, entry] of DATUM_SERIALIZERS) {
        if (entry.test(c)) {
            return {
                k: "datum",
                type,
                data: entry.serialize(c, x => serializeConstant(x, templateMap, uniques)),
                ...(isQuotedConstant(c) ? { q: true } : {}),
            };
        }
    }
    if (Array.isArray(c)) {
        return {
            k: "arr",
            v: c.map(item => serializeConstant(item, templateMap, uniques)),
            ...(isQuotedConstant(c) ? { q: true } : {}),
        };
    }
    // (written as plain JSON it would come back without its class)
    throw new Error(`Cannot serialize a constant of class ${c?.constructor?.name ?? typeof c}: no datum serializer is registered for it`);
};

export class UnitSerializer {
    public static serialize(code: Code, meta: UnitMeta, tmpl?: ClosureTemplate): string {
        return JSON.stringify(this.serializeUnit(code, meta, tmpl), null, 2);
    }

    public static serializeUnit(
        code: Code,
        meta: UnitMeta,
        tmpl?: ClosureTemplate
    ): AnimaExecutionUnit {
        if (!meta.id || !meta.version || !meta.scriptname) {
            throw new Error("Unit metadata must contain id, version, and scriptname");
        }

        const effectiveTmpl =
            tmpl ??
            new ClosureTemplate(
                [],
                null,
                code,
                [],
                meta.scriptname,
                code.arity && code.arity.rest !== "none" ? code.arity.rest : "array",
                code.arity ? code.arity.pad : false
            );

        // 1. Compile all procedures recursively
        AotCompiler.compileAll(code, effectiveTmpl);

        // 2. Discover and assign IDs to all closure templates
        const templates: ClosureTemplate[] = [];
        const templateMap = new Map<ClosureTemplate, number>();
        const uniques = new Map<symbol, number>();

        const scan = (c: any) => {
            if (c instanceof ClosureTemplate) {
                if (!templateMap.has(c)) {
                    const id = templates.length;
                    templateMap.set(c, id);
                    templates.push(c);
                    for (const nested of c.code.constants) scan(nested);
                }
            } else if (c instanceof Closure) {
                scan(c.tmpl);
            } else if (Array.isArray(c)) {
                for (const item of c) scan(item);
            } else if (typeof c === "object" && c !== null) {
                for (const key of Object.keys(c)) scan((c as any)[key]);
            }
        };

        for (const c of code.constants) scan(c);

        // 3. Emit AOT JS sources for root
        const rootEmitted = AotCompiler.emitCodeSources(code, effectiveTmpl);

        // 4. Emit AOT JS sources for each child template
        const serializedTemplates: UnitTemplate[] = templates.map((t, id) => {
            AotCompiler.compileAll(t.code, t);
            const emitted = AotCompiler.emitCodeSources(t.code, t);
            const tmplArity: UnitArity = {
                params: t.arity.params,
                rest: t.arity.rest === "none" ? null : t.arity.rest,
                pad: t.arity.pad,
            };
            return {
                id,
                name: t.name,
                arity: tmplArity,
                numRegs: t.code.numReg,
                restPos: t.code.restPos,
                inlines: [...t.code.inlines],
                intrinsics: t.code.intrinsics.map(i => ({ name: i.name, leaf: i.leaf, pos: i.pos })),
                upvars: t.upvarLocs.map(u => ({ index: u.index, local: u.local })),
                params: t.params.map(p => p.description ?? ""),
                remParams: t.remParams ? (t.remParams.description ?? "") : null,
                sites: {
                    calls: emitted.callSites,
                    globals: emitted.globalLoads,
                    intrinsics: emitted.intrinsicSites,
                },
                usedDeps: emitted.usedDeps,
                constants: t.code.constants.map(c => serializeConstant(c, templateMap, uniques)),
                ops: [...t.code.ops],
                sources: {
                    direct: emitted.directSource,
                    resume: emitted.resumeSource,
                },
            };
        });

        const rootArity: UnitArity = {
            params: effectiveTmpl.arity.params,
            rest: effectiveTmpl.arity.rest === "none" ? null : effectiveTmpl.arity.rest,
            pad: effectiveTmpl.arity.pad,
        };

        return {
            id: meta.id,
            version: meta.version,
            scriptname: meta.scriptname,
            arity: rootArity,
            numRegs: code.numReg,
            debug: code.debug,
            reentrant: code.reentrant,
            interrupts: code.interrupts,
            restPos: code.restPos,
            inlines: [...code.inlines],
            intrinsics: code.intrinsics.map(i => ({ name: i.name, leaf: i.leaf, pos: i.pos })),
            sites: {
                calls: rootEmitted.callSites,
                globals: rootEmitted.globalLoads,
                intrinsics: rootEmitted.intrinsicSites,
            },
            usedDeps: rootEmitted.usedDeps,
            constants: code.constants.map(c => serializeConstant(c, templateMap, uniques)),
            templates: serializedTemplates,
            ops: [...code.ops],
            sources: {
                direct: rootEmitted.directSource,
                resume: rootEmitted.resumeSource,
            },
            name: effectiveTmpl.name,
            params: effectiveTmpl.params.map(p => p.description ?? ""),
            remParams: effectiveTmpl.remParams ? (effectiveTmpl.remParams.description ?? "") : null,
            upvars: effectiveTmpl.upvarLocs.map(u => ({ index: u.index, local: u.local })),
        };
    }
}
