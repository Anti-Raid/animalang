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
import { Lsrc, malformed, mapExprs } from "./lang";

const MIN_CHAIN = 200;

// (a %let of several binds them at once, which a %let* would not do)
const isLink = (e: any): e is any[] => {
    if (!Array.isArray(e) || (e[0] !== CORE_LET_STAR && e[0] !== CORE_LET && e[0] !== CORE_LETREC) || malformed(Lsrc, e) !== null) return false;
    if (e[0] === CORE_LET_STAR) return true;
    return e[2].length === 1 && (e[0] === CORE_LET || isLambda(e[2][0][1]));
};

export const flattenLets = (ast: any): any => {
    const walk = (e: any): any => {
        // (a form that is not laid out as it should be is left for the compiler to refuse)
        if (!Array.isArray(e) || malformed(Lsrc, e) !== null) return e;
        if (!isLink(e)) return mapExprs(Lsrc, e, walk);
        const links: any[][] = [];
        for (let link: any = e; isLink(link); link = link[link.length - 1]) {
            links.push(link);
            if (link.length <= 3) break;
        }
        if (links.length <= MIN_CHAIN) return mapExprs(Lsrc, e, walk);
        const bindings: [symbol, any][] = [];
        const last = links[links.length - 1];
        for (const link of links) {
            for (const [name, init] of link[2]) bindings.push([name, link[0] === CORE_LETREC ? [CORE_LETREC, link[1], [[name, walk(init)]], name] : walk(init)]);
            if (link !== last) for (const form of link.slice(3, -1)) bindings.push([Symbol("_"), walk(form)]);
        }
        return [CORE_LET_STAR, e[1], bindings, ...last.slice(3).map(walk)];
    };
    return walk(ast);
};
