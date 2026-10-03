// What the benchmarks use, bundled on its own by `npm run bench` (vite.bench.config.ts) so they measure the library as
// it ships: one module, rather than the per-module code vitest runs the sources as, where every access to an import costs
// extra (see intrinsics.bench.ts)
export { createScheme } from "./scheme";
export { impl, type AnimaOptions } from "./magicvm/meta";
export { IProcedure } from "./common";
export { ASTStringifier } from "./scheme/printer";
export { hostTailFrom, type Code } from "./magicvm/exec";
export type { Anima } from "./anima";
