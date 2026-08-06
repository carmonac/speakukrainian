import { describe, expect, it } from 'vitest';
import { MAX_SECTION_DEPTH, type Section } from '@speakukrainian/shared';
import {
  buildPath,
  buildTree,
  deepestAfterMove,
  placeUnder,
  rewriteDescendant,
} from './sections.tree.js';

const audit = {
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'editor',
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: 'editor',
};

function section(overrides: Partial<Section> & Pick<Section, 'id' | 'slug' | 'path'>): Section {
  return {
    parentId: null,
    ancestorIds: [],
    depth: 0,
    kind: 'content',
    title: { en: overrides.slug },
    showInMenu: false,
    sortOrder: 0,
    status: 'draft',
    audit,
    ...overrides,
  };
}

const root = section({ id: 'root-id', slug: 'grammar-points', path: '/grammar-points' });

describe('buildPath', () => {
  it('prefixes a root slug with a single slash', () => {
    expect(buildPath(null, 'grammar-points')).toBe('/grammar-points');
  });

  it('appends a child slug to its parent path', () => {
    expect(buildPath('/grammar-points', 'present-simple')).toBe('/grammar-points/present-simple');
  });
});

describe('placeUnder', () => {
  it('places a root section at depth 0 with no ancestors', () => {
    expect(placeUnder(null, 'grammar-points')).toEqual({
      parentId: null,
      ancestorIds: [],
      depth: 0,
      path: '/grammar-points',
    });
  });

  it('places a child under its parent path and ancestor chain', () => {
    expect(placeUnder(root, 'present-simple')).toEqual({
      parentId: 'root-id',
      ancestorIds: ['root-id'],
      depth: 1,
      path: '/grammar-points/present-simple',
    });
  });

  it('extends a grandparent chain rather than replacing it', () => {
    const child = section({
      id: 'child-id',
      slug: 'tenses',
      path: '/grammar-points/tenses',
      parentId: 'root-id',
      ancestorIds: ['root-id'],
      depth: 1,
    });

    expect(placeUnder(child, 'present-simple')).toEqual({
      parentId: 'child-id',
      ancestorIds: ['root-id', 'child-id'],
      depth: 2,
      path: '/grammar-points/tenses/present-simple',
    });
  });
});

describe('rewriteDescendant', () => {
  const grandchild = section({
    id: 'grandchild-id',
    slug: 'c',
    path: '/a/b/c',
    parentId: 'child-id',
    ancestorIds: ['root-id', 'child-id'],
    depth: 2,
  });

  it('rewrites only the renamed prefix of a grandchild path', () => {
    const rewritten = rewriteDescendant(grandchild, {
      id: 'root-id',
      oldPath: '/a',
      next: { parentId: null, ancestorIds: [], depth: 0, path: '/grammar' },
    });

    expect(rewritten.path).toBe('/grammar/b/c');
    // A rename is not a re-parent: the chain and the depth are unchanged.
    expect(rewritten.ancestorIds).toEqual(['root-id', 'child-id']);
    expect(rewritten.depth).toBe(2);
  });

  it('re-parents a grandchild when its ancestor moves under a new parent', () => {
    const rewritten = rewriteDescendant(grandchild, {
      id: 'root-id',
      oldPath: '/a',
      next: {
        parentId: 'other-root',
        ancestorIds: ['other-root'],
        depth: 1,
        path: '/other/a',
      },
    });

    expect(rewritten.path).toBe('/other/a/b/c');
    expect(rewritten.ancestorIds).toEqual(['other-root', 'root-id', 'child-id']);
    expect(rewritten.depth).toBe(3);
    // The invariant `sectionSchema`'s second refinement checks.
    expect(rewritten.depth).toBe(rewritten.ancestorIds.length);
  });

  it('refuses a descendant whose stored path is not under the node', () => {
    expect(() =>
      rewriteDescendant(section({ id: 'stray', slug: 'c', path: '/elsewhere/c' }), {
        id: 'root-id',
        oldPath: '/a',
        next: { parentId: null, ancestorIds: [], depth: 0, path: '/grammar' },
      }),
    ).toThrow(/not under/);
  });

  it('refuses a descendant that does not list the node among its ancestors', () => {
    expect(() =>
      rewriteDescendant(
        section({ id: 'stray', slug: 'c', path: '/a/b/c', ancestorIds: ['someone-else'] }),
        {
          id: 'root-id',
          oldPath: '/a',
          next: { parentId: null, ancestorIds: [], depth: 0, path: '/grammar' },
        },
      ),
    ).toThrow(/ancestors/);
  });

  it('does not treat a sibling with a shared path prefix as a descendant', () => {
    // `/a-b` starts with `/a` as a string but is not under it.
    expect(() =>
      rewriteDescendant(section({ id: 'sibling', slug: 'a-b', path: '/a-b' }), {
        id: 'root-id',
        oldPath: '/a',
        next: { parentId: null, ancestorIds: [], depth: 0, path: '/grammar' },
      }),
    ).toThrow(/not under/);
  });
});

