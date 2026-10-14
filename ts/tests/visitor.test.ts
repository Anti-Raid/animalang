import { describe, expect, it } from 'vitest';
import { DESCEND, Visitor, Worklist, run, type Task } from '../magicvm/visitor';
import { Lsrc, mapTree } from '../magicvm/passes/lang';
import { createScheme } from '../scheme';
import { createLuau, toString } from '../lua';
import { impl } from '../magicvm/meta';
import { UnitSerializer } from '../magicvm/aot/serializer';
import { UnitLoader } from '../magicvm/loader';
import { ASTStringifier } from '../scheme/printer';

// [n, [n - 1, ... [0]]]
const nest = (n: number): any => { let t: any = [0]; for (let i = 1; i <= n; i++) t = [i, t]; return t; };

describe("Worklist", () => {
    it("visits each node before what it adds, in the order added", () => {
        const seen: any[] = [];
        const todo = new Worklist();
        todo.add(["a", ["b", "c"], "d"]);
        todo.run(e => {
            if (Array.isArray(e)) todo.addAll(e);
            else seen.push(e);
        });
        expect(seen).toEqual(["a", "b", "c", "d"]);
    });

    it("calls what `then` was given when the walk gets there, with each node's context", () => {
        const seen: string[] = [];
        const todo = new Worklist<number>();
        todo.add("x", 1);
        todo.then(() => seen.push("between"));
        todo.add("y", 2);
        todo.run((e, depth) => {
            seen.push(`${e}${depth}`);
            if (e === "x") {
                todo.add("inside", depth + 1);
                todo.then(() => seen.push("after inside"));
            }
        });
        expect(seen).toEqual(["x1", "inside2", "after inside", "between", "y2"]);
    });

    it("stops, and walks a tree deeper than the stack", () => {
        let visited = 0;
        const todo = new Worklist();
        todo.addAll([1, 2, 3, 4]);
        todo.run(e => {
            visited++;
            if (e === 2) todo.stop();
        });
        expect(visited).toBe(2);
        let leaves = 0;
        const deep = new Worklist();
        deep.add(nest(300000));
        deep.run(e => {
            if (Array.isArray(e)) deep.addAll(e);
            else leaves++;
        });
        expect(leaves).toBe(300001);
    });
});

describe("Visitor", () => {
    it("gives each node a result made from its kids', their contexts from `before`", () => {
        // the sum of each leaf times its depth, where a node's second kid is one deeper than its first
        const sum = new Visitor<number, number>(
            (e, depth) => Array.isArray(e) ? DESCEND : e * depth,
            f => { f.kids = f.e; f.state = true; },
            f => f.out.reduce((a, b) => a + b, 0),
            (f, i) => f.ctx + i,
        );
        expect(sum.visit([1, [10, 100]], 1)).toBe(1 * 1 + 10 * 2 + 100 * 3);
    });

    it("walks a tree deeper than the stack", () => {
        const height = new Visitor<undefined, number>(
            e => Array.isArray(e) ? DESCEND : 0,
            f => { f.kids = f.e; },
            f => 1 + Math.max(...f.out),
        );
        expect(height.visit(nest(300000), undefined)).toBe(300001);
    });

    it("mapTree rebuilds only what changed, innermost first", () => {
        const [CALL, IF] = ["%call", "%if"].map(n => Symbol.for(n));
        const f = Symbol("f"), x = Symbol("x");
        const tree = [IF, null, [CALL, null, f, 1], [CALL, null, f, x], 2];
        const leaf = (e: any) => Array.isArray(e) ? DESCEND : e === 1 ? 10 : e;
        const order: any[] = [];
        const out = mapTree(Lsrc, tree, leaf, (next, e) => { order.push(e[0]); return next; });
        expect(out).toEqual([IF, null, [CALL, null, f, 10], [CALL, null, f, x], 2]);
        expect(out[3]).toBe(tree[3]);
        expect(order).toEqual([CALL, CALL, IF]);
        expect(mapTree(Lsrc, tree, e => Array.isArray(e) ? DESCEND : e, next => next)).toBe(tree);
        expect(mapTree(Lsrc, tree, e => Array.isArray(e) ? DESCEND : e, next => next, true)).not.toBe(tree);
    });
});

