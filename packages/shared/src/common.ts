import { z } from 'zod';

/**
 * A BCP-47 locale code, e.g. `en`, `es`, `uk`, `en-GB`.
 */
export const localeCodeSchema = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|\d{3}))?$/, 'Must be a BCP-47 locale code');

export type LocaleCode = z.infer<typeof localeCodeSchema>;

/**
 * A site has a handful of languages; the cap exists so no read of the locales
 * collection is unbounded, and `LocalesService` is what makes it true by
 * refusing to create the hundred-and-first.
 *
 * It is also the bound on every localized value below: a
 * `Record<LocaleCode, string>` can only hold a translation for a locale that
 * exists, so a value with more entries than this carries translations for
 * locales the site cannot have. It is the **cap** and not the live locale
 * count, which would cost a locales read on every write and would fail a stored
 * value the day a locale is deleted.
 *
 * It lives in this module rather than in `locale.ts` because the schemas below
 * are built from it and `locale.ts` imports this file: importing it back would
 * be an ESM cycle with the constant in its temporal dead zone while these
 * schemas are being constructed, which crashes at module evaluation rather than
 * failing a test — vitest resolves each module on its own, and `tsc` compiles
 * the cycle happily. The package's `postbuild` script imports the built package
 * for exactly that reason, so reintroducing the cycle fails `pnpm build`.
 */
export const MAX_LOCALES = 100;

/**
 * Longest one translation of a plain localized field may be — `title`,
 * `menuLabel`, `seo.metaTitle`, `seo.metaDescription`, `assetRef.alt`.
 *
 * Per locale and not in total across them: a total would make the sixth
 * translation fail for text already authored in five languages, and report it
 * against whichever locale happened to be saved last (ADR-014).
 *
 * 500 is ~3× the largest external limit any of these fields answers to — Google
 * truncates a `<title>` near 60 characters and a meta description near 160, and
 * screen-reader guidance puts alt text near 125 — and ~45× the longest title
 * anything has actually stored. No field takes a tighter number of its own,
 * because those external limits are *truncation* rather than failure: enforcing
 * 160 on a meta description would turn a cosmetic search-result ellipsis into a
 * refused save.
 */
export const MAX_LOCALIZED_TEXT_LENGTH = 500;

/**
 * Longest one translation of a rich text field may be, decided separately from
 * the plain one because the editor legitimately produces long HTML.
 *
 * Media is referenced by absolute storage URL and never inlined as a data URI,
 * so a body's size is prose and node count, not asset bytes: an `<img>` node is
 * ~140 characters and an `<audio>` node ~295. Measured against that, a typical
 * lesson (20 paragraphs, 6 clips, 2 images) is ~7 900 characters per locale, a
 * deliberately heavy page (40 paragraphs, 30 clips, 12 images) ~22 200, and the
 * heaviest page anyone could plausibly author ~58 200. 100 000 clears the last
 * of those by 1.7×, and reaching it in one language takes ~340 dense paragraphs.
 *
 * It also stays inside the two ceilings underneath it: `.max()` counts UTF-16
 * code units and Ukrainian prose measures ~1.8 UTF-8 bytes per character, so a
 * single-locale field at this bound is ~300 KB on the wire — under both the
 * 1 MiB body limit (ADR-015) and Firestore's 1 048 576-byte document ceiling.
 */
export const MAX_RICH_TEXT_LENGTH = 100_000;

/**
 * The admin's error interceptor raises these in a toast with the issue path
 * stripped, so each has to say what kind of field it came from on its own.
 */
const TOO_LONG_TEXT = `Each translation is limited to ${MAX_LOCALIZED_TEXT_LENGTH} characters`;
const TOO_LONG_RICH_TEXT = `Each translation of a rich text field is limited to ${MAX_RICH_TEXT_LENGTH} characters — split a longer lesson across pages`;
/** Reported against the value as a whole: no one entry is the one too many. */
const TOO_MANY_TRANSLATIONS = `A localized value cannot carry more than ${MAX_LOCALES} translations — the most the site can have`;

/**
 * Content translated per locale, as a stored document holds it. Keys are locale
 * codes; the default locale is always present, other locales are filled in as
 * translations land.
 *
 * Deliberately unbounded, and {@link localizedTextSchema} is where the bounds
 * live (ADR-012). Two reasons, both about documents that already exist: a
 * repository parses every document it reads through the stored schema, so one
 * over-long stored title would 500 the public menu, the admin tree and that
 * section's own edit screen at once — leaving no screen from which to repair it;
 * and `RichTextSanitizer` runs *after* the pipe and re-serializes what it
 * cleans (`&` becomes `&amp;`, `controls` becomes `controls=""`), so a value
 * that passed at exactly the bound can be stored over it, with no attacker
 * involved.
 */
export const storedLocalizedTextSchema = z.record(localeCodeSchema, z.string());

