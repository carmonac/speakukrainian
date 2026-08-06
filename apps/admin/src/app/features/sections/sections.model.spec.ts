import { describe, expect, it } from 'vitest';
import { MAX_SECTION_DEPTH, type SectionTreeNode } from '@speakukrainian/shared';
import { MOVE_FIRST_POSITION, TOP_LEVEL_OPTION, UNTITLED_SECTION } from './section-messages';
import {
  applyMove,
  canMoveInto,
  findNode,
  flattenTree,
  isNoOpMove,
  isSiblingSlot,
  parentOptions,
  positionOptions,
  sectionTitle,
  siblingDropRange,
  siblingPositionAt,
  subtreeHeight,
} from './sections.model';

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

/** A tree written as nesting, with every derived field computed the way the API would. */
interface Shape {
  id: string;
  children?: Shape[];
}

function build(shapes: Shape[], parent: SectionTreeNode | null = null): SectionTreeNode[] {
  return shapes.map((shape, index) => {
    const ancestorIds = parent === null ? [] : [...parent.ancestorIds, parent.id];
    const self = node(shape.id, {
      parentId: parent === null ? null : parent.id,
      ancestorIds,
      depth: ancestorIds.length,
      path: parent === null ? `/${shape.id}` : `${parent.path}/${shape.id}`,
      sortOrder: index,
    });
    return { ...self, children: build(shape.children ?? [], self) };
  });
}

/** a → (a1 → a1x, a2), b → b1. Two roots, one of them two levels deep. */
const forest = (): SectionTreeNode[] =>
  build([
    { id: 'a', children: [{ id: 'a1', children: [{ id: 'a1x' }] }, { id: 'a2' }] },
    { id: 'b', children: [{ id: 'b1' }] },
  ]);

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

/** The moving node's own subtree is what decides how deep a target can be. */
function moverIn(tree: SectionTreeNode[], id: string): SectionTreeNode {
  const found = findNode(tree, id);
  if (found === null) {
    throw new Error(`The fixture has no section "${id}"`);
  }
  return found;
}

describe('subtreeHeight', () => {
  it('is zero for a leaf', () => {
    expect(subtreeHeight(moverIn(forest(), 'b1'))).toBe(0);
  });

  it('counts the levels below, not the nodes', () => {
    expect(subtreeHeight(moverIn(forest(), 'a1'))).toBe(1);
    expect(subtreeHeight(moverIn(forest(), 'a'))).toBe(2);
  });
});

describe('canMoveInto', () => {
  it('refuses the moving section itself', () => {
    const tree = forest();
    expect(canMoveInto(moverIn(tree, 'a1'), moverIn(tree, 'a1'))).toBe(false);
  });

  it('refuses a section inside the moving one own subtree', () => {
    const tree = forest();
    expect(canMoveInto(moverIn(tree, 'a'), moverIn(tree, 'a1x'))).toBe(false);
    expect(canMoveInto(moverIn(tree, 'a'), moverIn(tree, 'a1'))).toBe(false);
  });

  it('allows a section outside it, and the top level', () => {
    const tree = forest();
    expect(canMoveInto(moverIn(tree, 'a1'), moverIn(tree, 'b'))).toBe(true);
    expect(canMoveInto(moverIn(tree, 'a1'), null)).toBe(true);
  });

  it('allows a target that lands the whole subtree on the limit and refuses the next', () => {
    // `mover` is two levels tall, so it fits under a parent at depth 1 — its
    // grandchild lands exactly on MAX_SECTION_DEPTH — and not under one at 2.
    const tree = build([
      { id: 'd0', children: [{ id: 'd1', children: [{ id: 'd2', children: [{ id: 'd3' }] }] }] },
      { id: 'mover', children: [{ id: 'kid', children: [{ id: 'grandkid' }] }] },
    ]);
    const mover = moverIn(tree, 'mover');
    expect(subtreeHeight(mover)).toBe(2);
    expect(moverIn(tree, 'd1').depth + 1 + subtreeHeight(mover)).toBe(MAX_SECTION_DEPTH);

    expect(canMoveInto(mover, moverIn(tree, 'd1'))).toBe(true);
    expect(canMoveInto(mover, moverIn(tree, 'd2'))).toBe(false);
  });
});

