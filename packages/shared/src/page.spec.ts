import { describe, expect, it } from 'vitest';
import { contentPageSchema, pageBodySchema } from './page.js';

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
});
