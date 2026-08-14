import { describe, expect, it } from 'vitest';
import {
  MAX_LOCALES,
  MAX_LOCALIZED_TEXT_LENGTH,
  MAX_RICH_TEXT_LENGTH,
  assetRefSchema,
  documentIdSchema,
  externalDocumentIdSchema,
  localizedTextSchema,
  paginationQuerySchema,
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

/** The shape Firestore's own `collection.doc()` hands out: 20 mixed characters. */
const AUTO_ID = 'aB3xY9zQ1mN4pR7sT2vW';

describe('documentIdSchema', () => {
  it.each([
    ['__name__', 'the id Firestore itself uses for a document key'],
    ['__foo__', 'the general reserved form'],
    ['__', 'shorter than Firestore\'s documented "__.*__", and refused anyway'],
    ['__foo', 'a prefix without the closing underscores'],
  ])('refuses %s — %s', (id) => {
    // These are the cases the fix is: each one reached `collection.doc()` and
    // came back as an async INVALID_ARGUMENT from the server, which the
    // exception filter could only log as unhandled and answer 500.
    //
    // `__` and `__foo` matter on their own: Firestore's documented rule is
    // `__.*__`, which lets both through, so anyone "simplifying" this back to
    // the documented regex has to fail here.
    expect(documentIdSchema.safeParse(id).success).toBe(false);
  });

  it('names the reserved form in the message, not just the character class', () => {
    const result = documentIdSchema.safeParse('__name__');

    expect(result.error?.issues.map((issue) => issue.message)).toContain(
      'A Firestore document id cannot begin with "__", which Firestore reserves',
    );
  });

  it('accepts a Firestore auto-id', () => {
    expect(documentIdSchema.parse(AUTO_ID)).toBe(AUTO_ID);
  });

  it.each(['a_b', 'my-id', 'x__y', 'foo__', '_x_', 'sec-1', 'h5p-42'])(
    'accepts %s — underscores and hyphens are only reserved as a leading pair',
    (id) => {
      expect(documentIdSchema.parse(id)).toBe(id);
    },
  );

  it.each([
    ['0f4c1b2e-6f7a-4c2b-9d3e-5a1b2c3d4e5f', 'a randomUUID(), as H5P content ids are'],
    ['aBcDeFgHiJkLmNoPqRsTuVwXyZ01', 'a 28-character Firebase uid'],
  ])('accepts %s — %s', (id) => {
    // These are ids the system really stores; a schema that refused one would
    // break H5P saves and the admin user list rather than any attacker.
    expect(documentIdSchema.parse(id)).toBe(id);
  });

  it.each(['a/b', '.', '..', '', 'a b', 'a.b'])('refuses %s', (id) => {
    // Pre-existing behaviour, pinned so a rewrite of the character class cannot
    // drop it: `/` makes `doc()` throw on an odd segment count, and `.`/`..`
    // are path traversal.
    expect(documentIdSchema.safeParse(id).success).toBe(false);
  });

  it('accepts 128 characters and refuses 129 or 1501', () => {
    // The length bound predates this rule and is deliberately 11× tighter than
    // Firestore's 1500 bytes, so these pin the criterion rather than prove the
    // reserved-form fix. The character class is ASCII-only, which is what makes
    // 128 code units also 128 bytes.
    expect(documentIdSchema.parse('a'.repeat(128))).toHaveLength(128);
    expect(documentIdSchema.safeParse('a'.repeat(129)).success).toBe(false);
    expect(documentIdSchema.safeParse('a'.repeat(1501)).success).toBe(false);
  });
});

describe('paginationQuerySchema', () => {
  it('defaults the limit and coerces it from the query string', () => {
    expect(paginationQuerySchema.parse({})).toEqual({ limit: 25 });
    expect(paginationQuerySchema.parse({ limit: '10' })).toMatchObject({ limit: 10 });
  });

  it('accepts a cursor of the shape it hands back', () => {
    // `paginate` returns `nextCursor` as the last document's id, so a cursor
    // this API produced always parses back.
    expect(paginationQuerySchema.parse({ cursor: AUTO_ID })).toEqual({
      limit: 25,
      cursor: AUTO_ID,
    });
  });

  it('accepts a cursor over a collection keyed by ids this system did not mint', () => {
    // `GET /api/users` pages documents whose ids are Firebase uids, so it can
    // hand back this exact value as a `nextCursor`. On `documentIdSchema` the
    // API would 400 the cursor it had just produced.
    expect(paginationQuerySchema.parse({ cursor: 'auth0|5f2c1b2e' }).cursor).toBe('auth0|5f2c1b2e');
    expect(documentIdSchema.safeParse('auth0|5f2c1b2e').success).toBe(false);
  });

  it.each(['__name__', 'a/b', '..'])('refuses a cursor of %s', (cursor) => {
    // A cursor goes straight to `collection.doc(cursor).get()`, so an
    // unconstrained one 500s four list routes.
    expect(paginationQuerySchema.safeParse({ cursor }).success).toBe(false);
  });

  it('refuses an empty cursor rather than reading it as "no cursor"', () => {
    // A deliberate 2xx → 400: `?cursor=` used to reach `paginate`, whose
    // `if (cursor)` started from the beginning. Every neighbouring id-shaped
    // query parameter already refuses an empty value, and a caller with no
    // cursor omits the parameter — the admin's `toHttpParams` drops it.
    expect(paginationQuerySchema.safeParse({ cursor: '' }).success).toBe(false);
  });
});

describe('externalDocumentIdSchema', () => {
  it.each([
    ['auth0|5f2c1b2e6f7a4c2b9d3e5a1b', 'an Auth0 subject'],
    ['oidc:acct:ada@example.com', 'an OIDC subject with a colon and an @'],
    ['aBcDeFgHiJkLmNoPqRsTuVwXyZ01', 'a Firebase-generated uid'],
    ['a.b', 'a dot that is not the whole id'],
  ])('accepts %s — %s', (uid) => {
    // The alphabet belongs to the auth provider, so this schema answers only
    // "can Firestore store it", never "is it made of the right characters". A
    // uid refused here would turn a legitimate role change into a 400.
    expect(externalDocumentIdSchema.parse(uid)).toBe(uid);
  });

  it.each(['__name__', '__foo__', '__', '__foo', '.', '..', 'a/b', '/', ''])(
    'refuses %s, which Firestore itself refuses',
    (uid) => {
      // `PATCH /api/users/__name__/role` answered 500 for exactly this: Firebase
      // will create such a uid and Firestore will not store a document under it.
      expect(externalDocumentIdSchema.safeParse(uid).success).toBe(false);
    },
  );

  it("accepts 128 characters, Firebase Auth's own cap on a uid, and refuses 129", () => {
    expect(externalDocumentIdSchema.parse('a'.repeat(128))).toHaveLength(128);
    expect(externalDocumentIdSchema.safeParse('a'.repeat(129)).success).toBe(false);
  });

  it('is looser than documentIdSchema in the alphabet and no looser in the rules', () => {
    // The pair only makes sense if it differs in exactly one dimension: a later
    // tidy-up that collapses them would either 400 real provider uids or
    // reopen the reserved-id 500 on every route.
    expect(documentIdSchema.safeParse('auth0|123').success).toBe(false);
    expect(externalDocumentIdSchema.safeParse('auth0|123').success).toBe(true);

    for (const refused of ['__name__', '.', '..', 'a/b', '']) {
      expect(externalDocumentIdSchema.safeParse(refused).success).toBe(false);
      expect(documentIdSchema.safeParse(refused).success).toBe(false);
    }
  });
});
