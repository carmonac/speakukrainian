import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { Firestore } from '@google-cloud/firestore';
import { H5PConfig } from '@lumieducation/h5p-server';
import type { H5PEditor, ITemporaryFile, IUser } from '@lumieducation/h5p-server';
import type { Auth } from 'firebase-admin/auth';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { COLLECTIONS, h5pSaveResultSchema, type H5pSaveResult } from '@speakukrainian/shared';
import { H5pTemporaryStorage } from '../src/h5p/h5p-temporary.storage.js';
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

/** Hosts a request may legitimately reach: this app, and the emulators it runs against. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

interface ErrorBody {
  statusCode: number;
  message: string;
}

/** Something `vi.spyOn` returned, read only for the arguments it recorded. */
interface Probe {
  mock: { calls: readonly (readonly unknown[])[] };
  mockRestore: () => void;
}

function stripPort(value: string): string {
  const withoutBrackets = /^\[(.+)]/.exec(value);
  return withoutBrackets?.[1] ?? value.split(':')[0] ?? '';
}

/** Every host named anywhere in one call's arguments, whatever shape they took. */
function hostsIn(args: readonly unknown[]): string[] {
  const hosts: string[] = [];

  for (const argument of args) {
    if (argument instanceof URL) {
      hosts.push(argument.hostname);
    } else if (typeof argument === 'string') {
      // A unix socket path is not a host, and `new URL` would not parse it.
      if (!argument.startsWith('/')) {
        hosts.push(URL.canParse(argument) ? new URL(argument).hostname : stripPort(argument));
      }
    } else if (typeof argument === 'object' && argument !== null) {
      const options = argument as { hostname?: unknown; host?: unknown };
      const named = options.hostname ?? options.host;
      if (typeof named === 'string') {
        hosts.push(stripPort(named));
      }
    }
  }

  return hosts.filter((host) => host !== '');
}

/**
 * Every host this process opened an HTTP(S) request or a TCP connection to
 * while `work` ran.
 *
 * **Two probes rather than one, because either alone is blind somewhere.** An
 * agent reusing a kept-alive socket makes a second request with no `connect`,
 * and a client that is not `node:http(s)` opens a connection with no `request`.
 * The H5P library reaches the hub through axios and `follow-redirects`, neither
 * of which is ours to depend on, so what is watched is the two places every one
 * of them has to pass through. The app runs in this process, so this sees its
 * traffic and not only the suite's.
 */
async function hostsReachedDuring(work: () => void | Promise<void>): Promise<string[]> {
  const probes: Probe[] = [
    vi.spyOn(https, 'request'),
    vi.spyOn(http, 'request'),
    vi.spyOn(net.Socket.prototype, 'connect'),
  ];

  try {
    await work();
    // Read before restoring: `mockRestore` resets the spy, and a probe read
    // after it reports nothing whatever happened.
    return probes.flatMap((probe) => probe.mock.calls.flatMap((call) => hostsIn(call)));
  } finally {
    for (const probe of probes) {
      probe.mockRestore();
    }
  }
}

