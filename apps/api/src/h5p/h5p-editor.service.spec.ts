import { HttpException } from '@nestjs/common';
import {
  H5PAjaxEndpoint,
  H5PConfig,
  H5PEditor,
  fsImplementations,
} from '@lumieducation/h5p-server';
import type { IUser } from '@lumieducation/h5p-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
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
  postAjax: MockInstance<H5PAjaxEndpoint['postAjax']>;
  getAjax: MockInstance<H5PAjaxEndpoint['getAjax']>;
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

  const editor = new H5PEditor(
    keyValueStorage,
    config,
    new H5pLibraryStorage(storage),
    new H5pContentStorage(storage),
    new H5pTemporaryStorage(storage, config),
  );
  const endpoint = new H5PAjaxEndpoint(editor);

  return {
    service: new H5pEditorService(endpoint, editor),
    objects,
    editor,
    postAjax: vi.spyOn(endpoint, 'postAjax'),
    getAjax: vi.spyOn(endpoint, 'getAjax'),
  };
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
