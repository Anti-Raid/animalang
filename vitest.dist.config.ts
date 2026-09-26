import { defineConfig } from 'vitest/config';

// `npm run test:dist`: end-to-end tests of the package as it ships (dist/, built first), through its public API only
export default defineConfig({
  test: {
    include: ['dist-test/**/*.test.ts'],
  },
});
