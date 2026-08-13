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
  // `.env.example` ships this empty on purpose, so the suite has to supply one
  // of its own. A fixed literal rather than a random value per run, because
  // every other emulator default here is fixed and a token minted by one worker
  // has to verify in another.
  H5P_URL_TOKEN_SECRET: 'the-e2e-signing-key-for-h5p-url-tokens-0123456789',
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
    // Setup boots the app, seeds through Firestore and mints two tokens, and
    // still gets the same budget as a test: 30s is far past what the emulators
    // need, so a hook that overruns it is an emulator defect worth reading in
    // the log, not a slow runner to be absorbed by a larger number.
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