describe('deepestAfterMove', () => {
  it('adds the subtree drop to the destination depth', () => {
    const descendants = [
      section({ id: 'd1', slug: 'd1', path: '/a/b', depth: 1, ancestorIds: ['root-id'] }),
      section({
        id: 'd2',
        slug: 'd2',
        path: '/a/b/c',
        depth: 2,
        ancestorIds: ['root-id', 'd1'],
      }),
    ];

    expect(deepestAfterMove(root, descendants, 3)).toBe(5);
    expect(deepestAfterMove(root, descendants, 3)).toBeGreaterThan(MAX_SECTION_DEPTH);
  });

  it('is the destination depth for a leaf', () => {
    expect(deepestAfterMove(root, [], 2)).toBe(2);
  });
});

describe('buildTree', () => {
  const flat: Section[] = [
    section({ id: 'r1', slug: 'r1', path: '/r1', sortOrder: 0 }),
    section({ id: 'r2', slug: 'r2', path: '/r2', sortOrder: 1 }),
    section({
      id: 'c1',
      slug: 'c1',
      path: '/r1/c1',
      parentId: 'r1',
      ancestorIds: ['r1'],
      depth: 1,
      sortOrder: 0,
    }),
    section({
      id: 'c2',
      slug: 'c2',
      path: '/r1/c2',
      parentId: 'r1',
      ancestorIds: ['r1'],
      depth: 1,
      sortOrder: 1,
    }),
    section({
      id: 'g1',
      slug: 'g1',
      path: '/r1/c1/g1',
      parentId: 'c1',
      ancestorIds: ['r1', 'c1'],
      depth: 2,
      sortOrder: 0,
    }),
  ];

  /** The nesting the acceptance criterion describes: walking `parentId` by hand. */
  const walk = (parentId: string | null): { id: string; children: unknown[] }[] =>
    flat
      .filter((s) => s.parentId === parentId)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((s) => ({ id: s.id, children: walk(s.id) }));

  const shape = (nodes: { id: string; children: unknown[] }[]): unknown =>
    nodes.map((node) => ({
      id: node.id,
      children: shape(node.children as { id: string; children: unknown[] }[]),
    }));

  it('produces the same nesting as walking parentId by hand', () => {
    expect(shape(buildTree(flat))).toEqual(shape(walk(null)));
  });

  it('keeps children in sortOrder', () => {
    const [first] = buildTree(flat);
    expect(first?.children.map((child) => child.id)).toEqual(['c1', 'c2']);
  });

  it('surfaces an orphan as a root rather than dropping it', () => {
    const orphan = section({
      id: 'lost',
      slug: 'lost',
      path: '/gone/lost',
      parentId: 'gone',
      ancestorIds: ['gone'],
      depth: 1,
    });

    expect(buildTree([...flat, orphan]).map((node) => node.id)).toEqual(['r1', 'r2', 'lost']);
  });

  it('returns an empty array for an empty collection', () => {
    expect(buildTree([])).toEqual([]);
  });
});
