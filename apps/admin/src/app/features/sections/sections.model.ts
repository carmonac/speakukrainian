import {
  MAX_SECTION_DEPTH,
  resolveLocalized,
  type LocaleCode,
  type Section,
  type SectionTreeNode,
} from '@speakukrainian/shared';
import { MOVE_FIRST_POSITION, TOP_LEVEL_OPTION, UNTITLED_SECTION } from './section-messages';

/** One rendered line of the tree. The page renders a flat list of these. */
export interface SectionRow {
  section: SectionTreeNode;
  /** Indentation level from the walk, not `section.depth`. */
  depth: number;
  hasChildren: boolean;
  childCount: number;
  expanded: boolean;
  canAddChild: boolean;
}

/**
 * Flattens the tree into the rows to render, depth first, emitting a parent
 * immediately before its own children and skipping the whole subtree of a
 * collapsed node.
 *
 * Collapsed — not expanded — is the stored set, so a tree loaded for the first
 * time is fully open and only what the admin folded away stays folded.
 */
export function flattenTree(
  nodes: readonly SectionTreeNode[],
  collapsed: ReadonlySet<string>,
): SectionRow[] {
  const rows: SectionRow[] = [];

  const walk = (siblings: readonly SectionTreeNode[], depth: number): void => {
    for (const section of siblings) {
      const expanded = !collapsed.has(section.id);
      rows.push({
        section,
        // The walk's own depth, because `buildTree` deliberately surfaces a
        // section whose parent document is gone as a root: its stored `depth`
        // would then indent it under nothing.
        depth,
        hasChildren: section.children.length > 0,
        childCount: section.children.length,
        expanded,
        // The stored depth, because this is exactly the check the API's create
        // makes — using the walk depth would offer an action it then refuses.
        canAddChild: section.depth + 1 <= MAX_SECTION_DEPTH,
      });
      if (expanded) {
        walk(section.children, depth + 1);
      }
    }
  };

  walk(nodes, 0);
  return rows;
}

/**
 * The title to show in the admin's own chrome: the default locale, then any
 * locale that has text, then a placeholder.
 *
 * The admin falls back further than ADR-009 does. ADR-009 governs rendering the
 * public site, where showing a reader a language they did not ask for is a
 * product decision; here the string only has to identify a row well enough to
 * click on. Stopping at the default locale would blank the whole tree the
 * moment an admin makes a locale default that the existing content was not
 * authored in — a state `/locales` can put the site into.
 *
 * Which locale the fallback lands on is the record's own key order, which is
 * whatever the API answered with. That is good enough to identify a row; a
 * caller that needs a deterministic choice should iterate the locales list.
 */
export function sectionTitle(section: Section, defaultCode: LocaleCode | null): string {
  if (defaultCode !== null) {
    const preferred = resolveLocalized(section.title, defaultCode, defaultCode);
    if (preferred.length > 0) {
      return preferred;
    }
  }
  for (const text of Object.values(section.title)) {
    if (text.trim().length > 0) {
      return text;
    }
  }
  return UNTITLED_SECTION;
}

