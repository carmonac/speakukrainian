import {
  MAX_SECTION_DEPTH,
  resolveLocalized,
  type LocaleCode,
  type Section,
  type SectionTreeNode,
} from '@speakukrainian/shared';
import { UNTITLED_SECTION } from './section-messages';

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
