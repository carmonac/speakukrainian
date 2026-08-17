import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { H5pContent, SaveH5pContentInput } from '@speakukrainian/shared';
import type { NotificationService } from '../../core/notifications/notification.service';
import {
  H5P_NEW_CONTENT_ID,
  mountH5pEditor,
  mountH5pPlayer,
  reattachExercise,
  reportAttachment,
  type H5pEditorContent,
  type H5pEditorHost,
  type H5pEditorMount,
  type H5pPlayerHost,
} from './h5p-exercise.model';
import type { H5pApi, H5pPlayerModel } from './h5p.api';
import { EXERCISE_ATTACH_FAILED, EXERCISE_PREVIOUS_DETACHED } from './page-messages';

/**
 * Neither `h5p-editor` nor `h5p-player` is defined in this file. An upgraded
 * element of either tag would construct a `ResizeObserver` jsdom does not have
 * and then wait forever on scripts jsdom never fetches — a spec that hangs
 * rather than fails. Left undefined they are plain `HTMLElement`s, which is the
 * whole surface `mountH5pEditor` and `mountH5pPlayer` drive.
 * `H5P_DEFINE_EDITOR_ELEMENT` and `H5P_DEFINE_PLAYER_ELEMENT` exist so this
 * stays true, one tag at a time.
 */
const CONTENT: H5pEditorContent = {
  integration: { editor: { ajaxPath: '/api/h5p/ajax?token=abc&action=' } },
  scripts: ['/api/h5p/core/js/h5p.js'],
  styles: ['/api/h5p/core/styles/h5p.css'],
};

const BODY: SaveH5pContentInput = {
  library: 'H5P.MultiChoice 1.16',
  params: { params: { question: 'Котра година?' }, metadata: { title: 'Time' } },
};

interface Recorded {
  saves: { contentId: string | undefined; body: SaveH5pContentInput }[];
  ready: number;
  saved: string[];
  errors: string[];
  invalid: string[];
}

function options(recorded: Recorded, overrides: Partial<H5pEditorMount> = {}): H5pEditorMount {
  return {
    contentId: H5P_NEW_CONTENT_ID,
    content: CONTENT,
    save: (contentId, body) => {
      recorded.saves.push({ contentId, body });
      return Promise.resolve({ contentId: 'c-new' });
    },
    onReady: () => {
      recorded.ready += 1;
    },
    onSaved: (contentId) => recorded.saved.push(contentId),
    onError: (message) => recorded.errors.push(message),
    onInvalid: (message) => recorded.invalid.push(message),
    ...overrides,
  };
}

function blank(): Recorded {
  return { saves: [], ready: 0, saved: [], errors: [], invalid: [] };
}

function editorIn(container: HTMLElement): H5pEditorHost {
  const element = container.querySelector<H5pEditorHost>('h5p-editor');
  if (element === null) {
    throw new Error('Expected an h5p-editor in the container');
  }
  return element;
}

/** What the element looked like at the moment each boot write landed on it. */
interface BootStep {
  write: 'content-id' | 'saveContentCallback' | 'loadContentCallback';
  connected: boolean;
  contentId: string | null;
  hasSaveCallback: boolean;
}

/**
 * Records the boot sequence by instrumenting the element `mountH5pEditor`
 * creates, before it is handed back.
 *
 * This is the one invariant in this file that no other assertion can reach: the
 * real component renders from `attributeChangedCallback` and from the
 * `loadContentCallback` **setter**, so an out-of-order mount fails only inside a
 * browser — `render()` reaching `this.root.innerHTML` with no root, inside an
 * `async` method, which is an unhandled rejection and a blank screen. Nothing in
 * jsdom upgrades the element, so nothing here would otherwise notice.
 *
 * `defineProperty` on the *instance* rather than a defined custom element: an
 * accessor is exactly what the component declares for `loadContentCallback`, and
 * it costs none of the `ResizeObserver` and script loading an upgrade would.
 */
