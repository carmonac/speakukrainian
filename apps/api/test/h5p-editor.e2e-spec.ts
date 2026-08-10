import type { INestApplication } from '@nestjs/common';
import type { Firestore } from '@google-cloud/firestore';
import { H5PConfig } from '@lumieducation/h5p-server';
import type { H5PEditor } from '@lumieducation/h5p-server';
import type { Auth } from 'firebase-admin/auth';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COLLECTIONS, h5pSaveResultSchema, type H5pSaveResult } from '@speakukrainian/shared';
import { H5P_CONFIG, H5P_EDITOR } from '../src/h5p/h5p.tokens.js';
import { FIRESTORE } from '../src/infra/firestore/firestore.tokens.js';
import { StorageService } from '../src/infra/storage/storage.service.js';
import { authOf, createTestApp, signInAs, type TestUser } from './emulator.js';
import {
  DEP_LIBRARY_DIR,
  MAIN_LIBRARY,
  MAIN_LIBRARY_DIR,
  buildH5pPackage,
} from './fixtures/h5p-package.js';

const CONTENT_PREFIX = 'h5p/content/';
const LIBRARIES_PREFIX = 'h5p/libraries/';
const TEMP_PREFIX = 'h5p/temp/';

/** The controller's own refusal of a wildcard path, and nothing else in the stack says it. */
const REFUSED_PATH = 'The requested file path is not valid.';

/**
 * 8 KB, deterministic, and nothing like a run of zeroes: a range assertion is
 * only worth making if the bytes of one slice differ from the bytes of every
 * other. `mp3` is on `H5PConfig.contentWhitelist`, so the editor accepts it.
 */
const CLIP_BYTES = Buffer.from(
  Uint8Array.from({ length: 8 * 1024 }, (_value, index) => (index * 37 + (index >> 8)) % 251),
);

interface ErrorBody {
  statusCode: number;
  message: string;
}

interface SavedFileBody {
  mime: string;
  /** `<filename>#tmp` — the suffix the H5P client strips before asking for it. */
  path: string;
}

interface ContentTypeCacheBody {
  apiVersion: { major: number; minor: number };
  libraries: { machineName: string; installed: boolean }[];
  outdated: boolean;
  user: string;
}

interface LibraryDataBody {
  name: string;
  javascript: string[];
  semantics: { name: string }[];
  version: { major: number; minor: number };
}

