import { describe, expect, it } from 'vitest';
import {
  contentPageSchema,
  createContentPageSchema,
  editableContentPageFields,
  pageBodySchema,
  updateContentPageSchema,
} from './page.js';

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
