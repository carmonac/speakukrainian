import {
  resolveLocalized,
  type LocaleCode,
  type MenuEntry,
  type Section,
} from '@speakukrainian/shared';

/**
 * Nests the menu in memory, in the same two passes as `buildTree`: every entry
 * is built first, then linked, so a child does not depend on its parent
 * appearing before it in the input.
 *
 * The input is every published, `showInMenu: true` section, already ordered by
 * `sortOrder`, which is what makes `children` come out ordered with no extra
 * sort — a promoted child included, since the ordering is global.
 *
 * ADR-011: a section whose parent is not in that set — hidden, draft or
 * archived — attaches to the nearest ancestor that *is*, or becomes a top-level
 * entry when none is. It keeps its own `href`, which still contains the hidden
 * ancestor's slug, because that is where the page actually lives. The
 * alternative is that unticking one section silently deletes a whole branch of
 * the navigation.
 */
export function buildMenu(
  sections: Section[],
  locale: LocaleCode,
  defaultLocale: LocaleCode,
): MenuEntry[] {
  const entries = new Map<string, MenuEntry>(
    sections.map((section) => [section.id, toEntry(section, locale, defaultLocale)]),
  );

  const roots: MenuEntry[] = [];
  for (const section of sections) {
    const entry = entries.get(section.id)!;
    const parent = nearestVisibleAncestor(section, entries);
    if (parent) {
      parent.children.push(entry);
    } else {
      roots.push(entry);
    }
  }
  return roots;
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

/** Walks `ancestorIds` from the closest outwards, so promotion is by one level where it can be. */
function nearestVisibleAncestor(
  section: Section,
  entries: Map<string, MenuEntry>,
): MenuEntry | undefined {
  for (let index = section.ancestorIds.length - 1; index >= 0; index -= 1) {
    const ancestor = entries.get(section.ancestorIds[index]!);
    if (ancestor) {
      return ancestor;
    }
  }
  return undefined;
}
