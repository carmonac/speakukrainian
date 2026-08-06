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
 * Same purge strategy as the sections suite: every slug this one creates starts
 * with `e2e-menu-`, so every path it creates starts with `/e2e-menu-` and the
 * purge deletes exactly those. The menu is a global read, so an assertion here
 * has to select this suite's own entries out of whatever else is stored.
 */
const PREFIX = '/e2e-menu-';

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
    await create({
      slug: 'e2e-menu-external',
      title: { en: 'External' },
      kind: 'link',
      link: { type: 'external', href: 'https://example.com/x', openInNewTab: true },
      status: 'published',
      showInMenu: true,
    });
    await create({
      slug: 'e2e-menu-internal',
      title: { en: 'Internal' },
      kind: 'link',
      link: { type: 'internal', href: '/lessons', openInNewTab: false },
      status: 'published',
      showInMenu: true,
    });

    expect(await findByHref('https://example.com/x')).toMatchObject({ openInNewTab: true });
    expect(await findByHref('/lessons')).toMatchObject({ openInNewTab: false });
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
});
