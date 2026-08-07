import { describe, expect, it } from 'vitest';
import type { Section, SectionTreeNode } from '@speakukrainian/shared';
import { UNTITLED_SECTION } from '../sections/section-messages';
import { LINK_SECTION_SUFFIX, MISSING_SECTION_OPTION, OWN_SECTION_OPTION } from './page-messages';
import {
  EXCERPT_LENGTH,
  descriptionExcerpt,
  sourceOptions,
  sourceProblem,
  subsectionPreviewRows,
  type SourceOption,
} from './subsection-list.model';

const audit = {
  createdAt: '2026-01-01T00:00:00Z',
  createdBy: 'admin',
  updatedAt: '2026-01-01T00:00:00Z',
  updatedBy: 'admin',
};

function section(id: string, overrides: Partial<Section> = {}): Section {
  return {
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
    status: 'published',
    audit,
    ...overrides,
  };
}

function node(id: string, overrides: Partial<SectionTreeNode> = {}): SectionTreeNode {
  return { ...section(id), children: [], ...overrides };
}

const GRAMMAR = node('grammar', {
  title: { en: 'Grammar points' },
  children: [
    node('tenses', {
      parentId: 'grammar',
      ancestorIds: ['grammar'],
      depth: 1,
      title: { en: 'Tenses' },
    }),
  ],
});

const ELSEWHERE = node('elsewhere', {
  kind: 'link',
  title: { en: 'Elsewhere' },
  link: { type: 'external', href: 'https://example.test', openInNewTab: false },
});

const TREE = [GRAMMAR, ELSEWHERE];

function labelOf(options: readonly SourceOption[], id: string | null): string {
  const found = options.find((option) => option.id === id);
  if (found === undefined) {
    throw new Error(`Expected an option for ${String(id)}`);
  }
  return found.label;
}

describe('sourceOptions', () => {
  it('offers the page’s own section first, storing no id for it', () => {
    // The entry carrying the section id is what would copy that id into the
    // stored body, pinning the page to a section it merely lives in today.
    const options = sourceOptions(TREE, 'grammar', null, 'en');

    expect(options[0]?.id).toBeNull();
    expect(options[0]?.label).toBe(`${OWN_SECTION_OPTION} (Grammar points)`);
  });

  it('names the own-section entry alone when the section is not in the tree', () => {
    expect(labelOf(sourceOptions(TREE, 'gone', null, 'en'), null)).toBe(OWN_SECTION_OPTION);
    expect(labelOf(sourceOptions(TREE, null, null, 'en'), null)).toBe(OWN_SECTION_OPTION);
  });

  it('walks the whole tree, keeping the depth for indentation', () => {
    const options = sourceOptions(TREE, 'grammar', null, 'en');

    expect(options.map((option) => option.id)).toEqual([null, 'grammar', 'tenses', 'elsewhere']);
    expect(options.find((option) => option.id === 'tenses')?.depth).toBe(1);
  });

  it('marks a link section and says so in its label', () => {
    // Offered rather than disabled, so the refusal is something an author can
    // provoke and read — but forewarned rather than ambushed.
    const options = sourceOptions(TREE, 'grammar', null, 'en');
    const link = options.find((option) => option.id === 'elsewhere');

    expect(link?.isLink).toBe(true);
    expect(link?.label).toBe(`Elsewhere${LINK_SECTION_SUFFIX}`);
    expect(options.find((option) => option.id === 'grammar')?.isLink).toBe(false);
  });

  it('keeps a selected id the tree does not carry, as a marked entry', () => {
    // A `mat-select` holding an unknown value renders a blank trigger, and the
    // author is given no reason to think anything is wrong.
    const options = sourceOptions(TREE, 'grammar', 'deleted', 'en');
    const stale = options.at(-1);

    expect(stale?.id).toBe('deleted');
    expect(stale?.missing).toBe(true);
    expect(stale?.label).toBe(MISSING_SECTION_OPTION);
  });

  it('adds no such entry when the selected id is really there', () => {
    const options = sourceOptions(TREE, 'grammar', 'tenses', 'en');

    expect(options.filter((option) => option.missing)).toEqual([]);
  });
});

describe('sourceProblem', () => {
  const options = sourceOptions(TREE, 'grammar', 'deleted', 'en');

  it('accepts the default, which resolves to the page’s own section', () => {
    expect(sourceProblem(options, null)).toBeNull();
  });

  it('accepts a content section', () => {
    expect(sourceProblem(options, 'tenses')).toBeNull();
  });

  it('refuses a link section', () => {
    expect(sourceProblem(options, 'elsewhere')).toBe('not-content');
  });

  it('refuses a section that is no longer in the tree', () => {
    expect(sourceProblem(options, 'deleted')).toBe('missing');
  });

  it('fails open while the tree is unknown', () => {
    // A slow or failed tree read must not block saving a page whose body is
    // otherwise fine; the rule applies once the facts arrive.
    expect(sourceProblem([], 'elsewhere')).toBeNull();
  });
});

