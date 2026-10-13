// Flattening long chains of nested binding forms, the first pass. A front end that binds each local around the rest
// of its block (as Luau's does) gives a function with a thousand locals a thousand forms, one inside the last form of
// the other, and the passes after this one would go as deep, which the js stack does not allow. A chain of more than
// MIN_CHAIN links, each the last form of the one before, is made one %let*. A link is a %let of one binding, a %let*,
// or a %letrec of one lambda. The %let*'s bindings are the links' in order, the forms a link has before the next one
// bound to names nothing uses; a %letrec's procedure is bound to (%letrec ((f lambda)) f), where it still sees itself.
// A %let* evaluates its inits in order and binds each name for what follows, as the chain did, and the passes handle a
// long one without going deep. Shorter chains are left as they are: no function a person writes is touched (Luau
// allows a function 200 locals)
import { CORE_LET, CORE_LET_STAR, CORE_LETREC } from "../../common";
import { isLambda } from "../lambda";
import { DESCEND, Visitor } from "../visitor";
import { Lsrc, malformed, rebuilt, subExprs } from "./lang";

const MIN_CHAIN = 200;

// (a %let of several binds them at once, which a %let* would not do)
const isLink = (e: any): e is any[] => {
    if (!Array.isArray(e) || (e[0] !== CORE_LET_STAR && e[0] !== CORE_LET && e[0] !== CORE_LETREC) || malformed(Lsrc, e) !== null) return false;
    if (e[0] === CORE_LET_STAR) return true;
    return e[2].length === 1 && (e[0] === CORE_LET || isLambda(e[2][0][1]));
};

// the links of the chain `e` starts
const chainOf = (e: any[]): any[][] => {
    const links: any[][] = [];
    for (let link: any = e; isLink(link); link = link[link.length - 1]) {
        links.push(link);
        if (link.length <= 3) break;
    }
    return links;
};

export const flattenLets = (ast: any): any => new Visitor<undefined, any>(
    // (a form that is not laid out as it should be is left for the compiler to refuse)
    e => !Array.isArray(e) || malformed(Lsrc, e) !== null ? e : DESCEND,
    f => {
        const links = isLink(f.e) ? chainOf(f.e) : [];
        if (links.length <= MIN_CHAIN) {
            f.kids = subExprs(Lsrc, f.e);
            return;
        }
        const kids: any[] = [], last = links[links.length - 1];
        for (const link of links) {
            for (const b of link[2]) kids.push(b[1]);
            if (link !== last) for (let i = 3; i < link.length - 1; i++) kids.push(link[i]);
        }
        for (let i = 3; i < last.length; i++) kids.push(last[i]);
        f.kids = kids;
        f.state = links;
    },
    f => {
        const links: any[][] | undefined = f.state, out = f.out;
        if (links === undefined) return rebuilt(Lsrc, f);
        const bindings: [symbol, any][] = [], last = links[links.length - 1];
        let at = 0;
        for (const link of links) {
            for (const [name] of link[2]) bindings.push([name, link[0] === CORE_LETREC ? [CORE_LETREC, link[1], [[name, out[at++]]], name] : out[at++]]);
            if (link !== last) for (let i = 3; i < link.length - 1; i++) bindings.push([Symbol("_"), out[at++]]);
        }
        return [CORE_LET_STAR, f.e[1], bindings, ...out.slice(at)];
    },
).visit(ast, undefined);