describe('siblingDropRange', () => {
  const rows = (): ReturnType<typeof flattenTree> => flattenTree(forest(), new Set());

  it('spans the sibling group including each sibling own expanded subtree', () => {
    // Rows: a(0) a1(1) a1x(2) a2(1) b(0) b1(1).
    expect(siblingDropRange(rows(), 'a1')).toEqual({ start: 1, end: 3 });
  });

  it('stops at the first shallower row on each side', () => {
    expect(siblingDropRange(rows(), 'b1')).toEqual({ start: 5, end: 5 });
  });

  it('spans the whole list for a root, whose band is every root and its subtree', () => {
    expect(siblingDropRange(rows(), 'a')).toEqual({ start: 0, end: 5 });
  });

  it('ignores a collapsed sibling own subtree, which renders no rows', () => {
    const collapsed = flattenTree(forest(), new Set(['a1']));
    expect(siblingDropRange(collapsed, 'a1')).toEqual({ start: 1, end: 2 });
  });
});

describe('isSiblingSlot', () => {
  const rows = (): ReturnType<typeof flattenTree> => flattenTree(forest(), new Set());

  it('refuses a slot outside the sibling band', () => {
    // Rows: a(0) a1(1) a1x(2) a2(1) b(0) b1(1). "b1" is an only child.
    expect(isSiblingSlot(rows(), 'b1', 5)).toBe(true);
    expect(isSiblingSlot(rows(), 'b1', 4)).toBe(false);
  });

  it('refuses a slot in the middle of another sibling expanded subtree', () => {
    // Dragging the root "b" over "a"'s open subtree: landing between "a1" and
    // "a1x" would draw the placeholder there and then drop the row after the
    // whole of "a", which is a different place.
    expect(isSiblingSlot(rows(), 'b', 2)).toBe(false);
    expect(isSiblingSlot(rows(), 'b', 3)).toBe(false);
  });

  it('offers the slot before each of its own siblings, and the one after the last', () => {
    // Every position among the two roots is still reachable: before "a", and
    // after the whole of "a" — which is where "b" already is.
    expect(isSiblingSlot(rows(), 'b', 0)).toBe(true);
    expect(isSiblingSlot(rows(), 'b', 4)).toBe(true);
    expect(siblingPositionAt(rows(), 'b', 0)).toBe(0);
    expect(siblingPositionAt(rows(), 'b', 4)).toBe(1);
  });

  it('offers the slots inside the moving row own subtree, which travels with it', () => {
    // "a1x" is "a1"'s child and sits still during the drag, so the slot after
    // it is how "a1" gets dropped back where it started.
    expect(isSiblingSlot(rows(), 'a1', 1)).toBe(true);
    expect(isSiblingSlot(rows(), 'a1', 2)).toBe(true);
    expect(isSiblingSlot(rows(), 'a1', 3)).toBe(true);
  });

  it('refuses every slot for a row the tree does not render', () => {
    expect(isSiblingSlot(rows(), 'nobody', 0)).toBe(false);
  });
});

describe('siblingPositionAt', () => {
  const rows = (): ReturnType<typeof flattenTree> => flattenTree(forest(), new Set());

  it('counts siblings rather than rows, across an expanded sibling subtree', () => {
    // Landing on the last row of the band is position 1, not 2: a1x is a1 own
    // child and is not a sibling, so a naive `currentIndex - 1` is wrong here.
    expect(siblingPositionAt(rows(), 'a1', 3)).toBe(1);
  });

  it('is zero at the top of the band', () => {
    expect(siblingPositionAt(rows(), 'a1', 1)).toBe(0);
  });

  it('clamps a drop outside the band back into it', () => {
    expect(siblingPositionAt(rows(), 'a1', 0)).toBe(0);
    expect(siblingPositionAt(rows(), 'a1', 99)).toBe(1);
  });

  it('counts only the moving row own siblings, not another parent children', () => {
    // b1 sits after a whole other parent subtree, so an index-based count
    // would report it as the third child of something.
    expect(siblingPositionAt(rows(), 'b1', 5)).toBe(0);
  });
});

