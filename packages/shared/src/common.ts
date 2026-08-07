import { z } from 'zod';

/**
 * A BCP-47 locale code, e.g. `en`, `es`, `uk`, `en-GB`.
 */
export const localeCodeSchema = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|\d{3}))?$/, 'Must be a BCP-47 locale code');

export type LocaleCode = z.infer<typeof localeCodeSchema>;

/**
 * Content translated per locale. Keys are locale codes; the default locale is
 * always present, other locales are filled in as translations land.
 */
export const localizedTextSchema = z.record(localeCodeSchema, z.string());
export type LocalizedText = z.infer<typeof localizedTextSchema>;

/**
 * Rich text is stored as sanitized HTML produced by the admin editor. It may
 * embed `<audio>`, `<img>` and `<figure>` nodes that point at asset URLs.
 */
export const richTextSchema = z.record(localeCodeSchema, z.string());
export type RichText = z.infer<typeof richTextSchema>;

/**
 * Reads one locale out of a localized value. See ADR-009: a value that is
 * absent — or present but empty, which is what the editor writes for a tab the
 * author opened and left blank — falls back to the default locale, and only
 * then to `''`. Nothing localized ever reaches a template as `undefined`.
 *
 * `defaultLocale` is a parameter rather than the `DEFAULT_LOCALE` constant
 * because that constant lives in `locale.ts`, which imports this module.
 */
export function resolveLocalized(
  value: LocalizedText | RichText | null | undefined,
  locale: LocaleCode,
  defaultLocale: LocaleCode,
): string {
  return pickLocale(value, locale) ?? pickLocale(value, defaultLocale) ?? '';
}

function pickLocale(
  value: LocalizedText | RichText | null | undefined,
  locale: LocaleCode,
): string | undefined {
  const text = value?.[locale];
  return text !== undefined && text.trim().length > 0 ? text : undefined;
}

export const publishStatusSchema = z.enum(['draft', 'published', 'archived']);
export type PublishStatus = z.infer<typeof publishStatusSchema>;

/** ISO-8601 timestamp string. Firestore Timestamps are converted at the repository boundary. */
export const isoDateTimeSchema = z.iso.datetime({ offset: true });

/**
 * A Firestore document id. Constrained so a hand-crafted path segment cannot
 * reach `collection.doc()` as `..` or a nested path — a value carrying `/`
 * makes `doc()` throw for an odd number of segments, which would turn a bad
 * request into a 500.
 */
export const documentIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'Must be a Firestore document id');

/**
 * URL-safe identifier used in public routes, unique among siblings.
 */
export const slugSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Must be lowercase kebab-case');

export const auditSchema = z.object({
  createdAt: isoDateTimeSchema,
  createdBy: z.string(),
  updatedAt: isoDateTimeSchema,
  updatedBy: z.string(),
});
export type Audit = z.infer<typeof auditSchema>;

/** Reference to a file in Cloud Storage (or the local fake-gcs emulator). */
export const assetRefSchema = z.object({
  /** Storage object path, e.g. `images/sections/abc123.webp`. */
  path: z.string().min(1),
  /** Publicly resolvable URL for the object. */
  url: z.url(),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  /** Localized alt text — required for images to keep the public site accessible. */
  alt: localizedTextSchema.optional(),
});
export type AssetRef = z.infer<typeof assetRefSchema>;

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
