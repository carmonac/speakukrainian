import type { INestApplication } from '@nestjs/common';
import type {
  DocumentData,
  DocumentReference,
  Firestore,
  Transaction,
} from '@google-cloud/firestore';
import type { Auth } from 'firebase-admin/auth';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  COLLECTIONS,
  MAX_SECTION_DEPTH,
  sectionSchema,
  type Page,
  type Section,
  type SectionTreeNode,
} from '@speakukrainian/shared';
import { FIRESTORE } from '../src/infra/firestore/firestore.tokens.js';
import { MAX_TREE_SECTIONS } from '../src/sections/sections.repository.js';
import { authOf, createTestApp, signInAs, type TestUser } from './emulator.js';

/**
 * Sections use Firestore auto-ids, so this suite cannot clean up by a known
 * document id the way the locales suite does. Every slug it creates starts with
 * `e2e-` instead, which makes every path it creates start with `/e2e-`, and the
 * purge deletes exactly those.
 */
const PREFIX = '/e2e-';

/** 20 characters, the shape of a Firestore auto-id, and not one that exists. */
const UNKNOWN_ID = 'zzzz0000zzzz0000zzzz';

interface ErrorBody {
  statusCode: number;
  message: string;
}

/** The nesting shape both `GET /tree` and a hand walk of `parentId` reduce to. */
interface Nesting {
  id: string;
  children: Nesting[];
}

