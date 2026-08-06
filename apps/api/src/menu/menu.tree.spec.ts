import { describe, expect, it } from 'vitest';
import type { Section } from '@speakukrainian/shared';
import { buildMenu } from './menu.tree.js';

const audit = {
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'editor',
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: 'editor',
};

/** Every fixture is what `listForMenu` answers with: published and in the menu. */
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
    showInMenu: true,
    sortOrder: 0,
    status: 'published',
    audit,
    ...overrides,
  };
}

describe('buildMenu labels', () => {
  it('resolves the menu label for the requested locale', () => {
    const menu = buildMenu(
      [
        section('a', {
          title: { en: 'Grammar points', uk: 'Граматика' },
          menuLabel: { en: 'Grammar', uk: 'Грам' },
        }),
      ],
      'uk',
      'en',
    );

    expect(menu.map((entry) => entry.label)).toEqual(['Грам']);
  });

  it('falls back to the title when the section has no menu label', () => {
    const menu = buildMenu([section('a', { title: { en: 'Grammar points' } })], 'en', 'en');

    expect(menu[0]?.label).toBe('Grammar points');
  });

  it('falls back to the title when the label is present but empty', () => {
    // ADR-009 treats blank as missing, and the form writes a blank key for a tab
    // the author opened and left alone.
    const menu = buildMenu(
      [section('a', { title: { en: 'Grammar points' }, menuLabel: { en: '   ' } })],
      'en',
      'en',
    );

    expect(menu[0]?.label).toBe('Grammar points');
  });

  it("falls back to the default locale's title for a locale with no translation", () => {
    const menu = buildMenu(
      [section('a', { title: { en: 'Grammar points' }, menuLabel: { en: 'Grammar' } })],
      'es',
      'en',
    );

    // The label is resolved per field: `es` has neither, so `en`'s label wins
    // before `en`'s title does.
    expect(menu[0]?.label).toBe('Grammar');
  });

  it('falls back to the default locale title when neither locale has a label', () => {
    const menu = buildMenu(
      [section('a', { title: { en: 'Grammar points', uk: 'Граматика' } })],
      'es',
      'en',
    );

    expect(menu[0]?.label).toBe('Grammar points');
  });
});

describe('buildMenu hrefs', () => {
  it('uses an external link target as the href and carries openInNewTab', () => {
    const menu = buildMenu(
      [
        section('a', {
          kind: 'link',
          path: '/a',
          link: { type: 'external', href: 'https://example.com/x', openInNewTab: true },
        }),
      ],
      'en',
      'en',
    );

    expect(menu[0]).toMatchObject({ href: 'https://example.com/x', openInNewTab: true });
  });

  it('uses an internal link target as the href', () => {
    const menu = buildMenu(
      [
        section('a', {
          kind: 'link',
          path: '/a',
          link: { type: 'internal', href: '/lessons', openInNewTab: false },
        }),
      ],
      'en',
      'en',
    );

    expect(menu[0]).toMatchObject({ href: '/lessons', openInNewTab: false });
  });

  it('uses the section path for a content section, with openInNewTab false', () => {
    const menu = buildMenu([section('a', { path: '/grammar-points' })], 'en', 'en');

    expect(menu[0]).toMatchObject({ href: '/grammar-points', openInNewTab: false });
  });

  it('carries no audit and no status into the response (ADR-010)', () => {
    const menu = buildMenu([section('a')], 'en', 'en');

    expect(Object.keys(menu[0] ?? {}).sort()).toEqual([
      'children',
      'href',
      'id',
      'label',
      'openInNewTab',
    ]);
  });
});

describe('buildMenu nesting', () => {
  it('nests a child under its parent', () => {
    const menu = buildMenu(
      [section('a'), section('b', { parentId: 'a', ancestorIds: ['a'], depth: 1, path: '/a/b' })],
      'en',
      'en',
    );

    expect(menu.map((entry) => entry.id)).toEqual(['a']);
    expect(menu[0]?.children.map((entry) => entry.id)).toEqual(['b']);
  });

  it('nests a child whose parent appears later in the input', () => {
    // A one-pass implementation would leave the child at the top level.
    const menu = buildMenu(
      [
        section('b', { parentId: 'a', ancestorIds: ['a'], depth: 1, path: '/a/b', sortOrder: 0 }),
        section('a', { sortOrder: 1 }),
      ],
      'en',
      'en',
    );

    expect(menu.map((entry) => entry.id)).toEqual(['a']);
    expect(menu[0]?.children.map((entry) => entry.id)).toEqual(['b']);
  });

  it('promotes a visible child of a hidden parent to its grandparent, keeping its own href', () => {
    // B is absent from the input, which is what "hidden or unpublished" means
    // here — the query never returned it.
    const menu = buildMenu(
      [
        section('a', { sortOrder: 0 }),
        section('c', {
          parentId: 'b',
          ancestorIds: ['a', 'b'],
          depth: 2,
          path: '/a/b/c',
          sortOrder: 1,
        }),
      ],
      'en',
      'en',
    );

    expect(menu.map((entry) => entry.id)).toEqual(['a']);
    expect(menu[0]?.children.map((entry) => entry.id)).toEqual(['c']);
    // No synthesised placeholder for B, and the path is not rewritten to `/a/c`:
    // that is where the page really lives.
    expect(menu[0]?.children).toHaveLength(1);
    expect(menu[0]?.children[0]?.href).toBe('/a/b/c');
  });

  it('promotes to the top level when no ancestor is in the menu', () => {
    const menu = buildMenu(
      [
        section('c', {
          parentId: 'b',
          ancestorIds: ['a', 'b'],
          depth: 2,
          path: '/a/b/c',
        }),
      ],
      'en',
      'en',
    );

    expect(menu.map((entry) => entry.id)).toEqual(['c']);
    expect(menu[0]?.href).toBe('/a/b/c');
  });

  it('orders a promoted child among its new siblings by sortOrder', () => {
    const menu = buildMenu(
      [
        section('a', { sortOrder: 0 }),
        section('early', {
          parentId: 'b',
          ancestorIds: ['a', 'b'],
          depth: 2,
          path: '/a/b/early',
          sortOrder: 1,
        }),
        section('direct', {
          parentId: 'a',
          ancestorIds: ['a'],
          depth: 1,
          path: '/a/direct',
          sortOrder: 2,
        }),
      ],
      'en',
      'en',
    );

    expect(menu[0]?.children.map((entry) => entry.id)).toEqual(['early', 'direct']);
  });
});
