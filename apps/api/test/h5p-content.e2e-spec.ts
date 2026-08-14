import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Firestore } from '@google-cloud/firestore';
import type { Auth } from 'firebase-admin/auth';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COLLECTIONS,
  contentPageSchema,
  h5pContentSchema,
  h5pSaveResultSchema,
  sectionSchema,
  type ContentPage,
  type H5pContent,
  type H5pSaveResult,
  type Page,
  type Section,
} from '@speakukrainian/shared';
import { FIRESTORE } from '../src/infra/firestore/firestore.tokens.js';
import { StorageService } from '../src/infra/storage/storage.service.js';
import { authOf, createTestApp, signInAs, type TestUser } from './emulator.js';
import { CONTENT_FILE, buildH5pPackage } from './fixtures/h5p-package.js';

const CONTENT_PREFIX = 'h5p/content/';
const LIBRARY_PREFIX = 'h5p/libraries/';

/** 20 characters, the shape of a Firestore auto-id, and not one that exists. */
const UNKNOWN_PAGE_ID = 'zzzz0000zzzz0000zzzz';

interface ErrorBody {
  statusCode: number;
  message: string;
}

/**
 * The stored index row, read through the admin SDK rather than through the API.
 * Derived from the schema rather than restated, so a field added to
 * `h5pContentSchema` is a field these assertions can reach; `id` is the document
 * id and so is not inside the document.
 */
type IndexRow = Omit<H5pContent, 'id'>;

/** What `GET /api/h5p/params/:contentId` answers with, and what a save posts back. */
interface ContentParametersBody {
  library: string;
  params: { metadata: { title: string }; params: Record<string, unknown> };
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

  /**
   * A section and two pages under it: one to attach exercises to, one deleted
   * mid-suite so the "a stale `pageId` is normal" case has a page that really
   * stopped existing.
   */
  let section: Section;
  let page: ContentPage;
  let doomedPage: ContentPage;

  const createdContentIds: string[] = [];

  /**
   * Every page this file creates, including the ones a case creates for itself.
   * A case that fails between creating a page and deleting it would otherwise
   * orphan it under a section this teardown then cannot remove.
   */
  const createdPageIds: string[] = [];

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
   * Each installed library object as `path@timeCreated`. The timestamp is what
   * makes "untouched" distinguishable from "written again over the same names":
   * an overwrite is a new object, and gets a new creation time.
   */
  const libraryObjects = async (): Promise<string[]> =>
    (await storage.list(LIBRARY_PREFIX))
      .map((object) => `${object.path}@${object.createdAt.toISOString()}`)
      .sort();