function recordBootOrder(steps: BootStep[]): void {
  const createElement = document.createElement.bind(document);

  vi.spyOn(document, 'createElement').mockImplementation((tag: string, ...rest: unknown[]) => {
    const element = createElement(tag, ...(rest as []));
    if (tag !== 'h5p-editor') {
      return element;
    }

    const step = (write: BootStep['write']): void => {
      steps.push({
        write,
        connected: element.isConnected,
        contentId: element.getAttribute('content-id'),
        hasSaveCallback: 'saveContentCallback' in element,
      });
    };

    const setAttribute = element.setAttribute.bind(element);
    element.setAttribute = (name: string, value: string): void => {
      setAttribute(name, value);
      if (name === 'content-id') {
        step('content-id');
      }
    };

    for (const name of ['saveContentCallback', 'loadContentCallback'] as const) {
      let held: unknown;
      Object.defineProperty(element, name, {
        configurable: true,
        get: () => held,
        set: (value: unknown) => {
          held = value;
          // Only the assignment, not the teardown's clearing.
          if (value !== undefined) {
            step(name);
          }
        },
      });
    }

    return element;
  });
}

describe('mountH5pEditor', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    container.remove();
  });

  it('connects the element before it wires it, and assigns the load callback last', () => {
    const steps: BootStep[] = [];
    recordBootOrder(steps);

    mountH5pEditor(container, options(blank(), { contentId: 'c1' }));

    expect(steps.map((entry) => entry.write)).toEqual([
      'content-id',
      'saveContentCallback',
      'loadContentCallback',
    ]);
    // Every write lands on an element that is already in the document: the
    // component builds its root in `connectedCallback`, and a render before that
    // throws where nothing catches it.
    expect(steps.every((entry) => entry.connected)).toBe(true);
    // And the render the load callback triggers finds the id and the save
    // callback already there, which is what it needs to do anything.
    const load = steps.at(-1);
    expect(load?.contentId).toBe('c1');
    expect(load?.hasSaveCallback).toBe(true);
  });

  it('leaves exactly one h5p-editor carrying "new" for an exercise that does not exist yet', () => {
    mountH5pEditor(container, options(blank()));

    expect(container.querySelectorAll('h5p-editor')).toHaveLength(1);
    // The literal string, not an absent attribute: `render()` returns early on
    // a falsy content id and boots nothing at all.
    expect(editorIn(container).getAttribute('content-id')).toBe('new');
  });

  it('carries the stored id for an exercise that already exists', () => {
    mountH5pEditor(container, options(blank(), { contentId: 'c1' }));

    expect(editorIn(container).getAttribute('content-id')).toBe('c1');
  });

  it('resolves the content it was mounted with, whatever it is asked for', async () => {
    mountH5pEditor(container, options(blank(), { contentId: 'c1' }));

    const load = editorIn(container).loadContentCallback;
    if (load === undefined) {
      throw new Error('Expected a load callback');
    }

    await expect(load('c1')).resolves.toBe(CONTENT);
    // The component calls it with `undefined` for new content; the mount fetched
    // under the id the route resolved either way.
    await expect(load(undefined)).resolves.toBe(CONTENT);
  });

  it('delegates a save to the mount and answers with the new content id', async () => {
    const recorded = blank();
    mountH5pEditor(container, options(recorded));

    const save = editorIn(container).saveContentCallback;
    if (save === undefined) {
      throw new Error('Expected a save callback');
    }

    await expect(save(undefined, BODY)).resolves.toEqual({ contentId: 'c-new' });
    expect(recorded.saves).toEqual([{ contentId: undefined, body: BODY }]);
  });

  it('propagates a save failure to the caller of saveContentCallback', async () => {
    // The component turns this rejection into its own `save-error` event, so
    // swallowing it here would lose the only report the screen gets.
    const recorded = blank();
    mountH5pEditor(container, options(recorded, { save: () => Promise.reject(new Error('nope')) }));

    const save = editorIn(container).saveContentCallback;
    await expect(save?.(undefined, BODY)).rejects.toThrow('nope');
  });

  it('routes the widget events to their options, with each event’s own message', () => {
    const recorded = blank();
    mountH5pEditor(container, options(recorded));
    const element = editorIn(container);

    element.dispatchEvent(
      new CustomEvent('editorloaded', {
        detail: { contentId: 'new', ubername: 'H5P.MultiChoice 1.16' },
      }),
    );
    element.dispatchEvent(new CustomEvent('saved', { detail: { contentId: 'c-9' } }));
    element.dispatchEvent(new CustomEvent('save-error', { detail: { message: 'API down' } }));
    element.dispatchEvent(
      new CustomEvent('validation-error', { detail: { message: 'Set a title.' } }),
    );

    expect(recorded.ready).toBe(1);
    expect(recorded.saved).toEqual(['c-9']);
    expect(recorded.errors).toEqual(['API down']);
    expect(recorded.invalid).toEqual(['Set a title.']);
  });

  it('tolerates an event with no detail, answering a saved from the id the save returned', async () => {
    const recorded = blank();
    mountH5pEditor(container, options(recorded));
    const element = editorIn(container);

    await element.saveContentCallback?.(undefined, BODY);
    element.dispatchEvent(new CustomEvent('saved'));
    element.dispatchEvent(new CustomEvent('save-error'));

    expect(recorded.saved).toEqual(['c-new']);
    // Empty, so the caller supplies its own sentence rather than showing one
    // this file invented.
    expect(recorded.errors).toEqual(['']);
  });

  it('says nothing about a saved event that carries no id and follows no save', () => {
    const recorded = blank();
    mountH5pEditor(container, options(recorded));

    editorIn(container).dispatchEvent(new CustomEvent('saved'));

    expect(recorded.saved).toEqual([]);
  });

  it('tears down to an empty container, an unwired element and a deaf one', () => {
    const recorded = blank();
    const teardown = mountH5pEditor(container, options(recorded));
    const element = editorIn(container);

    teardown();

    expect(container.children).toHaveLength(0);
    expect(element.isConnected).toBe(false);
    // Cleared, so a render already in flight returns early instead of calling
    // back into a destroyed screen.
    expect(element.loadContentCallback).toBeUndefined();
    expect(element.saveContentCallback).toBeUndefined();

    element.dispatchEvent(new CustomEvent('saved', { detail: { contentId: 'c-9' } }));
    element.dispatchEvent(new CustomEvent('save-error', { detail: { message: 'API down' } }));
    element.dispatchEvent(new CustomEvent('editorloaded', { detail: {} }));
    expect(recorded.saved).toEqual([]);
    expect(recorded.errors).toEqual([]);
    expect(recorded.ready).toBe(0);
  });

  it('leaves one element when the same container is mounted into twice', () => {
    const recorded = blank();
    mountH5pEditor(container, options(recorded, { contentId: 'c1' }));
    mountH5pEditor(container, options(recorded, { contentId: 'c2' }));

    expect(container.querySelectorAll('h5p-editor')).toHaveLength(1);
    expect(editorIn(container).getAttribute('content-id')).toBe('c2');
  });
});