describe('applyMove', () => {
  it('re-parents the node and rewrites every descendant path, depth and chain', () => {
    const moved = applyMove(forest(), 'a1', { parentId: 'b', position: 0 });

    const a1 = moverIn(moved, 'a1');
    expect(a1.parentId).toBe('b');
    expect(a1.ancestorIds).toEqual(['b']);
    expect(a1.depth).toBe(1);
    expect(a1.path).toBe('/b/a1');

    const a1x = moverIn(moved, 'a1x');
    expect(a1x.parentId).toBe('a1');
    expect(a1x.ancestorIds).toEqual(['b', 'a1']);
    expect(a1x.depth).toBe(2);
    expect(a1x.path).toBe('/b/a1/a1x');
    // The invariant `sectionSchema` refines on, which a `depth + 1` would break.
    expect(a1x.depth).toBe(a1x.ancestorIds.length);
  });

  it('renumbers the destination children and leaves the source numbers alone', () => {
    const moved = applyMove(forest(), 'a1', { parentId: 'b', position: 1 });

    expect(moverIn(moved, 'b').children.map((child) => [child.id, child.sortOrder])).toEqual([
      ['b1', 0],
      ['a1', 1],
    ]);
    // The gap the server also leaves behind: `sortOrder` is only compared
    // between children of one parent, so a2 keeping 1 orders nothing wrongly.
    expect(moverIn(moved, 'a').children.map((child) => [child.id, child.sortOrder])).toEqual([
      ['a2', 1],
    ]);
  });

  it('reorders among the same parent children', () => {
    const moved = applyMove(forest(), 'a2', { parentId: 'a', position: 0 });

    expect(moverIn(moved, 'a').children.map((child) => [child.id, child.sortOrder])).toEqual([
      ['a2', 0],
      ['a1', 1],
    ]);
    expect(moverIn(moved, 'a2').path).toBe('/a/a2');
  });

  it('promotes a subsection to the top level', () => {
    const moved = applyMove(forest(), 'a1', { parentId: null, position: 0 });

    expect(moved.map((root) => [root.id, root.sortOrder])).toEqual([
      ['a1', 0],
      ['a', 1],
      ['b', 2],
    ]);
    expect(moverIn(moved, 'a1').path).toBe('/a1');
    expect(moverIn(moved, 'a1').parentId).toBeNull();
    expect(moverIn(moved, 'a1x').path).toBe('/a1/a1x');
  });

  it('clamps a position past the end of the destination children', () => {
    const moved = applyMove(forest(), 'a1', { parentId: 'b', position: 99 });

    expect(moverIn(moved, 'b').children.map((child) => child.id)).toEqual(['b1', 'a1']);
  });

  it('does not mutate the tree it was given', () => {
    // The rollback in `SectionsPage` holds the previous tree by reference, so a
    // splice or a field assignment anywhere in here would leave it with nothing
    // to roll back to.
    const tree = forest();
    const before = structuredClone(tree);

    applyMove(tree, 'a1', { parentId: 'b', position: 0 });

    expect(tree).toEqual(before);
  });

  it('leaves an untouched branch alone, node for node', () => {
    const tree = forest();
    const untouched = moverIn(tree, 'a2');

    const moved = applyMove(tree, 'b1', { parentId: 'b', position: 0 });

    expect(moverIn(moved, 'a2')).toBe(untouched);
  });

  it('answers with the tree unchanged for a section it cannot find', () => {
    const tree = forest();

    expect(applyMove(tree, 'gone', { parentId: 'b', position: 0 })).toEqual(tree);
    expect(applyMove(tree, 'a1', { parentId: 'gone', position: 0 })).toEqual(tree);
  });
});

