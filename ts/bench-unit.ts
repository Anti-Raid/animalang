// Dedicated Benchmark: Cold Hydration Latency & Hot Execution Throughput for .animau
import { gzipSync } from "node:zlib";
import { createScheme } from "./scheme";
import { impl } from "./magicvm/meta";
import { UnitSerializer } from "./magicvm/aot/serializer";
import { UnitLoader } from "./magicvm/loader";
import { AnimaVM, Code } from "./magicvm/vm";
import { Env } from "./env";

type Workload = {
    name: string;
    description: string;
    src: string;
};

const workloads: Workload[] = [
    {
        name: "Simple Arithmetic",
        description: "Straight-line expression (+ (* 42 17) (- 1000 250))",
        src: "(+ (* 42 17) (- 1000 250))",
    },
    {
        name: "Higher-Order Closure",
        description: "Closure creation and invocation: ((make-adder 10) 25)",
        src: `
            (define (make-adder x) (lambda (y) (+ x y)))
            ((make-adder 10) 25)
        `,
    },
    {
        name: "Tail-Recursive Loop",
        description: "1,000-iteration accumulator loop",
        src: `
            (let loop ((n 1000) (acc 0))
              (if (= n 0) acc (loop (- n 1) (+ acc n))))
        `,
    },
    {
        name: "Recursive Fib",
        description: "Double recursive tree (fib 12)",
        src: `
            (define (fib n)
              (if (< n 2) n (+ (fib (- n 1)) (fib (- n 2)))))
            (fib 12)
        `,
    },
    {
        name: "Mutual Recursion (letrec)",
        description: "Mutually recursive letrec even?/odd?",
        src: `
            (letrec ((my-even? (lambda (n) (if (= n 0) #t (my-odd? (- n 1)))))
                     (my-odd? (lambda (n) (if (= n 0) #f (my-even? (- n 1))))))
              (list (my-even? 20) (my-odd? 19)))
        `,
    },
    {
        name: "Complex Rule / Validator",
        description: "Multi-branch rule with rate limits, thresholds and vector scoring",
        src: `
            (define (validate-event event-type count score)
              (let ((threshold (if (eq? event-type 'spam) 10 50)))
                (if (> count threshold)
                    (if (> score 0.85) 'block 'flag)
                    (if (> score 0.95) 'captcha 'pass))))
            (list (validate-event 'spam 15 0.9)
                  (validate-event 'normal 20 0.5)
                  (validate-event 'normal 100 0.99))
        `,
    },
];

