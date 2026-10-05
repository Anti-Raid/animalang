// The sizes Luau's compiler gives an empty table constructor from how the local it is bound to is assigned afterwards
// (Compiler/src/TableShape.cpp): a hash slot per field name, an array slot per t[1], t[2], ... in order, and the bound
// of a `for i = 1, k` (k up to 16) whose body assigns t[i]. A table's sizes decide when it grows, and so `#t` of a
// table with holes
import { L, isForm } from "./syntax/ast";
import type * as C from "./syntax/ast";

export type Shape = { array: number, hash: number };

const MAX_LOOP_BOUND = 16;

// a table literal, or setmetatable(a table literal, ...)
const tableHint = (e: C.Expr): C.Table | null => {
    if (!isForm(e)) return null;
    if (e[0] === L.TABLE) return e as C.Table;
    if (e[0] !== L.CALL || e.length !== 5) return null;
    const [, f, first] = e as C.Call;
    return isForm(f) && f[0] === L.GLOBAL && f[1] === "setmetatable" && isForm(first) && first[0] === L.TABLE ? first as C.Table : null;
};

export const predictShapes = (root: C.Block): Map<C.Table, Shape> => {
    const shapes = new Map<C.Table, Shape>();
    const tables = new Map<symbol, C.Table>();
    const fields = new Map<C.Table, Set<string>>();
    const loops = new Map<symbol, number>();
    const shapeOf = (table: C.Table): Shape => {
        let shape = shapes.get(table);
        if (shape === undefined) shapes.set(table, shape = { array: 0, hash: 0 });
        return shape;
    };
    const assign = (target: C.Expr): void => {
        if (!isForm(target) || target[0] !== L.INDEX) return;
        const [, obj, key] = target as C.Index;
        const table = typeof obj === "symbol" ? tables.get(obj) : undefined;
        if (table === undefined) return;
        if (typeof key === "string") {
            let names = fields.get(table);
            if (names === undefined) fields.set(table, names = new Set());
            if (!names.has(key)) {
                names.add(key);
                shapeOf(table).hash += 1;
            }
        } else if (typeof key === "number") {
            const shape = shapeOf(table);
            if (key === shape.array + 1) shape.array += 1;
        } else if (typeof key === "symbol") {
            const bound = loops.get(key);
            if (bound !== undefined && shapeOf(table).array === 0) shapeOf(table).array = bound;
        }
    };
    const visit = (e: unknown): void => {
        if (!Array.isArray(e)) return;
        if (!isForm(e)) {
            for (const x of e) visit(x);
            return;
        }
        switch (e[0]) {
            case L.LOCAL: {
                const [, names, values] = e as C.LocalStat;
                const table = names.length === 1 && values.length === 1 ? tableHint(values[0]) : null;
                if (table !== null && table.length === 2) tables.set(names[0], table);
                break;
            }
            case L.ASSIGN: {
                const [, targets, values] = e as C.Assign;
                for (const target of targets) assign(target);
                visit(values);
                return;
            }
            case L.FOR: {
                const [, name, from, to, step] = e as C.For;
                if (from === 1 && typeof to === "number" && to >= 1 && to <= MAX_LOOP_BOUND && step === null) loops.set(name, Math.trunc(to));
                break;
            }
        }
        for (let i = 1; i < e.length - 1; i++) visit(e[i]);
    };
    visit(root);
    return shapes;
};