describe("run", () => {
    it("gives a yielded walk's result, and anything else yielded straight back", () => {
        const depth = function* (e: any): Task<number> {
            if (!Array.isArray(e)) return yield 0;
            let most = 0;
            for (const x of e) most = Math.max(most, yield depth(x));
            return most + 1;
        };
        expect(run(depth([1, [2, [3]], 4]))).toBe(3);
        expect(run(depth(nest(300000)))).toBe(300001);
        expect(run(7)).toBe(7);
        expect(run([1, 2])).toEqual([1, 2]);
    });

    it("throws a walk's error into the walk that waits for it", () => {
        const log: string[] = [];
        const fails = function* (): Task<never> {
            throw new Error("inner");
        };
        const middle = function* (): Task<number> {
            try {
                return yield fails();
            } finally {
                log.push("middle left");
            }
        };
        const outer = function* (): Task<string> {
            try {
                yield middle();
                return "not reached";
            } catch (e: any) {
                return `caught ${e.message}`;
            }
        };
        expect(run(outer())).toBe("caught inner");
        expect(log).toEqual(["middle left"]);
        expect(() => run(middle())).toThrow("inner");
    });
});

describe("programs nested deeper than the js stack", () => {
    const [IF, CALL, INTCALL, BEGIN, LAMBDA, LET, ARRAY, VALUES, LETV] = ["%if", "%call", "%intcall", "%begin", "%lambda", "%let", "%array", "%values", "%let-values"].map(n => Symbol.for(n));
    const DEPTH = 10000;
    const shapes: [string, (n: number) => any, (v: any, n: number) => void][] = [
        ["an if in each else branch", n => { let f: any = 7; for (let i = 0; i < n; i++) f = [IF, null, [INTCALL, null, ARRAY], f, 1]; return f; }, v => expect(v).toBe(7)],
        ["an if in each test", n => { let f: any = true; for (let i = 0; i < n; i++) f = [IF, null, f, true, 2]; return f; }, v => expect(v).toBe(true)],
        ["a call in each argument", n => { let f: any = 0; for (let i = 0; i < n; i++) f = [INTCALL, null, ARRAY, f]; return f; }, (v, n) => { let d = 0; while (Array.isArray(v)) { v = v[0]; d++; } expect(d).toBe(n); }],
        ["a begin in each begin", n => { let f: any = 5; for (let i = 0; i < n; i++) f = [BEGIN, null, 0, f]; return f; }, v => expect(v).toBe(5)],
        ["a let of two in each body", n => { let f: any = 3; for (let i = 0; i < n; i++) f = [LET, null, [[Symbol("a"), 1], [Symbol("b"), 2]], f]; return f; }, v => expect(v).toBe(3)],
        ["a let in each init", n => { let f: any = 4; for (let i = 0; i < n; i++) { const a = Symbol("a"); f = [LET, null, [[a, f]], a]; } return f; }, v => expect(v).toBe(4)],
        ["a let-values in each body", n => { let f: any = 6; for (let i = 0; i < n; i++) f = [LETV, null, [[[Symbol("a"), Symbol("b")], null, [INTCALL, null, VALUES, 1, 2]]], f]; return f; }, v => expect(v).toBe(6)],
        ["a let in each body that reads the outermost variable", n => { const first = Symbol("first"); let f: any = first; for (let i = 0; i < n; i++) f = [LET, null, [[Symbol("a"), first], [Symbol("b"), first]], f]; return [LET, null, [[first, [INTCALL, null, ARRAY, 8]], [Symbol("pad"), 2]], f]; }, v => expect(v).toEqual([8])],
        ["a lambda in each lambda", n => { let f: any = 9; for (let i = 0; i < n; i++) f = [LAMBDA, null, [[], [], null, f]]; return [CALL, null, f]; }, v => expect(typeof v).toBe("object")],
    ];
    for (const options of [{ ...impl, optimize: true }, { ...impl, optimize: false }]) {
        for (const [name, make, check] of shapes) {
            it(`compiles and runs ${name}, ${DEPTH} deep${options.optimize ? "" : ", unoptimized"}`, () => {
                const anima = createScheme(options);
                check(anima.evaluateRaw(anima.compiler.compile(make(DEPTH))), DEPTH);
            });
        }
    }

    it("saves and loads a lambda in each lambda", () => {
        const anima = createScheme(impl);
        let f: any = 9;
        for (let i = 0; i < DEPTH; i++) f = [LAMBDA, null, [[], [], null, f]];
        const unit = UnitSerializer.serialize(anima.compiler.compile([CALL, null, [CALL, null, f]]), { id: "deep", version: "1", scriptname: "deep" });
        expect(typeof anima.evaluateRaw(UnitLoader.load(unit, anima.intrinsics).code)).toBe("object");
    });

    it("compiles calls of more arguments than a js engine compiles nested", () => {
        const anima = createScheme(impl);
        const value = (src: string) => new ASTStringifier().stringify(anima.evaluateRaw(anima.compileRaw(src)));
        const xs = (n: number) => Array.from({ length: n }, () => "x").join(" ");
        expect(value(`(define (g x) (length (list ${xs(5000)}))) (g 1)`)).toBe("5000");
        expect(value(`(define (g x) (length (cons* ${xs(5000)} '(1 2)))) (g 1)`)).toBe("5002");
        expect(value(`(define (g x) (+ ${xs(20000)})) (g 2)`)).toBe("40000");
        expect(value(`(define (g x) (- ${xs(20000)})) (g 2.5)`)).toBe("-49995");
        expect(value(`(define (g x) (<= ${xs(20000)})) (g 2)`)).toBe("#t");
        // the same values either side of where the templates stop being used
        for (const n of [15, 16, 17, 18, 127, 128, 129, 130]) {
            const items = Array.from({ length: n - 1 }, (_, i) => i + 1).join(" ");
            expect(value(`(define (g x) (list x ${items})) (equal? (g 0) '(0 ${items}))`)).toBe("#t");
            expect(value(`(define (g x) (cons* x ${items} '(a . b))) (equal? (g 0) '(0 ${items} a . b))`)).toBe("#t");
            expect(value(`(define (g x) (+ x ${items})) (g 0)`)).toBe(String(n * (n - 1) / 2));
            expect(value(`(define (g x) (list? (cons* x ${items} '(a b))))  (g 0)`)).toBe("#t");
        }
    });

    it("compiles a body of more definitions than it could look at once for each", () => {
        const anima = createScheme(impl);
        const defines = Array.from({ length: 20000 }, (_, i) => `(define v${i} ${i === 0 ? 1 : `(+ v${i - 1} 1)`})`).join(" ");
        expect(anima.evaluateRaw(anima.compileRaw(`((lambda () ${defines} v19999))`))).toBe(20000);
    });

    it("lowers and compiles Luau chains the parser reads without nesting", () => {
        const luau = createLuau(impl);
        const value = (src: string) => toString(luau.evaluateRaw(luau.compileRaw(src, "t")));
        const rep = (n: number, s: string, sep: string) => Array.from({ length: n }, () => s).join(sep);
        expect(value(`local a = 1 return ${rep(20000, "a", " + ")}`)).toBe("20000");
        expect(value(`local a = false return ${rep(5000, "a", " or ")} or 3`)).toBe("3");
        expect(value(`local x = {} x.a = x x.n = 7 return x${".a".repeat(3000)}.n`)).toBe("7");
        expect(value(`local x = {} function x:m() return self end return x${":m()".repeat(1500)} == x`)).toBe("true");
        expect(value(`local n = 0 local function f() n += 1 return f end f${"()".repeat(3000)} return n`)).toBe("3000");
        expect(value(`local function f(...) return #{...} end local x = 1 return f(${rep(20000, "x", ", ")})`)).toBe("20000");
        // (each call inlined: a branch after a branch, which the compiled code's type facts go through in order)
        expect(value(`local function f(x) return x end return ${"f(".repeat(900)}1${")".repeat(900)}`)).toBe("1");
    });
});
