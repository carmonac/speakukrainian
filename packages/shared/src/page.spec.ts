import { describe, expect, it } from 'vitest';
import { MAX_LOCALES, MAX_LOCALIZED_TEXT_LENGTH, MAX_RICH_TEXT_LENGTH } from './common.js';
import {
  contentPageSchema,
  createContentPageSchema,
  editableContentPageFields,
  h5pExercisePageBodySchema,
  listPagesQuerySchema,
  pageBodySchema,
  richTextPageBodySchema,
  storedH5pExercisePageBodySchema,
  updateContentPageSchema,
} from './page.js';

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/** Distinct codes `localeCodeSchema` accepts (`zaa`, `zab`, …), one character each. */
const oneCharInLocales = (count: number): Record<string, string> =>
  Object.fromEntries(
    Array.from({ length: count }, (_unused, index) => [
      `z${LETTERS[Math.floor(index / LETTERS.length)]}${LETTERS[index % LETTERS.length]}`,
      'x',
    ]),
  );

const tooLongRichText = 'a'.repeat(MAX_RICH_TEXT_LENGTH + 1);

/** The absolute storage URLs a body actually carries — media is never inlined. */
const storageUrl = (path: string): string =>
  `http://localhost:4443/storage/v1/b/speakukrainian-media/o/${encodeURIComponent(path)}?alt=media`;

/** An `<audio>` node in the form `audio.extension.ts` renders. */
const audioNode = (index: number): string =>
  `<audio src="${storageUrl(`audio/2026/08/motion-${index}.mp3`)}" title="Verbs of motion ${index}" data-asset-path="audio/2026/08/motion-${index}.mp3" controls="true" preload="metadata"></audio>`;

const imageNode = (index: number): string =>
  `<img src="${storageUrl(`images/2026/08/motion-${index}.png`)}" alt="Verbs of motion ${index}">`;

/**
 * A lesson of the size this product really publishes: prose, headings, a dozen
 * images and half a dozen clips, all media referenced by URL. The AC asks for a
 * body of representative size rather than a token string, so the test that uses
 * it asserts its length too.
 */
const lesson = (locale: string): string => {
  const parts = [`<h2>${locale} — verbs of motion</h2>`];
  for (let index = 0; index < 160; index += 1) {
    parts.push(
      `<p>${locale} ${index}: a prefix on a verb of motion carries both the direction of travel and the aspect of the action.</p>`,
    );
    if (index % 12 === 0) {
      parts.push(imageNode(index));
    }
    if (index % 24 === 0) {
      parts.push(audioNode(index));
    }
  }
  return parts.join('');
};

const audit = {
  createdAt: '2026-01-01T00:00:00Z',
  createdBy: 'admin',
  updatedAt: '2026-01-01T00:00:00Z',
  updatedBy: 'admin',
};

const basePage = {
  id: 'page-1',
  sectionId: 'sec-1',
  slug: 'intro',
  path: '/grammar-points/intro',
  title: { en: 'Introduction' },
  sortOrder: 0,
  status: 'draft' as const,
  publishedAt: null,
  audit,
};

describe('pageBodySchema', () => {
  it('parses a rich text body with audio', () => {
    const body = pageBodySchema.parse({
      type: 'rich_text',
      content: { en: '<p>Listen:</p><audio src="https://cdn/a.mp3"></audio>' },
      audioAssets: [
        {
          path: 'audio/a.mp3',
          url: 'https://cdn/a.mp3',
          contentType: 'audio/mpeg',
          sizeBytes: 1024,
        },
      ],
    });
    expect(body.type).toBe('rich_text');
  });

  it('defaults a subsection list to an image grid', () => {
    const body = pageBodySchema.parse({ type: 'subsection_list' });
    expect(body).toMatchObject({ layout: 'grid', showImages: true, showDescriptions: true });
  });

  it('starts an H5P exercise with no content attached', () => {
    const body = pageBodySchema.parse({ type: 'h5p_exercise' });
    expect(body).toMatchObject({ h5pContentId: null, explanationPosition: 'above' });
  });

  it('rejects an unknown page type', () => {
    expect(pageBodySchema.safeParse({ type: 'video' }).success).toBe(false);
  });
});

