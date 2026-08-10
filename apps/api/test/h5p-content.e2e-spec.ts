import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Firestore } from '@google-cloud/firestore';
import type { Auth } from 'firebase-admin/auth';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COLLECTIONS,
  h5pContentSchema,
  h5pSaveResultSchema,
  type H5pContent,
  type H5pSaveResult,
  type Page,
} from '@speakukrainian/shared';
import { FIRESTORE } from '../src/infra/firestore/firestore.tokens.js';
import { StorageService } from '../src/infra/storage/storage.service.js';
import { authOf, createTestApp, signInAs, type TestUser } from './emulator.js';
import { CONTENT_FILE, buildH5pPackage } from './fixtures/h5p-package.js';

const CONTENT_PREFIX = 'h5p/content/';
const LIBRARY_PREFIX = 'h5p/libraries/';

interface ErrorBody {
  statusCode: number;
  message: string;
}

/** One in-flight supertest request, whichever verb built it. */
type SupertestRequest = ReturnType<ReturnType<typeof request>['get']>;

describe('h5p content index (e2e)', () => {
  let app: INestApplication;
  let auth: Auth;
  let storage: StorageService;
  let firestore: Firestore;
  let editor: TestUser;
  let student: TestUser;

  /** Uploaded once in setup and never deleted, so the read cases are stable. */
  let uploads: H5pSaveResult[];

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

  const listAs = async (
    token: string,
    query: string,
  ): Promise<{ status: number; body: Page<H5pContent> }> => {
    const response = await request(server())
      .get(`/api/h5p/content${query}`)
      .set('Authorization', `Bearer ${token}`);

    return { status: response.status, body: response.body as Page<H5pContent> };
  };

  beforeAll(async () => {
    app = await createTestApp();
    auth = authOf(app);
    storage = app.get(StorageService);
    firestore = app.get<Firestore>(FIRESTORE);
    [editor, student] = await Promise.all([signInAs(auth, 'editor'), signInAs(auth, 'student')]);

    // Sequential rather than concurrent: `audit.createdAt` is what the index is
    // ordered by, so the three have to be uploaded in a known order.
    uploads = [];
    for (const title of ['First drill', 'Second drill', 'Third drill']) {
      uploads.push(await upload(await buildH5pPackage({ title })));
    }
  });

  afterAll(async () => {
    // Both halves tolerate an already-deleted target, so the cases that delete
    // their own content need no bookkeeping here.
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

  describe('the index', () => {
    it('pages newest first and walks to the rest with the cursor', async () => {
      // Containment, never equality: the collection carries rows from earlier
      // runs. Newest-first ordering is what keeps these three at the front.
      const first = await listAs(editor.idToken, '?limit=2');
      expect(first.status).toBe(200);
      expect(first.body.items).toHaveLength(2);
      expect(first.body.nextCursor).not.toBeNull();

      const second = await listAs(editor.idToken, `?limit=2&cursor=${first.body.nextCursor}`);
      expect(second.status).toBe(200);

      const walked = [...first.body.items, ...second.body.items].map((content) => content.id);
      expect(new Set(walked).size).toBe(walked.length);
      for (const saved of uploads) {
        expect(walked).toContain(saved.contentId);
      }
      // Newest first: the last upload leads the first page.
      expect(first.body.items[0]?.id).toBe(uploads[2]?.contentId);
    });

    it('answers with documents that satisfy the shared schema', async () => {
      const { body } = await listAs(editor.idToken, '?limit=1');

      expect(() => body.items.map((item) => h5pContentSchema.parse(item))).not.toThrow();
    });

    it('refuses a limit outside the shared bounds', async () => {
      const response = await request(server())
        .get('/api/h5p/content?limit=0')
        .set('Authorization', `Bearer ${editor.idToken}`)
        .expect(400);

      expect((response.body as ErrorBody).message).toContain('Validation failed');
    });
  });

  describe('reading one content', () => {
    it('answers with the index document the upload wrote', async () => {
      const saved = uploads[0];
      const response = await request(server())
        .get(`/api/h5p/content/${saved?.contentId}`)
        .set('Authorization', `Bearer ${editor.idToken}`)
        .expect(200);

      const content = h5pContentSchema.parse(response.body);
      expect(content.id).toBe(saved?.contentId);
      expect(content.title).toBe('First drill');
      expect(content.storagePath).toBe(`${CONTENT_PREFIX}${saved?.contentId}`);
      expect(content.sizeBytes).toBeGreaterThan(0);
      // Nothing populates the back-pointer yet; ADR-007 records why.
      expect(content.pageId).toBeNull();
    });

    it('answers 404 for an id nothing was ever uploaded under', async () => {
      const response = await request(server())
        .get(`/api/h5p/content/${randomUUID()}`)
        .set('Authorization', `Bearer ${editor.idToken}`)
        .expect(404);

      expect((response.body as ErrorBody).message).toBe('That exercise does not exist.');
    });

    it('does not shadow the public content-file route it shares a path with', async () => {
      // `GET content/:id` and the public `GET content/:contentId/*path` both
      // start with `content/`, and `H5pController` is registered first.
      await request(server())
        .get(`/api/h5p/content/${uploads[0]?.contentId}/${CONTENT_FILE}`)
        .expect(200);
    });
  });

  describe('deleting a content', () => {
    it('removes the objects and the document, and closes the public reach', async () => {
      const doomed = await upload(await buildH5pPackage({ title: 'To be deleted' }));

      await request(server())
        .delete(`/api/h5p/content/${doomed.contentId}`)
        .set('Authorization', `Bearer ${editor.idToken}`)
        .expect(204);

      expect(await storage.list(`${CONTENT_PREFIX}${doomed.contentId}/`)).toEqual([]);
      const document = await firestore
        .collection(COLLECTIONS.h5pContent)
        .doc(doomed.contentId)
        .get();
      expect(document.exists).toBe(false);

      await request(server())
        .get(`/api/h5p/content/${doomed.contentId}`)
        .set('Authorization', `Bearer ${editor.idToken}`)
        .expect(404);
      // The point of sweeping the objects first: an old link stops working the
      // moment the delete starts, not when it finishes.
      await request(server()).get(`/api/h5p/play/${doomed.contentId}`).expect(404);
    });

    it('leaves the installed libraries alone, so the same package uploads again', async () => {
      const bytes = await buildH5pPackage({ title: 'Library survivor' });
      const doomed = await upload(bytes);
      const before = (await storage.list(LIBRARY_PREFIX)).map((object) => object.path).sort();
      const directoriesBefore = (await storage.listSubdirectories(LIBRARY_PREFIX)).sort();

      await request(server())
        .delete(`/api/h5p/content/${doomed.contentId}`)
        .set('Authorization', `Bearer ${editor.idToken}`)
        .expect(204);

      expect((await storage.list(LIBRARY_PREFIX)).map((object) => object.path).sort()).toEqual(
        before,
      );
      expect((await storage.listSubdirectories(LIBRARY_PREFIX)).sort()).toEqual(directoriesBefore);

      const again = await upload(bytes);
      expect(again.contentId).not.toBe(doomed.contentId);
      // What this can show is that the delete garbage-collected nothing. What it
      // cannot show is "not reinstalled" as opposed to "reinstalled over the
      // same object names" — the dedupe itself is pinned by the patch-version
      // case in `h5p.e2e-spec.ts`.
      expect((await storage.list(LIBRARY_PREFIX)).map((object) => object.path).sort()).toEqual(
        before,
      );
    });

    it('answers 404 for an unknown id rather than a silent 204', async () => {
      await request(server())
        .delete(`/api/h5p/content/${randomUUID()}`)
        .set('Authorization', `Bearer ${editor.idToken}`)
        .expect(404);
    });

    it('answers the second delete of the same id 404, exactly like one that never existed', async () => {
      const doomed = await upload(await buildH5pPackage({ title: 'Deleted twice' }));

      await request(server())
        .delete(`/api/h5p/content/${doomed.contentId}`)
        .set('Authorization', `Bearer ${editor.idToken}`)
        .expect(204);
      // A 204 here would let a client read "there was something to delete".
      await request(server())
        .delete(`/api/h5p/content/${doomed.contentId}`)
        .set('Authorization', `Bearer ${editor.idToken}`)
        .expect(404);
    });

    it('finishes a delete whose objects an earlier attempt already swept', async () => {
      // The half-completed delete. The document is the sole authority for the
      // 404, so the retry must succeed even though the sweep finds nothing —
      // otherwise the row could never be removed.
      const doomed = await upload(await buildH5pPackage({ title: 'Half swept' }));
      await storage.deleteByPrefix(`${CONTENT_PREFIX}${doomed.contentId}/`);

      await request(server())
        .delete(`/api/h5p/content/${doomed.contentId}`)
        .set('Authorization', `Bearer ${editor.idToken}`)
        .expect(204);

      const document = await firestore
        .collection(COLLECTIONS.h5pContent)
        .doc(doomed.contentId)
        .get();
      expect(document.exists).toBe(false);
    });
  });

  describe('who may call these routes', () => {
    // ADR-007: the absence of any public enumeration is what lets the play and
    // content-file routes stay `@Public()`. These three are the behavioural
    // proof of the guard the route-metadata spec pins per route.
    const routes = (id: string): ['get' | 'delete', string][] => [
      ['get', '/api/h5p/content'],
      ['get', `/api/h5p/content/${id}`],
      ['delete', `/api/h5p/content/${id}`],
    ];

    const call = (method: 'get' | 'delete', path: string): SupertestRequest =>
      method === 'get' ? request(server()).get(path) : request(server()).delete(path);

    it('refuses a student with 403 on all three', async () => {
      for (const [method, path] of routes(uploads[0]?.contentId ?? 'missing')) {
        await call(method, path).set('Authorization', `Bearer ${student.idToken}`).expect(403);
      }
    });

    it('refuses an anonymous caller with 401 on all three', async () => {
      for (const [method, path] of routes(uploads[0]?.contentId ?? 'missing')) {
        await call(method, path).expect(401);
      }
    });

    it('leaves the content it refused to delete in place', async () => {
      // A 403 that had already swept the objects would be worse than useless.
      const saved = uploads[0];
      expect((await storage.list(`${CONTENT_PREFIX}${saved?.contentId}/`)).length).toBeGreaterThan(
        0,
      );
      await request(server())
        .get(`/api/h5p/content/${saved?.contentId}`)
        .set('Authorization', `Bearer ${editor.idToken}`)
        .expect(200);
    });
  });
});
