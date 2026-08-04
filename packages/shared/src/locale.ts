import { z } from 'zod';
import { auditSchema, localeCodeSchema } from './common.js';

/**
 * A locale the site is available in. Seeded with `en`, `es` and `uk`; admins
 * add more at runtime. Exactly one locale is the default and it cannot be
 * disabled or deleted.
 */
export const localeSchema = z.object({
  /** Document id equals the locale code. */
  id: localeCodeSchema,
  code: localeCodeSchema,
  /** Name in English, for the admin UI, e.g. "Ukrainian". */
  name: z.string().min(1),
  /** Name in the locale itself, for the public language switcher, e.g. "Українська". */
  nativeName: z.string().min(1),
  /** Right-to-left scripts need `dir="rtl"` on the public site. */
  direction: z.enum(['ltr', 'rtl']).default('ltr'),
  isDefault: z.boolean().default(false),
  /** Disabled locales stay in the database but are hidden from the public site. */
  enabled: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
  audit: auditSchema,
});
export type Locale = z.infer<typeof localeSchema>;

export const createLocaleSchema = localeSchema
  .omit({ id: true, audit: true, isDefault: true })
  .extend({ code: localeCodeSchema });
export type CreateLocaleInput = z.infer<typeof createLocaleSchema>;

export const updateLocaleSchema = createLocaleSchema.partial().omit({ code: true });
export type UpdateLocaleInput = z.infer<typeof updateLocaleSchema>;

/**
 * Query for `GET /api/locales`. `?enabled=true` is what the public site asks
 * for. `z.stringbool()` rather than `z.coerce.boolean()`, which reads the
 * string `"false"` as `true`.
 */
export const listLocalesQuerySchema = z.object({
  enabled: z.stringbool().optional(),
});
export type ListLocalesQuery = z.infer<typeof listLocalesQuerySchema>;

export const SEED_LOCALES = ['en', 'es', 'uk'] as const;
export const DEFAULT_LOCALE = 'en';
