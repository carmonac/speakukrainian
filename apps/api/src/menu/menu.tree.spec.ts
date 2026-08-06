import { describe, expect, it } from 'vitest';
import type { Section } from '@speakukrainian/shared';
import { buildMenu } from './menu.tree.js';

const audit = {
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'editor',
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: 'editor',
};

/**
 * A section as `listAllForTree` answers with it: the input is the whole
 * collection, so a fixture opts *out* of the menu rather than into it.
 *
 * `sortOrder` defaults to 0 because that is what `nextSortOrder` assigns to a
 * first child — numbering restarts under every parent, and a fixture that
 * numbers globally hides exactly the interleaving these tests exist to catch.
 */
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

/** A child of `parent`, with the derived fields a real document would carry. */
function child(id: string, parent: Section, overrides: Partial<Section> = {}): Section {
  return section(id, {
    parentId: parent.id,
    ancestorIds: [...parent.ancestorIds, parent.id],
    depth: parent.depth + 1,
    path: `${parent.path}/${id}`,
    ...overrides,
  });
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

  it('falls back to a locale that has text when neither the requested nor the default does', () => {
    // The API does not require a title in the default locale, so a section
    // titled only in `uk` is a shape a reader can reach. A name in the wrong
    // language identifies the destination; a blank one does not.
    const menu = buildMenu([section('a', { title: { uk: 'Тільки' } })], 'en', 'en');

    expect(menu[0]?.label).toBe('Тільки');
  });

  it('falls back through the menu label before the title when neither resolves', () => {
    const menu = buildMenu(
      [section('a', { title: { uk: 'Граматика' }, menuLabel: { uk: 'Грам' } })],
      'en',
      'en',
    );

    expect(menu[0]?.label).toBe('Грам');
  });

  it('leaves out a section with no text in any locale, and promotes its children', () => {
    // Every locale blank is what the editor writes for tabs an author opened
    // and left alone, so this is reachable without a hand-written document.
    const nameless = section('nameless', { title: { en: '  ', uk: '' }, menuLabel: {} });
    const menu = buildMenu(
      [nameless, child('c', nameless, { title: { en: 'Child' } })],
      'en',
      'en',
    );

    expect(menu.map((entry) => entry.label)).toEqual(['Child']);
    expect(menu[0]?.href).toBe('/nameless/c');
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

  it.each(['javascript:alert(1)', 'ftp://x.test', 'example.com'])(
    'never publishes the stored href %j, which the write path refuses',
    (href) => {
      // ADR-012 reads such a document leniently so it stays repairable. Serving
      // its href on an anonymous route is a different question, answered here.
      const menu = buildMenu(
        [section('a', { kind: 'link', link: { type: 'external', href, openInNewTab: false } })],
        'en',
        'en',
      );

      expect(menu).toEqual([]);
      expect(JSON.stringify(menu)).not.toContain(href);
    },
  );

  it.each([
    '//evil.com',
    '/\\evil.com',
    '/\\\\evil.com',
    '/\\/evil.com',
    '/\t/evil.com',
    '/\n/evil.com',
    '/\r/evil.com',
  ])('leaves the internal target %j, which escapes the site, out of the menu', (href) => {
    // A browser resolves every one of these to `http://evil.com/`: the URL
    // parser folds `\` to `/` and strips tab, LF and CR before parsing. They all
    // start with `/`, so they are the spellings a prefix rule waves through.
    const menu = buildMenu(
      [
        section('a', {
          kind: 'link',
          link: { type: 'internal', href, openInNewTab: false },
        }),
        section('b'),
      ],
      'en',
      'en',
    );

    expect(menu.map((entry) => entry.id)).toEqual(['b']);
    expect(JSON.stringify(menu)).not.toContain('evil.com');
  });

  it('leaves a section whose stored href is empty out of the menu, and serves the rest', () => {
    // Nothing writes an empty href today, but the stored shape allows one so
    // that it cannot 500 every read of the collection (ADR-012). What is left is
    // the projection's job: an entry with nowhere to go is dropped like any
    // other refused target.
    const menu = buildMenu(
      [
        section('a', { kind: 'link', link: { type: 'internal', href: '', openInNewTab: false } }),
        section('b'),
      ],
      'en',
      'en',
    );

    expect(menu.map((entry) => entry.id)).toEqual(['b']);
  });

  it('keeps the visible children of a section whose stored href is refused, in its slot', () => {
    // The refused section is dropped the way a draft one is, so ADR-011's
    // promotion applies and the branch under it is not lost with it.
    const first = section('first', { sortOrder: 0 });
    const bad = section('bad', {
      sortOrder: 1,
      kind: 'link',
      link: { type: 'external', href: 'javascript:alert(1)', openInNewTab: false },
    });
    const last = section('last', { sortOrder: 2 });

    const menu = buildMenu(
      [first, child('k1', bad, { sortOrder: 0 }), bad, child('k2', bad, { sortOrder: 1 }), last],
      'en',
      'en',
    );

    expect(menu.map((entry) => entry.id)).toEqual(['first', 'k1', 'k2', 'last']);
    expect(JSON.stringify(menu)).not.toContain('javascript:');
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

describe('buildMenu visibility', () => {
  it('leaves out a section that is not ticked into the menu', () => {
    // The input is now the whole collection, so this predicate is the only thing
    // keeping an unticked section out of an anonymous response.
    const menu = buildMenu([section('a'), section('b', { showInMenu: false })], 'en', 'en');

    expect(menu.map((entry) => entry.id)).toEqual(['a']);
  });

  it.each(['draft', 'archived'] as const)('leaves out a %s section', (status) => {
    const menu = buildMenu([section('a'), section('b', { status })], 'en', 'en');

    expect(menu.map((entry) => entry.id)).toEqual(['a']);
  });
});

describe('buildMenu nesting', () => {
  it('nests a child under its parent', () => {
    const a = section('a');
    const menu = buildMenu([a, child('b', a)], 'en', 'en');

    expect(menu.map((entry) => entry.id)).toEqual(['a']);
    expect(menu[0]?.children.map((entry) => entry.id)).toEqual(['b']);
  });

  it('nests each of three visible levels under the level above it', () => {
    // Two visible ancestors, which is what makes the *nearest* in "nearest
    // visible ancestor" observable: attaching to the outermost one instead
    // flattens every three-level menu into two.
    const a = section('a');
    const b = child('b', a);
    const menu = buildMenu([a, b, child('c', b)], 'en', 'en');

    expect(menu.map((entry) => entry.id)).toEqual(['a']);
    expect(menu[0]?.children.map((entry) => entry.id)).toEqual(['b']);
    expect(menu[0]?.children[0]?.children.map((entry) => entry.id)).toEqual(['c']);
  });

  it('nests a child whose parent appears later in the input', () => {
    const a = section('a', { sortOrder: 1 });
    const menu = buildMenu([child('b', a), a], 'en', 'en');

    expect(menu.map((entry) => entry.id)).toEqual(['a']);
    expect(menu[0]?.children.map((entry) => entry.id)).toEqual(['b']);
  });

  it('promotes a visible child of a hidden parent to its grandparent, keeping its own href', () => {
    const a = section('a');
    const b = child('b', a, { status: 'draft' });
    const menu = buildMenu([a, b, child('c', b)], 'en', 'en');

    expect(menu.map((entry) => entry.id)).toEqual(['a']);
    expect(menu[0]?.children.map((entry) => entry.id)).toEqual(['c']);
    // No synthesised placeholder for B, and the path is not rewritten to `/a/c`:
    // that is where the page really lives.
    expect(menu[0]?.children).toHaveLength(1);
    expect(menu[0]?.children[0]?.href).toBe('/a/b/c');
  });

  it('promotes to the top level when no ancestor is in the menu', () => {
    const a = section('a', { showInMenu: false });
    const b = child('b', a, { status: 'draft' });
    const menu = buildMenu([a, b, child('c', b)], 'en', 'en');

    expect(menu.map((entry) => entry.id)).toEqual(['c']);
    expect(menu[0]?.href).toBe('/a/b/c');
  });
});

describe('buildMenu ordering', () => {
  it('lands a promoted pair in the slot their hidden parent held, not interleaved', () => {
    // The numbering `nextSortOrder` really assigns: it restarts under every
    // parent, so `k1`'s 0 and `b1`'s 0 say nothing about each other. Ordering
    // the visible sections by `sortOrder` alone reads `b1, k1, b2, k2` and
    // breaks the 0-vs-0 tie by document id.
    const root = section('root');
    const b1 = child('b1', root, { sortOrder: 0 });
    const b2 = child('b2', root, { sortOrder: 1 });
    const hidden = child('hidden', root, { sortOrder: 2, status: 'draft' });
    const b3 = child('b3', root, { sortOrder: 3 });

    const menu = buildMenu(
      [
        root,
        b1,
        child('k1', hidden, { sortOrder: 0 }),
        b2,
        child('k2', hidden, { sortOrder: 1 }),
        hidden,
        b3,
      ],
      'en',
      'en',
    );

    expect(menu[0]?.children.map((entry) => entry.id)).toEqual(['b1', 'b2', 'k1', 'k2', 'b3']);
  });

  it('keeps two parents apart when their children share sortOrder values', () => {
    const left = section('left', { sortOrder: 0 });
    const right = section('right', { sortOrder: 1 });
    // The order `orderBy('sortOrder')` produces: every first child before every
    // second one, whichever parent they belong to.
    const menu = buildMenu(
      [
        left,
        child('left-1', left, { sortOrder: 0 }),
        child('right-1', right, { sortOrder: 0 }),
        right,
        child('left-2', left, { sortOrder: 1 }),
        child('right-2', right, { sortOrder: 1 }),
      ],
      'en',
      'en',
    );

    expect(menu[0]?.children.map((entry) => entry.id)).toEqual(['left-1', 'left-2']);
    expect(menu[1]?.children.map((entry) => entry.id)).toEqual(['right-1', 'right-2']);
  });

  it("lands children promoted out of a hidden root in that root's slot", () => {
    const first = section('first', { sortOrder: 0 });
    const hidden = section('hidden', { sortOrder: 1, status: 'draft' });
    const last = section('last', { sortOrder: 2 });

    const menu = buildMenu(
      [
        first,
        child('k1', hidden, { sortOrder: 0 }),
        hidden,
        child('k2', hidden, { sortOrder: 1 }),
        last,
      ],
      'en',
      'en',
    );

    expect(menu.map((entry) => entry.id)).toEqual(['first', 'k1', 'k2', 'last']);
  });
});
