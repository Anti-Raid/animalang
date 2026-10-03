// The transformer's output (core forms as Scheme lists) as the compiler's input: core forms as arrays (see
// magicvm/README.md). Quoted data stays Scheme data; a vector literal, being an array, is quoted
import { CORE_BLOCK, CORE_CALL, CORE_ESCAPE, CORE_INTAPPLY, CORE_INTCALL, CORE_LAMBDA, CORE_LET, CORE_LET_STAR, CORE_LET_VALUES, CORE_LET_VALUES_STRICT, CORE_LETREC, CORE_QUOTE, CORE_SET, OP_DEFINE_GLOBAL, SOURCE_POS } from "../common";
import { isCoreForm } from "../magicvm/core";
import type { Intrinsics } from "../magicvm/intrinsics";
import { Cons } from "./list";
import { OP_CASE_LAMBDA } from "./symbols";
import { ASTStringifier } from "./printer";

const toArr = (x: any): any[] => x instanceof Cons ? x.toArray() : [];

// a formals list ((a b . rest), (a b), rest) as [params, rest]
const formals = (f: any): [symbol[], symbol | null] => {
    const params: symbol[] = [];
    let p = f;
    for (; p instanceof Cons; p = p.cdr) params.push(p.car);
    if (p !== null && typeof p !== "symbol") throw new Error(`bad formals: ${new ASTStringifier().stringify(f)}`);
    return [params, p];
};

const OP_APPLY = Symbol.for("%apply");

// quoted data in core text as Scheme's: a list read there is a list
export const schemeDatum = (x: any): any => Array.isArray(x) ? Cons.fromArray(x.map(schemeDatum)) : x;

export const toCore = (e: any, intrinsics: Intrinsics): any => {
    const toCore_ = (x: any) => toCore(x, intrinsics);
    const isIntrinsic = (x: any) => typeof x === "symbol" && !isCoreForm(x) && intrinsics.get(x) !== undefined;
    if (Array.isArray(e)) return [CORE_QUOTE, e];
    if (!(e instanceof Cons)) return e;
    if (e.isImproper()) throw new Error(`bad syntax: illegal use of dotted pair in execution context (consider quoting e.g. '${new ASTStringifier().stringify(e)}')`);
    const items = e.toArray();
    const body = (from: number) => items.slice(from).map(toCore_);
    let out: any[];
    switch (items[0]) {
        case CORE_QUOTE:
            out = items;
            break;
        case CORE_LAMBDA: {
            if (items[1] !== null && typeof items[1] !== "symbol" && !(items[1] instanceof Cons)) {
                throw new Error("lambda arguments must be a symbol (to bind all as a list to said symbol) or a list");
            }
            out = [CORE_LAMBDA, [[], ...formals(items[1]), ...body(2)]];
            break;
        }
        // one %lambda of the clauses of each
        case OP_CASE_LAMBDA: {
            const clauses = items.slice(1).map(c => {
                if (!(c instanceof Cons) || c.car !== CORE_LAMBDA) throw new Error("%case-lambda clauses must be %lambda forms");
                return toCore_(c)[1];
            });
            if (clauses.length === 0) throw new Error("case-lambda needs a clause");
            out = [CORE_LAMBDA, ...clauses];
            break;
        }
        case CORE_LET:
        case CORE_LET_STAR:
        case CORE_LETREC:
            out = [items[0], toArr(items[1]).map(b => {
                const s = SOURCE_POS.get(b);
                const binding = [b.car, toCore_(b.cdr.car)];
                if (s !== undefined) SOURCE_POS.set(binding, s);
                return binding;
            }), ...body(2)];
            break;
        case CORE_LET_VALUES:
        case CORE_LET_VALUES_STRICT:
            out = [items[0], toArr(items[1]).map(c => [...formals(c.car), toCore_(c.cdr.car)]), ...body(2)];
            break;
        case CORE_SET:
        case OP_DEFINE_GLOBAL:
        case CORE_BLOCK:
        case CORE_ESCAPE:
            out = [items[0], items[1], ...body(2)];
            break;
        case OP_APPLY:
            out = isIntrinsic(items[1]) ? [CORE_INTAPPLY, items[1], ...body(2)] : [OP_APPLY, ...body(1)];
            break;
        default:
            if (typeof items[0] === "symbol" && isCoreForm(items[0])) out = [items[0], ...body(1)];
            else if (isIntrinsic(items[0])) out = [CORE_INTCALL, items[0], ...body(1)];
            else out = [CORE_CALL, ...body(0)];
    }
    const pos = SOURCE_POS.get(e);
    if (pos !== undefined) SOURCE_POS.set(out, pos);
    return out;
};
