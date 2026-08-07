import type { PageType } from '@speakukrainian/shared';

// The wording both page screens share, so the list and the form explain a
// restriction in the same words and a test asserts one constant rather than a
// string copied into a template.

/** Shown for a page with no title in any locale at all, so no row is blank. */
export const UNTITLED_PAGE = '(untitled)';

/** Used only if a 409 arrives without a body to quote. */
export const PAGE_SLUG_TAKEN_FALLBACK = 'Another page in this section already uses this slug.';

/**
 * Publishing patches `status` alone, so unsaved body edits would not be written
 * and the form would be left claiming to be pristine when it is not.
 */
export const PUBLISH_NEEDS_SAVE = 'Save your changes before publishing.';

/** A new page needs a section, and the list is where one is chosen. */
export const PICK_SECTION_FIRST = 'Choose a section first.';

/** `PagesRepository.create` refuses this with a 422, so the action is not offered. */
export const SECTION_CANNOT_HOLD_PAGES = 'A link section has no pages of its own.';

/**
 * `/pages/new` was opened with no usable `sectionId`. Nothing failed, so nothing
 * else would say anything.
 */
export const PAGE_NEEDS_SECTION = 'Open a new page from the section it belongs to.';

/** A `?type=` this release has no body editor for — #10 and #13 add the rest. */
export const BODY_TYPE_UNAVAILABLE = 'This page type cannot be edited here yet.';

export const PLAIN_TITLE_HINT =
  'Formatting is not kept — the title is used in menus, breadcrumbs and the browser tab.';

export const PLAIN_SEO_HINT =
  'Formatting is not kept — these go in the page’s <head>, where markup cannot.';

/** The list column and the form's own heading, so the two never drift. */
export const PAGE_TYPE_LABELS: Record<PageType, string> = {
  rich_text: 'Rich text',
  subsection_list: 'Subsection list',
  h5p_exercise: 'H5P exercise',
};

/** The list's "no filter" entry, which sends no `sectionId` at all. */
export const ALL_SECTIONS_OPTION = 'All sections';

/** Distinguished from "no pages yet" so an outage never reads as an empty section. */
export const PAGES_LOAD_FAILED = 'Could not load pages.';

// The subsection-list body editor's wording.

/**
 * The source picker's first entry, which stores no section id at all; the model
 * appends the section's own title in brackets when it can resolve one.
 */
export const OWN_SECTION_OPTION = 'This page’s own section';

export const OWN_SECTION_HINT =
  'Kept as it is, no section is stored — the page lists whichever section it lives in, even if that section is later moved.';

/** A section shown in the picker that has no subsections to list. */
export const LINK_SECTION_SUFFIX = ' (link section)';

/** The label for a stored source id that is nowhere in the tree. */
export const MISSING_SECTION_OPTION = '(section no longer exists)';

export const SOURCE_MUST_BE_CONTENT =
  'A link section has no subsections of its own. Choose a content section.';

export const SOURCE_SECTION_MISSING = 'That section no longer exists. Choose another one.';

/** The tree behind the picker could not be read; the interceptor has toasted. */
export const SUBSECTION_SOURCE_LOAD_FAILED = 'Could not load the list of sections.';

/** Both remedies, because neither is obvious from an empty panel. */
export const SUBSECTION_PREVIEW_EMPTY =
  'This section has no published subsections yet. Publish one, or point this page at another section.';

/** Distinguished from the empty state, the reason `PAGES_LOAD_FAILED` gives. */
export const SUBSECTION_PREVIEW_FAILED = 'Could not load the subsections to preview.';

/** There is no section to list — the preview has nothing to ask the API for. */
export const SUBSECTION_PREVIEW_NO_SOURCE = 'Choose a section above to preview its subsections.';

/** Shown only when the API answers with a cursor; paging the preview is out of scope. */
export const SUBSECTION_PREVIEW_TRUNCATED =
  'This section has more published subsections than are previewed here.';

export const PREVIEW_LOCALE_LABEL = 'Preview language';