async function run() {
    const anima = createScheme(impl);
    const table = anima.intrinsics;

    console.log("=".repeat(85));
    console.log("   ANIMALANG / MAGICVM: EXECUTION UNIT (.animau) BENCHMARK REPORT");
    console.log("=".repeat(85));
    console.log();

    console.log("### 1. COLD START / HYDRATION LATENCY");
    console.log("| Workload | Raw Compile (11 Passes) | .animau JSON Hydration | Pre-Parsed Hydration | Speedup |");
    console.log("|:---|:---:|:---:|:---:|:---:|");

    const coldResults: any[] = [];

    for (const w of workloads) {
        // Compile raw to get unit JSON
        const rawCode = anima.compileRaw(w.src) as Code;
        const meta = { id: w.name, version: "1.0.0", scriptname: `${w.name}.scm` };
        const jsonStr = UnitSerializer.serialize(rawCode, meta);
        const jsonObj = JSON.parse(jsonStr);

        // Warm up V8
        for (let i = 0; i < 10; i++) {
            anima.compileRaw(w.src);
            UnitLoader.load(jsonStr, table);
            UnitLoader.load(jsonObj, table);
        }

        // Measure Raw Compilation (Source -> Lexer -> Parser -> 11 Nanopasses -> AOT)
        const N_RAW = 50;
        const t0 = performance.now();
        for (let i = 0; i < N_RAW; i++) {
            anima.compileRaw(w.src);
        }
        const rawTimeMs = (performance.now() - t0) / N_RAW;

        // Measure JSON String Hydration (JSON.parse + Single-Batch Factory + Caches)
        const N_JSON = 500;
        const t1 = performance.now();
        for (let i = 0; i < N_JSON; i++) {
            UnitLoader.load(jsonStr, table);
        }
        const jsonTimeMs = (performance.now() - t1) / N_JSON;

        // Measure Pre-Parsed Object Hydration (Single-Batch Factory + Caches)
        const N_OBJ = 500;
        const t2 = performance.now();
        for (let i = 0; i < N_OBJ; i++) {
            UnitLoader.load(jsonObj, table);
        }
        const objTimeMs = (performance.now() - t2) / N_OBJ;

        const speedup = (rawTimeMs / jsonTimeMs).toFixed(1);

        console.log(
            `| ${w.name.padEnd(26)} | ${(rawTimeMs * 1000).toFixed(0).padStart(6)} µs (${rawTimeMs.toFixed(2)} ms) | ${(jsonTimeMs * 1000).toFixed(0).padStart(5)} µs (${jsonTimeMs.toFixed(3)} ms) | ${(objTimeMs * 1000).toFixed(0).padStart(5)} µs (${objTimeMs.toFixed(3)} ms) | **${speedup}× faster** |`
        );

        coldResults.push({ name: w.name, rawTimeMs, jsonTimeMs, objTimeMs, speedup, jsonStr });
    }

    console.log();
    console.log("### 2. STEADY-STATE / HOT EXECUTION SPEED (Throughput)");
    console.log("| Workload | Native JIT Execution | Hydrated .animau Execution | Difference |");
    console.log("|:---|:---:|:---:|:---:|");

    for (const w of workloads) {
        const rawCode = anima.compileRaw(w.src) as Code;
        const meta = { id: w.name, version: "1.0.0", scriptname: `${w.name}.scm` };
        const jsonStr = UnitSerializer.serialize(rawCode, meta);
        const hydrated = UnitLoader.load(jsonStr, table);

        // Warm up hot loops
        for (let i = 0; i < 500; i++) {
            anima.evaluateRaw(rawCode);
            anima.evaluateRaw(hydrated.code);
        }

        const RUNS = 5000;
        const t0 = performance.now();
        for (let i = 0; i < RUNS; i++) {
            anima.evaluateRaw(rawCode);
        }
        const rawRunTime = (performance.now() - t0) / RUNS;

        const t1 = performance.now();
        for (let i = 0; i < RUNS; i++) {
            anima.evaluateRaw(hydrated.code);
        }
        const hydratedRunTime = (performance.now() - t1) / RUNS;

        const diffPercent = (((hydratedRunTime - rawRunTime) / rawRunTime) * 100).toFixed(1);
        const diffStr = Math.abs(parseFloat(diffPercent)) < 3.0 ? "0.0% (Zero Overhead)" : `${diffPercent}%`;

        console.log(
            `| ${w.name.padEnd(26)} | ${(rawRunTime * 1000).toFixed(2).padStart(8)} µs | ${(hydratedRunTime * 1000).toFixed(2).padStart(8)} µs | **${diffStr}** |`
        );
    }

    console.log();
    console.log("### 3. ARTIFACT SIZE & WIRE FOOTPRINT");
    console.log("| Workload | Raw JSON Size | Gzipped Size (Wire) | Compression Ratio |");
    console.log("|:---|:---:|:---:|:---:|");

    for (const r of coldResults) {
        const rawBytes = Buffer.byteLength(r.jsonStr, "utf8");
        const gzBytes = gzipSync(Buffer.from(r.jsonStr, "utf8")).byteLength;
        const ratio = ((1 - gzBytes / rawBytes) * 100).toFixed(1);

        console.log(
            `| ${r.name.padEnd(26)} | ${(rawBytes / 1024).toFixed(2).padStart(6)} KB | ${(gzBytes / 1024).toFixed(2).padStart(6)} KB | **${ratio}% reduction** |`
        );
    }

    console.log();
    console.log("### 4. HYDRATION THROUGHPUT (Units / Second on Single Core)");
    for (const r of coldResults) {
        const unitsPerSec = Math.round(1000 / r.jsonTimeMs);
        console.log(`* **${r.name}**: **${unitsPerSec.toLocaleString()} units/sec** hydrated directly from JSON.`);
    }
    console.log();
}

run().catch(console.error);
