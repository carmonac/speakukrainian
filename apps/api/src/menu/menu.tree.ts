import {
  linkTargetSchema,
  resolveLocalized,
  type LocaleCode,
  type LocalizedText,
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
 * ADR-011: a section whose parent is not in the menu — unticked, draft,
 * archived, or dropped by one of the checks below — attaches to the nearest
 * ancestor that is, or becomes a top-level entry when none is. It keeps its own
 * `href`, which still contains the hidden ancestor's slug, because that is where
 * the page actually lives. The alternative is that unticking one section
 * silently deletes a whole branch of the navigation.
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
 *
 * A stored link target is re-checked here against the rule the write path
 * applies. ADR-012 keeps *reading* a bad href lenient so the document stays
 * repairable; it does not follow that the value is fit to publish, and this
 * route is anonymous and sitewide, so a `javascript:` href stored before the
 * rule existed would otherwise be handed to every reader. Dropping the entry
 * reuses ADR-011's promotion rule, so the section's visible children keep their
 * place instead of disappearing with it. Falling back to `section.path` is not
 * the alternative it looks like: a `link` section has no page of its own there.
 */
function isInMenu(section: Section): boolean {
  if (!section.showInMenu || section.status !== 'published') {
    return false;
  }
  return section.link === undefined || linkTargetSchema.safeParse(section.link).success;
}

/**
 * `undefined` for a section that has no text to label it with in any locale,
 * which leaves it out of the menu — see {@link menuText}.
 */
function toEntry(
  section: Section,
  locale: LocaleCode,
  defaultLocale: LocaleCode,
): MenuEntry | undefined {
  const label = menuText(section, locale, defaultLocale);
  if (label === undefined) {
    return undefined;
  }
  return {
    id: section.id,
    label,
    href: section.link?.href ?? section.path,
    openInNewTab: section.link?.openInNewTab ?? false,
    children: [],
  };
}

/**
 * The label of one entry, and the decision rule 2 asks for about a translation
 * that is missing everywhere.
 *
 * ADR-009 resolves *within* a field — requested locale, then the default — and
 * the menu label is tried before the title because it overrides it. When
 * neither field resolves, any locale that has text wins over showing nothing:
 * the same widening `sectionTitle` makes in the admin, and for the same reason,
 * that a name in the wrong language identifies the destination and an empty one
 * does not. A section with text in no locale at all is left out of the menu
 * entirely, because the only thing left to render is a nameless link.
 */
function menuText(
  section: Section,
  locale: LocaleCode,
  defaultLocale: LocaleCode,
): string | undefined {
  const fields = [section.menuLabel, section.title];
  for (const field of fields) {
    const resolved = resolveLocalized(field, locale, defaultLocale);
    if (resolved.length > 0) {
      return resolved;
    }
  }
  for (const field of fields) {
    const text = anyText(field);
    if (text !== undefined) {
      return text;
    }
  }
  return undefined;
}

/**
 * Which locale this lands on is the record's own key order, which is whatever
 * Firestore answered with. A caller needing a deterministic choice would have to
 * read the locales list; identifying a menu destination does not.
 */
function anyText(field: LocalizedText | undefined): string | undefined {
  return Object.values(field ?? {}).find((text) => text.trim().length > 0);
}
