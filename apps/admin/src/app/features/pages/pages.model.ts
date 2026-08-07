import { resolveLocalized, type ContentPage, type LocaleCode } from '@speakukrainian/shared';
import type { SectionTreeNode } from '@speakukrainian/shared';
import { flattenTree, sectionTitle } from '../sections/sections.model';
import { UNTITLED_PAGE } from './page-messages';

/**
 * The title to show in the admin's own chrome: the default locale, then any
 * locale that has text, then a placeholder. `sectionTitle`'s reasoning, over a
 * page — the admin falls back further than ADR-009 does, because here the string
 * only has to identify a row well enough to click on, and stopping at the
 * default locale would blank the whole list the moment an admin makes a locale
 * default that the existing content was not authored in.
 */
export function pageTitle(page: ContentPage, defaultCode: LocaleCode | null): string {
  if (defaultCode !== null) {
    const preferred = resolveLocalized(page.title, defaultCode, defaultCode);
    if (preferred.length > 0) {
      return preferred;
    }
  }
  for (const text of Object.values(page.title)) {
    if (text.trim().length > 0) {
      return text;
    }
  }
  return UNTITLED_PAGE;
}

/** One entry of the list's section filter and of the "New page" target. */
export interface SectionChoice {
  id: string;
  label: string;
  /** Indentation only, from the walk. */
  depth: number;
  /** False for a link section, which `PagesRepository.create` refuses with a 422. */
  canHoldPages: boolean;
}

/**
 * Every section, flattened, as choices for the filter.
 *
 * The pages feature depending on the sections feature's read models is the right
 * direction — a page lives in a section — where the reverse would not be.
 * Nothing is collapsed, so the walk sees the whole tree.
 */
export function sectionChoices(
  tree: readonly SectionTreeNode[],
  defaultCode: LocaleCode | null,
): SectionChoice[] {
  return flattenTree(tree, new Set()).map((row) => ({
    id: row.section.id,
    label: sectionTitle(row.section, defaultCode),
    depth: row.depth,
    canHoldPages: row.section.kind === 'content',
  }));
}

/**
 * The owning section's path, read back off the page's own path — the same trick
 * `SectionFormPage.parentPath` and the API's `pages.rules.ts#sectionPathOf` use.
 * Answers `''` for a path with no segment to drop, which is a corrupt page path;
 * the form then simply shows the slug, rather than refusing to open the one
 * screen that could repair it.
 */
export function sectionPathOfPage(page: ContentPage): string {
  const cut = page.path.lastIndexOf('/');
  return cut <= 0 ? '' : page.path.slice(0, cut);
}
