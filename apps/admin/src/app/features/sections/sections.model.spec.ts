import { describe, expect, it } from 'vitest';
import { MAX_SECTION_DEPTH, type SectionTreeNode } from '@speakukrainian/shared';
import { UNTITLED_SECTION } from './section-messages';
import { flattenTree, sectionTitle } from './sections.model';

const audit = {
  createdAt: '2026-01-01T00:00:00Z',
  createdBy: 'admin',
  updatedAt: '2026-01-01T00:00:00Z',
  updatedBy: 'admin',
};

function node(
  id: string,
  overrides: Partial<SectionTreeNode> = {},
  children: SectionTreeNode[] = [],
): SectionTreeNode {
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
    status: 'draft',
    audit,
    ...overrides,
    children,
  };
}

/** Grammar → Tenses → Present simple, plus a second root. */
function threeLevels(): SectionTreeNode[] {
  const present = node('present-simple', { depth: 2, parentId: 'tenses' });
  const tenses = node('tenses', { depth: 1, parentId: 'grammar' }, [present]);
  return [node('grammar', {}, [tenses]), node('listening')];
}

describe('flattenTree', () => {
  it('emits a parent immediately before its own children', () => {
    const rows = flattenTree(threeLevels(), new Set());

    expect(rows.map((row) => [row.section.id, row.depth])).toEqual([
      ['grammar', 0],
      ['tenses', 1],
      ['present-simple', 2],
      ['listening', 0],
    ]);
  });

  it('omits the whole subtree of a collapsed node, not just its children', () => {
    const rows = flattenTree(threeLevels(), new Set(['grammar']));

    expect(rows.map((row) => row.section.id)).toEqual(['grammar', 'listening']);
    expect(rows[0]?.expanded).toBe(false);
    // The row still says it has children, so the chevron stays there to reopen.
    expect(rows[0]?.hasChildren).toBe(true);
  });

  it('collapses only the node named, leaving its siblings open', () => {
    const rows = flattenTree(threeLevels(), new Set(['tenses']));

    expect(rows.map((row) => row.section.id)).toEqual(['grammar', 'tenses', 'listening']);
  });

  it('reports childCount from the node own children', () => {
    const rows = flattenTree(threeLevels(), new Set());
    const counts = Object.fromEntries(rows.map((row) => [row.section.id, row.childCount]));

    expect(counts).toEqual({
      grammar: 1,
      tenses: 1,
      'present-simple': 0,
      listening: 0,
    });
  });

  it('offers Add subsection up to the stored depth limit and not past it', () => {
    // The API's create refuses `parent.depth + 1 > MAX_SECTION_DEPTH`, so this
    // is the off-by-one that would otherwise offer an action answered with 422.
    const rows = flattenTree(
      [
        node('deepest', { depth: MAX_SECTION_DEPTH }),
        node('one-above', { depth: MAX_SECTION_DEPTH - 1 }),
      ],
      new Set(),
    );

    expect(rows.map((row) => row.canAddChild)).toEqual([false, true]);
  });

  it('indents an orphaned node as a root even though its stored depth says otherwise', () => {
    // `buildTree` surfaces a section whose parent document is gone as a root.
    // Indenting by the stored depth would push it off under nothing.
    const orphan = node('orphan', { depth: 3, parentId: 'gone' });

    const [row] = flattenTree([orphan], new Set());

    expect(row?.depth).toBe(0);
    // The API still judges by the stored depth, so the action tracks that.
    expect(row?.canAddChild).toBe(true);
  });

  it('has no rows for an empty tree', () => {
    expect(flattenTree([], new Set())).toEqual([]);
  });
});

describe('sectionTitle', () => {
  it('reads the default locale', () => {
    expect(sectionTitle(node('grammar', { title: { en: 'Grammar', uk: 'Граматика' } }), 'en')).toBe(
      'Grammar',
    );
  });

  it('falls back to any locale that has text when the default one is blank', () => {
    // Making a locale default that the existing content was never authored in
    // is a state `/locales` can put the site into; the tree has to survive it.
    expect(sectionTitle(node('grammar', { title: { uk: 'Граматика' } }), 'en')).toBe('Граматика');
    expect(sectionTitle(node('grammar', { title: { en: '  ', uk: 'Граматика' } }), 'en')).toBe(
      'Граматика',
    );
  });

  it('falls back when the locales list failed to load', () => {
    expect(sectionTitle(node('grammar', { title: { en: 'Grammar' } }), null)).toBe('Grammar');
  });

  it('placeholders a section with no text in any locale', () => {
    expect(sectionTitle(node('grammar', { title: {} }), 'en')).toBe(UNTITLED_SECTION);
    expect(sectionTitle(node('grammar', { title: { en: '  ', uk: '' } }), 'en')).toBe(
      UNTITLED_SECTION,
    );
  });
});
