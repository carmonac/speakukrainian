import { describe, expect, it } from 'vitest';
import type { SubsectionListPageBody } from '@speakukrainian/shared';
import {
  nextPublishedAt,
  pagePath,
  pagePathRange,
  rewritePagePath,
  sectionPathOf,
  sourceSectionIdOf,
} from './pages.rules.js';

describe('pagePath', () => {
  it('appends the slug to the owning section path', () => {
    expect(pagePath('/grammar-points/present-simple', 'intro')).toBe(
      '/grammar-points/present-simple/intro',
    );
  });

  it('round-trips through sectionPathOf', () => {
    const sectionPath = '/grammar-points/present-simple';

    expect(sectionPathOf(pagePath(sectionPath, 'intro'))).toBe(sectionPath);
  });
});

describe('sectionPathOf', () => {
  it('reads the owning section off a page under a root section', () => {
    expect(sectionPathOf('/grammar-points/intro')).toBe('/grammar-points');
  });

  it('throws for a path with no section segment above it', () => {
    // The alternative is an empty section path, which no section ever has.
    expect(() => sectionPathOf('/intro')).toThrow('/intro');
  });
});

describe('rewritePagePath', () => {
  it('replaces only the old section prefix', () => {
    expect(rewritePagePath('/a/b/intro', '/a', '/z')).toBe('/z/b/intro');
  });

  it('keeps a page directly under the renamed section', () => {
    expect(rewritePagePath('/a/intro', '/a', '/z')).toBe('/z/intro');
  });

  it('throws when the page does not sit under the old prefix', () => {
    // A corrupt path rewritten to a guess is a broken URL cemented in place.
    expect(() => rewritePagePath('/ax/intro', '/a', '/z')).toThrow('/ax/intro');
  });
});

describe('pagePathRange', () => {
  it('is the half-open range covering the section prefix', () => {
    expect(pagePathRange('/a')).toEqual({ start: '/a/', end: '/a0' });
  });

  it('includes descendants and excludes a similarly named sibling', () => {
    const { start, end } = pagePathRange('/a');
    const inside = (path: string): boolean => path >= start && path < end;

    expect(inside('/a/x')).toBe(true);
    expect(inside('/a/b/x')).toBe(true);
    expect(inside('/ax/y')).toBe(false);
    expect(inside('/a0')).toBe(false);
    expect(inside('/a')).toBe(false);
  });
});

describe('sourceSectionIdOf', () => {
  const list = (extra: Partial<SubsectionListPageBody> = {}): SubsectionListPageBody => ({
    type: 'subsection_list',
    layout: 'grid',
    showImages: true,
    showDescriptions: true,
    ...extra,
  });

  it('reads the source off a subsection list that names one', () => {
    expect(sourceSectionIdOf(list({ sourceSectionId: 'zzzz0000zzzz0000zzzz' }))).toBe(
      'zzzz0000zzzz0000zzzz',
    );
  });

  it('is null for a subsection list that follows its own section', () => {
    // The absent key is how "my own section" is stored, and it has to stay free
    // of a section read.
    expect(sourceSectionIdOf(list())).toBeNull();
  });

  it('is null for a body of another type and for no body at all', () => {
    expect(
      sourceSectionIdOf({
        type: 'rich_text',
        content: { en: '<p>Hi</p>' },
        audioAssets: [],
        imageAssets: [],
      }),
    ).toBeNull();
    expect(
      sourceSectionIdOf({
        type: 'h5p_exercise',
        h5pContentId: null,
        explanationPosition: 'above',
        trackResults: false,
      }),
    ).toBeNull();
    expect(sourceSectionIdOf(undefined)).toBeNull();
  });
});

describe('nextPublishedAt', () => {
  const now = '2026-02-02T00:00:00.000Z';

  it('stamps the first publish', () => {
    expect(nextPublishedAt(null, 'published', now)).toBe(now);
  });

  it('leaves an existing stamp alone on a re-publish', () => {
    expect(nextPublishedAt('2026-01-01T00:00:00.000Z', 'published', now)).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });

  it('keeps the stamp when a page is unpublished or archived', () => {
    // The public site shows it as the article date; clearing it would lose the
    // date a draft-and-republish cycle is supposed to preserve.
    expect(nextPublishedAt('2026-01-01T00:00:00.000Z', 'draft', now)).toBe(
      '2026-01-01T00:00:00.000Z',
    );
    expect(nextPublishedAt('2026-01-01T00:00:00.000Z', 'archived', now)).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });

  it('leaves a never-published page unstamped', () => {
    expect(nextPublishedAt(null, 'draft', now)).toBeNull();
  });
});
