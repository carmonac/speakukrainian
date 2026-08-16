import type { SaveH5pContentInput } from '@speakukrainian/shared';
import type { H5pEditorModel } from './h5p.api';

/** The tag `H5P_DEFINE_ELEMENTS` registers, and the one this screen mounts. */
const H5P_EDITOR_TAG = 'h5p-editor';

/**
 * What a brand-new exercise is called, as a **literal content id**.
 *
 * `H5PEditorComponent.render` returns early on a falsy content id, so an absent
 * one boots nothing at all; `'new'` is the value it special-cases into
 * `loadContentCallback(undefined)`, an empty `ns.Editor` and
 * `saveContentCallback(undefined, …)`.
 */
export const H5P_NEW_CONTENT_ID = 'new';

/** The `history.state` key both screens use, so neither can spell it alone. */
export const EXERCISE_RESULT_STATE = 'exerciseResult';

/** What the widget route hands back to the page form. */
export interface ExerciseResult {
  contentId: string;
  /**
   * The save result's `mainLibrary`, an ubername (`H5P.MultiChoice 1.16`).
   * Empty when the `saved` event did not follow a save this screen performed,
   * which is the one case the page form treats as "no library to record".
   */
  mainLibrary: string;
}

/**
 * What `loadContentCallback` answers: the editor model, plus the three fields
 * the component reads **only** for existing content — its own documentation
 * says they "must only be defined if contentId is defined".
 */
export type H5pEditorContent = H5pEditorModel & {
  library?: string;
  metadata?: unknown;
  params?: unknown;
};

/**
 * The part of `H5PEditorComponent` this screen drives.
 *
 * Ours and not the package's, for the two reasons ADR-019 records: the
 * package's own `.d.ts` imports from `@lumieducation/h5p-server`, which does not
 * resolve from the admin and degrades silently to `any` under
 * `skipLibCheck`; and its `loadContentCallback` is declared to return an
 * `IEditorModel`, which requires the `urlGenerator` field ADR-007 says the API
 * must never send.
 */
export interface H5pEditorHost extends HTMLElement {
  loadContentCallback?: (contentId?: string) => Promise<H5pEditorContent>;
  saveContentCallback?: (
    contentId: string | undefined,
    body: SaveH5pContentInput,
  ) => Promise<{ contentId: string }>;
  /**
   * Optional because the element only has it once it has been **upgraded**, and
   * `H5P_DEFINE_ELEMENTS` exists precisely so that it need not be. A caller that
   * has to handle its absence cannot mistake an un-upgraded element for a save
   * that quietly did nothing.
   */
  save?: () => Promise<unknown>;
}

/** Everything one mounted widget needs, decided by the caller. */
export interface H5pEditorMount {
  /** A stored content id, or {@link H5P_NEW_CONTENT_ID}. */
  contentId: string;
  /** Already resolved, so no request happens in the middle of a mount. */
  content: H5pEditorContent;
  save: (
    contentId: string | undefined,
    body: SaveH5pContentInput,
  ) => Promise<{ contentId: string }>;
  /**
   * `editorloaded` — a content type's form has been built, which is the first
   * moment the widget can answer a save. See {@link mountH5pEditor} for what it
   * does **not** mean and for the one state it never reaches.
   */
  onReady: () => void;
  onSaved: (contentId: string) => void;
  /** `save-error` — the message is the caller's own constant. */
  onError: (message: string) => void;
  /** `validation-error` — the message is the widget's own English sentence. */
  onInvalid: (message: string) => void;
}

