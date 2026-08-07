import {
  resolveLocalized,
  type LocaleCode,
  type RichText,
  type Section,
  type SectionTreeNode,
} from '@speakukrainian/shared';
import { toPlainLocalized } from '../../shared/rich-text/localized-plain-text';
import { UNTITLED_SECTION } from '../sections/section-messages';
import { flattenTree, findNode, sectionTitle } from '../sections/sections.model';
import { LINK_SECTION_SUFFIX, MISSING_SECTION_OPTION, OWN_SECTION_OPTION } from './page-messages';

// What the `subsection_list` body editor derives, as pure functions with no
// Angular in them. The pages feature reading the sections feature's models is
// the direction `pages.model.ts` documents — a page lives in a section.

/** One entry of the source picker. */
export interface SourceOption {
  /** `null` is the "this page's own section" entry, which stores no id at all. */
  id: string | null;
  label: string;
  /** Indentation only, from the tree walk. */
  depth: number;
  /** A `link` section, which has no subsections to list. */
  isLink: boolean;
  /** A stored id that is nowhere in the tree — kept so the select shows something. */
  missing: boolean;
}

/**
 * Every section the page could list, with the default first.
 *
 * A `link` section is offered rather than disabled, and says so in its label:
 * the stale case — a stored source that was later switched to `kind: 'link'` or
 * deleted — needs {@link sourceProblem} anyway, so disabling the option would be
 * a second mechanism for one rule, and a refusal nobody can provoke cannot be
 * read.
 *
 * That is the opposite treatment to `sections.model.ts#parentOptions`, which
 * disables the illegal entry and prints its reason on the option itself. The
 * line between the two is whether a stored document can already be in the
 * refused state. Every stored parent is one the API accepted, so `parentOptions`
 * only ever refuses a move the author is about to make and the picker can be the
 * whole rule. A saved `sourceSectionId` can point at a section switched to
 * `kind: 'link'` or deleted long after the save, so this rule needs a validator
 * whatever the picker does — and given the validator, disabling the option would
 * remove the one case where the author can read the reason.
 *
 * Not the same thing as `pages.model.ts#sectionChoices`, despite the identical
 * walk and a flag that with two section kinds is today its negation. They answer
 * different questions: `canHoldPages` is the create rule `PagesRepository.create`
 * enforces with a 422, `isLink` is "has no subsections of its own". Merging them
 * would tie two unrelated rules to one field, and a third section kind, or the
 * API relaxing either rule, would have to unpick it.
 */
export function sourceOptions(
  tree: readonly SectionTreeNode[],
  ownSectionId: string | null,
  selectedId: string | null,
  defaultCode: LocaleCode | null,
): SourceOption[] {
  const own = ownSectionId === null ? null : findNode(tree, ownSectionId);
  const options: SourceOption[] = [
    {
      id: null,
      // `sectionTitle` and not `resolveLocalized`: this is admin chrome, where
      // falling back past the default locale keeps the entry readable.
      label:
        own === null
          ? OWN_SECTION_OPTION
          : `${OWN_SECTION_OPTION} (${sectionTitle(own, defaultCode)})`,
      depth: 0,
      isLink: false,
      missing: false,
    },
  ];

  for (const row of flattenTree(tree, new Set())) {
    const isLink = row.section.kind === 'link';
    options.push({
      id: row.section.id,
      label: sectionTitle(row.section, defaultCode) + (isLink ? LINK_SECTION_SUFFIX : ''),
      depth: row.depth,
      isLink,
      missing: false,
    });
  }

  // Without an entry for it, a `mat-select` holding an id the tree does not
  // carry renders a blank trigger and the author sees nothing wrong.
  if (selectedId !== null && !options.some((option) => option.id === selectedId)) {
    options.push({
      id: selectedId,
      label: MISSING_SECTION_OPTION,
      depth: 0,
      isLink: false,
      missing: true,
    });
  }

  return options;
}

