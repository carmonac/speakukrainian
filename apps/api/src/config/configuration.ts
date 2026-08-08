import { z } from 'zod';

/**
 * Environment contract for the API. Validated once at boot so a misconfigured
 * Cloud Run revision fails fast instead of erroring on the first request.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** Cloud Run injects PORT; it must be honoured exactly. */
  PORT: z.coerce.number().int().default(8080),

  GOOGLE_CLOUD_PROJECT: z.string().min(1),

  /** Bucket holding images, audio and H5P content. */
  STORAGE_BUCKET: z.string().min(1),

  /** Set for local dev; unset in Cloud Run. The Firestore SDK reads this itself. */
  FIRESTORE_EMULATOR_HOST: z.string().optional(),

  /**
   * Cloud Storage endpoint override, pointing at fake-gcs-server locally.
   *
   * Deliberately NOT named `STORAGE_EMULATOR_HOST`: the Storage SDK reads that
   * name and derives its own base URL from it, which then conflicts with the
   * `apiEndpoint` we pass and makes every object request 404.
   *
   * The scheme is required — bare `localhost:4443` parses as a URL with
   * protocol `localhost:`, which the SDK then cannot reach.
   */
  STORAGE_API_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),

  /** Comma-separated list of origins allowed to call the API. */
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:4200,http://localhost:4300')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),

  /** Base URL the public site is served from, used to build absolute links. */
  PUBLIC_SITE_URL: z.url().default('http://localhost:4300'),

  /** Where H5P keeps its working files, relative to the app root. */
  H5P_TEMP_DIR: z.string().default('./h5p/temporary-storage'),

  /**
   * Where the API reads the H5P client libraries from, relative to the app
   * root. `<dir>/core` and `<dir>/editor` are what the asset routes serve.
   *
   * `scripts/fetch-h5p-core.ts` writes `apps/api/h5p` and does not read this,
   * because it runs from `postinstall` where the API's environment is not
   * loaded. The default is the same directory; anything else has to be
   * populated by hand.
   */
  H5P_ASSETS_DIR: z.string().default('./h5p'),

  /**
   * Base URL the H5P client uses to reach this API. Every asset URL in a player
   * model is built from it.
   *
   * It must be **absolute** wherever the page's origin differs from the API's,
   * which is every local development setup: the admin runs on :4200 and the API
   * on :8080, so a relative `/api/h5p/core/js/h5p.js` in a model rendered at
   * :4200 resolves against :4200 and 404s. In production both are behind one
   * origin and the relative default is right.
   */
  H5P_BASE_URL: z.string().default('/api/h5p'),
});

export type Env = z.infer<typeof envSchema>;

export function loadConfig(raw: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}

export const isEmulated = (env: Env): boolean => Boolean(env.FIRESTORE_EMULATOR_HOST);