const PLAYER_MODEL: H5pPlayerModel = {
  contentId: 'c1',
  integration: { contents: {} },
  scripts: ['/api/h5p/core/js/h5p.js'],
  styles: ['/api/h5p/core/styles/h5p.css'],
  embedTypes: ['iframe'],
};

/** What the player element looked like at the moment each boot write landed. */
interface PlayerBootStep {
  write: 'content-id' | 'loadContentCallback';
  connected: boolean;
  contentId: string | null;
}

/**
 * The player-shaped sibling of {@link recordBootOrder}, and for the same reason:
 * the real component renders from `attributeChangedCallback` and from the
 * `loadContentCallback` setter, which calls `render` without awaiting it, so an
 * out-of-order mount fails only inside a browser — `render`'s `catch` reaching
 * `this.root.innerHTML` with no root, which is an unhandled rejection and a
 * blank panel. Nothing in jsdom upgrades the element, so nothing here would
 * otherwise notice.
 */
function recordPlayerBootOrder(steps: PlayerBootStep[]): void {
  const createElement = document.createElement.bind(document);

  vi.spyOn(document, 'createElement').mockImplementation((tag: string, ...rest: unknown[]) => {
    const element = createElement(tag, ...(rest as []));
    if (tag !== 'h5p-player') {
      return element;
    }

    const step = (write: PlayerBootStep['write']): void => {
      steps.push({
        write,
        connected: element.isConnected,
        contentId: element.getAttribute('content-id'),
      });
    };

    const setAttribute = element.setAttribute.bind(element);
    element.setAttribute = (name: string, value: string): void => {
      setAttribute(name, value);
      if (name === 'content-id') {
        step('content-id');
      }
    };

    let held: unknown;
    Object.defineProperty(element, 'loadContentCallback', {
      configurable: true,
      get: () => held,
      set: (value: unknown) => {
        held = value;
        // Only the assignment, not the teardown's clearing.
        if (value !== undefined) {
          step('loadContentCallback');
        }
      },
    });

    return element;
  });
}