describe('subsectionPreviewRows', () => {
  const options = { locale: 'uk', defaultCode: 'en', showImages: true, showDescriptions: true };

  it('resolves each title in the previewed locale, falling back to the default', () => {
    const rows = subsectionPreviewRows(
      [
        section('a', { title: { en: 'Tenses', uk: 'Часи' } }),
        section('b', { title: { en: 'Articles' } }),
      ],
      options,
    );

    expect(rows.map((row) => row.title)).toEqual(['Часи', 'Articles']);
  });

  it('names a section with no title in any locale rather than rendering a blank card', () => {
    const rows = subsectionPreviewRows([section('a', { title: {} })], options);

    expect(rows[0]?.title).toBe(UNTITLED_SECTION);
  });

  it('preserves the order the API answered in', () => {
    // `SectionsRepository.list` already orders by `sortOrder`; a second sort
    // here could disagree with the public site.
    const rows = subsectionPreviewRows(
      [section('third'), section('first'), section('second')],
      options,
    );

    expect(rows.map((row) => row.id)).toEqual(['third', 'first', 'second']);
  });

  it('carries the image and its alt text for the previewed locale', () => {
    const rows = subsectionPreviewRows(
      [
        section('a', {
          image: {
            path: 'images/a.png',
            url: 'https://cdn.test/images/a.png',
            contentType: 'image/png',
            sizeBytes: 10,
            alt: { en: 'A diagram', uk: 'Схема' },
          },
        }),
      ],
      options,
    );

    expect(rows[0]?.imageUrl).toBe('https://cdn.test/images/a.png');
    expect(rows[0]?.imageAlt).toBe('Схема');
  });

  it('drops the image when images are off', () => {
    const rows = subsectionPreviewRows(
      [
        section('a', {
          image: {
            path: 'images/a.png',
            url: 'https://cdn.test/images/a.png',
            contentType: 'image/png',
            sizeBytes: 10,
          },
        }),
      ],
      { ...options, showImages: false },
    );

    expect(rows[0]?.imageUrl).toBeNull();
    expect(rows[0]?.imageAlt).toBe('');
  });

  it('drops the excerpt when descriptions are off', () => {
    const rows = subsectionPreviewRows([section('a', { description: { uk: '<p>Опис</p>' } })], {
      ...options,
      showDescriptions: false,
    });

    expect(rows[0]?.excerpt).toBe('');
  });

  it('excerpts the description when they are on', () => {
    const rows = subsectionPreviewRows(
      [section('a', { description: { uk: '<p>Опис</p>' } })],
      options,
    );

    expect(rows[0]?.excerpt).toBe('Опис');
  });
});

describe('descriptionExcerpt', () => {
  it('strips the markup, so the excerpt reaches an escaped context as text', () => {
    expect(descriptionExcerpt({ en: '<p>Hello <strong>world</strong></p>' }, 'en', 'en')).toBe(
      'Hello world',
    );
  });

  it('answers nothing for a section with no description at all', () => {
    expect(descriptionExcerpt(undefined, 'en', 'en')).toBe('');
  });

  it('falls back past a locale whose text is blank markup', () => {
    // `<p></p>` is what the editor writes for a tab the author opened and left
    // empty: a non-blank string with no text in it. Resolving before stripping
    // would pick it and render an empty excerpt over real prose.
    expect(descriptionExcerpt({ uk: '<p></p>', en: '<p>Real text</p>' }, 'uk', 'en')).toBe(
      'Real text',
    );
  });

  it('cuts a long description on a word boundary and marks the cut', () => {
    const plain = 'alpha beta '.repeat(30).trim();
    const excerpt = descriptionExcerpt({ en: `<p>${plain}</p>` }, 'en', 'en');

    expect(excerpt.endsWith('…')).toBe(true);
    expect(excerpt.length).toBeLessThanOrEqual(EXCERPT_LENGTH + 1);
    const kept = excerpt.slice(0, -1);
    expect(plain.startsWith(kept)).toBe(true);
    // The character after the cut is a space, so no word was split.
    expect(plain[kept.length]).toBe(' ');
  });

  it('hard-cuts a single word longer than the limit', () => {
    const word = 'x'.repeat(EXCERPT_LENGTH + 40);
    const excerpt = descriptionExcerpt({ en: `<p>${word}</p>` }, 'en', 'en');

    expect(excerpt).toBe(`${'x'.repeat(EXCERPT_LENGTH)}…`);
  });

  it('leaves a description inside the limit exactly as written', () => {
    expect(descriptionExcerpt({ en: '<p>Short enough</p>' }, 'en', 'en')).toBe('Short enough');
  });
});