describe('isNoOpMove', () => {
  it('holds when the drop lands where the section already is', () => {
    const tree = forest();

    expect(isNoOpMove(tree, applyMove(tree, 'a1', { parentId: 'a', position: 0 }), 'a1')).toBe(
      true,
    );
  });

  it('does not hold for a new position, or a new parent', () => {
    const tree = forest();

    expect(isNoOpMove(tree, applyMove(tree, 'a1', { parentId: 'a', position: 1 }), 'a1')).toBe(
      false,
    );
    expect(isNoOpMove(tree, applyMove(tree, 'a1', { parentId: 'b', position: 0 }), 'a1')).toBe(
      false,
    );
  });

  it('reads a repeated sortOrder as no change, since the order is what shows', () => {
    // The section form still writes a raw `sortOrder`, so two siblings can hold
    // the same number. Comparing numbers would send a request for every drop.
    const tree = build([{ id: 'a', children: [{ id: 'a1' }, { id: 'a2' }] }]).map((root) => ({
      ...root,
      children: root.children.map((child) => ({ ...child, sortOrder: 0 })),
    }));

    expect(isNoOpMove(tree, applyMove(tree, 'a1', { parentId: 'a', position: 0 }), 'a1')).toBe(
      true,
    );
  });
});

describe('parentOptions', () => {
  const deepForest = (): SectionTreeNode[] =>
    build([
      { id: 'd0', children: [{ id: 'd1', children: [{ id: 'd2', children: [{ id: 'd3' }] }] }] },
      { id: 'mover', children: [{ id: 'kid' }] },
    ]);

  it('offers the top level first and indents the tree under it', () => {
    const tree = deepForest();
    const options = parentOptions(tree, moverIn(tree, 'mover'), 'en');

    expect(options[0]).toEqual({ id: null, label: TOP_LEVEL_OPTION, depth: 0, disabled: false });
    expect(options.map((option) => [option.id, option.depth])).toEqual([
      [null, 0],
      ['d0', 1],
      ['d1', 2],
      ['d2', 3],
      ['d3', 4],
    ]);
  });

  it('omits the moving section and its whole subtree rather than disabling them', () => {
    const tree = deepForest();
    const ids = parentOptions(tree, moverIn(tree, 'mover'), 'en').map((option) => option.id);

    expect(ids).not.toContain('mover');
    expect(ids).not.toContain('kid');
  });

  it('offers a parent that would overflow the depth limit, disabled', () => {
    const tree = deepForest();
    const options = parentOptions(tree, moverIn(tree, 'mover'), 'en');

    expect(options.map((option) => [option.id, option.disabled])).toEqual([
      [null, false],
      ['d0', false],
      ['d1', false],
      // `mover` is one level tall, so its child would land at depth 4 under d2
      // and at depth 5 under d3.
      ['d2', false],
      ['d3', true],
    ]);
  });

  it('labels each option with the section title', () => {
    const tree = forest();
    const labels = parentOptions(tree, moverIn(tree, 'a1'), 'en').map((option) => option.label);

    expect(labels).toEqual([TOP_LEVEL_OPTION, 'a', 'a2', 'b', 'b1']);
  });
});

describe('positionOptions', () => {
  it('never offers the moving section a place after itself', () => {
    const tree = forest();

    expect(positionOptions(tree, moverIn(tree, 'a1'), 'a', 'en')).toEqual([
      { position: 0, label: MOVE_FIRST_POSITION },
      { position: 1, label: 'After a2' },
    ]);
  });

  it('lists the chosen parent children, in order', () => {
    const tree = forest();

    expect(positionOptions(tree, moverIn(tree, 'a1'), 'b', 'en')).toEqual([
      { position: 0, label: MOVE_FIRST_POSITION },
      { position: 1, label: 'After b1' },
    ]);
  });

  it('lists the roots for the top level', () => {
    const tree = forest();

    expect(positionOptions(tree, moverIn(tree, 'a1'), null, 'en')).toEqual([
      { position: 0, label: MOVE_FIRST_POSITION },
      { position: 1, label: 'After a' },
      { position: 2, label: 'After b' },
    ]);
  });

  it('offers only First for an empty destination', () => {
    const tree = forest();

    expect(positionOptions(tree, moverIn(tree, 'a1'), 'b1', 'en')).toEqual([
      { position: 0, label: MOVE_FIRST_POSITION },
    ]);
  });
});
