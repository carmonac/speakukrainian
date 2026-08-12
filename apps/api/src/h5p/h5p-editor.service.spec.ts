import { Readable } from 'node:stream';
import { HttpException } from '@nestjs/common';
import {
  H5PAjaxEndpoint,
  H5PConfig,
  H5PEditor,
  fsImplementations,
} from '@lumieducation/h5p-server';
import type { IEditorModel, ILibraryMetadata, IUser } from '@lumieducation/h5p-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import {
  h5pContentSchema,
  type CreateH5pContentInput,
  type H5pContent,
  type SaveH5pContentInput,
  type UpdateH5pContentInput,
} from '@speakukrainian/shared';
import type { H5pContentRepository } from './h5p-content.repository.js';
import { H5pContentStorage } from './h5p-content.storage.js';
import { H5pEditorService, TEMP_SWEEP_INTERVAL_MS } from './h5p-editor.service.js';
import { H5pLibraryStorage } from './h5p-library.storage.js';
import { H5pTemporaryStorage } from './h5p-temporary.storage.js';
import { createH5pConfig } from './h5p.config.js';
import { InMemoryStorage } from './h5p.storage-fake.js';

const EDITOR: IUser = {
  id: 'editor000000000000000000001',
  name: 'An editor',
  email: 'editor@example.local',
  type: 'local',
};

const NOW = new Date('2026-05-01T12:00:00.000Z');
const LIFETIME_MS = new H5PConfig(undefined).temporaryFileLifetime;
/** Written long enough before `NOW` that `createdAt + temporaryFileLifetime` is in the past. */
const EXPIRED_AT = new Date(NOW.getTime() - LIFETIME_MS - 60_000);

interface Harness {
  service: H5pEditorService;
  objects: InMemoryStorage;
  editor: H5PEditor;
  rows: FakeIndex;
  postAjax: MockInstance<H5PAjaxEndpoint['postAjax']>;
  getAjax: MockInstance<H5PAjaxEndpoint['getAjax']>;
}

/**
 * The `h5pContent` index as a map, with the three behaviours the save depends
 * on: `create` refuses a duplicate id, `update` merges over the stored row and
 * answers `null` for one that is not there. Either write can be made to fail,
 * which is the only way to reach the two rollback branches — they need an
 * injected failure and are unit-only by construction.
 */
class FakeIndex {
  readonly rows = new Map<string, H5pContent>();
  createFailure: Error | null = null;
  updateFailure: Error | null = null;

  asRepository(): H5pContentRepository {
    return this as unknown as H5pContentRepository;
  }

  exists(id: string): Promise<boolean> {
    return Promise.resolve(this.rows.has(id));
  }

  create(input: CreateH5pContentInput, actorId: string): Promise<H5pContent> {
    if (this.createFailure) {
      return Promise.reject(this.createFailure);
    }
    if (this.rows.has(input.id)) {
      return Promise.reject(Object.assign(new Error('already exists'), { code: 6 }));
    }

    const now = new Date().toISOString();
    const row = h5pContentSchema.parse({
      ...input,
      audit: { createdAt: now, createdBy: actorId, updatedAt: now, updatedBy: actorId },
    });
    this.rows.set(row.id, row);
    return Promise.resolve(row);
  }

  update(id: string, input: UpdateH5pContentInput, actorId: string): Promise<H5pContent | null> {
    if (this.updateFailure) {
      return Promise.reject(this.updateFailure);
    }

    const existing = this.rows.get(id);
    if (!existing) {
      return Promise.resolve(null);
    }

    const row = h5pContentSchema.parse({
      ...existing,
      ...input,
      audit: { ...existing.audit, updatedAt: new Date().toISOString(), updatedBy: actorId },
    });
    this.rows.set(id, row);
    return Promise.resolve(row);
  }
}

/**
 * The real `H5PAjaxEndpoint` over the real adapters, with only the bucket faked.
 *
 * A stubbed endpoint could not answer the two questions this file exists to
 * ask — whether `body ?? {}` really keeps `'libraries' in body` from throwing a
 * `TypeError`, and whether the sweep really deletes an expired object and
 * spares a live one — because both are properties of the library's own code
 * running against this adapter. `h5p.module.ts` builds the same graph.
 */
