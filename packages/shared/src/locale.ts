import { z } from 'zod';
import { auditSchema, localeCodeSchema } from './common.js';

/** Long enough for any endonym; short enough that a name is never a payload. */
const MAX_LOCALE_NAME_LENGTH = 100;

/**
 * The fields an admin edits, without their defaults. A stored document and a
 * create body both want the defaults, so they are applied in `localeSchema`
 * below — but never in the patch schema: `.partial()` wraps a field in optional
 * and keeps its inner `.default()`, so a patch schema derived from the create
 * schema would fill in every field the request left out and silently rewrite
 * the stored value.
 */
export const editableLocaleFields = {
  /** Name in English, for the admin UI, e.g. "Ukrainian". */
  name: z.string().min(1).max(MAX_LOCALE_NAME_LENGTH),
  /** Name in the locale itself, for the public language switcher, e.g. "Українська". */
  nativeName: z.string().min(1).max(MAX_LOCALE_NAME_LENGTH),
  /** Right-to-left scripts need `dir="rtl"` on the public site. */
  direction: z.enum(['ltr', 'rtl']),
  /** Disabled locales stay in the database but are hidden from the public site. */
  enabled: z.boolean(),
  sortOrder: z.number().int(),
};

/**
 * A locale the site is available in. Seeded with `en`, `es` and `uk`; admins
 * add more at runtime. Exactly one locale is the default and it cannot be
 * disabled or deleted.
 */
export const localeSchema = z.object({
  /** Document id equals the locale code. */
  id: localeCodeSchema,
  code: localeCodeSchema,
  name: editableLocaleFields.name,
  nativeName: editableLocaleFields.nativeName,
  direction: editableLocaleFields.direction.default('ltr'),
  isDefault: z.boolean().default(false),
  enabled: editableLocaleFields.enabled.default(true),
  sortOrder: editableLocaleFields.sortOrder.default(0),
  audit: auditSchema,
});
export type Locale = z.infer<typeof localeSchema>;

export const createLocaleSchema = localeSchema
  .omit({ id: true, audit: true, isDefault: true })
  .extend({ code: localeCodeSchema });
export type CreateLocaleInput = z.infer<typeof createLocaleSchema>;

/**
 * Body of `PATCH /api/locales/:code`: every key optional, none defaulted, so a
 * request that carries one field changes exactly that field. `code` is absent
 * because it is the document id and cannot move.
 */
export const updateLocaleSchema = z.object(editableLocaleFields).partial();
export type UpdateLocaleInput = z.infer<typeof updateLocaleSchema>;

/**
 * Query for `GET /api/locales`. `?enabled=true` is what the public site asks
 * for; the flag only ever narrows, so `?enabled=false` and an absent flag both
 * mean "everything" rather than "only the disabled ones". `z.stringbool()`
 * rather than `z.coerce.boolean()`, which reads the string `"false"` as `true`.
 */
export const listLocalesQuerySchema = z.object({
  enabled: z.stringbool().optional(),
});
export type ListLocalesQuery = z.infer<typeof listLocalesQuerySchema>;

export const SEED_LOCALES = ['en', 'es', 'uk'] as const;
export const DEFAULT_LOCALE = 'en';
