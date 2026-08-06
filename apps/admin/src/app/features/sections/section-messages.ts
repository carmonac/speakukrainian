import { MAX_SECTION_DEPTH } from '@speakukrainian/shared';

// The wording both section screens share, so the tree and the form explain a
// restriction in the same words and a test asserts one constant rather than a
// string copied into a template.

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

/** Shown for a section with no title in any locale at all, so no row is blank. */
export const UNTITLED_SECTION = '(untitled)';

/** Used only if a 409 arrives without a body to quote. */
export const SLUG_TAKEN_FALLBACK = 'Another section under this parent already uses this slug.';

export const MENU_LABEL_HINT =
  'Leave the label empty and the menu uses the title. Formatting is not kept.';

/** Used only if a 400 or 422 about the link target arrives without a message to quote. */
export const LINK_REJECTED_FALLBACK = 'The API refused this link target.';

/** The parent picker's entry for "no parent at all", which `parentId: null` is. */
export const TOP_LEVEL_OPTION = 'Top level';

/** The position picker's entry for "before every other child". */
export const MOVE_FIRST_POSITION = 'First';

/**
 * The move route resolved a tree that has no such section. No request failed,
 * so nothing else would say anything.
 */
export const SECTION_GONE = 'That section no longer exists.';

export const NEST_HINT = 'Drop here to nest inside';

/** Both gestures, said once above the tree, because neither is discoverable. */
export const TREE_DRAG_HINT =
  'Drag a section by its handle to reorder it among its siblings, or drop it on another section’s nest area to move it inside. “Move to…” does the same from the keyboard.';
