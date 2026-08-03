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