describe('pageBodySchema strictness', () => {
  // A plain `z.object` drops an unknown key and reports success, so each of
  // these used to be a save that stored none of what it was sent.
  it.each([
    [
      'a subsection list carrying rich text content',
      { type: 'subsection_list', content: { en: '<p>x</p>' } },
      'content',
    ],
    [
      'a rich text body carrying an H5P id',
      { type: 'rich_text', content: { en: '<p>x</p>' }, h5pContentId: 'h5p-1' },
      'h5pContentId',
    ],
    [
      'an H5P exercise carrying rich text content',
      { type: 'h5p_exercise', content: { en: '<p>x</p>' } },
      'content',
    ],
  ])('rejects %s', (_name, body, key) => {
    const result = pageBodySchema.safeParse(body);

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
    expect(result.error?.issues[0]).toMatchObject({ keys: [key] });
  });

  it('paths the refusal at the body when the whole page is parsed', () => {
    // The admin renders the issue against the body field, so the path has to
    // survive the trip through the outer schema.
    const result = createContentPageSchema.safeParse({
      sectionId: 'sec-1',
      slug: 'intro',
      title: { en: 'Introduction' },
      body: { type: 'rich_text', content: { en: '<p>x</p>' }, h5pContentId: 'h5p-1' },
    });

    expect(result.error?.issues[0]?.path).toEqual(['body']);
  });

  it.each([
    [
      'rich_text',
      { type: 'rich_text', content: { en: '<p>x</p>' } },
      { audioAssets: [], imageAssets: [] },
    ],
    ['subsection_list', { type: 'subsection_list' }, { layout: 'grid', showImages: true }],
    ['h5p_exercise', { type: 'h5p_exercise' }, { h5pContentId: null, trackResults: false }],
  ])('still parses a %s body with its optional fields omitted', (_name, body, defaults) => {
    // Strictness must bite on unknown keys only: a variant that lost its own
    // defaults would refuse every body the admin actually sends.
    expect(pageBodySchema.parse(body)).toMatchObject(defaults);
  });
});

describe('contentPageSchema', () => {
  it('refuses to publish an H5P page with no uploaded content', () => {
    // Publishing an empty exercise would render a blank frame to learners.
    const result = contentPageSchema.safeParse({
      ...basePage,
      status: 'published',
      body: { type: 'h5p_exercise', h5pContentId: null, explanationPosition: 'above' },
    });
    expect(result.success).toBe(false);
  });

  it('allows publishing once H5P content exists', () => {
    const result = contentPageSchema.safeParse({
      ...basePage,
      status: 'published',
      body: { type: 'h5p_exercise', h5pContentId: 'h5p-42', explanationPosition: 'above' },
    });
    expect(result.success).toBe(true);
  });

  it('allows an H5P page to stay in draft while empty', () => {
    const result = contentPageSchema.safeParse({
      ...basePage,
      status: 'draft',
      body: { type: 'h5p_exercise', h5pContentId: null, explanationPosition: 'above' },
    });
    expect(result.success).toBe(true);
  });

  it('defaults a stored document written before the flags existed', () => {
    const { sortOrder: _sortOrder, status: _status, ...old } = basePage;

    expect(
      contentPageSchema.parse({
        ...old,
        body: { type: 'subsection_list' },
      }),
    ).toMatchObject({ sortOrder: 0, status: 'draft' });
  });
});