  const attach = (contentId: string, body: object, token = editor.idToken): SupertestRequest =>
    request(server())
      .post(`/api/h5p/content/${contentId}/attach`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const detach = (contentId: string, token = editor.idToken): SupertestRequest =>
    request(server())
      .post(`/api/h5p/content/${contentId}/detach`)
      .set('Authorization', `Bearer ${token}`);

  /** The stored row, so an assertion is about Firestore and not about a response. */
  const rowOf = async (contentId: string): Promise<IndexRow> => {
    const document = await firestore.collection(COLLECTIONS.h5pContent).doc(contentId).get();
    if (!document.exists) {
      throw new Error(`no index row for ${contentId}`);
    }
    return document.data() as unknown as IndexRow;
  };

  const readContent = async (contentId: string): Promise<H5pContent> => {
    const response = await request(server())
      .get(`/api/h5p/content/${contentId}`)
      .set('Authorization', `Bearer ${editor.idToken}`)
      .expect(200);
    return h5pContentSchema.parse(response.body);
  };

  const createPage = async (slug: string, title: string): Promise<ContentPage> => {
    const response = await request(server())
      .post('/api/pages')
      .set('Authorization', `Bearer ${editor.idToken}`)
      .send({
        sectionId: section.id,
        slug,
        title: { en: title },
        body: { type: 'rich_text', content: { en: `<p>${title}</p>` } },
      })
      .expect(201);
    const created = contentPageSchema.parse(response.body);
    createdPageIds.push(created.id);
    return created;
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

    // The slugs start with `e2e-`, so the pages suite's own purge is a backstop
    // if this file's teardown never runs — it deletes documents in both
    // collections whose `path` starts with `/e2e-`. `fileParallelism: false`
    // means the two suites never overlap.
    const unique = randomUUID().slice(0, 8);
    const sectionResponse = await request(server())
      .post('/api/sections')
      .set('Authorization', `Bearer ${editor.idToken}`)
      .send({ slug: `e2e-h5p-attach-${unique}`, title: { en: 'H5P attach' } })
      .expect(201);
    section = sectionSchema.parse(sectionResponse.body);
    page = await createPage(`e2e-lesson-${unique}`, 'The lesson');
    doomedPage = await createPage(`e2e-doomed-${unique}`, 'To be deleted');
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
      // Pages first: a section delete is refused while it still holds pages. A
      // page a case already deleted through the API deletes again harmlessly.
      for (const pageId of createdPageIds) {
        await firestore.collection(COLLECTIONS.pages).doc(pageId).delete();
      }
      if (section) {
        await firestore.collection(COLLECTIONS.sections).doc(section.id).delete();
      }
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
      // An upload attaches nothing: the back-reference is written only by the
      // attach route, which nothing has called for this exercise.
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

  describe('attaching an exercise to a page', () => {
    it('writes the page onto the index row, and the API and Firestore agree', async () => {
      const saved = await upload(await buildH5pPackage({ title: 'Attached drill' }));

      const response = await attach(saved.contentId, { pageId: page.id }).expect(200);

      expect(h5pContentSchema.parse(response.body).pageId).toBe(page.id);
      expect((await readContent(saved.contentId)).pageId).toBe(page.id);
      expect((await rowOf(saved.contentId)).pageId).toBe(page.id);
    });

    it('detaches, leaving the row in place with everything else untouched', async () => {
      const saved = await upload(await buildH5pPackage({ title: 'Detached drill' }));
      const before = await rowOf(saved.contentId);
      await attach(saved.contentId, { pageId: page.id }).expect(200);

      const response = await detach(saved.contentId).expect(200);

      expect(h5pContentSchema.parse(response.body).pageId).toBeNull();
      const after = await rowOf(saved.contentId);
      expect(after.pageId).toBeNull();
      expect(after.title).toBe(before.title);
      expect(after.storagePath).toBe(before.storagePath);
      expect(after.sizeBytes).toBe(before.sizeBytes);
      expect(after.audit.createdAt).toBe(before.audit.createdAt);
      expect(after.audit.createdBy).toBe(before.audit.createdBy);
    });

    it('keeps a non-null pageId across a save through the editor', async () => {
      // #52's invariant, and the first time it can be asserted honestly: before
      // this issue nothing could set `pageId`, so the equivalent case in
      // `h5p-editor.e2e-spec.ts` compares `null` with `null`. It lives here
      // rather than beside the save because the page fixture belongs to one
      // file.
      const saved = await upload(await buildH5pPackage({ title: 'Saved while attached' }));
      await attach(saved.contentId, { pageId: page.id }).expect(200);

      const read = (
        await request(server())
          .get(`/api/h5p/params/${saved.contentId}`)
          .set('Authorization', `Bearer ${editor.idToken}`)
          .expect(200)
      ).body as ContentParametersBody;

      await request(server())
        .post(`/api/h5p/editor/${saved.contentId}`)
        .set('Authorization', `Bearer ${editor.idToken}`)
        .send({
          library: read.library,
          params: {
            metadata: { ...read.params.metadata, title: 'Renamed by the widget' },
            params: read.params.params,
          },
        })
        .expect(200);

      const after = await rowOf(saved.contentId);
      expect(after.title).toBe('Renamed by the widget');
      expect(after.pageId).toBe(page.id);
    });

    it('refuses a page that does not exist, and writes nothing', async () => {
      const saved = await upload(await buildH5pPackage({ title: 'Bad page drill' }));

      const response = await attach(saved.contentId, { pageId: UNKNOWN_PAGE_ID }).expect(404);

      expect((response.body as ErrorBody).message).toBe('That page does not exist.');
      expect((await rowOf(saved.contentId)).pageId).toBeNull();
    });

    it('refuses to move an exercise that is already attached, naming the page it is on', async () => {
      const saved = await upload(await buildH5pPackage({ title: 'Already attached drill' }));
      await attach(saved.contentId, { pageId: page.id }).expect(200);

      const response = await attach(saved.contentId, { pageId: doomedPage.id }).expect(409);

      expect((response.body as ErrorBody).message).toContain(page.id);
      expect((response.body as ErrorBody).message).toContain('Detach it first.');
      expect((await rowOf(saved.contentId)).pageId).toBe(page.id);
    });

    it('writes nothing when the exercise is already on the page asked for', async () => {
      // A retry after a dropped response is ordinary on this route, and it must
      // not read as a fresh edit.
      const saved = await upload(await buildH5pPackage({ title: 'Retried drill' }));
      await attach(saved.contentId, { pageId: page.id }).expect(200);
      const before = await rowOf(saved.contentId);

      await attach(saved.contentId, { pageId: page.id }).expect(200);

      const after = await rowOf(saved.contentId);
      expect(after.audit.updatedAt).toBe(before.audit.updatedAt);
      expect(after.audit.updatedBy).toBe(before.audit.updatedBy);
    });

    it('refuses a body that also names another field of the row, and changes nothing', async () => {
      const saved = await upload(await buildH5pPackage({ title: 'Guarded drill' }));
      const before = await rowOf(saved.contentId);

      await attach(saved.contentId, {
        pageId: page.id,
        title: 'hacked',
        storagePath: 'h5p/content/elsewhere',
        sizeBytes: 1,
      }).expect(400);

      const after = await rowOf(saved.contentId);
      expect(after.title).toBe(before.title);
      expect(after.storagePath).toBe(before.storagePath);
      expect(after.sizeBytes).toBe(before.sizeBytes);
      expect(after.pageId).toBeNull();
    });

    it('keeps naming a page that has been deleted, and detaches from it anyway', async () => {
      // The divergence ADR-007 records, as a test rather than as prose: there is
      // no cascade, so a stale `pageId` is a normal and permanent state — and
      // `Detach it first.` has to work against a page that is gone.
      const saved = await upload(await buildH5pPackage({ title: 'Orphaned drill' }));
      const throwaway = await createPage(`e2e-throwaway-${randomUUID().slice(0, 8)}`, 'Throwaway');
      await attach(saved.contentId, { pageId: throwaway.id }).expect(200);

      await request(server())
        .delete(`/api/pages/${throwaway.id}`)
        .set('Authorization', `Bearer ${editor.idToken}`)
        .expect(204);

      expect((await readContent(saved.contentId)).pageId).toBe(throwaway.id);

      const response = await detach(saved.contentId).expect(200);
      expect(h5pContentSchema.parse(response.body).pageId).toBeNull();
    });

    it('answers 404 for an exercise nothing was ever uploaded under', async () => {
      const unknown = randomUUID();

      const attachFailure = await attach(unknown, { pageId: page.id }).expect(404);
      const detachFailure = await detach(unknown).expect(404);

      expect((attachFailure.body as ErrorBody).message).toBe('That exercise does not exist.');
      expect((detachFailure.body as ErrorBody).message).toBe('That exercise does not exist.');
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
      const before = await libraryObjects();
      const directoriesBefore = (await storage.listSubdirectories(LIBRARY_PREFIX)).sort();

      await request(server())
        .delete(`/api/h5p/content/${doomed.contentId}`)
        .set('Authorization', `Bearer ${editor.idToken}`)
        .expect(204);

      expect(await libraryObjects()).toEqual(before);
      expect((await storage.listSubdirectories(LIBRARY_PREFIX)).sort()).toEqual(directoriesBefore);

      const again = await upload(bytes);
      expect(again.contentId).not.toBe(doomed.contentId);
      expect(await libraryObjects()).toEqual(before);
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

    it('removes a row whose stored document no longer satisfies the schema', async () => {
      // Hand-written, because the API cannot produce it: a seed script or a
      // console edit can, and this route is the only way to repair it. The
      // read routes still refuse it — parse-on-read is what keeps a wrong
      // shape out of a response — so the delete is the whole repair path.
      const corruptId = randomUUID();
      createdContentIds.push(corruptId);
      await storage.put(`${CONTENT_PREFIX}${corruptId}/h5p.json`, Buffer.from('{}'));
      await firestore
        .collection(COLLECTIONS.h5pContent)
        .doc(corruptId)
        .set({
          title: 'Corrupted by hand',
          mainLibrary: 'SpeakTest.Main 1.0',
          storagePath: `${CONTENT_PREFIX}${corruptId}`,
          sizeBytes: 'not-a-number',
          pageId: null,
          audit: {
            createdAt: '2026-05-01T00:00:00.000Z',
            createdBy: 'editor-1',
            updatedAt: '2026-05-01T00:00:00.000Z',
            updatedBy: 'editor-1',
          },
        });

      await request(server())
        .delete(`/api/h5p/content/${corruptId}`)
        .set('Authorization', `Bearer ${editor.idToken}`)
        .expect(204);

      expect(await storage.list(`${CONTENT_PREFIX}${corruptId}/`)).toEqual([]);
      const document = await firestore.collection(COLLECTIONS.h5pContent).doc(corruptId).get();
      expect(document.exists).toBe(false);
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
    type Method = 'get' | 'post' | 'delete';

    const routes = (id: string): [Method, string][] => [
      ['get', '/api/h5p/content'],
      ['get', `/api/h5p/content/${id}`],
      ['delete', `/api/h5p/content/${id}`],
      ['post', `/api/h5p/content/${id}/attach`],
      ['post', `/api/h5p/content/${id}/detach`],
    ];

    const call = (method: Method, path: string): SupertestRequest =>
      method === 'get'
        ? request(server()).get(path)
        : method === 'post'
          ? request(server()).post(path)
          : request(server()).delete(path);

    it('refuses a student with 403 on all five', async () => {
      for (const [method, path] of routes(uploads[0]?.contentId ?? 'missing')) {
        await call(method, path).set('Authorization', `Bearer ${student.idToken}`).expect(403);
      }
    });

    it('refuses an anonymous caller with 401 on all five', async () => {
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