/**
 * Creates the `<h5p-editor>` element, wires it, and answers with its teardown.
 *
 * **The order of the writes below is the boot, and it is not obvious.**
 * `attributeChangedCallback` renders when `content-id` changes and the
 * `loadContentCallback` *setter* renders when the callback identity changes,
 * while `render()` returns early when either is missing. So the element is
 * connected first — `connectedCallback` is what creates the root the render
 * writes into — then given its id, then its save callback, and the load
 * callback **last**, which is the one render that does anything. Assigning the
 * load callback before the element is connected reaches `this.root.innerHTML`
 * with no root, inside an `async` method: an unhandled rejection and a blank
 * screen.
 *
 * The element is created here rather than written in a template for the same
 * reason: appending it ourselves is what guarantees it is connected before it
 * is wired, the removal is then a teardown this code owns, and the caller's
 * template needs no `CUSTOM_ELEMENTS_SCHEMA`.
 *
 * **`editorloaded` means "a content type's form exists", not "the widget is on
 * screen", and it has one state it never reaches.** It is triggered by
 * `h5peditor-library-selector.js` at the end of `loadSemantics`, so for a *new*
 * exercise it does not fire until the author has chosen a content type — before
 * that the hub is up and usable and there is genuinely nothing to save. And
 * because it is the **last** statement of that callback, any throw while the
 * form is being built skips it: the editor is then half-drawn and no event ever
 * arrives. That is not hypothetical — upstream's `ns.Html.createHtml` reads
 * `field.tags.includes('table')` unconditionally, so one `html` field with no
 * `tags` in a library's `semantics.json` is enough. ADR-019 records what that
 * looks like to an author and how to recognise it.
 *
 * The editor's **scripts** are not torn down and cannot be: `addScripts`
 * appends them to `document.head` deduped on `data-h5p-src`, removing the tags
 * would not un-define `window.H5P`, and re-adding them would re-execute them.
 * They load once per browser session. The stylesheets are never added at all —
 * the component omits them deliberately, and the editor's iframe loads its own.
 */
export function mountH5pEditor(container: HTMLElement, mount: H5pEditorMount): () => void {
  const element = document.createElement(H5P_EDITOR_TAG) as H5pEditorHost;

  /**
   * The id the last save resolved with. The component builds the `saved`
   * event's detail out of exactly that value, so this is the same id by a
   * shorter route — and it is what answers when the event carries no detail.
   */
  let lastSavedContentId: string | null = null;

  const onReady = (): void => mount.onReady();
  const onSaved = (event: Event): void => {
    const contentId = detailContentId(event) ?? lastSavedContentId;
    if (contentId !== null) {
      mount.onSaved(contentId);
    }
  };
  const onSaveError = (event: Event): void => mount.onError(detailMessage(event) ?? '');
  const onValidationError = (event: Event): void => mount.onInvalid(detailMessage(event) ?? '');

  // `replaceChildren`, so a re-run against the same container never leaves two.
  container.replaceChildren(element);

  element.addEventListener('editorloaded', onReady);
  element.addEventListener('saved', onSaved);
  element.addEventListener('save-error', onSaveError);
  element.addEventListener('validation-error', onValidationError);

  // `setAttribute` and not the `contentId` property: the property setter only
  // writes this attribute, and the attribute behaves the same whether or not
  // the element has been upgraded.
  element.setAttribute('content-id', mount.contentId);

  element.saveContentCallback = async (contentId, body) => {
    const result = await mount.save(contentId, body);
    lastSavedContentId = result.contentId;
    return result;
  };

  // Last: this assignment is the render.
  element.loadContentCallback = () => {
    // The argument can only ever be the id this mount was created for, and the
    // caller has already fetched under it.
    return Promise.resolve(mount.content);
  };

  return () => {
    element.removeEventListener('editorloaded', onReady);
    element.removeEventListener('saved', onSaved);
    element.removeEventListener('save-error', onSaveError);
    element.removeEventListener('validation-error', onValidationError);
    // Not decoration: clearing the load callback is what makes a render already
    // in flight return early instead of calling back into a destroyed screen.
    element.loadContentCallback = undefined;
    element.saveContentCallback = undefined;
    container.replaceChildren();
  };
}

/**
 * `CustomEvent.detail` is built by a foreign realm's code and typed by nothing
 * we own, so both readers below narrow it rather than trusting it.
 */
function eventDetail(event: Event): object | null {
  if (!(event instanceof CustomEvent)) {
    return null;
  }
  const detail: unknown = event.detail;
  return typeof detail === 'object' && detail !== null ? detail : null;
}

function detailMessage(event: Event): string | null {
  const detail = eventDetail(event);
  if (detail === null || !('message' in detail)) {
    return null;
  }
  const { message } = detail;
  return typeof message === 'string' && message !== '' ? message : null;
}

function detailContentId(event: Event): string | null {
  const detail = eventDetail(event);
  if (detail === null || !('contentId' in detail)) {
    return null;
  }
  const { contentId } = detail;
  return typeof contentId === 'string' && contentId !== '' ? contentId : null;
}
