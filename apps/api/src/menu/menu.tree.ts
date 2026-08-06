import {
  resolveLocalized,
  type LocaleCode,
  type MenuEntry,
  type Section,
  type SectionTreeNode,
} from '@speakukrainian/shared';
import { buildTree } from '../sections/sections.tree.js';

/**
 * The menu is a filtered projection of the section tree, so it is built from
 * the whole tree — including the sections it does not show.
 *
 * That is not incidental. `sortOrder` is assigned per parent, so a value is
 * only comparable between siblings; picking the visible sections out with a
 * query and sorting them by `sortOrder` alone interleaves a promoted child with
 * its new siblings, since its number was handed out under a different parent.
 * Walking the tree in order instead puts every entry where its author put it:
 * a promoted child lands in the slot its hidden ancestor occupied, because that
 * is where the walk reaches it. Ordering within one sibling group is
 * `buildTree`'s, which is the order the admin's own tree screen shows.
 *
 * ADR-011: a section whose parent is not in the menu — unticked, draft or
 * archived — attaches to the nearest ancestor that is, or becomes a top-level
 * entry when none is. It keeps its own `href`, which still contains the hidden
 * ancestor's slug, because that is where the page actually lives. The
 * alternative is that unticking one section silently deletes a whole branch of
 * the navigation.
 *
 * @param sections every stored section, ordered by `sortOrder`
 */
export function buildMenu(
  sections: Section[],
  locale: LocaleCode,
  defaultLocale: LocaleCode,
): MenuEntry[] {
  const roots: MenuEntry[] = [];

  // The nearest visible ancestor is carried down the walk rather than looked up
  // from a node's `ancestorIds`, so promotion cannot skip a level that is in
  // the menu. Recursion is bounded by MAX_SECTION_DEPTH, and `buildTree` leaves
  // any cycle out of its roots, so the walk always terminates.
  const visit = (node: SectionTreeNode, visibleParent: MenuEntry | undefined): void => {
    const entry = isInMenu(node) ? toEntry(node, locale, defaultLocale) : undefined;
    if (entry !== undefined) {
      (visibleParent === undefined ? roots : visibleParent.children).push(entry);
    }
    for (const child of node.children) {
      visit(child, entry ?? visibleParent);
    }
  };

  for (const node of buildTree(sections)) {
    visit(node, undefined);
  }
  return roots;
}

/**
 * What the public navigation shows. This is the only thing keeping a draft or
 * unticked section out of an anonymous response, now that the read behind the
 * menu is the whole collection rather than a filtered query.
 */
function isInMenu(section: Section): boolean {
  return section.showInMenu && section.status === 'published';
}

function toEntry(section: Section, locale: LocaleCode, defaultLocale: LocaleCode): MenuEntry {
  return {
    id: section.id,
    // `resolveLocalized` is ADR-009's rule *within* one field; the `||` is the
    // separate product rule that an empty menu label falls back to the title.
    label:
      resolveLocalized(section.menuLabel, locale, defaultLocale) ||
      resolveLocalized(section.title, locale, defaultLocale),
    href: section.link?.href ?? section.path,
    openInNewTab: section.link?.openInNewTab ?? false,
    children: [],
  };
}
