import { defineConfig } from 'vite';
import { resolve } from 'path';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [
    dts({ 
      insertTypesEntry: true, // Creates a types field reference in your entry point
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
      formats: ['es', 'cjs'],
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