describe('createContentPageSchema', () => {
  it('defaults a new page to a draft and leaves sortOrder to the repository', () => {
    const parsed = createContentPageSchema.parse({
      sectionId: 'sec-1',
      slug: 'intro',
      title: { en: 'Introduction' },
      body: { type: 'rich_text', content: { en: '<p>Hi</p>' } },
    });

    expect(parsed.status).toBe('draft');
    expect(parsed.sortOrder).toBeUndefined();
  });

  it('rejects a sectionId that is not a document id', () => {
    // `collection.doc('a/b')` throws for an odd number of segments, which would
    // turn a bad request into a 500 instead of a 400.
    expect(
      createContentPageSchema.safeParse({
        sectionId: 'a/b',
        slug: 'intro',
        title: { en: 'Introduction' },
        body: { type: 'subsection_list' },
      }).success,
    ).toBe(false);
  });

  it('rejects a sourceSectionId that is not a document id', () => {
    // The other document id a page request carries: rendering a subsection list
    // hands it to `collection.doc()`, so an unconstrained one stores with a 201
    // and reads back as a 500.
    const result = createContentPageSchema.safeParse({
      sectionId: 'sec-1',
      slug: 'intro',
      title: { en: 'Introduction' },
      body: { type: 'subsection_list', sourceSectionId: 'a/b/../c' },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['body', 'sourceSectionId']);

    expect(
      createContentPageSchema.safeParse({
        sectionId: 'sec-1',
        slug: 'intro',
        title: { en: 'Introduction' },
        body: { type: 'subsection_list', sourceSectionId: 'sec-2' },
      }).success,
    ).toBe(true);
  });
});

describe('h5pContentId is a document id on the way in (ADR-012)', () => {
  it('refuses a reserved Firestore id, pathed to the field', () => {
    // It is the id of another document and Phase 2 renders the exercise by
    // handing it to `collection.doc()`, where a reserved id comes back as an
    // async INVALID_ARGUMENT and a 500.
    const result = h5pExercisePageBodySchema.safeParse({
      type: 'h5p_exercise',
      h5pContentId: '__name__',
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['h5pContentId']);
  });

  it('still accepts a real content id and an explicit null', () => {
    // Null is the ordinary state of an exercise page before its first upload,
    // so the tightening must not make one unsavable.
    expect(
      h5pExercisePageBodySchema.parse({
        type: 'h5p_exercise',
        h5pContentId: '0f4c1b2e-6f7a-4c2b-9d3e-5a1b2c3d4e5f',
      }).h5pContentId,
    ).toBe('0f4c1b2e-6f7a-4c2b-9d3e-5a1b2c3d4e5f');
    expect(
      h5pExercisePageBodySchema.parse({ type: 'h5p_exercise', h5pContentId: null }).h5pContentId,
    ).toBeNull();
  });

  it('reads back a stored value the input schema refuses', () => {
    // The stored variant stays lenient so a document written before the rule
    // existed is still readable and still repairable through the admin — the
    // whole point of the split. Firestore cannot actually hold a reserved id,
    // which is why this is the ADR-012 shape and not a live hazard.
    expect(
      storedH5pExercisePageBodySchema.parse({
        type: 'h5p_exercise',
        h5pContentId: '__name__',
      }).h5pContentId,
    ).toBe('__name__');
  });
});

describe('localized bounds on a page request', () => {
  const page = (body: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    sectionId: 'sec-1',
    slug: 'intro',
    title: { en: 'Introduction' },
    body,
    ...extra,
  });

  it('refuses an over-long rich text body, pathed to the locale', () => {
    const result = createContentPageSchema.safeParse(
      page({ type: 'rich_text', content: { en: '<p>ok</p>', uk: tooLongRichText } }),
    );

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['body', 'content', 'uk']);
  });

  it('refuses an over-long subsection list intro', () => {
    // One case per variant: a variant the derivation missed would accept this.
    const result = createContentPageSchema.safeParse(
      page({ type: 'subsection_list', intro: { uk: tooLongRichText } }),
    );

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['body', 'intro', 'uk']);
  });

  it('refuses an over-long H5P explanation', () => {
    const result = createContentPageSchema.safeParse(
      page({ type: 'h5p_exercise', explanation: { uk: tooLongRichText } }),
    );

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['body', 'explanation', 'uk']);
  });

  it.each(['imageAssets', 'audioAssets'])(
    'refuses an over-long alt on a body %s entry, pathed through the array',
    (field) => {
      // The one bound the derivation re-applies by hand: `.extend()` replaces
      // both asset arrays wholesale, so a later simplification of that extend
      // would drop it without changing anything else.
      const result = createContentPageSchema.safeParse(
        page({
          type: 'rich_text',
          content: { en: '<p>ok</p>' },
          [field]: [
            {
              path: 'images/2026/08/motion-0.png',
              url: storageUrl('images/2026/08/motion-0.png'),
              contentType: 'image/png',
              sizeBytes: 2048,
              alt: { en: 'a'.repeat(MAX_LOCALIZED_TEXT_LENGTH + 1) },
            },
          ],
        }),
      );

      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['body', field, 0, 'alt', 'en']);
    },
  );

  it('refuses an over-long meta description, pathed to the locale', () => {
    const result = createContentPageSchema.safeParse(
      page(
        { type: 'subsection_list' },
        {
          seo: {
            metaDescription: { en: 'a'.repeat(MAX_LOCALIZED_TEXT_LENGTH + 1) },
          },
        },
      ),
    );

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['seo', 'metaDescription', 'en']);
  });

  it(`refuses a title carrying more than ${MAX_LOCALES} translations`, () => {
    // Every value is one character, so the count is the only thing refusing it.
    const result = createContentPageSchema.safeParse({
      ...page({ type: 'subsection_list' }),
      title: oneCharInLocales(MAX_LOCALES + 1),
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['title']);
    expect(result.error?.issues[0]?.message).toContain(String(MAX_LOCALES));
  });

  it('refuses an over-long rich text body on a patch too', () => {
    // `.partial()` keeps what is inside a field, so an edit cannot store what a
    // create refused.
    const result = updateContentPageSchema.safeParse({
      body: { type: 'rich_text', content: { uk: tooLongRichText } },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['body', 'content', 'uk']);
  });

  it('still reports an unknown key and applies the asset defaults after .extend()', () => {
    // The bounded variants are derived from the stored ones, and `.extend()`
    // silently dropping the strict catchall would reopen "a save reporting
    // success for a write that did not happen".
    const result = richTextPageBodySchema.safeParse({
      type: 'rich_text',
      content: { en: '<p>x</p>' },
      nope: 1,
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
    expect(result.error?.issues[0]).toMatchObject({ keys: ['nope'] });

    expect(
      richTextPageBodySchema.parse({ type: 'rich_text', content: { en: '<p>x</p>' } }),
    ).toEqual({ type: 'rich_text', content: { en: '<p>x</p>' }, audioAssets: [], imageAssets: [] });
  });

  it('saves a real lesson: ~20 000 characters of rich text in three locales', () => {
    const content = {
      en: lesson('en'),
      es: lesson('es'),
      uk: lesson('uk'),
    };
    // Asserted here so a later shrink of the fixture cannot quietly turn this
    // into a token string that proves nothing about the bound.
    expect(content.uk.length).toBeGreaterThan(20_000);
    expect(content.uk).toContain('<audio');
    expect(content.uk).toContain('<img');

    const parsed = createContentPageSchema.parse(
      page(
        { type: 'rich_text', content },
        {
          title: { en: 'Verbs of motion', es: 'Verbos de movimiento', uk: 'Дієслова руху' },
          seo: { metaDescription: { uk: 'Дієслова руху в українській мові' } },
        },
      ),
    );

    expect(parsed.body.type).toBe('rich_text');
    const stored = parsed.body.type === 'rich_text' ? parsed.body.content : {};
    for (const locale of ['en', 'es', 'uk'] as const) {
      expect(stored[locale]).toBe(content[locale]);
    }
  });
});

describe('contentPageSchema reads a stored page leniently (ADR-012)', () => {
  it('parses a document whose body and title are over the input bounds', () => {
    // `PagesRepository.fromDocument` parses every page it reads through this
    // schema. A bound here would make one over-long document unreadable — and
    // `RichTextSanitizer` runs *after* validation and re-serializes what it
    // cleans, so a body that passed at exactly the bound can be stored over it
    // with no attacker involved.
    const stored = {
      ...basePage,
      title: oneCharInLocales(MAX_LOCALES + 1),
      body: { type: 'rich_text', content: { uk: tooLongRichText } },
      seo: { metaTitle: { en: 'a'.repeat(MAX_LOCALIZED_TEXT_LENGTH + 1) } },
    };

    const result = contentPageSchema.safeParse(stored);

    expect(result.success).toBe(true);
    expect(Object.keys(result.data?.title ?? {})).toHaveLength(MAX_LOCALES + 1);
    const body = result.data?.body;
    expect(body?.type === 'rich_text' ? body.content['uk'] : '').toBe(tooLongRichText);

    // Refused on the way in, which is what makes the read above a decision.
    expect(
      createContentPageSchema.safeParse({
        sectionId: 'sec-1',
        slug: stored.slug,
        title: stored.title,
        body: stored.body,
        seo: stored.seo,
      }).success,
    ).toBe(false);
  });
});

describe('listPagesQuerySchema', () => {
  it('coerces limit from the query string and defaults it', () => {
    expect(listPagesQuerySchema.parse({ limit: '10' })).toMatchObject({ limit: 10 });
    expect(listPagesQuerySchema.parse({})).toMatchObject({ limit: 25 });
  });

  it('accepts the three filters and refuses a type that is not a page type', () => {
    expect(
      listPagesQuerySchema.parse({ sectionId: 'sec-1', status: 'published', type: 'h5p_exercise' }),
    ).toMatchObject({ sectionId: 'sec-1', status: 'published', type: 'h5p_exercise' });
    expect(listPagesQuerySchema.safeParse({ type: 'video' }).success).toBe(false);
    expect(listPagesQuerySchema.safeParse({ sectionId: 'a/b' }).success).toBe(false);
  });
});

describe('updateContentPageSchema', () => {
  it('returns only the fields the request carried', () => {
    const parsed = updateContentPageSchema.parse({ slug: 'intro' });

    // A defaulted `status` here would unpublish a live page on a slug fix, and
    // a defaulted `sortOrder` would jump it to the top of its section.
    expect(parsed).toEqual({ slug: 'intro' });
    expect(Object.keys(parsed)).toEqual(['slug']);
  });

  it('accepts an empty patch without inventing any field', () => {
    expect(updateContentPageSchema.parse({})).toEqual({});
  });

  it('strips a sectionId, which only a move between sections may change', () => {
    expect(updateContentPageSchema.parse({ sectionId: 'sec-2', slug: 'intro' })).toEqual({
      slug: 'intro',
    });
  });

  it('keeps the values a full patch does carry', () => {
    const parsed = updateContentPageSchema.parse({
      slug: 'intro',
      title: { en: 'Introduction' },
      body: { type: 'subsection_list', layout: 'list' },
      sortOrder: 4,
      status: 'published',
    });

    expect(parsed).toMatchObject({
      slug: 'intro',
      title: { en: 'Introduction' },
      sortOrder: 4,
      status: 'published',
    });
    expect(parsed.body).toMatchObject({ type: 'subsection_list', layout: 'list' });
  });

  it('rejects an invalid value for a field it does carry', () => {
    expect(updateContentPageSchema.safeParse({ status: 'nonsense' }).success).toBe(false);
    expect(updateContentPageSchema.safeParse({ slug: 'Not Kebab' }).success).toBe(false);
    expect(updateContentPageSchema.safeParse({ body: { type: 'video' } }).success).toBe(false);
  });
});

describe('editableContentPageFields', () => {
  it('names only fields the stored document also has', () => {
    const stored = Object.keys(contentPageSchema.shape);
    const unstorable = Object.keys(editableContentPageFields).filter(
      (field) => !stored.includes(field),
    );

    expect(unstorable).toEqual([]);
  });
});