describe('sections (e2e)', () => {
  let app: INestApplication;
  let auth: Auth;
  let firestore: Firestore;
  let editor: TestUser;
  let student: TestUser;

  const server = (): ReturnType<INestApplication['getHttpServer']> => app.getHttpServer();
  const bearer = (user: TestUser): string => `Bearer ${user.idToken}`;

  const post = (body: object): request.Test =>
    request(server()).post('/api/sections').set('Authorization', bearer(editor)).send(body);

  const create = async (body: Record<string, unknown>): Promise<Section> => {
    const response = await post(body).expect(201);
    return sectionSchema.parse(response.body);
  };

  const read = async (id: string): Promise<Section> => {
    const response = await request(server())
      .get(`/api/sections/${id}`)
      .set('Authorization', bearer(editor))
      .expect(200);
    return sectionSchema.parse(response.body);
  };

  const patch = (id: string, body: object): request.Test =>
    request(server()).patch(`/api/sections/${id}`).set('Authorization', bearer(editor)).send(body);

  const moveTo = (id: string, body: object): request.Test =>
    request(server())
      .patch(`/api/sections/${id}/move`)
      .set('Authorization', bearer(editor))
      .send(body);

  /** Follows the cursor so an assertion about "every section" really sees them all. */
  const listAll = async (query = ''): Promise<Section[]> => {
    const items: Section[] = [];
    let cursor: string | null = null;
    do {
      const suffix: string = cursor ? `${query ? '&' : '?'}cursor=${cursor}` : '';
      const response = await request(server())
        .get(`/api/sections${query}${suffix}`)
        .set('Authorization', bearer(editor))
        .expect(200);
      const page = response.body as Page<Section>;
      items.push(...page.items.map((section) => sectionSchema.parse(section)));
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  };

  const readTree = async (): Promise<SectionTreeNode[]> => {
    const response = await request(server())
      .get('/api/sections/tree')
      .set('Authorization', bearer(editor))
      .expect(200);
    return response.body as SectionTreeNode[];
  };

  /**
   * Runs at setup as well as teardown: a run killed before its teardown would
   * otherwise fail the next one on a duplicate root slug.
   */
  const purge = async (): Promise<void> => {
    const snapshot = await firestore
      .collection(COLLECTIONS.sections)
      .limit(MAX_TREE_SECTIONS)
      .get();
    const mine = snapshot.docs
      .filter((doc) => String(doc.get('path') ?? '').startsWith(PREFIX))
      .sort((a, b) => Number(b.get('depth')) - Number(a.get('depth')));
    for (const doc of mine) {
      await doc.ref.delete();
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

  it('derives path, depth and ancestors for a root and its child', async () => {
    const root = await create({ slug: 'e2e-grammar-points', title: { en: 'Grammar points' } });

    expect(root.path).toBe('/e2e-grammar-points');
    expect(root.depth).toBe(0);
    expect(root.ancestorIds).toEqual([]);
    expect(root.parentId).toBeNull();

    const child = await create({
      parentId: root.id,
      slug: 'e2e-present-simple',
      title: { en: 'Present simple' },
    });

    expect(child.path).toBe('/e2e-grammar-points/e2e-present-simple');
    expect(child.depth).toBe(1);
    expect(child.ancestorIds).toEqual([root.id]);
  });

  it('rewrites every descendant path when a slug changes', async () => {
    const root = await create({ slug: 'e2e-rename-root', title: { en: 'Root' } });
    const child = await create({
      parentId: root.id,
      slug: 'e2e-rename-child',
      title: { en: 'Child' },
    });
    const grandchild = await create({
      parentId: child.id,
      slug: 'e2e-rename-grandchild',
      title: { en: 'Grandchild' },
    });

    await patch(root.id, { slug: 'e2e-grammar' }).expect(200);

    // Read them back rather than trusting the response: the criterion is about
    // what Firestore holds after the transaction.
    expect((await read(root.id)).path).toBe('/e2e-grammar');
    expect((await read(child.id)).path).toBe('/e2e-grammar/e2e-rename-child');
    expect((await read(grandchild.id)).path).toBe(
      '/e2e-grammar/e2e-rename-child/e2e-rename-grandchild',
    );

    // A rename is not a re-parent: depth and the ancestor chain are untouched.
    const rewritten = await read(grandchild.id);
    expect(rewritten.depth).toBe(2);
    expect(rewritten.ancestorIds).toEqual([root.id, child.id]);
  });

  it('leaves the fields a patch does not carry exactly as they were', async () => {
    const published = await create({
      slug: 'e2e-keep-published',
      title: { en: 'Published' },
      status: 'published',
      showInMenu: true,
      menuLabel: { en: 'Pub' },
    });
    expect(published.status).toBe('published');
    expect(published.showInMenu).toBe(true);

    await patch(published.id, { title: { en: 'Published renamed' } }).expect(200);

    // A title fix must not take the section off the public site or out of the
    // menu: the request named neither field.
    const renamed = await read(published.id);
    expect(renamed.title).toEqual({ en: 'Published renamed' });
    expect(renamed.status).toBe('published');
    expect(renamed.showInMenu).toBe(true);
    expect(renamed.menuLabel).toEqual({ en: 'Pub' });

    const link = await create({
      slug: 'e2e-keep-link',
      title: { en: 'Link' },
      kind: 'link',
      link: { type: 'external', href: 'https://example.com' },
    });

    await patch(link.id, { slug: 'e2e-keep-link-renamed' }).expect(200);

    const patched = await read(link.id);
    expect(patched.kind).toBe('link');
    expect(patched.link).toEqual({
      type: 'external',
      href: 'https://example.com',
      openInNewTab: false,
    });
    expect(patched.path).toBe('/e2e-keep-link-renamed');
  });

  it('clears an image when the patch sends null, and leaves it alone when the patch omits it', async () => {
    const image = {
      path: 'images/2026/01/hero.webp',
      url: 'https://cdn.test/images/2026/01/hero.webp',
      contentType: 'image/webp',
      sizeBytes: 4096,
      alt: { en: 'A hero' },
    };
    const created = await create({ slug: 'e2e-image', title: { en: 'Image' }, image });
    expect(created.image).toEqual(image);

    await patch(created.id, { title: { en: 'Image renamed' } }).expect(200);

    // An omitted key means "leave it alone", so a title fix must not strip the
    // image the author uploaded.
    expect((await read(created.id)).image).toEqual(image);

    await patch(created.id, { image: null }).expect(200);

    // Read it back: the criterion is that Firestore no longer holds the field,
    // not that the response happened to omit it.
    expect((await read(created.id)).image).toBeUndefined();
  });

  it('leaves every document at its original path when a rewrite fails mid-way', async () => {
    const root = await create({ slug: 'e2e-atomic-root', title: { en: 'Root' } });
    const child = await create({
      parentId: root.id,
      slug: 'e2e-atomic-child',
      title: { en: 'Child' },
    });
    const grandchild = await create({
      parentId: child.id,
      slug: 'e2e-atomic-grandchild',
      title: { en: 'Grandchild' },
    });

    const runReal = firestore.runTransaction.bind(firestore);
    // The only honest seam is the Transaction object itself: Firestore stages
    // writes and sends them at commit, so a throw part-way through the body is
    // exactly the partial-failure this criterion is about. The descendant query
    // is ordered, so "the second write" is deterministically the first child.
    const spy = vi.spyOn(firestore, 'runTransaction').mockImplementation(((
      updateFn: (tx: Transaction) => Promise<unknown>,
    ) =>
      runReal(async (tx) => {
        let writes = 0;
        const faulty = new Proxy(tx, {
          get(target, prop, receiver) {
            if (prop === 'set') {
              return (ref: DocumentReference, data: DocumentData): Transaction => {
                writes += 1;
                if (writes === 2) {
                  throw new Error('induced failure');
                }
                return target.set(ref, data);
              };
            }
            const value = Reflect.get(target, prop, receiver) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        return updateFn(faulty);
      })) as typeof firestore.runTransaction);

    try {
      await patch(root.id, { slug: 'e2e-atomic-renamed' }).expect(500);
    } finally {
      // Without this every later test runs against a transaction that throws
      // on its second write.
      spy.mockRestore();
    }

    expect((await read(root.id)).path).toBe('/e2e-atomic-root');
    expect((await read(root.id)).slug).toBe('e2e-atomic-root');
    expect((await read(child.id)).path).toBe('/e2e-atomic-root/e2e-atomic-child');
    expect((await read(grandchild.id)).path).toBe(
      '/e2e-atomic-root/e2e-atomic-child/e2e-atomic-grandchild',
    );
  });

  it('refuses a move into the section itself or one of its own descendants', async () => {
    const root = await create({ slug: 'e2e-cycle-root', title: { en: 'Root' } });
    const child = await create({
      parentId: root.id,
      slug: 'e2e-cycle-child',
      title: { en: 'Child' },
    });
    const grandchild = await create({
      parentId: child.id,
      slug: 'e2e-cycle-grandchild',
      title: { en: 'Grandchild' },
    });

    await moveTo(root.id, { parentId: grandchild.id, sortOrder: 0 }).expect(422);
    await moveTo(root.id, { parentId: root.id, sortOrder: 0 }).expect(422);

    expect((await read(root.id)).path).toBe('/e2e-cycle-root');
    expect((await read(child.id)).path).toBe('/e2e-cycle-root/e2e-cycle-child');
    expect((await read(grandchild.id)).path).toBe(
      '/e2e-cycle-root/e2e-cycle-child/e2e-cycle-grandchild',
    );
    expect((await read(root.id)).parentId).toBeNull();
  });

  it('refuses a section deeper than the nesting limit', async () => {
    let parentId: string | null = null;
    let deepest: Section | null = null;
    for (let depth = 0; depth <= MAX_SECTION_DEPTH; depth += 1) {
      deepest = await create({
        parentId,
        slug: `e2e-depth-${depth}`,
        title: { en: `Depth ${depth}` },
      });
      expect(deepest.depth).toBe(depth);
      parentId = deepest.id;
    }

    const response = await post({
      parentId,
      slug: 'e2e-depth-too-deep',
      title: { en: 'Too deep' },
    }).expect(422);
    expect((response.body as ErrorBody).message).toContain(String(MAX_SECTION_DEPTH + 1));

    await expect(listAll(`?parentId=${deepest?.id ?? ''}`)).resolves.toEqual([]);
  });

  it('keeps sibling slugs unique while allowing the same slug elsewhere', async () => {
    const first = await create({ slug: 'e2e-dup-a', title: { en: 'A' } });
    const second = await create({ slug: 'e2e-dup-b', title: { en: 'B' } });

    await create({ parentId: first.id, slug: 'e2e-duplicate', title: { en: 'One' } });

    const conflict = await post({
      parentId: first.id,
      slug: 'e2e-duplicate',
      title: { en: 'Two' },
    }).expect(409);
    expect((conflict.body as ErrorBody).message).toContain('e2e-duplicate');

    // The same slug under a different parent is a different path, so it stands.
    const elsewhere = await create({
      parentId: second.id,
      slug: 'e2e-duplicate',
      title: { en: 'Elsewhere' },
    });
    expect(elsewhere.path).toBe('/e2e-dup-b/e2e-duplicate');

    await post({ slug: 'e2e-dup-a', title: { en: 'Another root' } }).expect(409);
  });

  it('strips a script from a description posted straight at the API and keeps the audio node', async () => {
    const description = {
      en: '<p>ok</p><script>alert(1)</script><audio controls preload="metadata" src="https://cdn.test/a.mp3" data-asset-path="audio/2026/01/a.mp3"></audio>',
    };

    const created = await create({
      slug: 'e2e-sanitize',
      title: { en: 'Sanitize' },
      description,
    });

    // Re-read so the assertion is about what Firestore holds, not what the
    // controller happened to echo.
    const stored = await read(created.id);
    const stripped = stored.description?.['en'] ?? '';

    expect(stripped).not.toContain('<script');
    expect(stripped).not.toContain('alert(1)');
    expect(stripped).toContain('<p>ok</p>');
    expect(stripped).toContain('src="https://cdn.test/a.mp3"');
    expect(stripped).toContain('data-asset-path="audio/2026/01/a.mp3"');
    expect(stripped).toContain('controls');
    expect(stripped).toContain('preload="metadata"');
  });

  it('refuses to delete a section that still has children', async () => {
    const root = await create({ slug: 'e2e-delete-root', title: { en: 'Root' } });
    const child = await create({
      parentId: root.id,
      slug: 'e2e-delete-child',
      title: { en: 'Child' },
    });

    await request(server())
      .delete(`/api/sections/${root.id}`)
      .set('Authorization', bearer(editor))
      .expect(409);

    // Nothing is orphaned: both documents are still there.
    await expect(read(root.id)).resolves.toMatchObject({ id: root.id });
    await expect(read(child.id)).resolves.toMatchObject({ id: child.id });

    await request(server())
      .delete(`/api/sections/${child.id}`)
      .set('Authorization', bearer(editor))
      .expect(204);
    await request(server())
      .delete(`/api/sections/${root.id}`)
      .set('Authorization', bearer(editor))
      .expect(204);

    await request(server())
      .get(`/api/sections/${root.id}`)
      .set('Authorization', bearer(editor))
      .expect(404);
  });

  it('nests the tree exactly as walking parentId by hand does', async () => {
    const flat = await listAll();

    const walk = (parentId: string | null): Nesting[] =>
      flat
        .filter((section) => section.parentId === parentId)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((section) => ({ id: section.id, children: walk(section.id) }));

    const shape = (nodes: SectionTreeNode[]): Nesting[] =>
      nodes.map((node) => ({ id: node.id, children: shape(node.children) }));

    // Restricted to this suite's own forest so a section left in the emulator
    // by hand cannot decide whether the run passes.
    const mine = (nodes: Nesting[], sections: Section[]): Nesting[] =>
      nodes.filter((node) =>
        sections.some((section) => section.id === node.id && section.path.startsWith(PREFIX)),
      );

    expect(mine(shape(await readTree()), flat)).toEqual(mine(walk(null), flat));
    expect(mine(walk(null), flat).length).toBeGreaterThan(0);
  });

  it('rewrites path, depth and ancestors across a subtree that is re-parented', async () => {
    const from = await create({ slug: 'e2e-move-from', title: { en: 'From' } });
    const to = await create({ slug: 'e2e-move-to', title: { en: 'To' } });
    const child = await create({
      parentId: from.id,
      slug: 'e2e-move-child',
      title: { en: 'Child' },
    });
    const grandchild = await create({
      parentId: child.id,
      slug: 'e2e-move-grandchild',
      title: { en: 'Grandchild' },
    });

    await moveTo(child.id, { parentId: to.id, sortOrder: 0 }).expect(200);

    const movedChild = await read(child.id);
    expect(movedChild.path).toBe('/e2e-move-to/e2e-move-child');
    expect(movedChild.parentId).toBe(to.id);
    expect(movedChild.ancestorIds).toEqual([to.id]);
    expect(movedChild.depth).toBe(1);

    const movedGrandchild = await read(grandchild.id);
    expect(movedGrandchild.path).toBe('/e2e-move-to/e2e-move-child/e2e-move-grandchild');
    expect(movedGrandchild.ancestorIds).toEqual([to.id, child.id]);
    expect(movedGrandchild.depth).toBe(2);

    for (const section of [movedChild, movedGrandchild]) {
      expect(section.depth).toBe(section.ancestorIds.length);
    }
    // The old parent keeps its own path and loses the subtree.
    expect((await read(from.id)).path).toBe('/e2e-move-from');
    await expect(listAll(`?parentId=${from.id}`)).resolves.toEqual([]);
  });

  it('reorders siblings without touching their paths', async () => {
    const root = await create({ slug: 'e2e-order-root', title: { en: 'Root' } });
    const first = await create({ parentId: root.id, slug: 'e2e-order-a', title: { en: 'A' } });
    const second = await create({ parentId: root.id, slug: 'e2e-order-b', title: { en: 'B' } });

    // Appending at the end is what puts a new section at the bottom.
    expect(second.sortOrder).toBeGreaterThan(first.sortOrder);
    expect((await listAll(`?parentId=${root.id}`)).map((s) => s.id)).toEqual([first.id, second.id]);

    await moveTo(second.id, { parentId: root.id, sortOrder: first.sortOrder - 1 }).expect(200);

    expect((await listAll(`?parentId=${root.id}`)).map((s) => s.id)).toEqual([second.id, first.id]);
    expect((await read(second.id)).path).toBe('/e2e-order-root/e2e-order-b');
    expect((await read(second.id)).parentId).toBe(root.id);
  });

  it('does not rewrite the subtree when a move only reorders', async () => {
    const root = await create({ slug: 'e2e-quiet-root', title: { en: 'Root' } });
    const first = await create({ parentId: root.id, slug: 'e2e-quiet-a', title: { en: 'A' } });
    const second = await create({ parentId: root.id, slug: 'e2e-quiet-b', title: { en: 'B' } });
    const grandchild = await create({
      parentId: first.id,
      slug: 'e2e-quiet-ga',
      title: { en: 'GA' },
    });

    const before = await read(grandchild.id);

    await moveTo(first.id, { parentId: root.id, sortOrder: second.sortOrder + 1 }).expect(200);

    // No descendant path changed, so an audit stamp on the grandchild would
    // claim an editor touched a page they never opened.
    const after = await read(grandchild.id);
    expect(after.audit).toEqual(before.audit);
    expect(after.path).toBe(before.path);
    expect(after.ancestorIds).toEqual(before.ancestorIds);

    // The reorder itself still happened.
    expect((await listAll(`?parentId=${root.id}`)).map((s) => s.id)).toEqual([second.id, first.id]);
  });

  it('refuses a move onto a slug the destination already uses', async () => {
    const source = await create({ slug: 'e2e-taken-a', title: { en: 'A' } });
    const destination = await create({ slug: 'e2e-taken-b', title: { en: 'B' } });
    const moving = await create({
      parentId: source.id,
      slug: 'e2e-taken-child',
      title: { en: 'Moving' },
    });
    await create({ parentId: destination.id, slug: 'e2e-taken-child', title: { en: 'Sitting' } });

    await moveTo(moving.id, { parentId: destination.id, sortOrder: 0 }).expect(409);

    const unchanged = await read(moving.id);
    expect(unchanged.parentId).toBe(source.id);
    expect(unchanged.path).toBe('/e2e-taken-a/e2e-taken-child');
  });

  it('refuses every route to an anonymous caller and every mutation to a student', async () => {
    await request(server()).get('/api/sections').expect(401);
    await request(server()).get('/api/sections/tree').expect(401);
    await request(server())
      .post('/api/sections')
      .send({ slug: 'e2e-forbidden', title: { en: 'No' } })
      .expect(401);

    await request(server())
      .post('/api/sections')
      .set('Authorization', bearer(student))
      .send({ slug: 'e2e-forbidden', title: { en: 'No' } })
      .expect(403);
    await request(server()).get('/api/sections').set('Authorization', bearer(student)).expect(403);
  });

  it('answers 404 for an id that does not exist and for an unknown parent', async () => {
    await request(server())
      .get(`/api/sections/${UNKNOWN_ID}`)
      .set('Authorization', bearer(editor))
      .expect(404);
    await patch(UNKNOWN_ID, { title: { en: 'Nope' } }).expect(404);
    await moveTo(UNKNOWN_ID, { parentId: null, sortOrder: 0 }).expect(404);
    await request(server())
      .delete(`/api/sections/${UNKNOWN_ID}`)
      .set('Authorization', bearer(editor))
      .expect(404);

    // The parent is the thing that is missing, so this is a 404 and not a 422.
    const response = await post({
      parentId: UNKNOWN_ID,
      slug: 'e2e-orphan',
      title: { en: 'Orphan' },
    }).expect(404);
    expect((response.body as ErrorBody).message).toContain(UNKNOWN_ID);
  });

  it('filters the list by parent and status and pages with a cursor', async () => {
    const root = await create({ slug: 'e2e-filter-root', title: { en: 'Root' } });
    const draft = await create({
      parentId: root.id,
      slug: 'e2e-filter-draft',
      title: { en: 'Draft' },
    });
    const published = await create({
      parentId: root.id,
      slug: 'e2e-filter-published',
      title: { en: 'Published' },
      status: 'published',
    });

    const roots = await listAll('?parentId=root');
    expect(roots.every((section) => section.parentId === null)).toBe(true);
    expect(roots.map((section) => section.id)).toContain(root.id);

    const children = await listAll(`?parentId=${root.id}`);
    expect(children.map((section) => section.id)).toEqual([draft.id, published.id]);

    const publishedOnly = await listAll(`?parentId=${root.id}&status=published`);
    expect(publishedOnly.map((section) => section.id)).toEqual([published.id]);

    const firstPage = await request(server())
      .get(`/api/sections?parentId=${root.id}&limit=1`)
      .set('Authorization', bearer(editor))
      .expect(200);
    const page = firstPage.body as Page<Section>;
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.id).toBe(draft.id);
    expect(page.nextCursor).toBe(draft.id);

    const secondPage = await request(server())
      .get(`/api/sections?parentId=${root.id}&limit=1&cursor=${page.nextCursor ?? ''}`)
      .set('Authorization', bearer(editor))
      .expect(200);
    expect((secondPage.body as Page<Section>).items[0]?.id).toBe(published.id);
  });
});
