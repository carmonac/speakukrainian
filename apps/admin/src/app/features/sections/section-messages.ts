import { MAX_SECTION_DEPTH } from '@speakukrainian/shared';

/**
 * The wording both section screens share, so the tree and the form explain a
 * restriction in the same words and a test asserts one constant rather than a
 * string copied into a template.
 */

/**
 * The API refuses to delete a section that still has subsections. The tree
 * disables the action and says this instead of letting the admin discover it
 * through a 409.
 */
export const DELETE_WITH_CHILDREN_MESSAGE = 'Delete or move its subsections first.';

/** `MAX_SECTION_DEPTH` is a depth, and depth 0 is the first level. */
export const MAX_DEPTH_MESSAGE = `Sections nest at most ${MAX_SECTION_DEPTH + 1} levels deep.`;

export const PLAIN_TITLE_HINT =
  'Formatting is not kept — the title is used in menus, breadcrumbs and the browser tab.';

/** Shown for a section with no title in the default locale, so no row is blank. */
export const UNTITLED_SECTION = '(untitled)';

/** Used only if a 409 arrives without a body to quote. */
export const SLUG_TAKEN_FALLBACK = 'Another section under this parent already uses this slug.';
