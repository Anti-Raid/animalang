import { defineConfig } from 'vite';
import { resolve } from 'path';

// The library bundled the way `vite build` ships it, for the benchmarks (see ts/bench-entry.ts)
export default defineConfig({
  build: {
    outDir: '.bench',
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, 'ts/bench-entry.ts'),
      formats: ['es'],
      fileName: () => 'anima.js',
    },
  },
});
