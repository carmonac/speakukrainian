import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Firestore } from '@google-cloud/firestore';
import type { Auth } from 'firebase-admin/auth';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COLLECTIONS, h5pSaveResultSchema, type H5pSaveResult } from '@speakukrainian/shared';
import { FIRESTORE } from '../src/infra/firestore/firestore.tokens.js';
import { StorageService } from '../src/infra/storage/storage.service.js';
import { authOf, createTestApp, signInAs, type TestUser } from './emulator.js';
import { MAIN_LIBRARY_DIR, MEDIA_FILE, buildH5pPackage } from './fixtures/h5p-package.js';

const CONTENT_PREFIX = 'h5p/content/';

/**
 * The controller's own refusal, and nothing else in the stack says it.
 *
 * Every layer below has a guard of its own — the storage path builders raise
 * their own 400, `send` refuses to leave its root — so a traversal is answered
 * 4xx either way and only the sentence says *which* guard ran. Asserting it is
 * what stops the controller's guard being removed with this suite still green.
 */
const REFUSED_PATH = 'The requested file path is not valid.';

/**
 * 96 KB, deterministic, and nothing like a run of zeroes: a range assertion is
 * only worth making if the bytes of one slice differ from the bytes of every
 * other, and the 35-byte text file the fixture already carries is too small for
 * a range to mean anything at all.
 */
const MEDIA_BYTES = Buffer.from(
  Uint8Array.from({ length: 96 * 1024 }, (_value, index) => (index * 37 + (index >> 8)) % 251),
);

interface PlayerModelBody {
  contentId: string;
  scripts: string[];
  styles: string[];
  dependencies: { machineName: string }[];
  integration: {
    url: string;
    contents: Record<string, unknown>;
    /** The player's own labels — its fullscreen and copyright chrome, not the exercise. */
    l10n: { H5P: Record<string, string> };
  };
}

interface ErrorBody {
  statusCode: number;
  message: string;
}