describe('mountH5pPlayer', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    container.remove();
  });

  function playerIn(host: HTMLElement): H5pPlayerHost {
    const element = host.querySelector<H5pPlayerHost>('h5p-player');
    if (element === null) {
      throw new Error('Expected an h5p-player in the container');
    }
    return element;
  }

  it('connects the element, gives it its id, and assigns the load callback last', () => {
    const steps: PlayerBootStep[] = [];
    recordPlayerBootOrder(steps);

    mountH5pPlayer(container, { contentId: 'c1', model: PLAYER_MODEL });

    expect(steps.map((entry) => entry.write)).toEqual(['content-id', 'loadContentCallback']);
    // Every write lands on an element that is already in the document: the
    // component builds its root in `connectedCallback`, and a render before that
    // throws where nothing catches it.
    expect(steps.every((entry) => entry.connected)).toBe(true);
    // And the render the assignment triggers finds the id already there, which
    // is the only thing it is given to fetch under.
    expect(steps.at(-1)?.contentId).toBe('c1');
  });

  it('leaves exactly one h5p-player carrying the exercise’s id', () => {
    mountH5pPlayer(container, { contentId: 'c1', model: PLAYER_MODEL });

    expect(container.querySelectorAll('h5p-player')).toHaveLength(1);
    expect(playerIn(container).getAttribute('content-id')).toBe('c1');
  });

  it('resolves the model it was mounted with, whatever it is asked for', async () => {
    mountH5pPlayer(container, { contentId: 'c1', model: PLAYER_MODEL });

    const load = playerIn(container).loadContentCallback;
    if (load === undefined) {
      throw new Error('Expected a load callback');
    }

    await expect(load('c1')).resolves.toBe(PLAYER_MODEL);
    // The component calls it with four arguments and this mount answers with
    // the model the caller already fetched, so nothing it passes can change it.
    await expect(load(undefined)).resolves.toBe(PLAYER_MODEL);
  });

  it('tears down to an empty container and an unwired element', () => {
    const teardown = mountH5pPlayer(container, { contentId: 'c1', model: PLAYER_MODEL });
    const element = playerIn(container);

    teardown();

    expect(container.children).toHaveLength(0);
    expect(element.isConnected).toBe(false);
    // Cleared, so a render already in flight returns early instead of calling
    // back into a destroyed panel.
    expect(element.loadContentCallback).toBeUndefined();
  });

  it('leaves one element when the same container is mounted into twice', () => {
    mountH5pPlayer(container, { contentId: 'c1', model: PLAYER_MODEL });
    mountH5pPlayer(container, { contentId: 'c2', model: { ...PLAYER_MODEL, contentId: 'c2' } });

    expect(container.querySelectorAll('h5p-player')).toHaveLength(1);
    expect(playerIn(container).getAttribute('content-id')).toBe('c2');
  });
});

const ROW: H5pContent = {
  id: 'c1',
  title: 'Telling the time',
  mainLibrary: 'H5P.MultiChoice 1.16',
  pageId: 'p1',
  storagePath: 'h5p/content/c1',
  sizeBytes: 4096,
  audit: {
    createdAt: '2026-01-01T00:00:00Z',
    createdBy: 'admin',
    updatedAt: '2026-01-01T00:00:00Z',
    updatedBy: 'admin',
  },
};

interface Reattached {
  /** Every call in the order it was made, which is the invariant under test. */
  sequence: string[];
}

interface ApiOptions {
  attachFails?: boolean;
  detachFails?: boolean;
}

function stubApi(recorded: Reattached, apiOptions: ApiOptions = {}): H5pApi {
  return {
    attach: (contentId: string, pageId: string) => {
      recorded.sequence.push(`attach(${contentId}, ${pageId})`);
      return apiOptions.attachFails === true
        ? throwError(() => new Error('offline'))
        : of({ ...ROW, id: contentId, pageId });
    },
    detach: (contentId: string) => {
      recorded.sequence.push(`detach(${contentId})`);
      return apiOptions.detachFails === true
        ? throwError(() => new Error('offline'))
        : of({ ...ROW, id: contentId, pageId: null });
    },
  } as unknown as H5pApi;
}

