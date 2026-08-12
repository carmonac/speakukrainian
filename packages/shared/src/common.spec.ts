import { describe, expect, it } from 'vitest';
import {
  MAX_LOCALES,
  MAX_LOCALIZED_TEXT_LENGTH,
  MAX_RICH_TEXT_LENGTH,
  assetRefSchema,
  localizedTextSchema,
  resolveLocalized,
  richTextSchema,
  storedAssetRefSchema,
  storedLocalizedTextSchema,
  storedRichTextSchema,
} from './common.js';
import type { LocalizedText, RichText } from './common.js';

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/**
 * Distinct codes `localeCodeSchema` accepts (`zaa`, `zab`, …), so a case can
 * hold more translations than the site can have locales without any of them
 * being refused for its spelling — the bound under test is the count, not the
 * key.
 */
const localeCodes = (count: number): string[] =>
  Array.from(
    { length: count },
    (_unused, index) =>
      `z${LETTERS[Math.floor(index / LETTERS.length)]}${LETTERS[index % LETTERS.length]}`,
  );

/** One character per entry, so nothing here can be refused for its length. */
const oneCharIn = (codes: string[]): Record<string, string> =>
  Object.fromEntries(codes.map((code) => [code, 'x']));

describe('resolveLocalized', () => {
  const value: LocalizedText = { en: 'Hello', uk: 'Привіт' };

  it('returns the requested locale', () => {
    expect(resolveLocalized(value, 'uk', 'en')).toBe('Привіт');
  });

  it('falls back to the default locale when the requested key is absent', () => {
    expect(resolveLocalized(value, 'es', 'en')).toBe('Hello');
  });

  it('treats an empty string as a missing translation', () => {
    // The localized editor writes a key for every tab the author opens, so this
    // is the ordinary shape of half-translated content — ADR-009.
    expect(resolveLocalized({ en: 'Hello', es: '' }, 'es', 'en')).toBe('Hello');
  });

  it('treats a whitespace-only string as a missing translation', () => {
    expect(resolveLocalized({ en: 'Hello', es: '   \n ' }, 'es', 'en')).toBe('Hello');
  });

  it('returns an empty string when neither locale is present', () => {
    expect(resolveLocalized({ uk: 'Привіт' }, 'es', 'en')).toBe('');
  });

  it('returns an empty string for an undefined value', () => {
    expect(resolveLocalized(undefined, 'en', 'en')).toBe('');
  });

  it('returns an empty string for a null value', () => {
    expect(resolveLocalized(null, 'en', 'en')).toBe('');
  });

  it('returns an empty string when the requested locale is the blank default', () => {
    expect(resolveLocalized({ en: '' }, 'en', 'en')).toBe('');
  });

  it('resolves rich text with the same rules', () => {
    const body: RichText = { en: '<p>Hi</p>' };
    expect(resolveLocalized(body, 'uk', 'en')).toBe('<p>Hi</p>');
  });
});

describe('MAX_LOCALES', () => {
  it('is declared in this module, not re-exported from locale.ts', () => {
    // The constant has to be *here*: `locale.ts` imports this file, so reaching
    // back for it would put it in its temporal dead zone while the schemas
    // below are being built — a crash at module evaluation, not a test failure.
    expect(MAX_LOCALES).toBe(100);
  });
});

