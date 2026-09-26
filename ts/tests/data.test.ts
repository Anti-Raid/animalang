import { ASTStringifier, isDeepEqual, Table, BS, BSReader } from '../common';
import { ASPParseError } from '../scheme/reader';
import { describe, it, expect, beforeEach } from 'vitest';
import { Cons } from '../list';
import { createScheme } from '../scheme';
import { ByteCode } from '../bytecode-rvm/vm';
import { Anima } from '../anima';
import { impl, implAot } from '../bytecode-rvm/meta';
import { dumpFull, readFull, BYTECODE_VERSION } from '../bytecode-rvm/utils';
import { registerTestIntrinsics } from './helpers';

describe("Table internals", () => {
    it('border() is always a valid border and contents match a plain Map under random edits', () => {
        let seed = 12345
        const rand = (n: number) => {
            seed = (seed * 1103515245 + 12345) % 2147483648
            return seed % n
        }
        const problems: string[] = []
        for (let round = 0; round < 20; round++) {
            const t = new Table()
            const model = new Map<any, any>()
            for (let step = 0; step < 150; step++) {
                const key = rand(10) === 0 ? `s${rand(3)}` : rand(12) + 1
                if (rand(3) === 0) {
                    t.set(key, undefined)
                    model.delete(key)
                } else {
                    const val = rand(100)
                    t.set(key, val)
                    model.set(key, val)
                }
                const n = t.border()
                if ((n > 0 && !t.has(n)) || t.has(n + 1)) problems.push(`round ${round} step ${step}: ${n} is not a border`)
                if (t.size !== model.size) problems.push(`round ${round} step ${step}: size ${t.size} != ${model.size}`)
            }
            for (const [k, v] of model) if (t.get(k) !== v) problems.push(`round ${round}: ${k} is ${t.get(k)}, expected ${v}`)
        }
        expect(problems).toEqual([])
    });
});
describe("isDeepEqual: Improper Lists (Dotted Pairs)", () => {
    
    it("should correctly equate identical improper lists", () => {
        // (1 2 . 3)
        const a = Cons.pair(1, Cons.pair(2, 3));
        const b = Cons.pair(1, Cons.pair(2, 3));
        expect(isDeepEqual(a, b)).toBe(true);
    });

    it("should fail when comparing a proper list to an improper list", () => {
        // (1 2 3) 
        const proper = Cons.pair(1, Cons.pair(2, Cons.pair(3, null)));
        // (1 2 . 3)
        const improper = Cons.pair(1, Cons.pair(2, 3));
        
        expect(isDeepEqual(proper, improper)).toBe(false);
    });

    it("should fail when comparing an improper list to a native JS Array", () => {
        // (1 2 3)
        const arr = [1, 2, 3];
        // (1 2 3) as cons
        const arrCons = Cons.pair(1, Cons.pair(2, Cons.pair(3, null)))
        // (1 2 . 3) 
        const improper = Cons.pair(1, Cons.pair(2, 3));
        
        expect(isDeepEqual(arr, arrCons)).toBe(false);
        expect(isDeepEqual(arr, improper)).toBe(false);
    });

    it("should fail when improper lists have different tails", () => {
        // (1 2 . 3)
        const a = Cons.pair(1, Cons.pair(2, 3));
        // (1 2 . 4)
        const b = Cons.pair(1, Cons.pair(2, 4));
        
        expect(isDeepEqual(a, b)).toBe(false);
    });

    it("should correctly handle nested improper lists", () => {
        // (1 (2 . 3) . 4)
        const a = Cons.pair(1, Cons.pair(Cons.pair(2, 3), 4));
        const b = Cons.pair(1, Cons.pair(Cons.pair(2, 3), 4));
        // (1 (2 . 99) . 4)
        const c = Cons.pair(1, Cons.pair(Cons.pair(2, 99), 4));

        expect(isDeepEqual(a, b)).toBe(true);
        expect(isDeepEqual(a, c)).toBe(false);
    });
    
    it("should correctly handle list primitive equalities", () => {
        const a = Cons.pair(1, 2); // (1 . 2)
        const b = 2; // primitive (2)
        expect(isDeepEqual(a, b)).toBe(false);
    });
});
describe.each([["interp", impl], ["aot", implAot]] as const)("%s", (_mode, vmImpl) => {
let bcCache: Record<string, ByteCode> = {}
describe('Vectors (using JS Arrays)', () => {
    let evaluator: Anima;
    beforeEach(() => { evaluator = createScheme(vmImpl) });
    let s = new ASTStringifier();

    const run = (expr: string) => {
        const bc = evaluator.compileRaw(expr);
        return s.stringify(evaluator.evaluateRaw(bc));
    };

    it('evaluates vector literals #(...) and #[...]', () => {
        expect(run("#()")).toBe("#()");
        expect(run("#(1 2 3)")).toBe("#(1 2 3)");
        expect(run("'#(10 20 30)")).toBe("#(10 20 30)");
        expect(run("#[1 2 3]")).toBe("#(1 2 3)");
        expect(run('#("hello" #t 42)')).toBe('#("hello" #t 42)');
    });

    it('tests vector? predicate', () => {
        expect(run("(vector? #(1 2 3))")).toBe("#t");
        expect(run("(vector? #())")).toBe("#t");
        expect(run("(vector? '(1 2 3))")).toBe("#f");
        expect(run("(vector? '())")).toBe("#f");
        expect(run("(vector? 42)")).toBe("#f");
        expect(run('(vector? "vec")')).toBe("#f");
    });

    it('creates vectors with make-vector and vector', () => {
        expect(run("(make-vector 3)")).toBe("#(0 0 0)");
        expect(run("(make-vector 4 #t)")).toBe("#(#t #t #t #t)");
        expect(run("(make-vector 0)")).toBe("#()");
        expect(run("(vector 1 2 3)")).toBe("#(1 2 3)");
        expect(run("(vector)")).toBe("#()");
        expect(run("(let ((x 10)) (vector x (+ x 5)))")).toBe("#(10 15)");
    });

    it('measures vector-length', () => {
        expect(run("(vector-length #(1 2 3 4 5))")).toBe("5");
        expect(run("(vector-length #())")).toBe("0");
        expect(run("(vector-length (make-vector 10))")).toBe("10");
        expect(() => run("(vector-length '(1 2 3))")).toThrow();
    });

    it('indexes with vector-ref and bounds checks', () => {
        expect(run("(vector-ref #(10 20 30) 0)")).toBe("10");
        expect(run("(vector-ref #(10 20 30) 1)")).toBe("20");
        expect(run("(vector-ref #(10 20 30) 2)")).toBe("30");
        expect(() => run("(vector-ref #(10 20 30) 3)")).toThrow();
        expect(() => run("(vector-ref #(10 20 30) -1)")).toThrow();
    });

    it('mutates vectors with vector-set!', () => {
        const script = `
            (let ((v (vector 1 2 3)))
              (begin
                (vector-set! v 1 99)
                v))
        `;
        expect(run(script)).toBe("#(1 99 3)");
        expect(() => run("(let ((v (vector 1 2 3))) (vector-set! v 5 99))")).toThrow();
    });

    it('converts between vectors and lists', () => {
        expect(run("(vector->list #(1 2 3))")).toBe("(1 2 3)");
        expect(run("(vector->list #())")).toBe("()");
        expect(run("(list->vector '(1 2 3))")).toBe("#(1 2 3)");
        expect(run("(list->vector '())")).toBe("#()");
        expect(run("(vector->list (list->vector '(a b c)))")).toBe("(a b c)");
        expect(() => run("(list->vector 42)")).toThrow();
    });

    it('supports vector-fill!', () => {
        const script = `
            (let ((v (vector 1 2 3 4)))
              (begin
                (vector-fill! v 7)
                v))
        `;
        expect(run(script)).toBe("#(7 7 7 7)");
    });

    it('copies vectors independently with vector-copy', () => {
        const script = `
            (let ((v1 (vector 1 2 3)))
              (let ((v2 (vector-copy v1)))
                (begin
                  (vector-set! v2 0 99)
                  (list v1 v2))))
        `;
        expect(run(script)).toBe("(#(1 2 3) #(99 2 3))");
    });

    it('concatenates vectors with vector-append', () => {
        expect(run("(vector-append #(1 2) #(3 4) #(5))")).toBe("#(1 2 3 4 5)");
        expect(run("(vector-append)")).toBe("#()");
        expect(run("(vector-append #(1 2))")).toBe("#(1 2)");
    });

    it('checks vector-empty? and generic empty?', () => {
        expect(run("(vector-empty? #())")).toBe("#t");
        expect(run("(vector-empty? #(1))")).toBe("#f");
        expect(run("(empty? #())")).toBe("#t");
        expect(run("(empty? #(1))")).toBe("#f");
        expect(run("(empty? '())")).toBe("#t");
        expect(run('(empty? "")')).toBe("#t");
    });

    it('compares vectors with equal?', () => {
        expect(run("(equal? #(1 2 3) #(1 2 3))")).toBe("#t");
        expect(run("(equal? #(1 2) #(1 3))")).toBe("#f");
        expect(run("(equal? #(1 2) #(1 2 3))")).toBe("#f");
        expect(run("(equal? #(1 2) '(1 2))")).toBe("#f");
        expect(run("(equal? #(1 #(2 3)) #(1 #(2 3)))")).toBe("#t");
    });
});
describe('Tables (using Table class)', () => {
    let evaluator: Anima;
    beforeEach(() => { evaluator = createScheme(vmImpl) });
    let s = new ASTStringifier();

    const run = (expr: string) => {
        const bc = evaluator.compileRaw(expr);
        return s.stringify(evaluator.evaluateRaw(bc));
    };

    const runRaw = (expr: string) => {
        const bc = evaluator.compileRaw(expr);
        return evaluator.evaluateRaw(bc);
    };

    it('evaluates table literals {...}', () => {
        expect(run("{}")).toBe("{}");
        expect(run('{"a" 1 "b" 2}')).toBe('{"a" 1 "b" 2}');
        expect(run('{"sum" (+ 10 20) "isTrue" #t}')).toBe('{"sum" 30 "isTrue" #t}');
        expect(run('{"nested" {"x" 42}}')).toBe('{"nested" {"x" 42}}');
    });

    it('throws on malformed table literals', () => {
        expect(() => evaluator.compileRaw('{"a"}')).toThrow(ASPParseError);
        expect(() => evaluator.compileRaw('{"a" 1 "b"}')).toThrow(ASPParseError);
        expect(() => evaluator.compileRaw('{"a" . 1}')).toThrow(ASPParseError);
        expect(() => evaluator.compileRaw('{"a" 1 )')).toThrow(ASPParseError);
        expect(() => evaluator.compileRaw('(list 1 2 }')).toThrow(ASPParseError);
    });

    it('throws on malformed dotted pairs', () => {
        expect(() => evaluator.compileRaw("'(. 1)")).toThrow(ASPParseError);
        expect(() => evaluator.compileRaw("'(. 1)")).toThrow("'.' must follow at least one expression");
        expect(() => evaluator.compileRaw("'(a .)")).toThrow(ASPParseError);
        expect(() => evaluator.compileRaw("'(a .)")).toThrow("trailing '.' is not allowed");
        expect(() => evaluator.compileRaw("'(a . b c)")).toThrow(ASPParseError);
        expect(() => evaluator.compileRaw("'(a . b c)")).toThrow("multiple expressions after '.' is not allowed");
        expect(() => evaluator.compileRaw("'(a . b")).toThrow("missing closing bracket for '('");
        expect(() => evaluator.compileRaw("'(a . b]")).toThrow("Mismatched or missing closing bracket for '('");
        const err = (() => { try { evaluator.compileRaw("'(a . b c)") } catch (e) { return e } })() as ASPParseError;
        expect(err.pos).toBeTypeOf("number");
        expect(err.curtok).toBe("c");
        expect(s.stringify(evaluator.evaluateRaw(evaluator.compileRaw("'(a . b)")))).toBe("(a . b)");
    });

    it('tests table? predicate', () => {
        expect(run("(table? {})")).toBe("#t");
        expect(run('(table? (table "a" 1))')).toBe("#t");
        expect(run("(table? #(1 2))")).toBe("#f");
        expect(run("(table? '(1 2))")).toBe("#f");
        expect(run('(table? "string")')).toBe("#f");
        expect(run("(table? 123)")).toBe("#f");
        expect(run("(table? #t)")).toBe("#f");
    });

    it('creates tables with table constructor', () => {
        expect(run("(table)")).toBe("{}");
        expect(run('(table "k" 99)')).toBe('{"k" 99}');
        expect(run('(table "a" 1 "b" 2)')).toBe('{"a" 1 "b" 2}');
        expect(() => run('(table "a")')).toThrow();
    });

    it('indexes with table-ref and defaults', () => {
        expect(run('(table-ref {"a" 1 "b" 2} "a")')).toBe("1");
        expect(run('(table-ref {"a" 1 "b" 2} "b")')).toBe("2");
        expect(run('(table-ref {"a" 1} "missing" 42)')).toBe("42");
        expect(run('(table-ref {"a" 1} "missing" #f)')).toBe("#f");
        expect(() => run('(table-ref {"a" 1} "missing")')).toThrow();
        expect(run(`(table-ref {'id 123} 'id)`)).toBe("123")
    });

    it('checks equality with table-is?', () => {
        expect(run('(table-is? {"a" 1 "b" 2} "a" 1)')).toBe("#t");
        expect(run('(table-is? {"a" 1 "b" 2} "a" 2)')).toBe("#f");
        expect(run('(table-is? {"a" 1 "b" 2} "b" 2)')).toBe("#t");
        expect(run('(table-is? {"a" "food"} "a" "food")')).toBe("#t");
        expect(run('(table-is? {"a" "food"} "a" "toys")')).toBe("#f");
        expect(run('(table-is? {"a" 1} "missing" 1)')).toBe("#f");
        expect(run('(table-is? {"a" 1} "missing" "default" "default")')).toBe("#t");
        expect(run('(table-is? {"a" 1} "missing" "other" "default")')).toBe("#f");
        expect(run('(table-is? {\'id "123"} \'id "123")')).toBe("#t");
        expect(run('(table-is? {\'id "123"} \'id "456")')).toBe("#f");
        expect(() => run('(table-is? "not-a-table" "a" 1)')).toThrow();
        expect(() => run('(table-is? {"a" 1} "a")')).toThrow();
    });

    it('mutates tables with table-set!', () => {
        const script = `
            (let ((tbl (table)))
              (begin
                (table-set! tbl "x" 10)
                (table-set! tbl "y" 20)
                (table-set! tbl "x" 30)
                (list (table-ref tbl "x") (table-ref tbl "y"))))
        `;
        expect(run(script)).toBe("(30 20)");
    });

    it('checks membership with table-has?', () => {
        expect(run('(table-has? {"a" 1} "a")')).toBe("#t");
        expect(run('(table-has? {"a" 1} "b")')).toBe("#f");
        expect(run('(table-has? {} "any")')).toBe("#f");
    });

    it('removes keys with table-delete!', () => {
        const script = `
            (let ((tbl {"a" 1 "b" 2}))
              (let ((removed (table-delete! tbl "a")))
                (list removed (table-has? tbl "a") (table-size tbl))))
        `;
        expect(run(script)).toBe("(#t #f 1)");
    });

    it('clears table with table-clear!', () => {
        const script = `
            (let ((tbl {"a" 1 "b" 2}))
              (begin
                (table-clear! tbl)
                (table-size tbl)))
        `;
        expect(run(script)).toBe("0");
    });

    it('measures size with table-size and table-empty? / empty?', () => {
        expect(run("(table-size {})")).toBe("0");
        expect(run('(table-size {"a" 1 "b" 2})')).toBe("2");
        expect(run("(table-empty? {})")).toBe("#t");
        expect(run('(table-empty? {"a" 1})')).toBe("#f");
        expect(run("(empty? {})")).toBe("#t");
        expect(run('(empty? {"a" 1})')).toBe("#f");
    });

    it('extracts table-keys and table-values as vectors', () => {
        expect(run("(vector? (table-keys {}))")).toBe("#t");
        expect(run("(vector? (table-values {}))")).toBe("#t");
        expect(run("(table-keys {})")).toBe("#()");
        expect(run("(table-values {})")).toBe("#()");
        expect(run('(table-keys {"a" 1})')).toBe('#("a")');
        expect(run('(table-values {"a" 1})')).toBe("#(1)");
    });

    it('copies tables with table-copy', () => {
        const script = `
            (let ((t1 {"a" 1}))
              (let ((t2 (table-copy t1)))
                (begin
                  (table-set! t2 "a" 99)
                  (list (table-ref t1 "a") (table-ref t2 "a")))))
        `;
        expect(run(script)).toBe("(1 99)");
    });

    it('freezes tables with table-freeze! and enforces immutability', () => {
        expect(run("(table-frozen? {})")).toBe("#f");
        expect(run('(table-frozen? (table-freeze! {"a" 1}))')).toBe("#t");

        // Mutating a frozen table throws
        const failSet = `
            (let ((tbl (table-freeze! {"a" 1})))
              (table-set! tbl "a" 2))
        `;
        expect(() => run(failSet)).toThrow();

        // Deleting from a frozen table throws
        const failDel = `
            (let ((tbl (table-freeze! {"a" 1})))
              (table-delete! tbl "a"))
        `;
        expect(() => run(failDel)).toThrow();

        // Clearing a frozen table throws
        const failClear = `
            (let ((tbl (table-freeze! {"a" 1})))
              (table-clear! tbl))
        `;
        expect(() => run(failClear)).toThrow();

        // table-copy creates an unfrozen mutable copy of a frozen table
        const copyScript = `
            (let ((frozen (table-freeze! {"a" 1})))
              (let ((unfrozen (table-copy frozen)))
                (begin
                  (table-set! unfrozen "a" 42)
                  (list (table-frozen? frozen) (table-frozen? unfrozen) (table-ref unfrozen "a")))))
        `;
        expect(run(copyScript)).toBe("(#t #f 42)");
    });

    it('merges tables with table-merge!', () => {
        const script = `
            (let ((t1 {"a" 1 "b" 2})
                  (t2 {"b" 20 "c" 30}))
              (begin
                (table-merge! t1 t2)
                (list (table-ref t1 "a") (table-ref t1 "b") (table-ref t1 "c"))))
        `;
        expect(run(script)).toBe("(1 20 30)");
    });

    it('compares tables with equal?', () => {
        expect(run("(equal? {} {})")).toBe("#t");
        expect(run('(equal? {"a" 1 "b" 2} {"b" 2 "a" 1})')).toBe("#t");
        expect(run('(equal? {"a" 1} {"a" 2})')).toBe("#f");
        expect(run('(equal? {"a" 1} {"a" 1 "b" 2})')).toBe("#f");
        expect(run('(equal? {"nested" {"x" 1}} {"nested" {"x" 1}})')).toBe("#t");
        expect(run('(equal? {"a" 1} \'("a" 1))')).toBe("#f");
    });

    it('supports JS Table class interop and FFI methods', () => {
        const meta = new Table();
        meta.set("active", true);

        const t = new Table();
        t.set("name", "Willow");
        t.set("version", 2);
        t.set("meta", meta);

        expect(t instanceof Table).toBe(true);
        expect(t.size).toBe(3);
        expect(t.get("name")).toBe("Willow");
        expect(t.get("meta") instanceof Table).toBe(true);
        expect((t.get("meta") as Table).get("active")).toBe(true);

        // JS iteration
        const entries = [...t.entries()];
        expect(entries.length).toBe(3);

        // JS freeze
        t.frozen = true;
        expect(t.frozen).toBe(true);
        expect(() => t.set("name", "Other")).toThrow();
        expect(() => t.delete("version")).toThrow();
        expect(() => t.clear()).toThrow();

        // JS host can unfreeze
        t.frozen = false;
        expect(t.frozen).toBe(false);
        t.set("name", "Other");
        expect(t.get("name")).toBe("Other");
        t.frozen = true;

        // Scheme evaluateRaw returns actual Table instance
        const rawT = runRaw('{"id" "test-123" "count" 5}');
        expect(rawT instanceof Table).toBe(true);
        expect(rawT.get("id")).toBe("test-123");
        expect(rawT.get("count")).toBe(5);
    });

    it('stores keys 1..n in an array part and treats <#void> as absent', () => {
        const t = new Table();
        t.set(2, "b"); t.set(1, "a"); t.set("k", "v"); t.set(3, "c");
        expect(t.border()).toBe(3);
        expect([...t.entries()]).toEqual([[1, "a"], [2, "b"], [3, "c"], ["k", "v"]]);

        // removing from the middle keeps the array part dense; the rest stays reachable
        t.set(2, undefined);
        expect(t.border()).toBe(1);
        expect(t.has(2)).toBe(false);
        expect(t.get(3)).toBe("c");
        expect(t.size).toBe(3);
        t.set(2, "B");
        expect(t.border()).toBe(3);
        expect([...t.keys()]).toEqual([1, 2, 3, "k"]);

        // 1.0 and 1 are the same key, and so are 0 and -0
        t.set(1.0, "one"); t.set(-0, "zero");
        expect(t.get(1)).toBe("one");
        expect(t.get(0)).toBe("zero");

        expect(() => t.set(NaN, 1)).toThrow("table key cannot be NaN");
        expect(() => t.set(undefined, 1)).toThrow("table key cannot be <#void>");
        expect(t.get(NaN)).toBeUndefined();
    });

    it('table-set! of <#void> removes the key in Scheme', () => {
        expect(run(`(let ((t {"a" 1 "b" 2})) (table-set! t "a" <#void>) (list (table-has? t "a") (table-size t) (table-ref t "a" 'gone)))`)).toBe("(#f 1 gone)")
        expect(run(`(let ((t {1 "x" 2 "y" 3 "z"})) (table-set! t 2 <#void>) (list (table-size t) (table-ref t 3) (vector-length (table-entries t))))`)).toBe(`(2 "z" 2)`)
        expect(run(`(table-size {"a" <#void>})`)).toBe("0")
    });
});
describe('Floats, Infinities & NaNs', () => {
    let evaluator: Anima;
    beforeEach(() => {
        evaluator = createScheme(vmImpl)
        registerTestIntrinsics(evaluator)
    });
    let s = new ASTStringifier();

    const run = (expr: string) => {
        const bc = evaluator.compileRaw(expr);
        return s.stringify(evaluator.evaluateRaw(bc));
    };

    const runRaw = (expr: string) => {
        const bc = evaluator.compileRaw(expr);
        return evaluator.evaluateRaw(bc);
    };

    it('evaluates floating-point number literals', () => {
        expect(run("3.14")).toBe("3.14");
        expect(runRaw("3.14")).toBe(3.14);
        expect(run("-0.5")).toBe("-0.5");
        expect(runRaw("-0.5")).toBe(-0.5);
        expect(run("0.0")).toBe("0");
        expect(run(".25")).toBe("0.25");
        expect(run("-.75")).toBe("-0.75");
        expect(run("1.5e3")).toBe("1500");
        expect(run("1.5e-3")).toBe("0.0015");
    });

    it('evaluates infinities (+inf.0, -inf.0, inf.0) and NaNs (+nan.0, -nan.0, nan.0)', () => {
        expect(run("+inf.0")).toBe("+inf.0");
        expect(runRaw("+inf.0")).toBe(Infinity);
        expect(run("-inf.0")).toBe("-inf.0");
        expect(runRaw("-inf.0")).toBe(-Infinity);
        expect(run("inf.0")).toBe("+inf.0");
        expect(runRaw("inf.0")).toBe(Infinity);
        expect(run("+Infinity")).toBe("+inf.0");
        expect(run("-Infinity")).toBe("-inf.0");
        expect(run("Infinity")).toBe("+inf.0");

        expect(run("+nan.0")).toBe("+nan.0");
        expect(Number.isNaN(runRaw("+nan.0"))).toBe(true);
        expect(run("-nan.0")).toBe("+nan.0");
        expect(Number.isNaN(runRaw("-nan.0"))).toBe(true);
        expect(run("nan.0")).toBe("+nan.0");
        expect(Number.isNaN(runRaw("nan.0"))).toBe(true);
    });

    it('tests numeric predicates with floats, infinities and NaNs', () => {
        // number?
        expect(run("(number? 3.14)")).toBe("#t");
        expect(run("(number? +inf.0)")).toBe("#t");
        expect(run("(number? -inf.0)")).toBe("#t");
        expect(run("(number? +nan.0)")).toBe("#t");

        // integer?
        expect(run("(integer? 42)")).toBe("#t");
        expect(run("(integer? 3.14)")).toBe("#f");
        expect(run("(integer? +inf.0)")).toBe("#f");
        expect(run("(integer? -inf.0)")).toBe("#f");
        expect(run("(integer? +nan.0)")).toBe("#f");

        // positive?
        expect(run("(positive? 3.14)")).toBe("#t");
        expect(run("(positive? +inf.0)")).toBe("#t");
        expect(run("(positive? -inf.0)")).toBe("#f");
        expect(run("(positive? +nan.0)")).toBe("#f");

        // negative?
        expect(run("(negative? -3.14)")).toBe("#t");
        expect(run("(negative? -inf.0)")).toBe("#t");
        expect(run("(negative? +inf.0)")).toBe("#f");
        expect(run("(negative? +nan.0)")).toBe("#f");

        // zero?
        expect(run("(zero? 0.0)")).toBe("#t");
        expect(run("(zero? +inf.0)")).toBe("#f");
        expect(run("(zero? -inf.0)")).toBe("#f");
        expect(run("(zero? +nan.0)")).toBe("#f");

        // infinite?
        expect(run("(infinite? +inf.0)")).toBe("#t");
        expect(run("(infinite? -inf.0)")).toBe("#t");
        expect(run("(infinite? 3.14)")).toBe("#f");
        expect(run("(infinite? 42)")).toBe("#f");
        expect(run("(infinite? +nan.0)")).toBe("#f");

        // finite?
        expect(run("(finite? 3.14)")).toBe("#t");
        expect(run("(finite? 42)")).toBe("#t");
        expect(run("(finite? +inf.0)")).toBe("#f");
        expect(run("(finite? -inf.0)")).toBe("#f");
        expect(run("(finite? +nan.0)")).toBe("#f");

        // nan?
        expect(run("(nan? +nan.0)")).toBe("#t");
        expect(run("(nan? -nan.0)")).toBe("#t");
        expect(run("(nan? nan.0)")).toBe("#t");
        expect(run("(nan? 3.14)")).toBe("#f");
        expect(run("(nan? +inf.0)")).toBe("#f");
    });

    it('performs arithmetic with floating-point numbers', () => {
        expect(run("(+ 1.5 2.5)")).toBe("4");
        expect(run("(+ 1.25 0.5)")).toBe("1.75");
        expect(run("(- 10.5 3.25)")).toBe("7.25");
        expect(run("(- 5.5)")).toBe("-5.5");
        expect(run("(* 2.5 4.0)")).toBe("10");
        expect(run("(* -1.5 2.0)")).toBe("-3");
        expect(run("(/ 7.5 2.5)")).toBe("3");
        expect(run("(/ 1.0 4.0)")).toBe("0.25");
        expect(run("(remainder 5.5 2.0)")).toBe("1.5");
    });

    it('performs arithmetic with infinities', () => {
        expect(run("(- +inf.0)")).toBe("-inf.0");
        expect(run("(- -inf.0)")).toBe("+inf.0");
        expect(run("(+ +inf.0 100)")).toBe("+inf.0");
        expect(run("(+ -inf.0 100)")).toBe("-inf.0");
        expect(run("(* 2.0 +inf.0)")).toBe("+inf.0");
        expect(run("(* -2.0 +inf.0)")).toBe("-inf.0");
        expect(run("(/ 1.0 +inf.0)")).toBe("0");
        expect(run("(/ +inf.0 2.0)")).toBe("+inf.0");
        expect(run("(/ +inf.0 +inf.0)")).toBe("+nan.0");
        expect(run("(- +inf.0 +inf.0)")).toBe("+nan.0");
    });

    it('compares floats and infinities correctly', () => {
        expect(run("(< -inf.0 -100 0 100 +inf.0)")).toBe("#t");
        expect(run("(<= -inf.0 -inf.0 0 3.14 +inf.0 +inf.0)")).toBe("#t");
        expect(run("(> +inf.0 100 0 -100 -inf.0)")).toBe("#t");
        expect(run("(>= +inf.0 +inf.0 3.14 0 -inf.0 -inf.0)")).toBe("#t");
        expect(run("(= +inf.0 +inf.0)")).toBe("#t");
        expect(run("(= -inf.0 -inf.0)")).toBe("#t");
        expect(run("(= +inf.0 -inf.0)")).toBe("#f");
        expect(run("(= 3.14 3.14)")).toBe("#t");
        expect(run("(= 3.14 3.15)")).toBe("#f");
        expect(run("(= +nan.0 +nan.0)")).toBe("#f");

        expect(run("(eqv? +inf.0 +inf.0)")).toBe("#t");
        expect(run("(eqv? -inf.0 -inf.0)")).toBe("#t");
        expect(run("(eqv? +inf.0 -inf.0)")).toBe("#f");
        expect(run("(eqv? 3.14 3.14)")).toBe("#t");

        expect(run("(equal? +inf.0 +inf.0)")).toBe("#t");
        expect(run("(equal? -inf.0 -inf.0)")).toBe("#t");
        expect(run("(equal? '(1.5 +inf.0) '(1.5 +inf.0))")).toBe("#t");
        expect(run("(equal? #(1.5 +inf.0) #(1.5 +inf.0))")).toBe("#t");
        expect(run('(equal? {"x" +inf.0} {"x" +inf.0})')).toBe("#t");
    });

    it('serializes and deserializes floats and infinities in ByteCode (BS / BSReader)', () => {
        // Direct BS / BSReader F64 serde
        const bs = new BS();
        bs.writeF64(3.141592653589793);
        bs.writeF64(Infinity);
        bs.writeF64(-Infinity);
        bs.writeF64(NaN);
        bs.writeValue(2.71828);
        bs.writeValue(Infinity);
        bs.writeValue(-Infinity);
        bs.writeValue(100);

        const buf = bs.finalize();
        const reader = new BSReader(buf);

        expect(reader.readF64()).toBe(3.141592653589793);
        expect(reader.readF64()).toBe(Infinity);
        expect(reader.readF64()).toBe(-Infinity);
        expect(Number.isNaN(reader.readF64())).toBe(true);

        expect(reader.read()).toBe(2.71828);
        expect(reader.read()).toBe(Infinity);
        expect(reader.read()).toBe(-Infinity);
        expect(reader.read()).toBe(100);

        // ByteCode serialization containing floats and infinities
        const bc = evaluator.compileRaw('(+ 3.14 2.71 +inf.0)');
        const bcBs = new BS();
        bcBs.writeSerializable(bc as ByteCode);

        const dumped = bcBs.finalize();
        const bcReader = new BSReader(dumped);
        ByteCode.register(bcReader, evaluator.intrinsics);
        const deserializedBc = bcReader.read() as ByteCode;

        expect(deserializedBc instanceof ByteCode).toBe(true);
        expect(s.stringify(evaluator.evaluateRaw(deserializedBc))).toBe("+inf.0");

        // ByteCode serialization with float result
        const bcFloat = evaluator.compileRaw('(* 2.5 1.5)');
        const bcFloatBs = new BS();
        bcFloatBs.writeSerializable(bcFloat as ByteCode);
        const floatDumped = bcFloatBs.finalize();
        const floatReader = new BSReader(floatDumped);
        ByteCode.register(floatReader, evaluator.intrinsics);
        const deserializedFloatBc = floatReader.read() as ByteCode;
        expect(s.stringify(evaluator.evaluateRaw(deserializedFloatBc))).toBe("3.75");

        // Quoted list constants (proper, nested, improper)
        for (const [src, expected] of [
            ["'(1 2 3)", "(1 2 3)"],
            ["(car '(1 2))", "1"],
            ["'((a b) (c . d) \"s\")", "((a b) (c . d) \"s\")"],
            ["'(1 2 . 3)", "(1 2 . 3)"],
        ]) {
            const listBs = new BS();
            listBs.writeSerializable(evaluator.compileRaw(src) as ByteCode);
            const listReader = new BSReader(listBs.finalize());
            ByteCode.register(listReader, evaluator.intrinsics);
            expect(s.stringify(evaluator.evaluateRaw(listReader.read() as ByteCode))).toBe(expected);
        }

        const longList = Cons.fromArray(Array.from({ length: 100000 }, (_, i) => i));
        const longBs = new BS();
        longBs.writeValue(longList);
        const longBack = new BSReader(longBs.finalize()).read() as Cons;
        expect(longBack instanceof Cons).toBe(true);
        expect(longBack.length).toBe(100000);

        const full = dumpFull(evaluator.compileRaw("(list 1 '(2 3))") as ByteCode);
        expect(full[1]).toBe(BYTECODE_VERSION);
        expect(s.stringify(evaluator.evaluateRaw(readFull(full) as ByteCode))).toBe("(1 (2 3))");
        const wrongVersion = full.slice();
        wrongVersion[1] = BYTECODE_VERSION + 1;
        expect(() => readFull(wrongVersion)).toThrow(`bytecode version ${BYTECODE_VERSION + 1} is not supported`);
        expect(() => readFull(full.subarray(2))).toThrow("not anima bytecode");
    });

    it("serializes intrinsics by name and binds them to the loading table", () => {
        const bc = evaluator.compileRaw("(list (%test-add 1 2) (%test-call-or (lambda (x) x) 4))") as ByteCode;
        // core operations (here %list) are recorded like any other
        expect(bc.intrinsics.map(used => used.name).sort()).toEqual(["%list", "%test-add", "%test-call-or"]);
        const dumped = dumpFull(bc);
        expect(s.stringify(evaluator.evaluateRaw(readFull(dumped, evaluator.intrinsics) as ByteCode))).toBe("(3 4)");

        // the same intrinsics at other positions: operands are remapped by name
        const other = createScheme(vmImpl);
        other.registerIntrinsic("%test-first", (regs, s) => regs[s], { args: [1, 1], leaf: true });
        registerTestIntrinsics(other);
        expect(other.intrinsics.byName("%test-add")!.pos).not.toBe(evaluator.intrinsics.byName("%test-add")!.pos);
        expect(s.stringify(other.evaluateRaw(readFull(dumped, other.intrinsics) as ByteCode))).toBe("(3 4)");
        expect(s.stringify(other.evaluateRaw((bc as ByteCode).fresh(new Map(), other.intrinsics)))).toBe("(3 4)");
        // the original still runs with its own positions
        expect(s.stringify(evaluator.evaluateRaw(bc))).toBe("(3 4)");

        expect(() => readFull(dumped, createScheme(vmImpl).intrinsics)).toThrow("'%test-add', which is not registered");
        expect(() => readFull(dumped)).toThrow("needs an intrinsics table");
    });

    it("refuses to load code whose intrinsics changed from leaf to not a leaf, or back", () => {
        const leafCode = dumpFull(evaluator.compileRaw("(%test-add 1 2)") as ByteCode);
        const other = createScheme(vmImpl);
        other.registerIntrinsic("%test-add", (regs, s) => regs[s] + regs[s + 1], { args: [2, 2] });
        expect(() => readFull(leafCode, other.intrinsics)).toThrow("compiled with '%test-add' as a leaf, but it is registered as not a leaf");
        const nonLeafCode = dumpFull(other.compileRaw("(%test-add 1 2)") as ByteCode);
        expect(() => readFull(nonLeafCode, evaluator.intrinsics)).toThrow("compiled with '%test-add' as not a leaf, but it is registered as a leaf");
    });
});
})