describe('reattachExercise', () => {
  it('attaches the new exercise before it detaches the old one', async () => {
    // Detaching first opens a window in which no row names the page, and leaves
    // nothing to fall back to if the attach then fails. The order is the point,
    // so the sequence is asserted rather than the two calls' presence.
    const recorded: Reattached = { sequence: [] };

    const result = await reattachExercise(stubApi(recorded), {
      pageId: 'p1',
      previousContentId: 'c-old',
      nextContentId: 'c-new',
    });

    expect(recorded.sequence).toEqual(['attach(c-new, p1)', 'detach(c-old)']);
    expect(result).toEqual({ attached: true, detachedPrevious: true });
  });

  it('attaches only, on a page that had no exercise', async () => {
    const recorded: Reattached = { sequence: [] };

    const result = await reattachExercise(stubApi(recorded), {
      pageId: 'p1',
      previousContentId: null,
      nextContentId: 'c-new',
    });

    expect(recorded.sequence).toEqual(['attach(c-new, p1)']);
    expect(result).toEqual({ attached: true, detachedPrevious: false });
  });

  it('asks for nothing at all when the page already owns this exercise', async () => {
    // A re-save of the same exercise through the widget. The attach would be a
    // 200 no-op, but a detach of the id we just attached would undo it.
    const recorded: Reattached = { sequence: [] };

    const result = await reattachExercise(stubApi(recorded), {
      pageId: 'p1',
      previousContentId: 'c1',
      nextContentId: 'c1',
    });

    expect(recorded.sequence).toEqual([]);
    // `attached: true` with nothing sent: the index already names this page, so
    // there is nothing to warn about.
    expect(result).toEqual({ attached: true, detachedPrevious: false });
  });

  it('still detaches the old exercise when the attach failed', async () => {
    // The body write goes ahead either way, so leaving the old row pointing at
    // this page would leave the index naming an exercise the page no longer
    // shows — the worse of the two stale states.
    const recorded: Reattached = { sequence: [] };

    const result = await reattachExercise(stubApi(recorded, { attachFails: true }), {
      pageId: 'p1',
      previousContentId: 'c-old',
      nextContentId: 'c-new',
    });

    expect(recorded.sequence).toEqual(['attach(c-new, p1)', 'detach(c-old)']);
    // And it says the attach failed, which is the only way the caller can tell
    // the author that the upload nonetheless survived.
    expect(result).toEqual({ attached: false, detachedPrevious: true });
  });

  it('resolves rather than rejecting when the detach fails', async () => {
    // The caller writes the body next; a rejection here would abort a write of
    // content that is already on the server.
    const recorded: Reattached = { sequence: [] };

    await expect(
      reattachExercise(stubApi(recorded, { detachFails: true }), {
        pageId: 'p1',
        previousContentId: 'c-old',
        nextContentId: 'c-new',
      }),
    ).resolves.toEqual({ attached: true, detachedPrevious: true });
  });
});

describe('reportAttachment', () => {
  function collect(): { notifications: NotificationService; said: string[] } {
    const said: string[] = [];
    return {
      said,
      notifications: {
        success: (message: string) => said.push(`success: ${message}`),
        info: (message: string) => said.push(`info: ${message}`),
        error: (message: string) => said.push(`error: ${message}`),
      } as unknown as NotificationService,
    };
  }

  it('says nothing when the index caught up and nothing was displaced', () => {
    const { notifications, said } = collect();

    reportAttachment(notifications, { attached: true, detachedPrevious: false });

    expect(said).toEqual([]);
  });

  it('reassures the author that a displaced exercise was not deleted', () => {
    const { notifications, said } = collect();

    reportAttachment(notifications, { attached: true, detachedPrevious: true });

    expect(said).toEqual([`info: ${EXERCISE_PREVIOUS_DETACHED}`]);
  });

  it('says what survived a failed attach, rather than leaving the error toast to speak', () => {
    // The interceptor's own toast — "Failed to fetch", or a 5xx sentence —
    // lands straight after an upload that visibly worked, and reads as though
    // the upload was what failed. There is one snackbar and the last message
    // wins, so this one has to be the last.
    const { notifications, said } = collect();

    reportAttachment(notifications, { attached: false, detachedPrevious: false });

    expect(said).toEqual([`error: ${EXERCISE_ATTACH_FAILED}`]);
  });

  it('prefers the failure to the reassurance when a replace half-failed', () => {
    // Both are true; two `open` calls in a row means the first is a flash
    // nobody reads, and the surprising one is the one worth the slot.
    const { notifications, said } = collect();

    reportAttachment(notifications, { attached: false, detachedPrevious: true });

    expect(said).toEqual([`error: ${EXERCISE_ATTACH_FAILED}`]);
  });
});
