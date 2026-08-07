import type { INestApplication } from '@nestjs/common';
import type { DocumentReference, Firestore, Transaction } from '@google-cloud/firestore';
import type { Auth } from 'firebase-admin/auth';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  COLLECTIONS,
  contentPageSchema,
  sectionSchema,
  type ContentPage,
  type Page,
  type Section,
} from '@speakukrainian/shared';
import { FIRESTORE } from '../src/infra/firestore/firestore.tokens.js';
import { MAX_TRANSACTION_WRITES } from '../src/sections/sections.repository.js';
import { authOf, createTestApp, signInAs, type TestUser } from './emulator.js';

/**
 * Pages and sections both use Firestore auto-ids, so this suite cannot clean up
 * by a known document id. Every slug it creates starts with `e2e-` instead,
 * which makes every path it creates start with `/e2e-`, and the purge deletes
 * exactly those — from both collections, pages first, or a section delete would
 * be refused by the very check this file tests.
 */
const PREFIX = '/e2e-';

/** Bounds the purge read the way the repository bounds every other read. */
const PURGE_LIMIT = 1000;

/** 20 characters, the shape of a Firestore auto-id, and not one that exists. */
const UNKNOWN_ID = 'zzzz0000zzzz0000zzzz';

interface ErrorBody {
  statusCode: number;
  message: string;
}

/** What both `ZodValidationPipe` and `PagesService.fail` put on the body. */
interface IssueBody {
  message: string;
  errors?: { path: string; message: string }[];
}

const AUDIO =
  '<audio controls preload="metadata" src="https://cdn.test/a.mp3" data-asset-path="audio/2026/01/a.mp3"></audio>';

