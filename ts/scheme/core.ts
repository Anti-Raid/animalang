// The transformer's output (core forms as Scheme lists) as the compiler's input: core forms as arrays (see
// bytecode-rvm/README.md). Quoted data stays Scheme data; a vector literal, being an array, is quoted
import { ASTStringifier, CORE_BLOCK, CORE_ESCAPE, CORE_LAMBDA, CORE_LET, CORE_LET_STAR, CORE_LET_VALUES, CORE_LET_VALUES_STRICT, CORE_LETREC, CORE_QUOTE, CORE_SET, OP_DEFINE_GLOBAL, SOURCE_POS } from "../common";
import { Cons } from "./list";

const toArr = (x: any): any[] => x instanceof Cons ? x.toArray() : [];

// a formals list ((a b . rest), (a b), rest) as [params, rest]
const formals = (f: any): [symbol[], symbol | null] => {
    const params: symbol[] = [];
    let p = f;
    for (; p instanceof Cons; p = p.cdr) params.push(p.car);
    if (p !== null && typeof p !== "symbol") throw new Error(`bad formals: ${new ASTStringifier().stringify(f)}`);
    return [params, p];
};

export const toCore = (e: any): any => {
    if (Array.isArray(e)) return [CORE_QUOTE, e];
    if (!(e instanceof Cons)) return e;
    if (e.isImproper()) throw new Error(`bad syntax: illegal use of dotted pair in execution context (consider quoting e.g. '${new ASTStringifier().stringify(e)}')`);
    const items = e.toArray();
    const body = (from: number) => items.slice(from).map(toCore);
    let out: any[];
    switch (items[0]) {
        case CORE_QUOTE:
            out = items;
            break;
        case CORE_LAMBDA: {
            if (items[1] !== null && typeof items[1] !== "symbol" && !(items[1] instanceof Cons)) {
                throw new Error("lambda arguments must be a symbol (to bind all as a list to said symbol) or a list");
            }
            out = [CORE_LAMBDA, ...formals(items[1]), ...body(2)];
            break;
        }
        case CORE_LET:
        case CORE_LET_STAR:
        case CORE_LETREC:
            out = [items[0], toArr(items[1]).map(b => {
                const s = SOURCE_POS.get(b);
                const binding = [b.car, toCore(b.cdr.car)];
                if (s !== undefined) SOURCE_POS.set(binding, s);
                return binding;
            }), ...body(2)];
            break;
        case CORE_LET_VALUES:
        case CORE_LET_VALUES_STRICT:
            out = [items[0], toArr(items[1]).map(c => [...formals(c.car), toCore(c.cdr.car)]), ...body(2)];
            break;
        case CORE_SET:
        case OP_DEFINE_GLOBAL:
        case CORE_BLOCK:
        case CORE_ESCAPE:
            out = [items[0], items[1], ...body(2)];
            break;
        default:
            out = items.map(toCore);
    }
    const pos = SOURCE_POS.get(e);
    if (pos !== undefined) SOURCE_POS.set(out, pos);
    return out;
};