describe('h5p editor ajax (e2e)', () => {
  let app: INestApplication;
  let auth: Auth;
  let storage: StorageService;
  let firestore: Firestore;
  let editor: TestUser;
  /** A second editor, so "another editor cannot read this file" is a real claim. */
  let otherEditor: TestUser;
  let student: TestUser;
  let exercise: H5pSaveResult;

  const createdContentIds: string[] = [];

  const server = (): ReturnType<INestApplication['getHttpServer']> => app.getHttpServer();

  const ajaxGet = (query: string, token = editor.idToken) =>
    request(server()).get(`/api/h5p/ajax?${query}`).set('Authorization', `Bearer ${token}`);

  const ajaxPost = (query: string, token = editor.idToken) =>
    request(server()).post(`/api/h5p/ajax?${query}`).set('Authorization', `Bearer ${token}`);

  const tempFile = (filename: string, token = editor.idToken) =>
    request(server())
      .get(`/api/h5p/temp-files/${filename}`)
      .set('Authorization', `Bearer ${token}`);

  /** Uploads one file through the editor's own route and returns the stored filename. */
  const uploadClip = async (
    bytes: Buffer = CLIP_BYTES,
    filename = 'clip.mp3',
    contentType = 'audio/mpeg',
    fieldType = 'audio',
    token = editor.idToken,
  ): Promise<request.Response> =>
    ajaxPost('action=files&language=en', token)
      .field('field', JSON.stringify({ type: fieldType, name: 'file' }))
      .attach('file', bytes, { filename, contentType });

  /** The filename the editor stored, i.e. the returned path without its `#tmp` marker. */
  const storedName = (response: request.Response): string =>
    (response.body as SavedFileBody).path.replace(/#tmp$/, '');

  beforeAll(async () => {
    app = await createTestApp();
    auth = authOf(app);
    storage = app.get(StorageService);
    firestore = app.get<Firestore>(FIRESTORE);
    [editor, otherEditor, student] = await Promise.all([
      signInAs(auth, 'editor'),
      signInAs(auth, 'editor'),
      signInAs(auth, 'student'),
    ]);

    // The fixture libraries may already be installed at this patch version from
    // another suite, and `LibraryManager` will not reinstall an equal version —
    // so without this `semantics.json` could be missing from a directory that
    // otherwise looks complete.
    await storage.deleteByPrefix(`${LIBRARIES_PREFIX}${MAIN_LIBRARY_DIR}/`);
    await storage.deleteByPrefix(`${LIBRARIES_PREFIX}${DEP_LIBRARY_DIR}/`);

    const response = await request(server())
      .post('/api/h5p/content')
      .set('Authorization', `Bearer ${editor.idToken}`)
      .attach('file', await buildH5pPackage(), {
        filename: 'drill.h5p',
        contentType: 'application/octet-stream',
      })
      .expect(201);

    exercise = h5pSaveResultSchema.parse(response.body);
    createdContentIds.push(exercise.contentId);
  });

  afterAll(async () => {
    if (storage) {
      await Promise.all(
        createdContentIds.map((id) => storage.deleteByPrefix(`${CONTENT_PREFIX}${id}/`)),
      );
      const owners = [editor, otherEditor].filter((user) => user !== undefined);
      await Promise.all(owners.map((user) => storage.deleteByPrefix(`${TEMP_PREFIX}${user.uid}/`)));
    }
    if (firestore) {
      await Promise.all(
        createdContentIds.map((id) =>
          firestore.collection(COLLECTIONS.h5pContent).doc(id).delete(),
        ),
      );
    }
    const created = [editor, otherEditor, student].filter((user) => user !== undefined);
    await Promise.all(created.map((user) => auth.deleteUser(user.uid)));
    if (app) {
      await app.close();
    }
  });

  describe('GET ajax?action=content-type-cache', () => {
    it('answers with a well-formed payload built from the installed libraries', async () => {
      const response = await ajaxGet('action=content-type-cache&language=en').expect(200);

      const body = response.body as ContentTypeCacheBody;
      expect(body.apiVersion).toEqual(expect.objectContaining({ major: expect.any(Number) }));
      expect(body.user).toBe('local');
      // `addLocalLibraries` lists every installed runnable library, which is
      // what the editor's content-type selector actually reads.
      expect(body.libraries.map((library) => library.machineName)).toContain(
        MAIN_LIBRARY.machineName,
      );
      expect(
        body.libraries.find((library) => library.machineName === MAIN_LIBRARY.machineName)
          ?.installed,
      ).toBe(true);
    });

    it('does not reach out to api.h5p.org, which `outdated: false` is the observable proof of', async () => {
      // `outdated` is `ContentTypeCache.isOutdated()`, which reads
      // `contentTypeCacheUpdate` out of the key-value storage `h5p.module.ts`
      // seeds. Remove the seeding and two things happen together: this reports
      // `true`, **and** `get()` stops short-circuiting and falls through to
      // `forceUpdate()` → `registerOrGetUuid()` → an HTTPS POST to
      // `config.hubRegistrationEndpoint` on every single call. `fetchingDisabled`
      // does not prevent that request; it is only a field in the payload. So
      // this assertion is the one that pins the fix — a status check would pass
      // either way, because the failure is caught and the body still arrives.
      const response = await ajaxGet('action=content-type-cache').expect(200);

      expect((response.body as ContentTypeCacheBody).outdated).toBe(false);
    });
  });

  describe('GET ajax?action=libraries', () => {
    it('answers with the semantics and assets the editor needs to render a form', async () => {
      const response = await ajaxGet(
        `action=libraries&machineName=${MAIN_LIBRARY.machineName}&majorVersion=1&minorVersion=0&language=en`,
      ).expect(200);

      const body = response.body as LibraryDataBody;
      expect(body.name).toBe(MAIN_LIBRARY.machineName);
      expect(body.version).toEqual({ major: 1, minor: 0 });
      expect(body.semantics.map((entry) => entry.name)).toContain('question');
      expect(body.javascript.some((url) => url.includes(`${MAIN_LIBRARY_DIR}/main.js`))).toBe(true);
    });

    it('answers 400 when the version parameters are missing', async () => {
      const response = await ajaxGet(
        `action=libraries&machineName=${MAIN_LIBRARY.machineName}`,
      ).expect(400);

      expect((response.body as ErrorBody).message).toBe(
        'The editor sent a request this server could not understand.',
      );
    });

    it('answers 404 for a library nobody installed', async () => {
      const response = await ajaxGet(
        'action=libraries&machineName=H5P.NotHere&majorVersion=1&minorVersion=0',
      ).expect(404);

      expect((response.body as ErrorBody).message).toBe(
        'That library is not installed on this server.',
      );
    });

    it.each([['uk-'], ['english'], ['not a code']])(
      'answers 400 for the language %j rather than 500',
      async (language) => {
        // The library refuses these with a plain `Error`, which the mapper
        // declines — so without the route's own check this is a 500 for a query
        // parameter the caller typed.
        const response = await ajaxGet(
          `action=libraries&machineName=${MAIN_LIBRARY.machineName}&majorVersion=1&minorVersion=0&language=${encodeURIComponent(language)}`,
        ).expect(400);

        expect((response.body as ErrorBody).message).toBe('That is not a valid language code.');
      },
    );
  });

  describe('the action allowlist', () => {
    it.each([
      ['GET', 'content-hub-metadata-cache'],
      ['GET', 'library-install'],
      ['GET', 'files'],
      ['GET', 'nonsense'],
    ] as const)('refuses %s ?action=%s with a 400', async (_method, action) => {
      const response = await ajaxGet(`action=${action}`).expect(400);

      expect((response.body as ErrorBody).message).toBe(
        'That editor action is not available on this server.',
      );
    });

    it.each([['library-install'], ['get-content'], ['content-hub-metadata-cache'], ['nonsense']])(
      'refuses POST ?action=%s with a 400',
      async (action) => {
        // `library-install` and `get-content` each start an HTTPS request to
        // `api.h5p.org`, and an unknown action reaches the endpoint's own
        // default branch, which raises `malformed-request` with a **500**.
        const response = await ajaxPost(`action=${action}`).send({}).expect(400);

        expect((response.body as ErrorBody).message).toBe(
          'That editor action is not available on this server.',
        );
      },
    );

    it('refuses a request with no action at all', async () => {
      await ajaxGet('').expect(400);
      await ajaxPost('').send({}).expect(400);
    });

    it('serves the POST actions that carry a JSON body', async () => {
      const overview = await ajaxPost('action=libraries&language=en')
        .send({ libraries: [`${MAIN_LIBRARY.machineName} 1.0`] })
        .expect(200);

      expect((overview.body as { uberName: string }[]).map((library) => library.uberName)).toEqual([
        `${MAIN_LIBRARY.machineName} 1.0`,
      ]);
    });

    it('does not fail with a 500 when a POST carries no body at all', async () => {
      // `postAjax` does `'libraries' in body` on three of its five branches, so
      // `undefined` would be `TypeError: Cannot use 'in' operator`.
      const response = await ajaxPost('action=libraries&language=en').expect(400);

      expect((response.body as ErrorBody).message).toBe(
        'The editor sent a request this server could not understand.',
      );
    });

    it('answers the translations action without a language, rather than 500', async () => {
      // `listLibraryLanguageFiles` hands `language` straight to a validator that
      // refuses `undefined` with a plain `Error`.
      const response = await ajaxPost('action=translations')
        .send({ libraries: [`${MAIN_LIBRARY.machineName} 1.0`] })
        .expect(200);

      expect(response.body).toHaveProperty('data');
    });
  });

  describe('POST ajax?action=files', () => {
    it('stores the upload under the caller’s own temporary prefix', async () => {
      const response = await uploadClip();

      expect(response.status).toBe(200);
      const body = response.body as SavedFileBody;
      expect(body.mime).toBe('audio/mpeg');
      // `H5PEditor.saveContentFile` files an upload by its mimetype and gives it
      // a unique short id; `#tmp` is what tells the client it is not saved yet.
      expect(body.path).toMatch(/^audios\/audio-[\w]+\.mp3#tmp$/);

      const objectPath = `${TEMP_PREFIX}${editor.uid}/${storedName(response)}`;
      await expect(storage.exists(objectPath)).resolves.toBe(true);
      // The owner is in the object name, which is the only thing that keeps two
      // editors' identically named uploads apart.
      await expect(
        storage.exists(`${TEMP_PREFIX}${otherEditor.uid}/${storedName(response)}`),
      ).resolves.toBe(false);
    });

    it('refuses a file type that is not on the content whitelist, as a 400 and not a 500', async () => {
      // The library raises `not-in-whitelist` with `H5pError`'s default status
      // of 500. Reported that way the author is told the server broke, and
      // neither the rule nor the fix is anywhere in the answer.
      const response = await uploadClip(
        Buffer.from('MZ not really an executable'),
        'malware.exe',
        'application/octet-stream',
        'file',
      );

      expect(response.status).toBe(400);
      expect((response.body as ErrorBody).message).toBe(
        'That kind of file cannot be uploaded into an exercise.',
      );
    });

    it('refuses a file whose bytes are not what the field asked for', async () => {
      const response = await uploadClip(CLIP_BYTES, 'clip.mp3', 'audio/mpeg', 'image');

      expect(response.status).toBe(400);
      expect((response.body as ErrorBody).message).toBe(
        'That file could not be read as the kind of media the field expects.',
      );
    });

    it('leaves no uploaded file behind on the container filesystem', async () => {
      // Multer does not clean up after a successful request. There is nothing
      // to assert over HTTP, so this asserts the property that is observable:
      // repeated uploads keep working and the bucket holds exactly what was
      // uploaded, with the local cleanup pinned by the controller spec.
      const first = await uploadClip();
      const second = await uploadClip();

      expect(storedName(first)).not.toBe(storedName(second));
      await expect(
        storage.exists(`${TEMP_PREFIX}${editor.uid}/${storedName(second)}`),
      ).resolves.toBe(true);
    });
  });

  describe('GET temp-files', () => {
    it('streams the whole file back to its owner and offers ranges', async () => {
      const uploaded = await uploadClip();

      const response = await tempFile(storedName(uploaded)).expect(200);

      expect(response.headers['accept-ranges']).toBe('bytes');
      expect(response.headers['content-type']).toMatch(/^audio\/mpeg/);
      // Per-user, short-lived and role-guarded, so no cache may hold it.
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(Buffer.from(response.body as Buffer)).toEqual(CLIP_BYTES);
    });

    it('answers a byte range with 206 and exactly those bytes', async () => {
      const uploaded = await uploadClip();

      const response = await tempFile(storedName(uploaded))
        .set('Range', 'bytes=1000-1099')
        .expect(206);

      expect(response.headers['content-range']).toBe(
        `bytes 1000-1099/${String(CLIP_BYTES.length)}`,
      );
      expect(response.headers['content-length']).toBe('100');
      // Comparing the bytes is what says the range reached storage rather than
      // being applied to a fully buffered object.
      expect(Buffer.from(response.body as Buffer)).toEqual(CLIP_BYTES.subarray(1000, 1100));
    });

    it('answers 416 for a range past the end, carrying the real size', async () => {
      const uploaded = await uploadClip();

      const response = await tempFile(storedName(uploaded))
        .set('Range', `bytes=${String(CLIP_BYTES.length + 10)}-`)
        .expect(416);

      expect(response.headers['content-range']).toBe(`bytes */${String(CLIP_BYTES.length)}`);
    });

    it('does not let another editor read a file by its name', async () => {
      // The URL carries no owner, so the owner can only be the token — which is
      // also why this route cannot be made public for the editor's own preview.
      const uploaded = await uploadClip();

      const response = await tempFile(storedName(uploaded), otherEditor.idToken).expect(404);

      expect((response.body as ErrorBody).message).toBe(
        'That file is not in temporary storage. It may have expired.',
      );
    });

    it('answers 404 for a name nobody uploaded, saying it may simply have expired', async () => {
      const response = await tempFile('audios/audio-notmine.mp3').expect(404);

      expect((response.body as ErrorBody).message).toBe(
        'That file is not in temporary storage. It may have expired.',
      );
    });

    it.each([
      ['an encoded separator', 'audios/..%2F..%2Fcontent%2Fh5p.json'],
      ['an encoded dot-dot', '%2e%2e%2f%2e%2e%2fh5p.json'],
      ['a backslash separator', 'audios/..%5C..%5Ch5p.json'],
    ])('refuses a path carrying %s', async (_shape, path) => {
      const response = await tempFile(path);

      expect(response.status).toBe(400);
      expect((response.body as ErrorBody).message).toBe(REFUSED_PATH);
      expect(response.text).not.toContain('SpeakTest.Main');
    });
  });

  describe('the expiry sweep', () => {
    /**
     * A sweep against the real bucket, with the *lifetime* driven rather than
     * the clock.
     *
     * The clock is not available: a bucket sets `timeCreated` itself, so no
     * test can create an already-expired object, and a request-driven sweep is
     * throttled to once per instance per interval — a suite that only made
     * requests could not tell "nothing had expired" from "the sweep never ran",
     * which is not a test. Driving `temporaryFileLifetime` instead exercises
     * the whole real path: `TemporaryFileManager.cleanUp` → this adapter's
     * `listFiles` over a fake-gcs listing → `deleteFile`. That is the half no
     * unit test can reach, because `StorageService.list` maps a **missing**
     * `timeCreated` to the epoch and only a real listing says whether one comes
     * back at all.
     */
    const sweepWithLifetime = async (lifetimeMs: number): Promise<void> => {
      const config = app.get<H5PConfig>(H5P_CONFIG);
      const original = config.temporaryFileLifetime;
      config.temporaryFileLifetime = lifetimeMs;
      try {
        await app.get<H5PEditor>(H5P_EDITOR).temporaryFileManager.cleanUp();
      } finally {
        config.temporaryFileLifetime = original;
      }
    };

    it('leaves a file that is still inside its lifetime alone', async () => {
      // The destructive half, and the one that would be silent: an editor's
      // uploads vanishing mid-session is one lost `createdAt` away.
      const uploaded = await uploadClip();

      await sweepWithLifetime(new H5PConfig(undefined).temporaryFileLifetime);

      await tempFile(storedName(uploaded)).expect(200);
    });

    it('removes a file that is past its lifetime, objects and all', async () => {
      const uploaded = await uploadClip();

      // Zero, so every stored object's `createdAt + lifetime` is in the past.
      await sweepWithLifetime(0);

      await expect(
        storage.exists(`${TEMP_PREFIX}${editor.uid}/${storedName(uploaded)}`),
      ).resolves.toBe(false);
      const response = await tempFile(storedName(uploaded)).expect(404);
      expect((response.body as ErrorBody).message).toBe(
        'That file is not in temporary storage. It may have expired.',
      );
    });
  });

  describe('the role boundary', () => {
    const routes = (): { name: string; call: (token?: string) => request.Test }[] => [
      { name: 'GET ajax', call: (token) => ajaxGet('action=content-type-cache', token) },
      { name: 'POST ajax', call: (token) => ajaxPost('action=libraries', token) },
      { name: 'GET temp-files', call: (token) => tempFile('audios/audio-anything.mp3', token) },
    ];

    it.each(routes().map((route) => [route.name, route.call] as const))(
      'refuses a student on %s',
      async (_name, call) => {
        const response = await call(student.idToken).expect(403);

        expect((response.body as ErrorBody).message).toContain('editor');
      },
    );

    it.each([
      ['GET ajax', '/api/h5p/ajax?action=content-type-cache'],
      ['GET temp-files', '/api/h5p/temp-files/audios/audio-anything.mp3'],
    ])('refuses an unauthenticated caller on %s', async (_name, path) => {
      await request(server()).get(path).expect(401);
    });

    it('refuses an unauthenticated POST', async () => {
      await request(server()).post('/api/h5p/ajax?action=libraries').send({}).expect(401);
    });
  });
});