describe('h5p serving (e2e)', () => {
  let app: INestApplication;
  let auth: Auth;
  let storage: StorageService;
  let firestore: Firestore;
  let editor: TestUser;
  let student: TestUser;
  let exercise: H5pSaveResult;
  /** A second content, so the traversal case has something it could actually leak. */
  let sibling: H5pSaveResult;

  const createdContentIds: string[] = [];

  const server = (): ReturnType<INestApplication['getHttpServer']> => app.getHttpServer();

  const upload = async (bytes: Buffer): Promise<H5pSaveResult> => {
    const response = await request(server())
      .post('/api/h5p/content')
      .set('Authorization', `Bearer ${editor.idToken}`)
      .attach('file', bytes, { filename: 'drill.h5p', contentType: 'application/octet-stream' })
      .expect(201);

    const saved = h5pSaveResultSchema.parse(response.body);
    createdContentIds.push(saved.contentId);
    return saved;
  };

  /**
   * The path an asset URL out of the player model resolves to on this API.
   *
   * `H5P_BASE_URL` may be relative (production, where both are one origin) or
   * absolute (every development machine, where the admin is on another port),
   * so the model carries either shape and only the path is ours to request.
   */
  const apiPathOf = (url: string): string | null => {
    const path = url.startsWith('http') ? new URL(url).pathname + new URL(url).search : url;
    return path.startsWith('/api/h5p/') ? path : null;
  };

  beforeAll(async () => {
    app = await createTestApp();
    auth = authOf(app);
    storage = app.get(StorageService);
    firestore = app.get<Firestore>(FIRESTORE);
    [editor, student] = await Promise.all([signInAs(auth, 'editor'), signInAs(auth, 'student')]);

    exercise = await upload(await buildH5pPackage({ mediaBytes: MEDIA_BYTES }));
    sibling = await upload(await buildH5pPackage({ title: 'The other exercise' }));
  });

  afterAll(async () => {
    if (storage) {
      await Promise.all(
        createdContentIds.map((id) => storage.deleteByPrefix(`${CONTENT_PREFIX}${id}/`)),
      );
    }
    if (firestore) {
      await Promise.all(
        createdContentIds.map((id) =>
          firestore.collection(COLLECTIONS.h5pContent).doc(id).delete(),
        ),
      );
    }
    const created = [editor, student].filter((user) => user !== undefined);
    await Promise.all(created.map((user) => auth.deleteUser(user.uid)));
    if (app) {
      await app.close();
    }
  });

  describe('the player model', () => {
    it('answers with no token at all', async () => {
      const response = await request(server())
        .get(`/api/h5p/play/${exercise.contentId}`)
        .expect(200);

      const model = response.body as PlayerModelBody;
      // The stock renderer returns an HTML string; these four fields are what
      // says the JSON renderer is the one that ran.
      expect(model.contentId).toBe(exercise.contentId);
      expect(model.scripts.length).toBeGreaterThan(0);
      expect(model.styles.length).toBeGreaterThan(0);
      expect(model.dependencies.map((library) => library.machineName)).toContain('SpeakTest.Main');
      expect(model.integration.contents).toHaveProperty(`cid-${exercise.contentId}`);
    });

    it('gives a student exactly the same answer, not a 403', async () => {
      const response = await request(server())
        .get(`/api/h5p/play/${exercise.contentId}`)
        .set('Authorization', `Bearer ${student.idToken}`)
        .expect(200);

      expect((response.body as PlayerModelBody).contentId).toBe(exercise.contentId);
    });

    it('answers 404 for an unknown id without mentioning an import', async () => {
      const response = await request(server()).get(`/api/h5p/play/${randomUUID()}`).expect(404);

      const body = response.body as ErrorBody;
      expect(body.message).toBe('That exercise does not exist.');
      expect(body.message).not.toContain('import');
    });

    it('answers 400 for an id that is not a path-safe atom, without blaming a package', async () => {
      const response = await request(server()).get('/api/h5p/play/not%2Fan%2Fid').expect(400);

      // Nobody uploaded anything: this is a GET with a bad id in the URL.
      expect((response.body as ErrorBody).message).toBe('That path is not valid.');
    });

    it('renders the player chrome in English whatever language is asked for', async () => {
      // The decision ADR-007 records, pinned where it is observable. `H5PPlayer`
      // has no `translationCallback`, and the library ships no Ukrainian client
      // translation to give it, so `?lang` selects nothing today. The day one is
      // wired this is the test that says so.
      const [fallback, ukrainian, spanish] = await Promise.all([
        request(server()).get(`/api/h5p/play/${exercise.contentId}`).expect(200),
        request(server()).get(`/api/h5p/play/${exercise.contentId}?lang=uk`).expect(200),
        request(server()).get(`/api/h5p/play/${exercise.contentId}?lang=es`).expect(200),
      ]);

      const chrome = (response: { body: unknown }): Record<string, string> =>
        (response.body as PlayerModelBody).integration.l10n.H5P;

      expect(chrome(ukrainian)['fullscreen']).toBe('Fullscreen');
      expect(chrome(ukrainian)).toEqual(chrome(fallback));
      expect(chrome(spanish)).toEqual(chrome(fallback));
    });

    it('serves every asset URL it advertises', async () => {
      // The one assertion that ties the configuration to the routes: if
      // `coreUrl`, `librariesUrl` or `baseUrl` and the controller ever disagree,
      // or if the fetch script did not run, one of these is a 404. Every URL
      // rather than a sample, because a wiring mistake affects a whole family.
      const response = await request(server())
        .get(`/api/h5p/play/${exercise.contentId}`)
        .expect(200);
      const model = response.body as PlayerModelBody;

      const paths = [...model.scripts, ...model.styles]
        .map(apiPathOf)
        .filter((path): path is string => path !== null);

      // Otherwise an empty list would pass this test.
      expect(paths.some((path) => path.startsWith('/api/h5p/core/'))).toBe(true);
      expect(paths.some((path) => path.startsWith('/api/h5p/libraries/'))).toBe(true);

      const answers = await Promise.all(
        paths.map(async (path) => [path, (await request(server()).get(path)).status] as const),
      );
      expect(answers.filter(([, status]) => status !== 200)).toEqual([]);
    });
  });

  describe('the client libraries on disk', () => {
    it('serves the H5P core', async () => {
      const response = await request(server()).get('/api/h5p/core/js/h5p.js').expect(200);

      expect(response.headers['content-type']).toMatch(/^(text|application)\/javascript/);
      expect(response.headers['cross-origin-resource-policy']).toBe('cross-origin');
      // An hour, not a year: the cache buster on these URLs is the library's
      // own version, so bumping the pinned commit does not change the URL.
      expect(response.headers['cache-control']).toBe('public, max-age=3600');
      // A stub or an error page would be far smaller than the real file.
      expect(Buffer.byteLength(response.text)).toBeGreaterThan(1024);
    });

    it('serves the H5P editor client from a path that does not collide with the model route', async () => {
      await request(server()).get('/api/h5p/editor-assets/scripts/h5peditor.js').expect(200);
    });

    it('answers 404 for a file that is not in the tree', async () => {
      await request(server()).get('/api/h5p/core/js/nope.js').expect(404);
    });

    it.each([
      ['/api/h5p/core/js/%2e%2e%2f%2e%2e%2fpackage.json'],
      ['/api/h5p/core/js/..%2f..%2fpackage.json'],
      ['/api/h5p/editor-assets/%2e%2e%2fcore%2fjs%2fh5p.js'],
    ])('refuses %s without serving anything from outside the tree', async (path) => {
      const response = await request(server()).get(path);

      expect(response.status).toBe(400);
      expect((response.body as ErrorBody).message).toBe(REFUSED_PATH);
      // The status alone would pass for a 200 carrying the wrong file, which is
      // the failure that actually matters.
      expect(response.text).not.toContain('@speakukrainian/api');
      expect(response.text).not.toContain('"dependencies"');
    });
  });

  describe('content files', () => {
    const mediaUrl = (): string => `/api/h5p/content/${exercise.contentId}/${MEDIA_FILE}`;

    it('streams the whole file and offers ranges', async () => {
      const response = await request(server()).get(mediaUrl()).expect(200);

      expect(response.headers['accept-ranges']).toBe('bytes');
      expect(response.headers['content-length']).toBe(String(MEDIA_BYTES.length));
      expect(response.headers['content-type']).toMatch(/^audio\/mpeg/);
      expect(response.headers['cross-origin-resource-policy']).toBe('cross-origin');
      // Short and private: a re-save replaces this object under the same URL.
      expect(response.headers['cache-control']).toBe('private, max-age=300');
      expect(Buffer.from(response.body as Buffer)).toEqual(MEDIA_BYTES);
    });

    it('answers a byte range with 206 and exactly those bytes', async () => {
      // Comparing the bytes is what says the range reached storage rather than
      // being applied to a fully buffered object: a status-only assertion
      // passes either way.
      const response = await request(server())
        .get(mediaUrl())
        .set('Range', 'bytes=1000-1099')
        .expect(206);

      expect(response.headers['content-range']).toBe(`bytes 1000-1099/${MEDIA_BYTES.length}`);
      expect(response.headers['content-length']).toBe('100');
      expect(response.headers['content-type']).toMatch(/^audio\/mpeg/);
      expect(response.headers['cache-control']).toBe('private, max-age=300');
      expect(Buffer.from(response.body as Buffer)).toEqual(MEDIA_BYTES.subarray(1000, 1100));
    });

    it('answers the open-ended range a media element sends when a learner seeks', async () => {
      const start = MEDIA_BYTES.length - 4096;
      const response = await request(server())
        .get(mediaUrl())
        .set('Range', `bytes=${start}-`)
        .expect(206);

      expect(response.headers['content-range']).toBe(
        `bytes ${start}-${MEDIA_BYTES.length - 1}/${MEDIA_BYTES.length}`,
      );
      expect(Buffer.from(response.body as Buffer)).toEqual(MEDIA_BYTES.subarray(start));
    });

    it('answers 416 for a range past the end of the file, carrying the real size', async () => {
      const response = await request(server())
        .get(mediaUrl())
        .set('Range', `bytes=${MEDIA_BYTES.length + 10}-`)
        .expect(416);

      // RFC 9110 §15.5.17. This is what a media element reads to learn what it
      // should have asked for; without it a seek past the end is a dead end.
      // Asserted on the wire because the header is set inside the H5P
      // endpoint's own call stack and has to survive the exception filter.
      expect(response.headers['content-range']).toBe(`bytes */${MEDIA_BYTES.length}`);
    });

    it('answers without a token, and answers a student the same way', async () => {
      await request(server()).get(mediaUrl()).expect(200);
      await request(server())
        .get(mediaUrl())
        .set('Authorization', `Bearer ${student.idToken}`)
        .expect(200);
    });

    it('answers 404 for a file that is not part of the exercise', async () => {
      const response = await request(server())
        .get(`/api/h5p/content/${exercise.contentId}/media/absent.mp3`)
        .expect(404);

      expect((response.body as ErrorBody).message).toBe('That file is not part of this exercise.');
    });

    it.each([
      ['an encoded separator', (id: string) => `..%2F${id}%2Fh5p.json`],
      ['an encoded dot-dot', (id: string) => `%2e%2e%2f${id}%2fh5p.json`],
      ['two encoded levels', (id: string) => `..%2F..%2Fcontent%2F${id}%2Fh5p.json`],
    ])('refuses a path carrying %s', async (_shape, build) => {
      // Express 5 decodes each wildcard segment before handing it over, so this
      // arrives as `['media', '../<id>/h5p.json']` — one ordinary-looking
      // segment. Only the joined string sees the traversal.
      const response = await request(server()).get(
        `/api/h5p/content/${exercise.contentId}/media/${build(sibling.contentId)}`,
      );

      expect(response.status).toBe(400);
      expect((response.body as ErrorBody).message).toBe(REFUSED_PATH);
      // The sibling's metadata carries its title; a leak would show it.
      expect(response.text).not.toContain('The other exercise');
      expect(response.text).not.toContain('SpeakTest.Main');
    });
  });

  describe('library files', () => {
    it('serves an installed library file with a year of caching', async () => {
      const response = await request(server())
        .get(`/api/h5p/libraries/${MAIN_LIBRARY_DIR}/main.js`)
        .expect(200);

      expect(response.text).toContain('window.SpeakTestMain');
      // Library URLs carry `?version=<major.minor.patch>`, so a patch upgrade
      // changes the URL and a year is safe.
      expect(response.headers['cache-control']).toBe('public, max-age=31536000');
      expect(response.headers['cross-origin-resource-policy']).toBe('cross-origin');
    });

    it('answers without a token', async () => {
      await request(server())
        .get(`/api/h5p/libraries/${MAIN_LIBRARY_DIR}/library.json`)
        .expect(200);
    });

    it('answers 400 for something that is not an ubername', async () => {
      const response = await request(server())
        .get('/api/h5p/libraries/not-a-ubername/x.js')
        .expect(400);

      expect((response.body as ErrorBody).message).toBe('That is not a valid H5P library name.');
    });

    it('refuses a library name that is a traversal without blaming a package', async () => {
      // `..` satisfies the ubername pattern, so this reaches our own path rule.
      // It is still a GET: telling this caller their package contains a file
      // with an unusable path names something they never sent.
      const response = await request(server())
        .get('/api/h5p/libraries/..-1.0/library.json')
        .expect(400);

      expect((response.body as ErrorBody).message).toBe('That path is not valid.');
    });

    it('answers 404 for a file the library does not have', async () => {
      const response = await request(server())
        .get(`/api/h5p/libraries/${MAIN_LIBRARY_DIR}/nope.js`)
        .expect(404);

      expect((response.body as ErrorBody).message).toBe('That file is not part of this library.');
    });

    it('refuses a traversal out of the library prefix', async () => {
      const response = await request(server())
        .get(`/api/h5p/libraries/${MAIN_LIBRARY_DIR}/..%2F..%2Fcontent%2Fh5p.json`)
        .expect(400);

      expect((response.body as ErrorBody).message).toBe(REFUSED_PATH);
    });
  });
});