/** The node in `nodes` with that id, at any depth, or `null`. */
export function findNode(nodes: readonly SectionTreeNode[], id: string): SectionTreeNode | null {
  for (const node of nodes) {
    if (node.id === id) {
      return node;
    }
    const found = findNode(node.children, id);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/** How many levels hang below a node: 0 for a leaf. */
export function subtreeHeight(node: SectionTreeNode): number {
  return node.children.reduce((deepest, child) => Math.max(deepest, 1 + subtreeHeight(child)), 0);
}

/**
 * Whether `moving` may become a child of `target` — `null` meaning the top
 * level. A boolean and never a message: a target that fails this is one the UI
 * does not offer, and the only wording anyone sees is `MAX_DEPTH_MESSAGE` or,
 * for a request that got past the UI, the API's own sentence.
 *
 * The two conditions are the two the API's `move` evaluates, over the same
 * fields, on the tree the client already holds — a section cannot land inside
 * itself or its own subtree, and its deepest descendant has to still fit.
 */
export function canMoveInto(moving: SectionTreeNode, target: SectionTreeNode | null): boolean {
  if (target !== null && (target.id === moving.id || target.ancestorIds.includes(moving.id))) {
    return false;
  }
  const nextDepth = target === null ? 0 : target.depth + 1;
  return nextDepth + subtreeHeight(moving) <= MAX_SECTION_DEPTH;
}

/** A contiguous, inclusive range of flat row indexes. */
export interface RowRange {
  start: number;
  end: number;
}

/**
 * The rows a vertical drag of `movingId` may land between: its own sibling
 * band, which is the rows from the first one after its parent to the last one
 * before its parent's next sibling. Restricting the drag to it is what makes a
 * plain vertical drag always a reorder and never an accidental re-parent.
 *
 * Measured on the rendered depth rather than on `parentId`, so a section whose
 * parent document is gone — which `flattenTree` surfaces as a root — has the
 * band the admin can actually see.
 */
export function siblingDropRange(rows: readonly SectionRow[], movingId: string): RowRange {
  const index = rows.findIndex((row) => row.section.id === movingId);
  if (index === -1) {
    return { start: 0, end: Math.max(rows.length - 1, 0) };
  }

  const depth = rows[index]!.depth;
  let start = index;
  while (start > 0 && rows[start - 1]!.depth >= depth) {
    start -= 1;
  }
  let end = index;
  while (end < rows.length - 1 && rows[end + 1]!.depth >= depth) {
    end += 1;
  }
  return { start, end };
}

/**
 * Whether the drag placeholder may rest at flat index `index` — CDK's index
 * being "the slot the moving row would occupy once it is taken out of the list
 * and put back", so `index` counts against the rows *without* the moving one.
 *
 * Two conditions. It has to be inside the sibling band, which is what makes a
 * vertical drag a reorder and never an accidental re-parent. And the row that
 * would follow it has to be one of its own siblings, one of its own descendants
 * — they sit still during the drag and travel with it on the drop — or the row
 * that ends the band. A slot in the middle of *another* sibling's expanded
 * subtree is refused: dropping there lands the row after that whole subtree, so
 * offering it would draw the placeholder somewhere the row will not appear.
 */
export function isSiblingSlot(
  rows: readonly SectionRow[],
  movingId: string,
  index: number,
): boolean {
  const at = rows.findIndex((row) => row.section.id === movingId);
  if (at === -1) {
    return false;
  }

  const { start, end } = siblingDropRange(rows, movingId);
  if (index < start || index > end) {
    return false;
  }

  const following = rows.filter((_, i) => i !== at)[index];
  return (
    following === undefined ||
    following.depth <= rows[at]!.depth ||
    following.section.ancestorIds.includes(movingId)
  );
}

/** A rendered row's vertical span, in viewport coordinates. */
export interface RowBand {
  id: string;
  top: number;
  bottom: number;
}

/**
 * The horizontal span the nest columns occupy. Every row shares it, and it does
 * not move during a drag: the only thing a drag translates is vertical.
 */
export interface NestStrip {
  left: number;
  right: number;
}

/**
 * Whether the pointer is over the column of nest targets rather than over the
 * body of the tree — the horizontal half of "drop it on a row to nest inside".
 */
export function isInNestStrip(strip: NestStrip | null, x: number): boolean {
  return strip !== null && x >= strip.left && x < strip.right;
}

/**
 * The row the pointer is level with. A whole row's height, not the 40px box the
 * icon is drawn in: the box says where the strip is, and the band is what has to
 * be hit.
 */
export function rowBandAt(bands: readonly RowBand[], y: number): string | null {
  return bands.find((band) => y >= band.top && y < band.bottom)?.id ?? null;
}

/**
 * The position among its siblings that dropping the moving row at flat index
 * `currentIndex` asks for — which is what a move body's `sortOrder` is.
 *
 * The flat index is not the position: an expanded sibling contributes a row per
 * descendant, and the moving row's own descendants sit between it and the next
 * sibling. So the rows before the landing point are counted, and only those at
 * the moving row's own depth inside its band are siblings.
 */
export function siblingPositionAt(
  rows: readonly SectionRow[],
  movingId: string,
  currentIndex: number,
): number {
  const index = rows.findIndex((row) => row.section.id === movingId);
  if (index === -1) {
    return 0;
  }

  const depth = rows[index]!.depth;
  const { start, end } = siblingDropRange(rows, movingId);
  const at = Math.min(Math.max(currentIndex, start), end);
  // The moving row leaves the list before it is re-inserted, and it always sits
  // inside its own band, so every index below `start` is unaffected by that.
  const rest = rows.filter((_, i) => i !== index);

  let position = 0;
  for (let i = start; i < at; i += 1) {
    if (rest[i]?.depth === depth) {
      position += 1;
    }
  }
  return position;
}

/** Where a move puts a section: under a parent (`null` for the top level), at a position. */
export interface MovePlacement {
  parentId: string | null;
  position: number;
}

/**
 * The tree as it will look once the move lands, as a **brand-new** tree: new
 * arrays for every child list that changes and new nodes for every node whose
 * fields change, with untouched branches reused by reference. Nothing is
 * spliced, pushed or assigned into the input, which is what lets the page hold
 * the previous tree as a rollback snapshot and what makes zoneless change
 * detection see a new signal value.
 *
 * It recomputes the same derived fields the server recomputes — `parentId`,
 * `ancestorIds`, `depth` and `path` for the moved node and every node under it,
 * and the destination's child numbering — so the screen shows the paths the
 * next read will return without waiting for one.
 */
export function applyMove(
  tree: readonly SectionTreeNode[],
  movingId: string,
  placement: MovePlacement,
): SectionTreeNode[] {
  const moving = findNode(tree, movingId);
  if (moving === null || placement.parentId === movingId) {
    return [...tree];
  }

  const detached = detach(tree, movingId) ?? [...tree];
  const parent = placement.parentId === null ? null : findNode(detached, placement.parentId);
  if (placement.parentId !== null && parent === null) {
    return [...tree];
  }

  const rehomed = rehome(moving, parent);
  const placed = replaceChildren(detached, placement.parentId, (children) =>
    insertAt(children, rehomed, placement.position),
  );
  return placed ?? [...tree];
}

/**
 * The tree without `id`, rebuilding only the branch that held it — `null` when
 * the id is nowhere below, which is what lets an untouched branch keep its own
 * array and its own node objects.
 */
function detach(nodes: readonly SectionTreeNode[], id: string): SectionTreeNode[] | null {
  if (nodes.some((node) => node.id === id)) {
    return nodes.filter((node) => node.id !== id);
  }

  let found = false;
  const next = nodes.map((node) => {
    const children = detach(node.children, id);
    if (children === null) {
      return node;
    }
    found = true;
    return { ...node, children };
  });
  return found ? next : null;
}

/**
 * A node and its whole subtree with the derived fields they get under a new
 * parent. `depth` comes from the ancestor chain rather than from the parent's
 * own depth, the same reason the server's `rewriteDescendant` gives: it is the
 * one spelling that cannot drift from `ancestorIds`.
 */
function rehome(node: SectionTreeNode, parent: SectionTreeNode | null): SectionTreeNode {
  const ancestorIds = parent === null ? [] : [...parent.ancestorIds, parent.id];
  const placed: SectionTreeNode = {
    ...node,
    parentId: parent === null ? null : parent.id,
    ancestorIds,
    depth: ancestorIds.length,
    path: parent === null ? `/${node.slug}` : `${parent.path}/${node.slug}`,
    children: [],
  };
  return { ...placed, children: node.children.map((child) => rehome(child, placed)) };
}

/** The child list with `node` at a clamped position, renumbered `0..n`. */
function insertAt(
  children: readonly SectionTreeNode[],
  node: SectionTreeNode,
  position: number,
): SectionTreeNode[] {
  const at = Math.min(Math.max(position, 0), children.length);
  const ordered = [...children.slice(0, at), node, ...children.slice(at)];
  return ordered.map((child, index) =>
    child.sortOrder === index ? child : { ...child, sortOrder: index },
  );
}

/**
 * The tree with one node's child list replaced — the root list when `parentId`
 * is null. `null` when no node carries that id, so a caller can tell "replaced
 * nothing" from "replaced with the same thing".
 */
function replaceChildren(
  nodes: readonly SectionTreeNode[],
  parentId: string | null,
  replace: (children: readonly SectionTreeNode[]) => SectionTreeNode[],
): SectionTreeNode[] | null {
  if (parentId === null) {
    return replace(nodes);
  }

  let found = false;
  const next = nodes.map((node) => {
    if (node.id === parentId) {
      found = true;
      return { ...node, children: replace(node.children) };
    }
    const children = replaceChildren(node.children, parentId, replace);
    if (children === null) {
      return node;
    }
    found = true;
    return { ...node, children };
  });
  return found ? next : null;
}

/**
 * Whether a move would leave the section exactly where it already is: same
 * parent, same order among the same siblings — in which case the request would
 * only rewrite the numbers it is already holding.
 *
 * Compared on the sibling id order and not on `sortOrder`, because the stored
 * numbers can be gappy or repeated: the section form still writes a raw
 * `sortOrder`, and a re-parent leaves a gap behind on purpose.
 */
export function isNoOpMove(
  previous: readonly SectionTreeNode[],
  next: readonly SectionTreeNode[],
  id: string,
): boolean {
  const before = findNode(previous, id);
  const after = findNode(next, id);
  if (before === null || after === null || before.parentId !== after.parentId) {
    return false;
  }

  const was = childIds(previous, before.parentId);
  const now = childIds(next, after.parentId);
  return was.length === now.length && was.every((child, index) => child === now[index]);
}

function childIds(nodes: readonly SectionTreeNode[], parentId: string | null): string[] {
  const siblings = parentId === null ? nodes : (findNode(nodes, parentId)?.children ?? []);
  return siblings.map((node) => node.id);
}

/** One entry of the move screen's parent picker. */
export interface ParentOption {
  id: string | null;
  label: string;
  /** Indentation only: 0 for the top-level entry, 1 for a root section, and so on. */
  depth: number;
  /** True for a parent the move would be refused for, which the option says out loud. */
  disabled: boolean;
}

/**
 * Every section that could hold `moving`, with the moving node and its whole
 * subtree **omitted** rather than disabled: those are never legal under any
 * reading and a disabled row invites "why?", while a too-deep one has a reason
 * worth showing.
 */
export function parentOptions(
  tree: readonly SectionTreeNode[],
  moving: SectionTreeNode,
  defaultCode: LocaleCode | null,
): ParentOption[] {
  const options: ParentOption[] = [
    {
      id: null,
      label: TOP_LEVEL_OPTION,
      depth: 0,
      disabled: !canMoveInto(moving, null),
    },
  ];

  const walk = (nodes: readonly SectionTreeNode[], depth: number): void => {
    for (const node of nodes) {
      if (node.id === moving.id) {
        continue;
      }
      options.push({
        id: node.id,
        label: sectionTitle(node, defaultCode),
        depth,
        disabled: !canMoveInto(moving, node),
      });
      walk(node.children, depth + 1);
    }
  };

  walk(tree, 1);
  return options;
}

/** One entry of the move screen's position picker. */
export interface PositionOption {
  position: number;
  label: string;
}

/**
 * Where among a parent's children the section can land, worded as places rather
 * than numbers. The moving node is left out of its own parent's list, so
 * "After" itself is never offered and the positions match what the server
 * renumbers to.
 */
export function positionOptions(
  tree: readonly SectionTreeNode[],
  moving: SectionTreeNode,
  parentId: string | null,
  defaultCode: LocaleCode | null,
): PositionOption[] {
  const parent = parentId === null ? null : findNode(tree, parentId);
  const siblings = (parentId === null ? tree : (parent?.children ?? [])).filter(
    (node) => node.id !== moving.id,
  );

  return [
    { position: 0, label: MOVE_FIRST_POSITION },
    ...siblings.map((node, index) => ({
      position: index + 1,
      label: `After ${sectionTitle(node, defaultCode)}`,
    })),
  ];
}