/**
 * Localized text as a request may carry it: bounded twice, and it needs both.
 * The per-entry bound alone bounds nothing, because a caller can invent valid
 * locale codes faster than the site can have locales — 500 characters under
 * each of a few hundred invented codes is a value of any size they like.
 *
 * It has the plain name because it is what almost every caller wants;
 * {@link storedLocalizedTextSchema} is the exception and says so.
 */
export const localizedTextSchema = z
  .record(localeCodeSchema, z.string().max(MAX_LOCALIZED_TEXT_LENGTH, TOO_LONG_TEXT))
  .refine((value) => Object.keys(value).length <= MAX_LOCALES, {
    message: TOO_MANY_TRANSLATIONS,
  });
export type LocalizedText = z.infer<typeof localizedTextSchema>;

/**
 * Rich text is stored as sanitized HTML produced by the admin editor. It may
 * embed `<audio>`, `<img>` and `<figure>` nodes that point at asset URLs.
 *
 * The stored variant, lenient for the same two reasons
 * {@link storedLocalizedTextSchema} carries — and the sanitizer one bites here
 * in particular, since this is the field it rewrites.
 *
 * Leniency here fixes the *read* half of that only: a body the sanitizer grew
 * past the bound is still served and still repairable, but the next save carries
 * it back and {@link richTextSchema} refuses it, so a title-only edit on that
 * page fails until the text is shortened. Accepted rather than given slack —
 * slack only moves the boundary — and the closure is to re-parse the sanitized
 * body at the write boundary, which is a follow-up issue. See ADR-012.
 */
export const storedRichTextSchema = z.record(localeCodeSchema, z.string());

/** Rich text as a request may carry it, bounded per entry and by entry count. */
export const richTextSchema = z
  .record(localeCodeSchema, z.string().max(MAX_RICH_TEXT_LENGTH, TOO_LONG_RICH_TEXT))
  .refine((value) => Object.keys(value).length <= MAX_LOCALES, {
    message: TOO_MANY_TRANSLATIONS,
  });
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
 * A Firestore document id. Firestore's four rules are that an id may not be `.`
 * or `..`, may not contain `/`, may not be of the reserved `__…__` form, and is
 * capped at 1500 bytes; the character class covers the first two, the second
 * regex covers the third, and `.max(128)` covers the fourth.
 *
 * All of it lives on this schema rather than on a guard inside the
 * repositories, because Firestore does **not** refuse a reserved id at
 * `collection.doc()` — that call happily returns a reference, and the refusal
 * comes back asynchronously from the server as
 * `3 INVALID_ARGUMENT: Resource id "__name__" is invalid because it is
 * reserved`. By the time it exists it is inside a transaction, it is a plain
 * `Error` rather than an `HttpException`, and `HttpExceptionFilter` can only
 * log it as unhandled and answer 500 — for input this schema exists to refuse.
 * Validating at the pipe turns that into a 400 before any I/O happens.
 *
 * The reserved rule is written as a `__` **prefix** rather than Firestore's
 * documented `__.*__` because the documented form is not the line the server
 * actually draws: the emulator refuses `__name__` and `__foo__` but accepts
 * `__`, `___` and `____`. The prefix is a superset of the documented regex and
 * of what the emulator enforces, and it costs nothing to over-reject `__foo`,
 * since no id this system produces begins with `__` — they are Firestore
 * auto-ids, `randomUUID()`s and Firebase uids.
 *
 * 128 rather than Firestore's 1500 for the same reason: the longest id anything
 * here writes is a 36-character UUID, and because the character class is
 * ASCII-only, 128 UTF-16 code units is exactly 128 bytes, so nothing has to
 * count bytes to stay an order of magnitude inside the real cap.
 */
export const documentIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'Must be a Firestore document id')
  .regex(/^(?!__)/, 'A Firestore document id cannot begin with "__", which Firestore reserves');

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

/**
 * Reference to a file in Cloud Storage (or the local fake-gcs emulator), as a
 * stored document holds it — its `alt` is read leniently for the reason
 * {@link storedLocalizedTextSchema} gives.
 */
export const storedAssetRefSchema = z.object({
  /** Storage object path, e.g. `images/sections/abc123.webp`. */
  path: z.string().min(1),
  /** Publicly resolvable URL for the object. */
  url: z.url(),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  /** Localized alt text — required for images to keep the public site accessible. */
  alt: storedLocalizedTextSchema.optional(),
});

/** The same reference as a request may carry it: `alt` is bounded. */
export const assetRefSchema = storedAssetRefSchema.extend({
  alt: localizedTextSchema.optional(),
});
export type AssetRef = z.infer<typeof assetRefSchema>;

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /**
   * The id of the last document of the previous page —
   * `BaseRepository.paginate` hands it straight to `collection.doc(cursor)` —
   * so it takes the document id rule. A `nextCursor` this API produced is a
   * document id of the collection being paged and always parses back.
   */
  cursor: documentIdSchema.optional(),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