async function createHarness(): Promise<Harness> {
  const objects = new InMemoryStorage();
  const storage = objects.asStorageService();
  const config = createH5pConfig('/api/h5p');

  const keyValueStorage = new fsImplementations.InMemoryStorage();
  // Seeded exactly as `h5p.module.ts` seeds it. Without this,
  // `content-type-cache` reaches out to `api.h5p.org` — which in a unit test
  // means a DNS timeout, and on a machine with network means a suite that is
  // not hermetic. The e2e is what pins the module's own seeding.
  await keyValueStorage.save('contentTypeCache', []);
  await keyValueStorage.save('contentTypeCacheUpdate', Date.now());

  // `setRenderer` exactly as `h5p.module.ts` sets it: the stock renderer
  // answers `render` with an HTML page, so without it the model cases below
  // would be asserting over a string. Mirroring the module here means the
  // module's own call is *not* what these cases pin — `h5p-editor.e2e-spec.ts`
  // is, over the real provider graph, the same way the player's renderer is.
  const editor = new H5PEditor(
    keyValueStorage,
    config,
    new H5pLibraryStorage(storage),
    new H5pContentStorage(storage),
    new H5pTemporaryStorage(storage, config),
  ).setRenderer((model: IEditorModel) => model);
  const endpoint = new H5PAjaxEndpoint(editor);
  const rows = new FakeIndex();

  return {
    service: new H5pEditorService(
      endpoint,
      editor,
      rows.asRepository(),
      new H5pContentStorage(storage),
      storage,
    ),
    objects,
    editor,
    rows,
    postAjax: vi.spyOn(endpoint, 'postAjax'),
    getAjax: vi.spyOn(endpoint, 'getAjax'),
  };
}

/** Lets a fire-and-forget `void this.maybeSweep()` run before a negative assertion. */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

/** The status of the `HttpException` a call rejected with. */
async function statusOf(call: Promise<unknown>): Promise<number> {
  try {
    await call;
  } catch (error) {
    if (error instanceof HttpException) {
      return error.getStatus();
    }
    throw error;
  }
  throw new Error('Expected the call to reject with an HttpException.');
}

/** The message of the `HttpException` a call rejected with. */
async function messageOf(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    if (error instanceof HttpException) {
      const body = error.getResponse();
      return typeof body === 'string' ? body : String((body as { message?: unknown }).message);
    }
    throw error;
  }
  throw new Error('Expected the call to reject with an HttpException.');
}

