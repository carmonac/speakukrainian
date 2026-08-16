import {
  H5P_PACKAGE_EXTENSION,
  formatMaxH5pUploadSize,
  type PageType,
} from '@speakukrainian/shared';

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

// The H5P authoring widget's wording. `/pages/:id/exercise` is a screen of its
// own, and the page form is where an author reaches it.

/**
 * `/pages/:id/exercise` was opened on a page whose body is not an exercise —
 * a hand-typed URL, or a link followed after the body type changed. Nothing
 * failed, so nothing else would say anything.
 */
export const PAGE_IS_NOT_AN_EXERCISE = 'That page is not an H5P exercise.';

/**
 * The widget route reads the stored page, so unsaved edits on the form would be
 * invisible to it and lost on the way back. Refused rather than carried across,
 * the shape {@link PUBLISH_NEEDS_SAVE} already sets.
 */
export const EXERCISE_NEEDS_SAVE = 'Save your changes before editing the exercise.';

/** `/pages/new` has no page id yet, and the widget route is keyed on one. */
export const EXERCISE_NEEDS_PAGE = 'Save the page before adding an exercise.';

/**
 * Shown on the widget screen itself, which the author stays on with their work
 * in front of them. The API's own sentence arrives separately as the
 * interceptor's toast; this one says what happened to the exercise.
 */
export const EXERCISE_SAVE_FAILED = 'The exercise was not saved. Your work is still here.';

/**
 * Shown on an existing exercise until the widget has built its form. There is
 * nothing to time out against and no timer is added; what a stuck one means is
 * in ADR-019.
 */
export const EXERCISE_LOADING = 'Loading the exercise editor…';

/**
 * The same slot on a **new** exercise, where the widget is not loading at all —
 * its content type list is up and choosing one is the author's next act, and
 * also what makes Save do anything.
 */
export const EXERCISE_PICK_TYPE = 'Choose a content type above to start building the exercise.';

/** An H5P page that has no exercise attached yet. */
export const NO_EXERCISE_YET = 'No exercise on this page yet.';

/**
 * Raised after a replace, and worded to close the question it provokes: the
 * previous exercise is still installed and still in the H5P content list, and
 * nothing in Phase 1 deletes it. `DELETE /api/h5p/content/:id` exists but is
 * wired to no screen, so "detached" is the whole of what happened.
 */
export const EXERCISE_PREVIOUS_DETACHED =
  'The previous exercise was detached from this page. It was not deleted — it is still in the H5P content list.';

/**
 * The attach failed after the exercise was already stored.
 *
 * It has to say **both** halves, because only one of them is visible: the
 * upload plainly worked, and the interceptor's own toast for the failed call
 * ("Failed to fetch", or a 5xx sentence) arrives straight after it and reads as
 * though the upload was what failed. There is one `MatSnackBar` and the last
 * message wins, so this one replaces that — which is the right way round, since
 * this is the only sentence that says what survived.
 *
 * It deliberately does not also say the previous exercise was detached. Two
 * toasts in a row means the first is a flash nobody reads, and of the two this
 * is the surprising one; what the author most needs to know is that the page is
 * fine.
 */
export const EXERCISE_ATTACH_FAILED =
  'The exercise was uploaded and this page now uses it. Recording which page it belongs to failed, so the H5P content list will show it as unattached.';

/**
 * The rule the browser pre-checks, stated before the file picker opens rather
 * than after a refused upload. Both halves come from `packages/shared`, which is
 * where the API reads them from too.
 */
export const EXERCISE_UPLOAD_HINT = `A ${H5P_PACKAGE_EXTENSION} package, under ${formatMaxH5pUploadSize()}.`;

/**
 * The attached exercise's index row could not be read, so its title is unknown
 * — but the id on the body is still good and the page still shows the exercise.
 * The interceptor has already toasted the API's own sentence.
 */
export const EXERCISE_SUMMARY_FAILED = 'Could not read the attached exercise’s details.';

/**
 * The narrower case: `GET /h5p/content/:id` answered 404, so the body names an
 * exercise that is gone. Worth its own sentence, because the remedy is to
 * upload or build another one rather than to retry.
 */
export const EXERCISE_CONTENT_MISSING =
  'The exercise this page names no longer exists. Upload or build another one.';

/**
 * Literally true, and it has to stay checkable: `h5p.config.ts` sets
 * `setFinishedEnabled: false` and wires no `IContentUserDataStorage`, so
 * nothing records an attempt. The flag is stored for the learner-accounts work
 * that will read it.
 */
export const TRACK_RESULTS_HINT =
  'Nothing is recorded yet — learner accounts do not exist. The setting is stored for when they do.';

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
