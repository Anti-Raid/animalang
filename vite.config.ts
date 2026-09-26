import { defineConfig } from 'vite';
import { resolve } from 'path';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [
    dts({ 
      insertTypesEntry: true, // Creates a types field reference in your entry point
      // the library's own sources only: not the configs, tests or benchmarks
      include: ['ts/**/*.ts'],
      exclude: ['ts/tests/**', 'ts/**/*.bench.ts', 'ts/bench-entry.ts'],
      compilerOptions: { types: ['node'] },
    })
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    lib: {
      // Defines the main entry file for your library
      entry: resolve(__dirname, 'ts/index.ts'),
      name: 'animalang',
      // Output formats to generate
      formats: ['es'],
      fileName: (format) => `index.${format}.js`,
    },
    rollupOptions: {
      // Ensure third-party dependencies aren't bundled into your library
      external: [], 
      output: {
        globals: {}
      }
    }
  },
});
