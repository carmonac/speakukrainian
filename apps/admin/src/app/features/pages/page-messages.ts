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
