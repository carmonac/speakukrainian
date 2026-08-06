import type { Section, SectionTreeNode } from '@speakukrainian/shared';

/**
 * The path/depth/ancestor arithmetic behind ADR-002's materialized tree, kept
 * apart from Firestore so it is reachable without an emulator. A stale
 * descendant path is a broken public URL, so every function here fails loudly
 * rather than guessing.
 */

/** `/grammar-points` for a root, `${parent.path}/${slug}` otherwise. */
export function buildPath(parentPath: string | null, slug: string): string {
  return parentPath === null ? `/${slug}` : `${parentPath}/${slug}`;
}

/** What a node's derived fields become under a given parent (or none). */
export interface Placement {
  parentId: string | null;
  ancestorIds: string[];
  depth: number;
  path: string;
}

export function placeUnder(parent: Section | null, slug: string): Placement {
  const ancestorIds = parent === null ? [] : [...parent.ancestorIds, parent.id];
  return {
    parentId: parent === null ? null : parent.id,
    ancestorIds,
    depth: ancestorIds.length,
    path: buildPath(parent === null ? null : parent.path, slug),
  };
}

/**
 * Whether a placement leaves a section's derived fields exactly as they are —
 * which is what a reorder under the same parent computes. Every field is
 * compared rather than just `path`, so a stored document whose derived fields
 * disagree with each other is still repaired by the rewrite.
 */
export function isSamePlacement(section: Section, placement: Placement): boolean {
  return (
    section.parentId === placement.parentId &&
    section.path === placement.path &&
    section.depth === placement.depth &&
    section.ancestorIds.length === placement.ancestorIds.length &&
    section.ancestorIds.every((id, index) => id === placement.ancestorIds[index])
  );
}

/** The node whose subtree is being rewritten, before and after the change. */
export interface MovedNode {
  id: string;
  oldPath: string;
  next: Placement;
}

/**
 * Rewrites one descendant for a node that moved from `oldPath` to
 * `node.next.path`. Throws when the descendant does not actually sit under the
 * node: that means the stored tree is already corrupt, and writing a guessed
 * path would cement it.
 */
export function rewriteDescendant(descendant: Section, node: MovedNode): Section {
  if (!descendant.path.startsWith(`${node.oldPath}/`)) {
    throw new Error(
      `Section ${descendant.id} has path "${descendant.path}", which is not under "${node.oldPath}"`,
    );
  }

  const index = descendant.ancestorIds.indexOf(node.id);
  if (index === -1) {
    throw new Error(`Section ${descendant.id} does not list ${node.id} among its ancestors`);
  }

  const ancestorIds = [
    ...node.next.ancestorIds,
    node.id,
    ...descendant.ancestorIds.slice(index + 1),
  ];

  return {
    ...descendant,
    path: node.next.path + descendant.path.slice(node.oldPath.length),
    ancestorIds,
    // Derived from the chain rather than added to the old depth, so
    // `sectionSchema`'s `depth === ancestorIds.length` refinement cannot be
    // broken by an off-by-one here.
    depth: ancestorIds.length,
  };
}

/** Deepest `depth` among the node and its descendants, once the node sits at `nextDepth`. */
export function deepestAfterMove(node: Section, descendants: Section[], nextDepth: number): number {
  const drop = descendants.reduce((deepest, d) => Math.max(deepest, d.depth - node.depth), 0);
  return nextDepth + drop;
}

/**
 * Nesting assembled in memory. Input must already be ordered by `sortOrder`,
 * which is what makes `children` come out ordered with no extra sort.
 */
export function buildTree(sections: Section[]): SectionTreeNode[] {
  const nodes = new Map<string, SectionTreeNode>(
    sections.map((section) => [section.id, { ...section, children: [] }]),
  );

  const roots: SectionTreeNode[] = [];
  for (const section of sections) {
    const node = nodes.get(section.id)!;
    const parent = section.parentId === null ? undefined : nodes.get(section.parentId);
    if (parent) {
      parent.children.push(node);
    } else {
      // A node whose parent is missing surfaces as a root rather than
      // disappearing: a data problem should be visible in the admin, not hide
      // content behind a document that is no longer there.
      roots.push(node);
    }
  }
  return roots;
}
