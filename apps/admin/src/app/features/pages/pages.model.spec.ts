import { describe, expect, it } from 'vitest';
import type { ContentPage, Section, SectionTreeNode } from '@speakukrainian/shared';
import { UNTITLED_PAGE } from './page-messages';
import { pageTitle, sectionChoices, sectionPathOfPage } from './pages.model';

const audit = {
  createdAt: '2026-01-01T00:00:00Z',
  createdBy: 'admin',
  updatedAt: '2026-01-01T00:00:00Z',
  updatedBy: 'admin',
};

function page(overrides: Partial<ContentPage> = {}): ContentPage {
  return {
    id: 'p1',
    sectionId: 's1',
    slug: 'intro',
    path: '/grammar-points/intro',
    title: { en: 'Intro' },
    body: { type: 'rich_text', content: {}, audioAssets: [], imageAssets: [] },
    sortOrder: 0,
    status: 'draft',
    publishedAt: null,
    audit,
    ...overrides,
  };
}

function node(id: string, overrides: Partial<SectionTreeNode> = {}): SectionTreeNode {
  const base: Section = {
    id,
    parentId: null,
    ancestorIds: [],
    depth: 0,
    kind: 'content',
    slug: id,
    path: `/${id}`,
    title: { en: id },
    showInMenu: false,
    sortOrder: 0,
    status: 'draft',
    audit,
  };
  return { ...base, children: [], ...overrides };
}

describe('pageTitle', () => {
  it('prefers the default locale', () => {
    expect(pageTitle(page({ title: { en: 'Intro', uk: 'Вступ' } }), 'en')).toBe('Intro');
  });

  it('falls back to any locale that has text', () => {
    // Making a locale default that the content was not authored in is a state
    // `/locales` can put the site into; blanking every row is not an answer.
    expect(pageTitle(page({ title: { uk: 'Вступ' } }), 'en')).toBe('Вступ');
  });

  it('falls back to a placeholder rather than rendering nothing', () => {
    expect(pageTitle(page({ title: {} }), 'en')).toBe(UNTITLED_PAGE);
    expect(pageTitle(page({ title: { en: '   ' } }), 'en')).toBe(UNTITLED_PAGE);
  });

  it('still answers when the locales list failed to load', () => {
    expect(pageTitle(page({ title: { en: 'Intro' } }), null)).toBe('Intro');
  });
});

describe('sectionChoices', () => {
  it('flattens the whole tree, depth first, with the walk’s own depth', () => {
    const tree = [
      node('grammar', {
        title: { en: 'Grammar' },
        children: [node('tenses', { title: { en: 'Tenses' }, depth: 1 })],
      }),
      node('listening', { title: { en: 'Listening' } }),
    ];

    expect(sectionChoices(tree, 'en')).toEqual([
      { id: 'grammar', label: 'Grammar', depth: 0, canHoldPages: true },
      { id: 'tenses', label: 'Tenses', depth: 1, canHoldPages: true },
      { id: 'listening', label: 'Listening', depth: 0, canHoldPages: true },
    ]);
  });

  it('marks a link section as unable to hold pages', () => {
    // `PagesRepository.create` refuses one with a 422, so the UI does not offer
    // an action the API would refuse.
    const tree = [
      node('docs', {
        kind: 'link',
        title: { en: 'Docs' },
        link: { type: 'external', href: 'https://example.com', openInNewTab: false },
      }),
    ];

    expect(sectionChoices(tree, 'en')[0]?.canHoldPages).toBe(false);
  });
});

describe('sectionPathOfPage', () => {
  it('drops the last segment of the page path', () => {
    expect(sectionPathOfPage(page({ path: '/grammar-points/tenses/present-simple' }))).toBe(
      '/grammar-points/tenses',
    );
  });

  it('answers empty for a path with no section to drop, rather than throwing', () => {
    // A corrupt page path is still worth opening the form for; that form is the
    // only screen that could repair it.
    expect(sectionPathOfPage(page({ path: '/orphan' }))).toBe('');
  });
});
