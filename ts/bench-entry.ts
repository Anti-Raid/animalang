// What the benchmarks use, bundled on its own by `npm run bench` (vite.bench.config.ts) so they measure the library as
// it ships: one module, rather than the per-module code vitest runs the sources as, where every access to an import costs
// extra (see intrinsics.bench.ts)
export { createScheme } from "./scheme";
export { impl, implAot, type AnimaOptions } from "./bytecode-rvm/meta";
export { ASTStringifier, IProcedure } from "./common";
export { hostTailFrom, type ByteCode } from "./bytecode-rvm/exec";
export { dumpFull, readFull } from "./bytecode-rvm/utils";
export type { Anima } from "./anima";