describe('H5pEditorService', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('the GET ajax allowlist', () => {
    it('answers content-type-cache without reaching for the H5P Hub', async () => {
      const answer = (await harness.service.getAjax({ action: 'content-type-cache' }, EDITOR)) as {
        libraries: unknown[];
        outdated: boolean;
        user: string;
      };

      // `outdated` is `isOutdated()`, which reads `contentTypeCacheUpdate`. A
      // `true` here would mean the seeded timestamp is not being read, which is
      // the same condition under which `get()` falls through to the hub.
      expect(answer.outdated).toBe(false);
      expect(answer.libraries).toEqual([]);
      expect(answer.user).toBe('local');
    });

    it.each([
      ['files', 'a POST-only action'],
      ['library-install', 'a hub action'],
      ['content-hub-metadata-cache', 'a content-hub action'],
      ['', 'no action at all'],
      ['nonsense', 'an action nobody implements'],
    ])('refuses %s (%s) with a 400 and never calls the endpoint', async (action) => {
      expect(await statusOf(harness.service.getAjax({ action }, EDITOR))).toBe(400);
      expect(harness.getAjax).not.toHaveBeenCalled();
    });

    it('refuses a missing action, which reaches the route as undefined', async () => {
      expect(await statusOf(harness.service.getAjax({}, EDITOR))).toBe(400);
      expect(harness.getAjax).not.toHaveBeenCalled();
    });

    it('says what happened rather than naming an internal id', async () => {
      expect(await messageOf(harness.service.getAjax({ action: 'get-content' }, EDITOR))).toBe(
        'That editor action is not available on this server.',
      );
    });
  });

  describe('the POST ajax allowlist', () => {
    it.each([
      ['library-install'],
      ['get-content'],
      ['content-hub-metadata-cache'],
      ['nonsense'],
      [''],
    ])('refuses %j with a 400 and never calls the endpoint', async (action) => {
      // `library-install` and `get-content` would each start an HTTP request to
      // `api.h5p.org`, and an unknown action reaches the endpoint's own default
      // branch, which raises `malformed-request` with a **500**.
      expect(await statusOf(harness.service.postAjax({ action }, EDITOR))).toBe(400);
      expect(harness.postAjax).not.toHaveBeenCalled();
    });

    it('refuses library-upload with no h5p part, rather than letting it be a 500', async () => {
      // `postAjax` reads `libraryUploadFile.name` before anything else.
      const status = await statusOf(harness.service.postAjax({ action: 'library-upload' }, EDITOR));

      expect(status).toBe(400);
      expect(harness.postAjax).not.toHaveBeenCalled();
    });

    it('refuses files with no file part, rather than letting it be a 500', async () => {
      // `postAjax` validates and parses `field` first, so a well-formed body
      // gets all the way to `H5PEditor.saveContentFile`, which reads
      // `file.mimetype` unconditionally — a `TypeError` and a 500 for a
      // request that simply left a part out.
      const status = await statusOf(
        harness.service.postAjax(
          { action: 'files', body: { field: '{"type":"audio","name":"file"}' } },
          EDITOR,
        ),
      );

      expect(status).toBe(400);
      expect(harness.postAjax).not.toHaveBeenCalled();
    });

    it.each([['image'], ['video'], ['audio'], ['file']])(
      'refuses files with no file part whatever the field type says (%s)',
      async (type) => {
        // The three media types are refused by the library's own mimetype check
        // — after it has already dereferenced the file. `file` reaches further
        // in still, so no field type may be relied on to fail safely.
        const status = await statusOf(
          harness.service.postAjax(
            { action: 'files', body: { field: JSON.stringify({ type, name: 'file' }) } },
            EDITOR,
          ),
        );

        expect(status).toBe(400);
      },
    );

    it('passes an empty object for a request that carried no body at all', async () => {
      // `postAjax` does `'libraries' in body` on three of its five branches, so
      // `undefined` is `TypeError: Cannot use 'in' operator` and a 500. A 400
      // here is the library's own refusal of a body with no `libraries`, which
      // is what proves the guard is in place.
      const status = await statusOf(harness.service.postAjax({ action: 'libraries' }, EDITOR));

      expect(status).toBe(400);
      expect(harness.postAjax).toHaveBeenCalled();
    });

    it('sweeps expired temporary files after answering, not before', async () => {
      // The trigger lives here rather than on the route because both mutating
      // operations create garbage and neither may lose it. This is the
      // commonest source: a session abandoned after an upload produces temp
      // objects and no save at all.
      const stale = `h5p/temp/${EDITOR.id}/images/stale.png`;
      harness.objects.objects.set(stale, {
        body: Buffer.from('abandoned by a session that never saved'),
        createdAt: new Date(Date.now() - LIFETIME_MS - 60_000),
      });

      await harness.service.postAjax(
        { action: 'libraries', body: { libraries: ['SpeakTest.Main 1.0'] } },
        EDITOR,
      );

      // The caller does not await the sweep, so this waits for the outcome
      // rather than for a call.
      await vi.waitFor(() => expect(harness.objects.paths()).not.toContain(stale));
    });

    it('does not sweep when the ajax request failed', async () => {
      const stale = `h5p/temp/${EDITOR.id}/images/stale.png`;
      harness.objects.objects.set(stale, {
        body: Buffer.from('abandoned by a session that never saved'),
        createdAt: new Date(Date.now() - LIFETIME_MS - 60_000),
      });
      const cleanUp = vi.spyOn(harness.editor.temporaryFileManager, 'cleanUp');

      await expect(harness.service.postAjax({ action: 'nonsense' }, EDITOR)).rejects.toThrow();
      await flushMicrotasks();

      expect(cleanUp).not.toHaveBeenCalled();
      expect(harness.objects.paths()).toContain(stale);
    });

    it('answers the libraries action for a body the endpoint understands', async () => {
      const answer = await harness.service.postAjax(
        { action: 'libraries', body: { libraries: ['SpeakTest.Main 1.0'] } },
        EDITOR,
      );

      // Nothing is installed in this harness, so the overview is empty — the
      // point is that the request was served rather than refused.
      expect(answer).toEqual([]);
    });

    it('defaults the language, since translations hands it straight to a validator', async () => {
      // `listLibraryLanguageFiles` declares `language` as required and passes it
      // to `validateLanguageCode`, which refuses `undefined` with a plain
      // `Error` — a 500 for a query parameter the caller simply left out.
      const answer = (await harness.service.postAjax(
        { action: 'translations', body: { libraries: [] } },
        EDITOR,
      )) as { data: unknown };

      expect(answer.data).toEqual({});
    });
  });

  describe('the editor model', () => {
    it('answers with exactly the three fields the widget boots from', async () => {
      const model = await harness.service.editorModel(undefined, undefined, EDITOR);

      // A field the library adds to `IEditorModel` shows up here, which is the
      // half of the leak an absent-`urlGenerator` assertion cannot see.
      expect(Object.keys(model).sort()).toEqual(['integration', 'scripts', 'styles']);
      expect(model.scripts.length + model.styles.length).toBeGreaterThan(40);
    });

    it.each([
      ['installLibraryLockMaxOccupationTime'],
      ['contentWhitelist'],
      ['libraryWhitelist'],
      ['hubRegistrationEndpoint'],
      ['maxFileSize'],
    ])('carries no part of the server configuration: %s', async (key) => {
      // **This is the assertion that matters.** `render` returns a live
      // `UrlGenerator` whose only serialisable own property is the whole
      // 41-key `H5PConfig`, and each of these five keys exists only there —
      // none of them appears anywhere in `generateIntegration` or
      // `generateEditorIntegration`. Asserting the *absence of `urlGenerator`*
      // would pass for a future field that carries the same config; a
      // substring assertion over the serialised body would not.
      const model = await harness.service.editorModel(undefined, undefined, EDITOR);

      expect(JSON.stringify(model)).not.toContain(key);
    });

    it('does not carry the url generator either', async () => {
      // The weaker of the two, kept because it names the field this is really
      // about. It is not a replacement for the substring cases above: on its
      // own it passes for any new field that also holds the configuration.
      const model = await harness.service.editorModel(undefined, undefined, EDITOR);

      expect(model).not.toHaveProperty('urlGenerator');
    });

    it('names the exercise being edited, and nothing when there is not one yet', async () => {
      const existing = await harness.service.editorModel('some-content-id', undefined, EDITOR);
      const fresh = await harness.service.editorModel(undefined, undefined, EDITOR);

      expect(existing.integration.editor?.nodeVersionId).toBe('some-content-id');
      expect(fresh.integration.editor?.nodeVersionId).toBeUndefined();
    });

    it('leaves the editor chrome English for uk, which upstream does not ship', async () => {
      // ADR-007, amendment 3: `H5P_TRANSLATE` localizes the strings this
      // *server* renders, and Joubel's own authoring UI comes from
      // `editor-assets/language/<code>.js` — 26 locales upstream, without
      // `uk`. `getLanguageReplacer` returns identity for one it does not have,
      // so `language/en.js` stays in the list. Recorded as an outcome rather
      // than as a plan, so that shipping `uk` upstream makes this fail loudly.
      const model = await harness.service.editorModel(undefined, 'uk', EDITOR);

      // The URLs carry a `?version=` cache buster, so the match is on the
      // file and not on the end of the string.
      expect(model.scripts.some((url) => url.includes('language/en.js'))).toBe(true);
      expect(model.scripts.some((url) => url.includes('language/es.js'))).toBe(false);
    });

    it('swaps in the editor language file for a locale upstream does ship', async () => {
      const model = await harness.service.editorModel(undefined, 'es', EDITOR);

      expect(model.scripts.some((url) => url.includes('language/es.js'))).toBe(true);
      expect(model.scripts.some((url) => url.includes('language/en.js'))).toBe(false);
    });

    it('defaults to English when the caller asked for no language', async () => {
      const model = await harness.service.editorModel(undefined, undefined, EDITOR);

      expect(model.integration.editor?.language).toBe('en');
    });

    it('refuses an unsafe content id with a 400 and never renders', async () => {
      const render = vi.spyOn(harness.editor, 'render');

      expect(await statusOf(harness.service.editorModel('../../etc', undefined, EDITOR))).toBe(400);
      expect(render).not.toHaveBeenCalled();
    });
  });

  describe('content parameters', () => {
    /** Content written straight through the storage adapter, as an import would leave it. */
    const seedContent = async (): Promise<string> =>
      new H5pContentStorage(harness.objects.asStorageService()).addContent(
        {
          title: 'Present perfect drill',
          language: 'en',
          mainLibrary: 'SpeakTest.Main',
          embedTypes: ['iframe'],
          preloadedDependencies: [
            { machineName: 'SpeakTest.Main', majorVersion: 1, minorVersion: 0 },
          ],
          license: 'U',
          defaultLanguage: 'en',
        },
        { question: 'Have you ever been to Kyiv?' },
        EDITOR,
      );

    it('answers with the metadata and the parameters, in the shape a save posts back', async () => {
      const contentId = await seedContent();

      const answer = await harness.service.contentParameters(contentId, EDITOR);

      expect(answer.library).toBe('SpeakTest.Main 1.0');
      expect(answer.h5p.title).toBe('Present perfect drill');
      expect(answer.params.metadata.title).toBe('Present perfect drill');
      expect(answer.params.params).toEqual({ question: 'Have you ever been to Kyiv?' });
    });

    it('answers 404 for an exercise nobody stored', async () => {
      expect(await statusOf(harness.service.contentParameters('not-here', EDITOR))).toBe(404);
    });

    it('refuses an unsafe content id with a 400', async () => {
      expect(await statusOf(harness.service.contentParameters('../../etc', EDITOR))).toBe(400);
    });
  });

  describe('save', () => {
    const LIBRARY = { machineName: 'SpeakTest.Main', majorVersion: 1, minorVersion: 0 };
    const UBERNAME = 'SpeakTest.Main 1.0';

    /**
     * A really installed library, because the save is really run.
     *
     * `saveOrUpdateContentReturnMetaData` reads `semantics.json` to walk the
     * parameters for file references and to build the metadata's
     * dependencies — a stubbed editor here would leave the whole save contract
     * untested until the e2e.
     */
    const installLibrary = async (): Promise<void> => {
      const libraries = new H5pLibraryStorage(harness.objects.asStorageService());
      await libraries.addLibrary({
        title: 'Speak Test Main',
        ...LIBRARY,
        patchVersion: 1,
        runnable: 1,
      } as ILibraryMetadata);
      await libraries.addFile(
        LIBRARY,
        'semantics.json',
        Readable.from([
          JSON.stringify([
            { name: 'question', type: 'text' },
            { name: 'clip', type: 'file', optional: true },
          ]),
        ]),
      );
    };

    const body = (question: string, title = 'Present perfect drill'): SaveH5pContentInput => ({
      library: UBERNAME,
      params: {
        metadata: { title, language: 'en', license: 'U' },
        params: { question },
      },
    });

    beforeEach(async () => {
      await installLibrary();
    });

    it('creates the content, its objects and its index row', async () => {
      const saved = await harness.service.save(undefined, body('Kyiv?'), { uid: 'editor-1' });

      expect(saved.title).toBe('Present perfect drill');
      expect(saved.mainLibrary).toBe(UBERNAME);
      expect(harness.objects.paths()).toContain(`h5p/content/${saved.contentId}/content.json`);

      const row = harness.rows.rows.get(saved.contentId);
      expect(row?.storagePath).toBe(`h5p/content/${saved.contentId}`);
      expect(row?.pageId).toBeNull();
      // One stamp, so a row that was never updated says so.
      expect(row?.audit.createdAt).toBe(row?.audit.updatedAt);
      expect(row?.audit.createdBy).toBe('editor-1');
    });

    it('records the size of what was actually stored', async () => {
      const saved = await harness.service.save(undefined, body('Kyiv?'), { uid: 'editor-1' });

      const stored = harness.objects
        .paths()
        .filter((path) => path.startsWith(`h5p/content/${saved.contentId}/`))
        .reduce((total, path) => total + Buffer.byteLength(harness.objects.text(path)), 0);
      expect(harness.rows.rows.get(saved.contentId)?.sizeBytes).toBe(stored);
      expect(stored).toBeGreaterThan(0);
    });

    it('keeps the content id when saving over an exercise that exists', async () => {
      const created = await harness.service.save(undefined, body('Kyiv?'), { uid: 'editor-1' });

      const updated = await harness.service.save(created.contentId, body('Lviv?', 'Renamed'), {
        uid: 'editor-2',
      });

      expect(updated.contentId).toBe(created.contentId);
      expect(harness.objects.text(`h5p/content/${created.contentId}/content.json`)).toContain(
        'Lviv?',
      );
      const row = harness.rows.rows.get(created.contentId);
      expect(row?.title).toBe('Renamed');
      // Who created it does not move; who saved it last does.
      expect(row?.audit.createdBy).toBe('editor-1');
      expect(row?.audit.updatedBy).toBe('editor-2');
    });

    it('recomputes the size after a save that changed the stored files', async () => {
      const created = await harness.service.save(undefined, body('Kyiv?'), { uid: 'editor-1' });
      const before = harness.rows.rows.get(created.contentId)?.sizeBytes ?? 0;

      await harness.service.save(created.contentId, body('Kyiv?'.repeat(200)), { uid: 'editor-1' });

      expect(harness.rows.rows.get(created.contentId)?.sizeBytes).toBeGreaterThan(before);
    });

    it('keeps the page an exercise is attached to', async () => {
      // `pageId` is `null` today and nothing sets it, but attaching an exercise
      // to a page is the first thing the admin exercise screen does.
      const created = await harness.service.save(undefined, body('Kyiv?'), { uid: 'editor-1' });
      const row = harness.rows.rows.get(created.contentId);
      harness.rows.rows.set(created.contentId, { ...row!, pageId: 'a-page' });

      await harness.service.save(created.contentId, body('Lviv?'), { uid: 'editor-1' });

      expect(harness.rows.rows.get(created.contentId)?.pageId).toBe('a-page');
    });

    it('refuses to save under an id that has no index row, and writes nothing', async () => {
      // Without this the library would happily create content under a
      // caller-supplied id: `H5pContentStorage.addContent` accepts one.
      const before = harness.objects.paths();

      expect(
        await statusOf(harness.service.save('made-up-id', body('Kyiv?'), { uid: 'editor-1' })),
      ).toBe(404);
      expect(
        await messageOf(harness.service.save('made-up-id', body('Kyiv?'), { uid: 'editor-1' })),
      ).toBe('That exercise does not exist.');
      expect(harness.objects.paths()).toEqual(before);
    });

    it('refuses an unsafe content id with a 400 and writes nothing', async () => {
      const before = harness.objects.paths();

      expect(
        await statusOf(harness.service.save('../../etc', body('Kyiv?'), { uid: 'editor-1' })),
      ).toBe(400);
      expect(harness.objects.paths()).toEqual(before);
    });

    it('answers 404 for a library nobody installed, rather than 500', async () => {
      // `generateContentMetadata` reads `getLibrary(...).machineName` without
      // checking, so this is a `TypeError` — a 500 for a value the caller sent.
      const call = (): Promise<unknown> =>
        harness.service.save(
          undefined,
          { ...body('Kyiv?'), library: 'H5P.NotHere 1.0' },
          {
            uid: 'editor-1',
          },
        );

      expect(await statusOf(call())).toBe(404);
      expect(await messageOf(call())).toBe('That library is not installed on this server.');
      expect(harness.objects.paths().filter((path) => path.startsWith('h5p/content/'))).toEqual([]);
    });

    it('answers 400 for a library name that is not an ubername', async () => {
      expect(
        await statusOf(
          harness.service.save(
            undefined,
            { ...body('Kyiv?'), library: 'not an ubername' },
            {
              uid: 'editor-1',
            },
          ),
        ),
      ).toBe(400);
    });

    it('removes the content objects when the index write of a new exercise fails', async () => {
      // The objects would otherwise sit under a `randomUUID()` prefix that
      // nothing references, no route can enumerate and no route can delete.
      harness.rows.createFailure = new Error('firestore unavailable');

      await expect(
        harness.service.save(undefined, body('Kyiv?'), { uid: 'editor-1' }),
      ).rejects.toThrow('firestore unavailable');

      expect(harness.objects.paths().filter((path) => path.startsWith('h5p/content/'))).toEqual([]);
    });

    it('keeps the content objects when the index write of an existing exercise fails', async () => {
      // The mirror image, and the direction that destroys an exercise if it is
      // implemented backwards: the row already names these objects and they are
      // the newer truth, so a save that could not write an audit field may not
      // delete them.
      const created = await harness.service.save(undefined, body('Kyiv?'), { uid: 'editor-1' });
      harness.rows.updateFailure = new Error('firestore unavailable');

      await expect(
        harness.service.save(created.contentId, body('Lviv?'), { uid: 'editor-1' }),
      ).rejects.toThrow('firestore unavailable');

      expect(harness.objects.paths()).toContain(`h5p/content/${created.contentId}/content.json`);
      expect(harness.objects.text(`h5p/content/${created.contentId}/content.json`)).toContain(
        'Lviv?',
      );
    });

    it('answers 404, and keeps the objects, when the row disappears mid-save', async () => {
      const created = await harness.service.save(undefined, body('Kyiv?'), { uid: 'editor-1' });
      harness.rows.rows.delete(created.contentId);
      // Past the existence check: the row is there when it is asked for and
      // gone by the time the update commits.
      harness.rows.rows.set(created.contentId, {
        ...h5pContentSchema.parse({
          id: created.contentId,
          title: 'x',
          mainLibrary: UBERNAME,
          storagePath: `h5p/content/${created.contentId}`,
          audit: {
            createdAt: '2026-01-01T00:00:00.000Z',
            createdBy: 'editor-1',
            updatedAt: '2026-01-01T00:00:00.000Z',
            updatedBy: 'editor-1',
          },
        }),
      });
      const rows = harness.rows.rows;
      vi.spyOn(harness.rows, 'update').mockImplementation(() => {
        rows.delete(created.contentId);
        return Promise.resolve(null);
      });

      expect(
        await statusOf(harness.service.save(created.contentId, body('Lviv?'), { uid: 'editor-1' })),
      ).toBe(404);
      expect(harness.objects.paths()).toContain(`h5p/content/${created.contentId}/content.json`);
    });

    it('sweeps expired temporary files after a save, since a create leaves them behind', async () => {
      // `ContentStorer.addOrUpdateContent` passes `deleteTemporaryFiles = isUpdate`,
      // so the temp copies of every file a new exercise references are
      // deliberately left for "the regular expiration mechanism".
      harness.objects.objects.set(`h5p/temp/${EDITOR.id}/images/stale.png`, {
        body: Buffer.from('abandoned by a session that never saved'),
        createdAt: new Date(Date.now() - LIFETIME_MS - 60_000),
      });

      await harness.service.save(undefined, body('Kyiv?'), { uid: 'editor-1' });

      // The sweep is deliberately not awaited by the caller, so the assertion
      // waits for the outcome rather than for a call.
      await vi.waitFor(() =>
        expect(harness.objects.paths()).not.toContain(`h5p/temp/${EDITOR.id}/images/stale.png`),
      );
    });

    it('does not sweep when the save failed', async () => {
      const stale = `h5p/temp/${EDITOR.id}/images/stale.png`;
      harness.objects.objects.set(stale, {
        body: Buffer.from('abandoned by a session that never saved'),
        createdAt: new Date(Date.now() - LIFETIME_MS - 60_000),
      });
      const cleanUp = vi.spyOn(harness.editor.temporaryFileManager, 'cleanUp');

      await expect(
        harness.service.save('made-up-id', body('Kyiv?'), { uid: 'editor-1' }),
      ).rejects.toThrow();
      await flushMicrotasks();

      expect(cleanUp).not.toHaveBeenCalled();
      expect(harness.objects.paths()).toContain(stale);
    });
  });

  describe('temporary files', () => {
    it('reads back a file the caller owns, with its size and mimetype', async () => {
      const clip = Buffer.from('a pronunciation clip');
      harness.objects.objects.set(`h5p/temp/${EDITOR.id}/audios/audio.mp3`, {
        body: clip,
        createdAt: NOW,
      });

      const file = await harness.service.temporaryFile('audios/audio.mp3', EDITOR, () => undefined);

      expect(file.mimetype).toBe('audio/mpeg');
      expect(file.totalLength).toBe(clip.length);
      expect(file.range).toBeUndefined();
    });

    it('answers 404 for a file another editor owns', async () => {
      harness.objects.objects.set('h5p/temp/someone-else/audios/audio.mp3', {
        body: Buffer.from('not yours'),
        createdAt: NOW,
      });

      expect(
        await statusOf(harness.service.temporaryFile('audios/audio.mp3', EDITOR, () => undefined)),
      ).toBe(404);
    });

    it('words the 404 for someone who uploaded a file that may simply have expired', async () => {
      expect(
        await messageOf(harness.service.temporaryFile('audios/gone.mp3', EDITOR, () => undefined)),
      ).toBe('That file is not in temporary storage. It may have expired.');
    });
  });

  describe('maybeSweep', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    const writeTemporaryFiles = (): void => {
      harness.objects.objects.set(`h5p/temp/${EDITOR.id}/images/stale.png`, {
        body: Buffer.from('abandoned by a session that never saved'),
        createdAt: EXPIRED_AT,
      });
      harness.objects.objects.set(`h5p/temp/${EDITOR.id}/images/live.png`, {
        body: Buffer.from('an open editor is still holding this'),
        createdAt: NOW,
      });
    };

    it('deletes an expired file and leaves one inside its lifetime alone', async () => {
      // The destructive failure mode is the second half: `StorageService.list`
      // maps a missing creation time to the epoch, so a derivation that lost
      // `createdAt` would delete every temporary file an editor is working with.
      writeTemporaryFiles();

      await harness.service.maybeSweep();

      expect(harness.objects.paths()).toEqual([`h5p/temp/${EDITOR.id}/images/live.png`]);
    });

    it('does not sweep again inside the interval', async () => {
      writeTemporaryFiles();
      await harness.service.maybeSweep();

      harness.objects.objects.set(`h5p/temp/${EDITOR.id}/images/second.png`, {
        body: Buffer.from('expired, but arrived after the sweep'),
        createdAt: EXPIRED_AT,
      });
      vi.setSystemTime(new Date(NOW.getTime() + TEMP_SWEEP_INTERVAL_MS - 1));
      await harness.service.maybeSweep();

      expect(harness.objects.paths()).toContain(`h5p/temp/${EDITOR.id}/images/second.png`);
    });

    it('sweeps again once the interval has passed', async () => {
      writeTemporaryFiles();
      await harness.service.maybeSweep();

      harness.objects.objects.set(`h5p/temp/${EDITOR.id}/images/second.png`, {
        body: Buffer.from('expired, but arrived after the sweep'),
        createdAt: EXPIRED_AT,
      });
      vi.setSystemTime(new Date(NOW.getTime() + TEMP_SWEEP_INTERVAL_MS));
      await harness.service.maybeSweep();

      expect(harness.objects.paths()).toEqual([`h5p/temp/${EDITOR.id}/images/live.png`]);
    });

    it('swallows a failing sweep, because it must never replace a response', async () => {
      // A save or an upload that succeeded may not answer 500 because a listing
      // failed. The caller does not await this, so an unhandled rejection here
      // would also take the process down.
      vi.spyOn(harness.editor.temporaryFileManager, 'cleanUp').mockRejectedValue(
        new Error('the bucket is unreachable'),
      );

      await expect(harness.service.maybeSweep()).resolves.toBeUndefined();
    });
  });
});
