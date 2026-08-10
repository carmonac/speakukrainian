import type { INestApplication } from '@nestjs/common';
import type { Firestore } from '@google-cloud/firestore';
import type { Auth } from 'firebase-admin/auth';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COLLECTIONS, type MenuEntry, type Section } from '@speakukrainian/shared';
import { FIRESTORE } from '../src/infra/firestore/firestore.tokens.js';
import { MAX_TREE_SECTIONS } from '../src/sections/sections.repository.js';
import { authOf, createTestApp, signInAs, type TestUser } from './emulator.js';

/**
 * The same prefix the sections and pages suites purge, deliberately wider than
 * the `e2e-menu-` this suite's own slugs carry: `GET /api/menu` reads the whole
 * sections collection and parses every document, so one section another suite
 * hand-wrote and was killed before deleting takes this suite's every read to
 * 500 — and a `/e2e-menu-` purge could not clear it. The menu is a global read,
 * so an assertion here has to select this suite's own entries out of whatever
 * else is stored.
 */
const PREFIX = '/e2e-';

describe('menu (e2e)', () => {
  let app: INestApplication;
  let auth: Auth;
  let firestore: Firestore;
  let editor: TestUser;

  const server = (): ReturnType<INestApplication['getHttpServer']> => app.getHttpServer();

  const create = async (body: Record<string, unknown>): Promise<Section> => {
    const response = await request(server())
      .post('/api/sections')
      .set('Authorization', `Bearer ${editor.idToken}`)
      .send(body)
      .expect(201);
    return response.body as Section;
  };

  const patch = (id: string, body: object): request.Test =>
    request(server())
      .patch(`/api/sections/${id}`)
      .set('Authorization', `Bearer ${editor.idToken}`)
      .send(body);

  /** Anonymous on purpose: `GET /api/menu` carries no Authorization header. */
  const readMenu = async (query = ''): Promise<MenuEntry[]> => {
    const response = await request(server()).get(`/api/menu${query}`).expect(200);
    return response.body as MenuEntry[];
  };

  const flatten = (entries: MenuEntry[]): MenuEntry[] =>
    entries.flatMap((entry) => [entry, ...flatten(entry.children)]);

  const findByHref = async (href: string, query = ''): Promise<MenuEntry | undefined> =>
    flatten(await readMenu(query)).find((entry) => entry.href === href);

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
    editor = await signInAs(auth, 'editor');
  });

  afterAll(async () => {
    if (app && firestore) {
      await purge();
    }
    if (editor) {
      await auth.deleteUser(editor.uid);
    }
    if (app) {
      await app.close();
    }
  });

  it('answers an anonymous caller and carries no audit uids', async () => {
    const section = await create({
      slug: 'e2e-menu-anon',
      title: { en: 'Anonymous' },
      status: 'published',
      showInMenu: true,
    });

    const menu = await readMenu();

    expect(flatten(menu).some((entry) => entry.id === section.id)).toBe(true);
    // ADR-010: a projection, not the stored document.
    expect(JSON.stringify(menu)).not.toContain('audit');
    expect(JSON.stringify(menu)).not.toContain('createdBy');
  });

  it('adds and removes an entry as showInMenu is ticked and unticked', async () => {
    const section = await create({
      slug: 'e2e-menu-toggle',
      title: { en: 'Toggle' },
      status: 'published',
      showInMenu: true,
    });

    expect(await findByHref('/e2e-menu-toggle')).toBeDefined();

    await patch(section.id, { showInMenu: false }).expect(200);

    expect(await findByHref('/e2e-menu-toggle')).toBeUndefined();

    await patch(section.id, { showInMenu: true }).expect(200);

    expect(await findByHref('/e2e-menu-toggle')).toBeDefined();
  });

  it('uses the menu label for the locale that has one and the title for the locale that does not', async () => {
    await create({
      slug: 'e2e-menu-label',
      title: { en: 'Grammar points', uk: 'Граматика', es: 'Gramática' },
      menuLabel: { uk: 'Грам' },
      status: 'published',
      showInMenu: true,
    });

    expect((await findByHref('/e2e-menu-label', '?locale=uk'))?.label).toBe('Грам');
    // `es` has no label at all, so it falls through to `es`'s own title.
    expect((await findByHref('/e2e-menu-label', '?locale=es'))?.label).toBe('Gramática');
  });

  it('carries a link section target and openInNewTab through', async () => {
    // The hrefs are namespaced like the slugs are: the menu is a global read, so
    // an assertion on a target this suite does not own — `/lessons`, or the
    // admin form's own `https://example.com` placeholder — is one ordinary
    // section away from failing for a reason that has nothing to do with it.
    await create({
      slug: 'e2e-menu-external',
      title: { en: 'External' },
      kind: 'link',
      link: { type: 'external', href: 'https://e2e-menu.example.test/x', openInNewTab: true },
      status: 'published',
      showInMenu: true,
    });
    await create({
      slug: 'e2e-menu-internal',
      title: { en: 'Internal' },
      kind: 'link',
      link: { type: 'internal', href: '/e2e-menu-internal-target', openInNewTab: false },
      status: 'published',
      showInMenu: true,
    });

    expect(await findByHref('https://e2e-menu.example.test/x')).toMatchObject({
      openInNewTab: true,
    });
    expect(await findByHref('/e2e-menu-internal-target')).toMatchObject({ openInNewTab: false });
    // The section's own path is not what a link section answers with.
    expect(await findByHref('/e2e-menu-external')).toBeUndefined();
  });

  it('leaves a draft section out of the menu even with showInMenu ticked', async () => {
    await create({
      slug: 'e2e-menu-draft',
      title: { en: 'Draft' },
      status: 'draft',
      showInMenu: true,
    });

    expect(await findByHref('/e2e-menu-draft')).toBeUndefined();
  });

  it('promotes a published child of a draft parent to the level above, keeping its own path', async () => {
    const root = await create({
      slug: 'e2e-menu-root',
      title: { en: 'Root' },
      status: 'published',
      showInMenu: true,
    });
    const hidden = await create({
      parentId: root.id,
      slug: 'e2e-menu-hidden',
      title: { en: 'Hidden' },
      status: 'draft',
      showInMenu: true,
    });
    await create({
      parentId: hidden.id,
      slug: 'e2e-menu-child',
      title: { en: 'Child' },
      status: 'published',
      showInMenu: true,
    });

    const rootEntry = flatten(await readMenu()).find((entry) => entry.id === root.id);

    expect(rootEntry?.children.map((entry) => entry.href)).toEqual([
      '/e2e-menu-root/e2e-menu-hidden/e2e-menu-child',
    ]);
    // ADR-011: the hidden ancestor gets no entry of its own, and the child's
    // href is not rewritten to skip it.
    expect(await findByHref('/e2e-menu-root/e2e-menu-hidden')).toBeUndefined();
  });

  it('lands promoted children where their hidden parent sat, not interleaved with its siblings', async () => {
    // No `sortOrder` is sent anywhere here: the numbers are the ones the API
    // itself hands out, and it numbers per parent, so `k1` and `b1` are both 0.
    // Ordering the menu by `sortOrder` alone reads `b1, k1, b2, k2`.
    const root = await create({
      slug: 'e2e-menu-ord',
      title: { en: 'Ordered' },
      status: 'published',
      showInMenu: true,
    });
    const inMenu = (slug: string, parentId: string): Record<string, unknown> => ({
      parentId,
      slug,
      title: { en: slug },
      status: 'published',
      showInMenu: true,
    });

    await create(inMenu('e2e-menu-ord-b1', root.id));
    await create(inMenu('e2e-menu-ord-b2', root.id));
    const hidden = await create({
      parentId: root.id,
      slug: 'e2e-menu-ord-hidden',
      title: { en: 'Hidden' },
      status: 'draft',
      showInMenu: true,
    });
    await create(inMenu('e2e-menu-ord-k1', hidden.id));
    await create(inMenu('e2e-menu-ord-k2', hidden.id));
    await create(inMenu('e2e-menu-ord-b3', root.id));

    const rootEntry = flatten(await readMenu()).find((entry) => entry.id === root.id);

    expect(rootEntry?.children.map((entry) => entry.label)).toEqual([
      'e2e-menu-ord-b1',
      'e2e-menu-ord-b2',
      'e2e-menu-ord-k1',
      'e2e-menu-ord-k2',
      'e2e-menu-ord-b3',
    ]);
  });

  it('serves the menu around a stored href the write path would refuse today, without publishing it', async () => {
    const root = await create({
      slug: 'e2e-menu-legacy-root',
      title: { en: 'Legacy root' },
      status: 'published',
      showInMenu: true,
    });
    const legacy = await create({
      parentId: root.id,
      slug: 'e2e-menu-legacy',
      title: { en: 'Legacy' },
      kind: 'link',
      link: { type: 'external', href: 'https://e2e-menu.example.test/legacy', openInNewTab: false },
      status: 'published',
      showInMenu: true,
    });
    await create({
      parentId: legacy.id,
      slug: 'e2e-menu-legacy-child',
      title: { en: 'Legacy child' },
      status: 'published',
      showInMenu: true,
    });
    // What `POST /api/sections` stored while `href` was only a non-empty string.
    await firestore
      .collection(COLLECTIONS.sections)
      .doc(legacy.id)
      .update({ 'link.href': 'javascript:alert(1)' });

    const rootEntry = flatten(await readMenu()).find((entry) => entry.id === root.id);

    // One such document must not take the entire public navigation down — the
    // menu is anonymous, sitewide, and unrelated to the section that is broken —
    // and it must not be published either: reading leniently keeps the document
    // repairable, it does not make its href fit to serve (ADR-012).
    expect(rootEntry).toBeDefined();
    expect(await findByHref('javascript:alert(1)')).toBeUndefined();
    // ADR-011's promotion, so dropping the entry does not take its branch too.
    expect(rootEntry?.children.map((entry) => entry.href)).toEqual([
      '/e2e-menu-legacy-root/e2e-menu-legacy/e2e-menu-legacy-child',
    ]);

    // An empty href is the same class of stored value and has to behave the same
    // way: readable, dropped, and not a 500 for every anonymous reader.
    await firestore
      .collection(COLLECTIONS.sections)
      .doc(legacy.id)
      .update({ 'link.href': '', 'link.type': 'internal' });

    const afterEmpty = flatten(await readMenu()).find((entry) => entry.id === root.id);

    expect(afterEmpty?.children.map((entry) => entry.href)).toEqual([
      '/e2e-menu-legacy-root/e2e-menu-legacy/e2e-menu-legacy-child',
    ]);
  });

  it('never publishes a stored internal href that a browser would resolve off-site', async () => {
    // `/\evil.test` starts with `/` but resolves to `http://evil.test/`, because
    // the URL parser folds `\` to `/`. The write path refuses it; a document
    // carrying one must not reach an anonymous reader either.
    const link = await create({
      slug: 'e2e-menu-folded',
      title: { en: 'Folded' },
      kind: 'link',
      link: { type: 'internal', href: '/e2e-menu-folded-target', openInNewTab: false },
      status: 'published',
      showInMenu: true,
    });
    await firestore
      .collection(COLLECTIONS.sections)
      .doc(link.id)
      .update({ 'link.href': '/\\e2e-menu-evil.test' });

    const menu = await readMenu();

    expect(flatten(menu).some((entry) => entry.id === link.id)).toBe(false);
    expect(JSON.stringify(menu)).not.toContain('e2e-menu-evil.test');
  });

  it('labels a section titled in no locale the reader asked for with the text it does have', async () => {
    // The API does not require a title in the default locale — only the admin
    // form does — so this is a shape an anonymous reader can reach.
    await create({
      slug: 'e2e-menu-uk-only',
      title: { uk: 'Тільки' },
      status: 'published',
      showInMenu: true,
    });

    expect((await findByHref('/e2e-menu-uk-only', '?locale=en'))?.label).toBe('Тільки');
  });
});
