import { configDefaults, defineConfig } from 'vitest/config';

// `npm test` runs the sources; the smoke tests of the built package (dist-test/) run with `npm run test:dist`
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'dist-test/**'],
  },
});
