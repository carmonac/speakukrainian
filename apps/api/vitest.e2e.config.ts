import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/** The same defaults `.env.example` documents, so a local run needs no exports. */
const emulatorEnv = {
  NODE_ENV: 'test',
  GOOGLE_CLOUD_PROJECT: 'speakukrainian-local',
  STORAGE_BUCKET: 'speakukrainian-media',
  FIRESTORE_EMULATOR_HOST: 'localhost:8081',
  FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099',
  STORAGE_API_ENDPOINT: 'http://localhost:4443',
};

/**
 * End-to-end tests run against the Firestore and Cloud Storage emulators from
 * `docker compose up`. They are excluded from the default `test` run because
 * they need those containers to be up.
 *
 * The SWC transform is not optional: these tests build the real Nest injector,
 * which resolves constructor parameters from `emitDecoratorMetadata`, and
 * Vitest's default esbuild transform does not emit that metadata.
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.e2e-spec.ts'],
    env: Object.fromEntries(
      Object.entries(emulatorEnv).map(([name, fallback]) => [name, process.env[name] ?? fallback]),
    ),
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