export type SourceProblem = 'not-content' | 'missing' | null;

/**
 * Why the chosen source cannot be listed, or `null`.
 *
 * **Fails open on an empty list**, which is what a caller passes while the tree
 * is unknown: a slow or failed tree read must not block saving a page whose body
 * is otherwise fine, and the rule applies the moment the facts arrive.
 */
export function sourceProblem(
  options: readonly SourceOption[],
  selectedId: string | null,
): SourceProblem {
  // The default is always valid: it resolves to the section the page lives in,
  // which the API has already refused to make a link section.
  if (selectedId === null) {
    return null;
  }
  const option = options.find((entry) => entry.id === selectedId);
  if (option === undefined) {
    return null;
  }
  if (option.missing) {
    return 'missing';
  }
  return option.isLink ? 'not-content' : null;
}

/** One card or row of the preview. */
export interface SubsectionPreviewRow {
  id: string;
  title: string;
  /** `null` when the section has no image, or when `showImages` is off. */
  imageUrl: string | null;
  imageAlt: string;
  /** `''` when the section has no description, or when `showDescriptions` is off. */
  excerpt: string;
}

/**
 * What the preview renders, for one locale.
 *
 * **Input order is preserved and nothing re-sorts here**: `SectionsRepository.list`
 * already answers `orderBy('sortOrder')`, and a second sort would be a second
 * opinion about ordering that could disagree with the public site.
 *
 * Locale resolution is ADR-009 per field, against the previewed locale — and
 * deliberately not `sectionTitle`, whose extra "then any locale that has text"
 * widening exists so an admin *row stays clickable*. Applying it here would hide
 * the very translation gap the author switched locales to look for.
 */
export function subsectionPreviewRows(
  sections: readonly Section[],
  options: {
    locale: LocaleCode;
    defaultCode: LocaleCode | null;
    showImages: boolean;
    showDescriptions: boolean;
  },
): SubsectionPreviewRow[] {
  const { locale, defaultCode, showImages, showDescriptions } = options;
  const fallback = defaultCode ?? locale;

  return sections.map((section) => {
    const image = showImages ? section.image : undefined;
    return {
      id: section.id,
      // ADR-009 leaves "no field has text in any locale" to the consumer; a
      // blank card is not something an author can act on.
      title: resolveLocalized(section.title, locale, fallback) || UNTITLED_SECTION,
      imageUrl: image?.url ?? null,
      imageAlt: image === undefined ? '' : resolveLocalized(image.alt, locale, fallback),
      excerpt: showDescriptions ? descriptionExcerpt(section.description, locale, defaultCode) : '',
    };
  });
}

export const EXCERPT_LENGTH = 160;

/**
 * A section's description as plain text, for the previewed locale.
 *
 * **Strips before it resolves, and the order is load-bearing.**
 * `resolveLocalized` treats a value as present when the *string* is non-blank,
 * and `<p></p>` — what the editor writes for a tab the author opened and left
 * empty — is a non-blank string with no text in it. Resolving first would pick
 * that locale and render an empty excerpt where the default locale had prose.
 *
 * Stripping also makes the result safe to interpolate, which is what keeps
 * `[innerHTML]` out of the preview's list (ADR-003).
 */
export function descriptionExcerpt(
  description: RichText | undefined,
  locale: LocaleCode,
  defaultCode: LocaleCode | null,
): string {
  const plain = toPlainLocalized(description);
  return truncate(resolveLocalized(plain, locale, defaultCode ?? locale));
}

/** Cuts on the last word boundary inside the limit; a single over-long word is hard-cut. */
function truncate(text: string): string {
  if (text.length <= EXCERPT_LENGTH) {
    return text;
  }
  const cut = text.slice(0, EXCERPT_LENGTH);
  const space = cut.lastIndexOf(' ');
  return `${space > 0 ? cut.slice(0, space) : cut}…`;
}