describe('localizedTextSchema', () => {
  it(`accepts ${MAX_LOCALIZED_TEXT_LENGTH} characters in each of two locales`, () => {
    // The bound is per locale, not a total across them: read the other way this
    // value is twice over, and adding a translation would invalidate the ones
    // already authored (ADR-014).
    const full = 'a'.repeat(MAX_LOCALIZED_TEXT_LENGTH);

    expect(localizedTextSchema.parse({ en: full, uk: full })).toEqual({ en: full, uk: full });
  });

  it('refuses an entry one character over, and names the locale that broke it', () => {
    // Two locales, one of them within the bound, so the count bound cannot be
    // what refuses this — and an author editing four tabs is told which one.
    const result = localizedTextSchema.safeParse({
      en: 'short',
      uk: 'я'.repeat(MAX_LOCALIZED_TEXT_LENGTH + 1),
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['uk']);
    expect(result.error?.issues[0]?.code).toBe('too_big');
  });

  it(`accepts a translation in each of ${MAX_LOCALES} locales`, () => {
    const value = oneCharIn(localeCodes(MAX_LOCALES));

    expect(Object.keys(localizedTextSchema.parse(value))).toHaveLength(MAX_LOCALES);
  });

  it(`refuses a value carrying more than ${MAX_LOCALES} translations`, () => {
    // Every key is a valid locale code and every value is one character, so
    // what is refused is the *number* of translations. Without this the
    // per-entry bound bounds nothing: a caller invents locale codes faster than
    // the site can have locales.
    const result = localizedTextSchema.safeParse(oneCharIn(localeCodes(MAX_LOCALES + 1)));

    expect(result.success).toBe(false);
    // Against the value as a whole: no single entry is the one too many.
    expect(result.error?.issues[0]?.path).toEqual([]);
    expect(result.error?.issues[0]?.message).toContain(String(MAX_LOCALES));
  });

  it('reports both failures when a value is over-long and over-count at once', () => {
    // Zod runs the refinement whatever the inner check did, so an author fixing
    // the length is not then told about the count. Rewriting this pair as one
    // early-returning `superRefine` — the shape `timeZoneSchema` uses for its
    // own reason — would report one issue and fail here, as it should.
    const value = oneCharIn(localeCodes(MAX_LOCALES + 1));
    value['uk'] = 'a'.repeat(MAX_LOCALIZED_TEXT_LENGTH + 1);

    const result = localizedTextSchema.safeParse(value);

    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(2);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([['uk'], []]);
  });
});

describe('richTextSchema', () => {
  it(`accepts ${MAX_RICH_TEXT_LENGTH} characters in each of two locales`, () => {
    const full = `<p>${'a'.repeat(MAX_RICH_TEXT_LENGTH - 7)}</p>`;
    expect(full).toHaveLength(MAX_RICH_TEXT_LENGTH);

    expect(richTextSchema.parse({ en: full, uk: full })).toEqual({ en: full, uk: full });
  });

  it('refuses an entry one character over, and names the locale that broke it', () => {
    const result = richTextSchema.safeParse({
      en: '<p>short</p>',
      uk: 'я'.repeat(MAX_RICH_TEXT_LENGTH + 1),
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['uk']);
    expect(result.error?.issues[0]?.code).toBe('too_big');
  });

  it(`accepts a translation in each of ${MAX_LOCALES} locales`, () => {
    const value = oneCharIn(localeCodes(MAX_LOCALES));

    expect(Object.keys(richTextSchema.parse(value))).toHaveLength(MAX_LOCALES);
  });

  it(`refuses a value carrying more than ${MAX_LOCALES} translations`, () => {
    const result = richTextSchema.safeParse(oneCharIn(localeCodes(MAX_LOCALES + 1)));

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual([]);
    expect(result.error?.issues[0]?.message).toContain(String(MAX_LOCALES));
  });

  it('reports both failures when a value is over-long and over-count at once', () => {
    const value = oneCharIn(localeCodes(MAX_LOCALES + 1));
    value['uk'] = 'a'.repeat(MAX_RICH_TEXT_LENGTH + 1);

    const result = richTextSchema.safeParse(value);

    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(2);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([['uk'], []]);
  });

  it('allows a rich text entry to be far longer than a plain one', () => {
    // The two bounds are separate decisions — a lesson runs to tens of
    // thousands of characters and a title does not — so a later tidy-up that
    // collapses them onto one number has to fail here.
    expect(MAX_RICH_TEXT_LENGTH).toBeGreaterThan(MAX_LOCALIZED_TEXT_LENGTH);
    expect(
      richTextSchema.safeParse({ en: 'a'.repeat(MAX_LOCALIZED_TEXT_LENGTH + 1) }).success,
    ).toBe(true);
  });
});

describe('the stored variants stay lenient (ADR-012)', () => {
  // The alarm for the failure the whole split exists to prevent. A bound that
  // reached the stored schema would 500 the public menu, the admin tree and the
  // offending document's own edit screen at once — and `RichTextSanitizer` runs
  // *after* the pipe and can grow a value past the bound it just passed, so the
  // API would brick itself with no attacker involved.
  it('reads back a localized value the input schema refuses', () => {
    const value = oneCharIn(localeCodes(MAX_LOCALES + 1));
    value['uk'] = 'a'.repeat(MAX_LOCALIZED_TEXT_LENGTH + 1);

    expect(localizedTextSchema.safeParse(value).success).toBe(false);
    expect(storedLocalizedTextSchema.parse(value)).toEqual(value);
  });

  it('reads back rich text the input schema refuses', () => {
    const value = oneCharIn(localeCodes(MAX_LOCALES + 1));
    value['uk'] = 'a'.repeat(MAX_RICH_TEXT_LENGTH + 1);

    expect(richTextSchema.safeParse(value).success).toBe(false);
    expect(storedRichTextSchema.parse(value)).toEqual(value);
  });
});

describe('assetRefSchema', () => {
  const asset = {
    path: 'images/2026/08/a.png',
    url: 'https://cdn.test/images/2026/08/a.png',
    contentType: 'image/png',
    sizeBytes: 2048,
  };

  it('refuses an over-long alt entry, pathed to the locale', () => {
    const result = assetRefSchema.safeParse({
      ...asset,
      alt: { en: 'a'.repeat(MAX_LOCALIZED_TEXT_LENGTH + 1) },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['alt', 'en']);
  });

  it('accepts alt text within the bound', () => {
    const alt = { en: 'A page of a Ukrainian workbook' };

    expect(assetRefSchema.parse({ ...asset, alt }).alt).toEqual(alt);
  });

  it('still reads a stored asset whose alt is over the bound', () => {
    const alt = { en: 'a'.repeat(MAX_LOCALIZED_TEXT_LENGTH + 1) };

    expect(storedAssetRefSchema.parse({ ...asset, alt }).alt).toEqual(alt);
  });
});