describe('pages (e2e)', () => {
  let app: INestApplication;
  let auth: Auth;
  let firestore: Firestore;
  let editor: TestUser;
  let student: TestUser;

  const server = (): ReturnType<INestApplication['getHttpServer']> => app.getHttpServer();
  const bearer = (user: TestUser): string => `Bearer ${user.idToken}`;

  const createSection = async (body: Record<string, unknown>): Promise<Section> => {
    const response = await request(server())
      .post('/api/sections')
      .set('Authorization', bearer(editor))
      .send(body)
      .expect(201);
    return sectionSchema.parse(response.body);
  };

  const readSection = async (id: string): Promise<Section> => {
    const response = await request(server())
      .get(`/api/sections/${id}`)
      .set('Authorization', bearer(editor))
      .expect(200);
    return sectionSchema.parse(response.body);
  };

  const renameSection = (id: string, slug: string): request.Test =>
    request(server())
      .patch(`/api/sections/${id}`)
      .set('Authorization', bearer(editor))
      .send({ slug });

  const deleteSection = (id: string): request.Test =>
    request(server()).delete(`/api/sections/${id}`).set('Authorization', bearer(editor));

  const post = (body: object): request.Test =>
    request(server()).post('/api/pages').set('Authorization', bearer(editor)).send(body);

  const create = async (body: Record<string, unknown>): Promise<ContentPage> => {
    const response = await post(body).expect(201);
    return contentPageSchema.parse(response.body);
  };

  const read = async (id: string): Promise<ContentPage> => {
    const response = await request(server())
      .get(`/api/pages/${id}`)
      .set('Authorization', bearer(editor))
      .expect(200);
    return contentPageSchema.parse(response.body);
  };

  const patch = (id: string, body: object): request.Test =>
    request(server()).patch(`/api/pages/${id}`).set('Authorization', bearer(editor)).send(body);

  const publish = (id: string): request.Test =>
    request(server()).post(`/api/pages/${id}/publish`).set('Authorization', bearer(editor));

  const unpublish = (id: string): request.Test =>
    request(server()).post(`/api/pages/${id}/unpublish`).set('Authorization', bearer(editor));

  const remove = (id: string): request.Test =>
    request(server()).delete(`/api/pages/${id}`).set('Authorization', bearer(editor));

  /** Follows the cursor so an assertion about "every page" really sees them all. */
  const listAll = async (query = ''): Promise<ContentPage[]> => {
    const items: ContentPage[] = [];
    let cursor: string | null = null;
    do {
      const suffix: string = cursor ? `${query ? '&' : '?'}cursor=${cursor}` : '';
      const response = await request(server())
        .get(`/api/pages${query}${suffix}`)
        .set('Authorization', bearer(editor))
        .expect(200);
      const page = response.body as Page<ContentPage>;
      items.push(...page.items.map((item) => contentPageSchema.parse(item)));
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  };

  const richText = (html: string): Record<string, unknown> => ({
    type: 'rich_text',
    content: { en: html },
  });

  /**
   * Runs at setup as well as teardown: a run killed before its teardown would
   * otherwise fail the next one on a duplicate root slug.
   */
  const purge = async (): Promise<void> => {
    for (const collection of [COLLECTIONS.pages, COLLECTIONS.sections]) {
      const snapshot = await firestore.collection(collection).limit(PURGE_LIMIT).get();
      const mine = snapshot.docs
        .filter((doc) => String(doc.get('path') ?? '').startsWith(PREFIX))
        // Deepest first, so a section is only deleted once its children are gone.
        .sort((a, b) => String(b.get('path')).length - String(a.get('path')).length);
      for (const doc of mine) {
        await doc.ref.delete();
      }
    }
  };

  beforeAll(async () => {
    app = await createTestApp();
    auth = authOf(app);
    firestore = app.get<Firestore>(FIRESTORE);
    await purge();
    [editor, student] = await Promise.all([signInAs(auth, 'editor'), signInAs(auth, 'student')]);
  });

  // Guarded on what setup actually reached: when `beforeAll` fails, an
  // unguarded teardown throws over the top of it and hides why.
  afterAll(async () => {
    if (app && firestore) {
      await purge();
    }
    const created = [editor, student].filter((user) => user !== undefined);
    await Promise.all(created.map((user) => auth.deleteUser(user.uid)));
    if (app) {
      await app.close();
    }
  });

  it('derives the page path from the owning section', async () => {
    const root = await createSection({
      slug: 'e2e-grammar-points',
      title: { en: 'Grammar points' },
    });
    const section = await createSection({
      parentId: root.id,
      slug: 'e2e-present-simple',
      title: { en: 'Present simple' },
    });

    const page = await create({
      sectionId: section.id,
      slug: 'e2e-intro',
      title: { en: 'Introduction' },
      body: richText('<p>Hi</p>'),
    });

    // Derived from the *owning* section, not from its parent.
    expect(page.path).toBe('/e2e-grammar-points/e2e-present-simple/e2e-intro');
    expect((await read(page.id)).path).toBe('/e2e-grammar-points/e2e-present-simple/e2e-intro');
  });

  it('keeps slugs unique inside a section while allowing the same slug elsewhere', async () => {
    const first = await createSection({ slug: 'e2e-slug-a', title: { en: 'A' } });
    const second = await createSection({ slug: 'e2e-slug-b', title: { en: 'B' } });

    await create({
      sectionId: first.id,
      slug: 'e2e-duplicate',
      title: { en: 'One' },
      body: richText('<p>One</p>'),
    });

    const conflict = await post({
      sectionId: first.id,
      slug: 'e2e-duplicate',
      title: { en: 'Two' },
      body: richText('<p>Two</p>'),
    }).expect(409);
    expect((conflict.body as ErrorBody).message).toContain('e2e-duplicate');

    // The same slug in another section is a different path, so it stands.
    const elsewhere = await create({
      sectionId: second.id,
      slug: 'e2e-duplicate',
      title: { en: 'Elsewhere' },
      body: richText('<p>Elsewhere</p>'),
    });
    expect(elsewhere.path).toBe('/e2e-slug-b/e2e-duplicate');
  });

  it('rewrites every page path under a section that is renamed', async () => {
    const root = await createSection({ slug: 'e2e-rn-root', title: { en: 'Root' } });
    const child = await createSection({
      parentId: root.id,
      slug: 'e2e-rn-child',
      title: { en: 'Child' },
    });
    const grandchild = await createSection({
      parentId: child.id,
      slug: 'e2e-rn-grandchild',
      title: { en: 'Grandchild' },
    });
    // A root whose path is a prefix of nothing but looks close enough to be
    // caught by a naive `startsWith` on the slug rather than on `<path>/`.
    const sibling = await createSection({ slug: 'e2e-rn-rootx', title: { en: 'Sibling' } });

    const own = await create({
      sectionId: root.id,
      slug: 'e2e-rn-own',
      title: { en: 'Own' },
      body: richText('<p>Own</p>'),
    });
    const deep = await create({
      sectionId: grandchild.id,
      slug: 'e2e-rn-deep',
      title: { en: 'Deep' },
      body: richText('<p>Deep</p>'),
    });
    const untouched = await create({
      sectionId: sibling.id,
      slug: 'e2e-rn-untouched',
      title: { en: 'Untouched' },
      body: richText('<p>Untouched</p>'),
    });
    const siblingBefore = await read(untouched.id);
    const ownBefore = await read(own.id);

    await renameSection(root.id, 'e2e-rn-renamed').expect(200);

    // Read them back rather than trusting a response: the criterion is about
    // what Firestore holds after the transaction.
    expect((await readSection(root.id)).path).toBe('/e2e-rn-renamed');
    expect((await read(own.id)).path).toBe('/e2e-rn-renamed/e2e-rn-own');
    expect((await read(deep.id)).path).toBe(
      '/e2e-rn-renamed/e2e-rn-child/e2e-rn-grandchild/e2e-rn-deep',
    );

    // The sibling's page shares a prefix up to `/e2e-rn-root`, and its path must
    // not move: the scan range ends at the separator, not at the slug.
    const after = await read(untouched.id);
    expect(after.path).toBe('/e2e-rn-rootx/e2e-rn-untouched');
    expect(after.audit).toEqual(siblingBefore.audit);

    // A rewritten page did have its public URL changed, which is something an
    // author can see, so it is stamped — unlike a renumbered sibling section.
    const ownAfter = await read(own.id);
    expect(ownAfter.audit.updatedBy).toBe(editor.uid);
    expect(Date.parse(ownAfter.audit.updatedAt)).toBeGreaterThan(
      Date.parse(ownBefore.audit.updatedAt),
    );
    expect(ownAfter.audit.createdAt).toBe(ownBefore.audit.createdAt);
  });

  it('rewrites page paths when a section is re-parented, and not when it is only reordered', async () => {
    const from = await createSection({ slug: 'e2e-mv-from', title: { en: 'From' } });
    const to = await createSection({ slug: 'e2e-mv-to', title: { en: 'To' } });
    const moving = await createSection({
      parentId: from.id,
      slug: 'e2e-mv-moving',
      title: { en: 'Moving' },
    });

    const page = await create({
      sectionId: moving.id,
      slug: 'e2e-mv-page',
      title: { en: 'Page' },
      body: richText('<p>Page</p>'),
    });
    expect(page.path).toBe('/e2e-mv-from/e2e-mv-moving/e2e-mv-page');

    await request(server())
      .patch(`/api/sections/${moving.id}/move`)
      .set('Authorization', bearer(editor))
      .send({ parentId: to.id, sortOrder: 0 })
      .expect(200);

    expect((await read(page.id)).path).toBe('/e2e-mv-to/e2e-mv-moving/e2e-mv-page');

    // A pure reorder changes no path, so it must not stamp the page's audit.
    const before = await read(page.id);
    await request(server())
      .patch(`/api/sections/${moving.id}/move`)
      .set('Authorization', bearer(editor))
      .send({ parentId: to.id, sortOrder: 0 })
      .expect(200);
    const after = await read(page.id);
    expect(after.path).toBe(before.path);
    expect(after.audit).toEqual(before.audit);
  });

  it('leaves the section and its pages untouched when the page rewrite fails mid-way', async () => {
    const section = await createSection({ slug: 'e2e-atomic-section', title: { en: 'Section' } });
    const page = await create({
      sectionId: section.id,
      slug: 'e2e-atomic-page',
      title: { en: 'Page' },
      body: richText('<p>Page</p>'),
    });

    const runReal = firestore.runTransaction.bind(firestore);
    // The only honest seam is the Transaction object itself: Firestore stages
    // writes and sends them at commit, so a throw part-way through the body is
    // exactly the partial failure this criterion is about. The section is
    // written with `set` and the pages with `update`, so failing the first
    // `update` fails *after* the section write has been staged — which is the
    // state a second, separate write would leave behind for real.
    const spy = vi.spyOn(firestore, 'runTransaction').mockImplementation(((
      updateFn: (tx: Transaction) => Promise<unknown>,
    ) =>
      runReal(async (tx) => {
        const faulty = new Proxy(tx, {
          get(target, prop, receiver) {
            if (prop === 'update') {
              return (): Transaction => {
                throw new Error('induced failure');
              };
            }
            const value = Reflect.get(target, prop, receiver) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        return updateFn(faulty);
      })) as typeof firestore.runTransaction);

    try {
      await renameSection(section.id, 'e2e-atomic-renamed').expect(500);
    } finally {
      // Without this every later test runs against a transaction that throws
      // on its first update.
      spy.mockRestore();
    }

    // The section write was staged before the page rewrite threw. If the two
    // were separate commits, this is where the section would have moved and
    // left the page's URL pointing nowhere.
    expect((await readSection(section.id)).path).toBe('/e2e-atomic-section');
    expect((await readSection(section.id)).slug).toBe('e2e-atomic-section');
    expect((await read(page.id)).path).toBe('/e2e-atomic-section/e2e-atomic-page');
  });

  it('refuses to delete a section that still holds pages', async () => {
    const section = await createSection({ slug: 'e2e-del-section', title: { en: 'Section' } });
    const page = await create({
      sectionId: section.id,
      slug: 'e2e-del-page',
      title: { en: 'Page' },
      body: richText('<p>Page</p>'),
    });

    await deleteSection(section.id).expect(409);

    // Nothing is orphaned: both documents are still there.
    await expect(read(page.id)).resolves.toMatchObject({ id: page.id });
    await expect(readSection(section.id)).resolves.toMatchObject({ id: section.id });

    await remove(page.id).expect(204);
    await deleteSection(section.id).expect(204);
  });

  it('refuses a page under a link section', async () => {
    const link = await createSection({
      slug: 'e2e-link-section',
      title: { en: 'Link' },
      kind: 'link',
      link: { type: 'external', href: 'https://example.com' },
    });

    const response = await post({
      sectionId: link.id,
      slug: 'e2e-link-page',
      title: { en: 'Page' },
      body: richText('<p>Page</p>'),
    }).expect(422);
    expect((response.body as ErrorBody).message).toContain('link section');

    await expect(listAll(`?sectionId=${link.id}`)).resolves.toEqual([]);
  });

  it('refuses a body carrying a field that belongs to another variant', async () => {
    const section = await createSection({ slug: 'e2e-strict-section', title: { en: 'Strict' } });

    const listWithContent = await post({
      sectionId: section.id,
      slug: 'e2e-strict-a',
      title: { en: 'A' },
      body: { type: 'subsection_list', content: { en: '<p>x</p>' } },
    }).expect(400);
    // Silently dropping the key would answer 201 for a save that stored none of
    // what it was sent.
    expect((listWithContent.body as IssueBody).errors?.[0]?.path).toBe('body');

    await post({
      sectionId: section.id,
      slug: 'e2e-strict-b',
      title: { en: 'B' },
      body: { type: 'rich_text', content: { en: '<p>x</p>' }, h5pContentId: 'h5p-1' },
    }).expect(400);

    await expect(listAll(`?sectionId=${section.id}`)).resolves.toEqual([]);
  });

  it('refuses to publish an H5P page with no content and stamps publishedAt once it has some', async () => {
    const section = await createSection({ slug: 'e2e-h5p-section', title: { en: 'H5P' } });
    const page = await create({
      sectionId: section.id,
      slug: 'e2e-h5p-page',
      title: { en: 'Exercise' },
      body: { type: 'h5p_exercise' },
    });
    expect(page.publishedAt).toBeNull();

    const refused = await publish(page.id).expect(422);
    const issue = (refused.body as IssueBody).errors?.[0];
    expect(issue?.path).toBe('body.h5pContentId');
    expect(issue?.message).toContain('H5P content');

    // The refusal has to be a refusal: a page left published with an empty
    // exercise renders a blank frame to learners.
    const stillDraft = await read(page.id);
    expect(stillDraft.status).toBe('draft');
    expect(stillDraft.publishedAt).toBeNull();

    await patch(page.id, { body: { type: 'h5p_exercise', h5pContentId: 'h5p-42' } }).expect(200);
    const published = contentPageSchema.parse((await publish(page.id).expect(200)).body);
    expect(published.status).toBe('published');
    expect(published.publishedAt).not.toBeNull();

    const stamp = published.publishedAt;
    const unpublished = contentPageSchema.parse((await unpublish(page.id).expect(200)).body);
    expect(unpublished.status).toBe('draft');
    // The public site shows this as the article date, so a draft-and-republish
    // cycle must not renumber the site's chronology.
    expect(unpublished.publishedAt).toBe(stamp);

    const republished = contentPageSchema.parse((await publish(page.id).expect(200)).body);
    expect(republished.publishedAt).toBe(stamp);
    expect((await read(page.id)).publishedAt).toBe(stamp);
  });

  it('strips a script from a body posted straight at the API and keeps the audio node', async () => {
    const section = await createSection({ slug: 'e2e-sanitize-section', title: { en: 'San' } });

    const page = await create({
      sectionId: section.id,
      slug: 'e2e-sanitize-page',
      title: { en: 'Tom & Jerry' },
      body: richText(`<p>ok</p><script>alert(1)</script>${AUDIO}`),
    });

    // Re-read so the assertion is about what Firestore holds, not what the
    // controller happened to echo.
    const stored = await read(page.id);
    const content = stored.body.type === 'rich_text' ? (stored.body.content['en'] ?? '') : '';

    expect(content).not.toContain('<script');
    expect(content).not.toContain('alert(1)');
    expect(content).toContain('<p>ok</p>');
    expect(content).toContain('src="https://cdn.test/a.mp3"');
    expect(content).toContain('data-asset-path="audio/2026/01/a.mp3"');
    expect(content).toContain('controls');
    expect(content).toContain('preload="metadata"');

    // `title` is plain localized text; sanitizing it would store the escape.
    expect(stored.title).toEqual({ en: 'Tom & Jerry' });
  });

  it('rewrites the path on a slug change and refuses a slug the section already uses', async () => {
    const section = await createSection({ slug: 'e2e-reslug-section', title: { en: 'Section' } });
    const page = await create({
      sectionId: section.id,
      slug: 'e2e-reslug-a',
      title: { en: 'A' },
      body: richText('<p>A</p>'),
    });
    await create({
      sectionId: section.id,
      slug: 'e2e-reslug-b',
      title: { en: 'B' },
      body: richText('<p>B</p>'),
    });

    await patch(page.id, { slug: 'e2e-reslug-renamed' }).expect(200);
    expect((await read(page.id)).path).toBe('/e2e-reslug-section/e2e-reslug-renamed');

    await patch(page.id, { slug: 'e2e-reslug-b' }).expect(409);
    expect((await read(page.id)).slug).toBe('e2e-reslug-renamed');
  });

  it('leaves the fields a patch does not carry exactly as they were', async () => {
    const section = await createSection({ slug: 'e2e-keep-section', title: { en: 'Section' } });
    const page = await create({
      sectionId: section.id,
      slug: 'e2e-keep-page',
      title: { en: 'Page' },
      body: richText('<p>Body</p>'),
      status: 'published',
    });
    expect(page.status).toBe('published');

    await patch(page.id, { title: { en: 'Renamed' } }).expect(200);

    // A title fix must not take the page off the public site or wipe its body.
    const renamed = await read(page.id);
    expect(renamed.title).toEqual({ en: 'Renamed' });
    expect(renamed.status).toBe('published');
    expect(renamed.body).toMatchObject({ type: 'rich_text', content: { en: '<p>Body</p>' } });
    expect(renamed.publishedAt).toBe(page.publishedAt);
  });

  it('filters the list by section, status and type and pages with a cursor', async () => {
    const section = await createSection({ slug: 'e2e-filter-section', title: { en: 'Filter' } });
    const draft = await create({
      sectionId: section.id,
      slug: 'e2e-filter-draft',
      title: { en: 'Draft' },
      body: richText('<p>Draft</p>'),
    });
    const published = await create({
      sectionId: section.id,
      slug: 'e2e-filter-published',
      title: { en: 'Published' },
      body: richText('<p>Published</p>'),
      status: 'published',
    });
    const list = await create({
      sectionId: section.id,
      slug: 'e2e-filter-list',
      title: { en: 'List' },
      body: { type: 'subsection_list' },
    });

    const inSection = await listAll(`?sectionId=${section.id}`);
    expect(inSection.map((item) => item.id)).toEqual([draft.id, published.id, list.id]);

    const publishedOnly = await listAll(`?sectionId=${section.id}&status=published`);
    expect(publishedOnly.map((item) => item.id)).toEqual([published.id]);

    const listsOnly = await listAll(`?sectionId=${section.id}&type=subsection_list`);
    expect(listsOnly.map((item) => item.id)).toEqual([list.id]);

    const allThree = await listAll(`?sectionId=${section.id}&status=draft&type=subsection_list`);
    expect(allThree.map((item) => item.id)).toEqual([list.id]);

    const firstPage = await request(server())
      .get(`/api/pages?sectionId=${section.id}&limit=1`)
      .set('Authorization', bearer(editor))
      .expect(200);
    const page = firstPage.body as Page<ContentPage>;
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.id).toBe(draft.id);
    expect(page.nextCursor).toBe(draft.id);

    const secondPage = await request(server())
      .get(`/api/pages?sectionId=${section.id}&limit=1&cursor=${page.nextCursor ?? ''}`)
      .set('Authorization', bearer(editor))
      .expect(200);
    expect((secondPage.body as Page<ContentPage>).items[0]?.id).toBe(published.id);
  });

  it('refuses every route to an anonymous caller and every route to a student', async () => {
    const body = { sectionId: UNKNOWN_ID, slug: 'e2e-no', title: { en: 'No' }, body: richText('') };

    await request(server()).get('/api/pages').expect(401);
    await request(server()).get(`/api/pages/${UNKNOWN_ID}`).expect(401);
    await request(server()).post('/api/pages').send(body).expect(401);
    await request(server()).patch(`/api/pages/${UNKNOWN_ID}`).send({}).expect(401);
    await request(server()).post(`/api/pages/${UNKNOWN_ID}/publish`).expect(401);
    await request(server()).post(`/api/pages/${UNKNOWN_ID}/unpublish`).expect(401);
    await request(server()).delete(`/api/pages/${UNKNOWN_ID}`).expect(401);

    const asStudent = (test: request.Test): request.Test =>
      test.set('Authorization', bearer(student));
    await asStudent(request(server()).get('/api/pages')).expect(403);
    await asStudent(request(server()).get(`/api/pages/${UNKNOWN_ID}`)).expect(403);
    await asStudent(request(server()).post('/api/pages').send(body)).expect(403);
    await asStudent(request(server()).patch(`/api/pages/${UNKNOWN_ID}`).send({})).expect(403);
    await asStudent(request(server()).post(`/api/pages/${UNKNOWN_ID}/publish`)).expect(403);
    await asStudent(request(server()).post(`/api/pages/${UNKNOWN_ID}/unpublish`)).expect(403);
    await asStudent(request(server()).delete(`/api/pages/${UNKNOWN_ID}`)).expect(403);
  });

  it('answers 404 for an unknown page and for a create under an unknown section', async () => {
    await request(server())
      .get(`/api/pages/${UNKNOWN_ID}`)
      .set('Authorization', bearer(editor))
      .expect(404);
    await patch(UNKNOWN_ID, { title: { en: 'Nope' } }).expect(404);
    await publish(UNKNOWN_ID).expect(404);
    await unpublish(UNKNOWN_ID).expect(404);
    await remove(UNKNOWN_ID).expect(404);

    // The section is the thing that is missing, so this is a 404 and not a 422.
    const response = await post({
      sectionId: UNKNOWN_ID,
      slug: 'e2e-orphan',
      title: { en: 'Orphan' },
      body: richText('<p>Orphan</p>'),
    }).expect(404);
    expect((response.body as ErrorBody).message).toContain(UNKNOWN_ID);
  });

  it('refuses a rename or a move that would rewrite more pages than one transaction commits', async () => {
    const section = await createSection({ slug: 'e2e-budget-section', title: { en: 'Budget' } });
    const seed = await create({
      sectionId: section.id,
      slug: 'e2e-budget-0',
      title: { en: 'Page 0' },
      body: richText('<p>0</p>'),
    });

    // The rest of the pages are written straight to Firestore, from the
    // document the route just wrote so the shape is exactly what the repository
    // reads back. The branch under test is about how *many* pages sit under the
    // section, and MAX_TRANSACTION_WRITES round trips through the route would
    // buy nothing but minutes.
    const collection = firestore.collection(COLLECTIONS.pages);
    const template = (await collection.doc(seed.id).get()).data()!;
    const filler: DocumentReference[] = [];
    let batch = firestore.batch();
    for (let index = 1; index <= MAX_TRANSACTION_WRITES; index += 1) {
      const ref = collection.doc();
      filler.push(ref);
      batch.set(ref, {
        ...template,
        slug: `e2e-budget-${index}`,
        path: `${section.path}/e2e-budget-${index}`,
        sortOrder: index,
      });
      if (filler.length % 400 === 0) {
        await batch.commit();
        batch = firestore.batch();
      }
    }
    await batch.commit();

    try {
      const refused = await renameSection(section.id, 'e2e-budget-renamed').expect(422);
      expect((refused.body as ErrorBody).message).toContain('the pages under it');

      // Refused outright rather than half committed: a rename that rewrote the
      // section and only some of its pages is a set of broken public URLs.
      expect((await readSection(section.id)).path).toBe('/e2e-budget-section');
      expect((await read(seed.id)).path).toBe('/e2e-budget-section/e2e-budget-0');

      // A move spends its budget on its own arithmetic — the subtree and the
      // renumbered destination siblings come out of the same 500 writes — and
      // guards the scan behind `reparented`, so the rename above proves nothing
      // about this branch.
      const target = await createSection({ slug: 'e2e-budget-target', title: { en: 'Target' } });
      const refusedMove = await request(server())
        .patch(`/api/sections/${section.id}/move`)
        .set('Authorization', bearer(editor))
        .send({ parentId: target.id, sortOrder: 0 })
        .expect(422);
      expect((refusedMove.body as ErrorBody).message).toContain('the pages under it');

      const unmoved = await readSection(section.id);
      expect(unmoved.parentId).toBeNull();
      expect(unmoved.path).toBe('/e2e-budget-section');
      expect((await read(seed.id)).path).toBe('/e2e-budget-section/e2e-budget-0');
    } finally {
      // The teardown purge reads one bounded page, and these would crowd out
      // the documents every other test in this file left behind.
      for (let from = 0; from < filler.length; from += 400) {
        const cleanup = firestore.batch();
        for (const ref of filler.slice(from, from + 400)) {
          cleanup.delete(ref);
        }
        await cleanup.commit();
      }
    }
  });
});
