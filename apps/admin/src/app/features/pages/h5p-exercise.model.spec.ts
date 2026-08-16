import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SaveH5pContentInput } from '@speakukrainian/shared';
import {
  H5P_NEW_CONTENT_ID,
  mountH5pEditor,
  type H5pEditorContent,
  type H5pEditorHost,
  type H5pEditorMount,
} from './h5p-exercise.model';

/**
 * `h5p-editor` is deliberately **not** defined in this file. An upgraded element
 * would construct a `ResizeObserver` jsdom does not have and then wait forever
 * on scripts jsdom never fetches — a spec that hangs rather than fails. Left
 * undefined it is a plain `HTMLElement`, which is the whole surface
 * `mountH5pEditor` drives. `H5P_DEFINE_ELEMENTS` exists so this stays true.
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
    onSaved: (contentId) => recorded.saved.push(contentId),
    onError: (message) => recorded.errors.push(message),
    onInvalid: (message) => recorded.invalid.push(message),
    ...overrides,
  };
}

function blank(): Recorded {
  return { saves: [], saved: [], errors: [], invalid: [] };
}

function editorIn(container: HTMLElement): H5pEditorHost {
  const element = container.querySelector<H5pEditorHost>('h5p-editor');
  if (element === null) {
    throw new Error('Expected an h5p-editor in the container');
  }
  return element;
}

describe('mountH5pEditor', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
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

    element.dispatchEvent(new CustomEvent('saved', { detail: { contentId: 'c-9' } }));
    element.dispatchEvent(new CustomEvent('save-error', { detail: { message: 'API down' } }));
    element.dispatchEvent(
      new CustomEvent('validation-error', { detail: { message: 'Set a title.' } }),
    );

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
    expect(recorded.saved).toEqual([]);
    expect(recorded.errors).toEqual([]);
  });

  it('leaves one element when the same container is mounted into twice', () => {
    const recorded = blank();
    mountH5pEditor(container, options(recorded, { contentId: 'c1' }));
    mountH5pEditor(container, options(recorded, { contentId: 'c2' }));

    expect(container.querySelectorAll('h5p-editor')).toHaveLength(1);
    expect(editorIn(container).getAttribute('content-id')).toBe('c2');
  });
});