/** The hosts above that are not this machine — the ones a request must never reach. */
function remoteAmong(hosts: readonly string[]): string[] {
  return [...new Set(hosts.filter((host) => !LOCAL_HOSTS.has(host)))];
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

/** What `GET params` answers with — the same object a save posts straight back. */
interface ContentParametersBody {
  h5p: { title: string };
  library: string;
  params: { metadata: { title: string }; params: Record<string, unknown> };
}

/** The body a save posts: what `/params` returned, plus the library it names. */
type SaveBody = { library: string; params: ContentParametersBody['params'] };

/** The stored index row, read through the admin SDK rather than through the API. */
interface IndexRow {
  title: string;
  mainLibrary: string;
  storagePath: string;
  pageId: string | null;
  sizeBytes: number;
  audit: { createdAt: string; createdBy: string; updatedAt: string; updatedBy: string };
}

/** The three fields `GET editor` answers with, read the way a client reads them. */
interface EditorModelBody {
  integration: {
    editor: { assets: { js: string[]; css: string[] }; nodeVersionId?: string; language: string };
    l10n: { H5P: Record<string, string> };
  };
  scripts: string[];
  styles: string[];
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

  const editorModel = (contentId?: string, language?: string, token = editor.idToken) =>
    request(server())
      .get(`/api/h5p/editor${contentId ? `/${contentId}` : ''}`)
      .query(language === undefined ? {} : { language })
      .set('Authorization', `Bearer ${token}`);

  const saveContent = (body: SaveBody, contentId?: string, token = editor.idToken) =>
    request(server())
      .post(`/api/h5p/editor${contentId ? `/${contentId}` : ''}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const contentParameters = (contentId: string, token = editor.idToken) =>
    request(server()).get(`/api/h5p/params/${contentId}`).set('Authorization', `Bearer ${token}`);

  /**
   * The path an asset URL out of the editor model resolves to on this API.
   *
   * `H5P_BASE_URL` may be relative (production, one origin) or absolute (every
   * development machine, where the admin is on another port), so the model
   * carries either shape and only the path is ours to request. The same helper
   * `h5p-play.e2e-spec.ts` uses, for the same reason.
   */
  const apiPathOf = (url: string): string | null => {
    const path = url.startsWith('http') ? new URL(url).pathname + new URL(url).search : url;
    return path.startsWith('/api/h5p/') ? path : null;
  };

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

    it('opens no connection to anything but this machine, and reports itself up to date', async () => {
      // **The two halves of the seeding are independent, and this asserts both.**
      // `contentTypeCache: []` is what stops the outbound call: `get()`
      // short-circuits on a truthy stored value, and without it falls through
      // to `forceUpdate()` → `registerOrGetUuid()` → an HTTPS POST to
      // `config.hubRegistrationEndpoint` on every single call. That failure is
      // caught, so the body still arrives and the status is still 200 — only
      // the connection itself says whether it happened, which is why this
      // watches for one rather than for a flag that merely correlates with it.
      // `contentTypeCacheUpdate` is what makes `isOutdated()` false, and
      // nothing else observes it, so it takes the second assertion.
      let body: ContentTypeCacheBody | undefined;

      const hosts = await hostsReachedDuring(async () => {
        const response = await ajaxGet('action=content-type-cache').expect(200);
        body = response.body as ContentTypeCacheBody;
      });

      expect(remoteAmong(hosts)).toEqual([]);
      expect(body?.outdated).toBe(false);
    });

    it('is watched by a probe that can see an outbound connection', async () => {
      // Without this the assertion above could equally mean the probe is blind,
      // which is the failure mode it was written to replace. `.invalid` is
      // reserved by RFC 2606 and never resolves, so the attempt is real and
      // nothing leaves the machine.
      const hosts = await hostsReachedDuring(() => {
        const attempt = https.request({ host: 'hub.invalid', port: 443 });
        // The name does not resolve, so this fails; nothing here waits for it.
        attempt.on('error', () => undefined);
        attempt.destroy();
      });

      expect(remoteAmong(hosts)).toContain('hub.invalid');
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

    it.each([
      ['a non-numeric major version', 'majorVersion=x&minorVersion=0'],
      ['a non-numeric minor version', 'majorVersion=1&minorVersion=y'],
      ['an empty version', 'majorVersion=&minorVersion=0'],
    ])('answers 400 for %s rather than 500', async (_shape, versions) => {
      // The *absent* versions are the endpoint's own 400 above; these reach
      // `LibraryName.validate`, which raises a plain `Error` that the mapper
      // correctly declines to map — a 500 for a query string the caller typed.
      const response = await ajaxGet(
        `action=libraries&machineName=${MAIN_LIBRARY.machineName}&${versions}`,
      ).expect(400);

      expect((response.body as ErrorBody).message).toBe('That is not a valid H5P library version.');
    });

    it.each([
      ['a traversal', '../../etc'],
      ['a name with a separator', 'H5P.Multi/Choice'],
      ['an empty name', ''],
    ])('answers 400 for %s in the machine name rather than 500', async (_shape, machineName) => {
      const response = await ajaxGet(
        `action=libraries&machineName=${encodeURIComponent(machineName)}&majorVersion=1&minorVersion=0`,
      ).expect(400);

      expect((response.body as ErrorBody).message).toBe('That is not a valid H5P library name.');
      // Nothing about the server's own layout comes back with the refusal.
      expect(response.text).not.toContain('h5p/libraries');
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

    it.each([['audio'], ['image'], ['video'], ['file']])(
      'answers 400 when no file part is sent for a %s field, rather than 500',
      async (type) => {
        // `postAjax` validates and parses `field` first, so a well-formed body
        // gets all the way to `H5PEditor.saveContentFile`, which reads
        // `file.mimetype` unconditionally: a `TypeError` and a 500 for a request
        // that simply left a part out. The same defect the `library-upload`
        // guard exists for.
        const response = await ajaxPost('action=files&language=en')
          .field('field', JSON.stringify({ type, name: 'file' }))
          .expect(400);

        expect((response.body as ErrorBody).message).toBe(
          'The editor sent a request this server could not understand.',
        );
      },
    );

    it('answers 400 for a files request that is JSON and carries no part at all', async () => {
      const response = await ajaxPost('action=files&language=en')
        .send({ field: '{"type":"audio","name":"file"}' })
        .expect(400);

      expect((response.body as ErrorBody).message).toBe(
        'The editor sent a request this server could not understand.',
      );
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

  describe('GET editor', () => {
    it('serves every asset URL the widget would load', async () => {
      // The mechanical half of "the editor loads": if `baseUrl`,
      // `editorLibraryUrl` or the routes ever disagree, or the fetch script did
      // not run, one of these is a 404. Every URL rather than a sample,
      // because a wiring mistake affects a whole family.
      const response = await editorModel(exercise.contentId).expect(200);
      const model = response.body as EditorModelBody;

      const paths = [
        ...new Set(
          [
            ...model.scripts,
            ...model.styles,
            ...model.integration.editor.assets.js,
            ...model.integration.editor.assets.css,
          ]
            .map(apiPathOf)
            .filter((path): path is string => path !== null),
        ),
      ];

      // Otherwise an empty list would pass this vacuously. The model advertises
      // 50 distinct assets — 8 core scripts, 34 editor scripts, 3 core styles
      // and 5 editor styles — so anything near zero means the collection, not
      // the routes.
      expect(paths.length).toBeGreaterThan(40);
      expect(paths.some((path) => path.startsWith('/api/h5p/core/'))).toBe(true);
      expect(paths.some((path) => path.startsWith('/api/h5p/editor-assets/'))).toBe(true);

      const answers = await Promise.all(
        paths.map(async (path) => [path, (await request(server()).get(path)).status] as const),
      );
      expect(answers.filter(([, status]) => status !== 200)).toEqual([]);
    });

    it('carries no part of this server’s configuration, on the wire', async () => {
      // Asserted over the serialised body and not only in the service spec,
      // because the serialisation *is* what the acceptance criterion is about:
      // `render` hands back a live `UrlGenerator` whose only serialisable own
      // property is the entire 41-key `H5PConfig`. Naming the config keys
      // rather than `urlGenerator` is what makes this survive the library
      // adding a second field that carries the same object.
      const response = await editorModel(exercise.contentId).expect(200);

      expect(Object.keys(response.body as object).sort()).toEqual([
        'integration',
        'scripts',
        'styles',
      ]);
      for (const key of [
        'installLibraryLockMaxOccupationTime',
        'contentWhitelist',
        'libraryWhitelist',
        'hubRegistrationEndpoint',
        'maxFileSize',
        'urlGenerator',
      ]) {
        expect(JSON.stringify(response.body)).not.toContain(key);
      }
    });

    it('answers without a content id, for an exercise that does not exist yet', async () => {
      // The array path, over HTTP. Two stacked `@Get` decorators would register
      // only one of the two routes and answer this one with a 404, with nothing
      // in the unit suite going red.
      const response = await request(server())
        .get('/api/h5p/editor')
        .set('Authorization', `Bearer ${editor.idToken}`)
        .expect(200);

      const model = response.body as EditorModelBody;
      expect(model.integration.editor.nodeVersionId).toBeUndefined();
      expect(model.scripts.length).toBeGreaterThan(0);
    });

    it('names the exercise being edited when the path carries one', async () => {
      const response = await editorModel(exercise.contentId).expect(200);

      expect((response.body as EditorModelBody).integration.editor.nodeVersionId).toBe(
        exercise.contentId,
      );
    });

    it('localizes the strings this server renders and leaves Joubel’s chrome English for uk', async () => {
      // ADR-007 amendment 3. `H5P_TRANSLATE` covers `integration.l10n.H5P`;
      // the authoring UI itself comes from `editor-assets/language/<code>.js`,
      // and upstream ships 26 of those without `uk`.
      const ukrainian = await editorModel(exercise.contentId, 'uk').expect(200);
      const spanish = await editorModel(exercise.contentId, 'es').expect(200);

      const uk = ukrainian.body as EditorModelBody;
      const es = spanish.body as EditorModelBody;
      expect(uk.integration.l10n.H5P['fullscreen']).not.toBe(es.integration.l10n.H5P['fullscreen']);
      expect(uk.scripts.some((url) => url.includes('language/en.js'))).toBe(true);
      expect(es.scripts.some((url) => url.includes('language/es.js'))).toBe(true);
    });

    it.each([['not a code'], ['english'], ['uk-']])(
      'answers 400 for the language %j rather than 500',
      async (language) => {
        const response = await editorModel(exercise.contentId, language).expect(400);

        expect((response.body as ErrorBody).message).toBe('That is not a valid language code.');
      },
    );

    it('answers 400 for a content id no document id could be', async () => {
      const response = await request(server())
        .get('/api/h5p/editor/not.a.document.id')
        .set('Authorization', `Bearer ${editor.idToken}`)
        .expect(400);

      expect((response.body as ErrorBody).message).toBe('Validation failed');
    });
  });

  describe('GET params', () => {
    it('answers with the stored metadata and parameters', async () => {
      const response = await contentParameters(exercise.contentId).expect(200);

      const body = response.body as ContentParametersBody;
      expect(body.library).toBe(`${MAIN_LIBRARY.machineName} 1.0`);
      expect(body.h5p.title).toBe(exercise.title);
      expect(body.params.metadata.title).toBe(exercise.title);
      // The fixture's own `content.json`, which is what the widget edits.
      expect(body.params.params['question']).toBe('Have you ever been to Kyiv?');
    });

    it('answers 404 for an exercise nobody stored', async () => {
      // The sentence is the storage adapter's, not `CONTENT_MISSING_MESSAGE`:
      // `getContent` reads `h5p.json`, which is absent, so `H5pContentStorage`
      // raises `content-file-missing`. Recorded as it is rather than reworded
      // by adding an index read to a route that needs none — the save route is
      // where the index is the authority, because there a wrong answer creates
      // content under a caller-supplied id.
      const response = await contentParameters('ffffffffffffffffffffffffffffffff').expect(404);

      expect((response.body as ErrorBody).message).toBe('That file is not part of this exercise.');
    });

    it('answers 400 for a content id no document id could be', async () => {
      await contentParameters('not.a.document.id').expect(400);
    });
  });

  /**
   * The save cases work on an exercise of their own.
   *
   * The `beforeAll` fixture is read by every other describe in this file, and a
   * save rewrites its `content.json` and its index row — so mutating it would
   * make those assertions depend on the order this file happens to run in.
   */
  describe('POST editor', () => {
    let target: H5pSaveResult;

    const rowOf = async (contentId: string): Promise<IndexRow> => {
      const snapshot = await firestore.collection(COLLECTIONS.h5pContent).doc(contentId).get();
      expect(snapshot.exists).toBe(true);
      return snapshot.data() as IndexRow;
    };

    beforeAll(async () => {
      const response = await request(server())
        .post('/api/h5p/content')
        .set('Authorization', `Bearer ${editor.idToken}`)
        .attach('file', await buildH5pPackage({ title: 'The exercise the save cases edit' }), {
          filename: 'drill.h5p',
          contentType: 'application/octet-stream',
        })
        .expect(201);

      target = h5pSaveResultSchema.parse(response.body);
      createdContentIds.push(target.contentId);
    });

    it('round-trips what /params returned, keeping the content id', async () => {
      // Posting back exactly what `/params` handed over is the assertion that
      // the two schemas agree: a 400 or a 500 here means `saveH5pContentSchema`
      // is wrong, not that the test is.
      const read = await contentParameters(target.contentId).expect(200);
      const { library, params } = read.body as ContentParametersBody;

      const saved = await saveContent(
        {
          library,
          params: {
            metadata: { ...params.metadata, title: 'Edited in the widget' },
            params: { ...params.params, question: 'Чи були ви коли-небудь у Києві?' },
          },
        },
        target.contentId,
        // The second editor, so `updatedBy` changing is observable.
        otherEditor.idToken,
      ).expect(200);

      expect((saved.body as H5pSaveResult).contentId).toBe(target.contentId);
      expect((saved.body as H5pSaveResult).title).toBe('Edited in the widget');

      const reread = (await contentParameters(target.contentId).expect(200))
        .body as ContentParametersBody;
      expect(reread.params.params['question']).toBe('Чи були ви коли-небудь у Києві?');
      expect(reread.h5p.title).toBe('Edited in the widget');
    });

    it('bumps the index row’s audit without touching how it was created', async () => {
      const before = await rowOf(target.contentId);
      const read = (await contentParameters(target.contentId).expect(200))
        .body as ContentParametersBody;

      await saveContent(
        {
          library: read.library,
          params: {
            metadata: { ...read.params.metadata, title: 'Saved again' },
            params: read.params.params,
          },
        },
        target.contentId,
        otherEditor.idToken,
      ).expect(200);

      const after = await rowOf(target.contentId);
      // Parsed epoch milliseconds, not string inequality: `touchAudit` has
      // millisecond resolution, and a save round trip through fake-gcs takes
      // tens of them.
      expect(Date.parse(after.audit.updatedAt)).toBeGreaterThan(Date.parse(before.audit.updatedAt));
      expect(after.audit.createdAt).toBe(before.audit.createdAt);
      expect(after.audit.createdBy).toBe(before.audit.createdBy);
      expect(after.audit.updatedBy).toBe(otherEditor.uid);
      expect(after.storagePath).toBe(before.storagePath);
      expect(after.pageId).toBe(before.pageId);
      expect(after.title).toBe('Saved again');
    });

    it('creates a new exercise when no content id is given, leaving the old one alone', async () => {
      const read = (await contentParameters(target.contentId).expect(200))
        .body as ContentParametersBody;
      const before = await rowOf(target.contentId);
      const beforeObjects = await storage.list(`${CONTENT_PREFIX}${target.contentId}/`);

      const created = await saveContent({
        library: read.library,
        params: {
          metadata: { ...read.params.metadata, title: 'A second exercise' },
          params: read.params.params,
        },
      }).expect(201);

      const saved = h5pSaveResultSchema.parse(created.body);
      createdContentIds.push(saved.contentId);
      expect(saved.contentId).not.toBe(target.contentId);

      const row = await rowOf(saved.contentId);
      expect(row.audit.createdAt).toBe(row.audit.updatedAt);
      expect(row.audit.createdBy).toBe(editor.uid);
      expect(row.storagePath).toBe(`${CONTENT_PREFIX}${saved.contentId}`);
      expect(row.pageId).toBeNull();

      // The exercise that was already there is untouched, objects and row.
      const after = await rowOf(target.contentId);
      expect(after.audit.updatedAt).toBe(before.audit.updatedAt);
      expect(
        (await storage.list(`${CONTENT_PREFIX}${target.contentId}/`)).map((o) => o.path),
      ).toEqual(beforeObjects.map((o) => o.path));
    });

    it('makes a temporary file uploaded from inside the editor part of the exercise', async () => {
      const uploaded = await uploadClip();
      expect(uploaded.status).toBe(200);
      const temporaryPath = (uploaded.body as SavedFileBody).path;
      expect(temporaryPath).toMatch(/#tmp$/);

      const read = (await contentParameters(target.contentId).expect(200))
        .body as ContentParametersBody;
      await saveContent(
        {
          library: read.library,
          params: {
            metadata: read.params.metadata,
            params: {
              ...read.params.params,
              // The fixture's `semantics.json` declares `clip` as `type: file`,
              // which is what `ContentFileScanner` walks.
              clip: { path: temporaryPath, mime: 'audio/mpeg', copyright: { license: 'U' } },
            },
          },
        },
        target.contentId,
      ).expect(200);

      const stored = (await contentParameters(target.contentId).expect(200))
        .body as ContentParametersBody;
      const clip = stored.params.params['clip'] as { path: string };
      // The `#tmp` marker is gone: the file belongs to the exercise now.
      expect(clip.path).toBe(temporaryPath.replace(/#tmp$/, ''));

      await expect(
        storage.exists(`${CONTENT_PREFIX}${target.contentId}/${clip.path}`),
      ).resolves.toBe(true);

      // Byte equality, not existence: an empty object would pass a listing
      // check and play back as silence.
      const served = await request(server())
        .get(`/api/h5p/content/${target.contentId}/${clip.path}`)
        .expect(200);
      expect(Buffer.from(served.body as Buffer)).toEqual(CLIP_BYTES);
    });

    it('answers 404 for a content id with no index row, and creates nothing', async () => {
      const orphan = 'ffffffffffffffffffffffffffffffff';
      const read = (await contentParameters(target.contentId).expect(200))
        .body as ContentParametersBody;

      const response = await saveContent(
        { library: read.library, params: read.params },
        orphan,
      ).expect(404);

      expect((response.body as ErrorBody).message).toBe('That exercise does not exist.');
      await expect(storage.exists(`${CONTENT_PREFIX}${orphan}/h5p.json`)).resolves.toBe(false);
    });

    it.each([
      ['no library', { params: { metadata: { title: 'x' }, params: {} } }],
      [
        'no metadata title',
        { library: 'SpeakTest.Main 1.0', params: { metadata: {}, params: {} } },
      ],
      [
        'no parameters at all',
        { library: 'SpeakTest.Main 1.0', params: { metadata: { title: 'x' } } },
      ],
    ])('answers 400 for a body with %s', async (_shape, body) => {
      // Each of these reaches a plain `Error` inside the library — a 500 for a
      // body the client sent.
      await saveContent(body as unknown as SaveBody, target.contentId).expect(400);
    });

    it('answers 404 for a library nobody installed, rather than 500', async () => {
      const read = (await contentParameters(target.contentId).expect(200))
        .body as ContentParametersBody;

      const response = await saveContent(
        { library: 'H5P.NotHere 1.0', params: read.params },
        target.contentId,
      ).expect(404);

      expect((response.body as ErrorBody).message).toBe(
        'That library is not installed on this server.',
      );
    });
  });

  describe('the expiry sweep', () => {
    /**
     * The sweep sees only what this suite wrote.
     *
     * `cleanUp()` enumerates the whole `h5p/temp/` prefix, and a lifetime of
     * zero marks *every* object under it expired — including the scratch files
     * of a session running beside this one, or of one that was interrupted. A
     * test may not reach past its own fixtures on a shared bucket, so what is
     * narrowed is the listing the sweep acts on, and nothing else: the real
     * fake-gcs listing, the `createdAt + temporaryFileLifetime` derivation and
     * the real `deleteFile` all still run underneath.
     *
     * **The rule this passes, for the next test tempted to `vi.spyOn` a live
     * provider: a spy may narrow the input the assertion is made over, and may
     * never narrow the behaviour under test.** A spy that stubbed out
     * `listFiles` — or the derivation inside it — would leave a test that
     * passes whether or not the sweep works, which is the failure this file
     * has already had once.
     */
    const scopeSweepToThisSuite = (): { mockRestore: () => void } => {
      const temporary = app.get(H5pTemporaryStorage);
      const owners = new Set([editor.uid, otherEditor.uid]);
      const listFiles = temporary.listFiles.bind(temporary);

      return vi
        .spyOn(temporary, 'listFiles')
        .mockImplementation(async (user?: IUser): Promise<ITemporaryFile[]> => {
          const files = await listFiles(user);
          return files.filter((file) => owners.has(file.ownedByUserId));
        });
    };

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
      const scope = scopeSweepToThisSuite();
      config.temporaryFileLifetime = lifetimeMs;
      try {
        await app.get<H5PEditor>(H5P_EDITOR).temporaryFileManager.cleanUp();
      } finally {
        config.temporaryFileLifetime = original;
        scope.mockRestore();
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
      { name: 'GET editor', call: (token) => editorModel(undefined, undefined, token) },
      {
        name: 'GET editor/:contentId',
        call: (token) => editorModel(exercise.contentId, undefined, token),
      },
      { name: 'GET params', call: (token) => contentParameters(exercise.contentId, token) },
      {
        name: 'POST editor',
        call: (token) =>
          saveContent(
            {
              library: `${MAIN_LIBRARY.machineName} 1.0`,
              params: { metadata: { title: 'x' }, params: {} },
            },
            undefined,
            token,
          ),
      },
      {
        name: 'POST editor/:contentId',
        call: (token) =>
          saveContent(
            {
              library: `${MAIN_LIBRARY.machineName} 1.0`,
              params: { metadata: { title: 'x' }, params: {} },
            },
            exercise.contentId,
            token,
          ),
      },
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
      ['GET editor', '/api/h5p/editor'],
      ['GET temp-files', '/api/h5p/temp-files/audios/audio-anything.mp3'],
    ])('refuses an unauthenticated caller on %s', async (_name, path) => {
      await request(server()).get(path).expect(401);
    });

    it.each([
      ['POST ajax', '/api/h5p/ajax?action=libraries'],
      ['POST editor', '/api/h5p/editor'],
    ])('refuses an unauthenticated %s', async (_name, path) => {
      await request(server()).post(path).send({}).expect(401);
    });
  });
});
