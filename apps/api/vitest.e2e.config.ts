import { defineConfig } from 'vitest/config';

/**
 * End-to-end tests run against the Firestore and Cloud Storage emulators from
 * `docker compose up`. They are excluded from the default `test` run because
 * they need those containers to be up.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.e2e-spec.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
