import type { INestApplication } from '@nestjs/common';
import type { Firestore } from '@google-cloud/firestore';
import type { Auth } from 'firebase-admin/auth';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COLLECTIONS,
  DEFAULT_LOCALE,
  SEED_LOCALES,
  type Locale,
  type PublicLocale,
} from '@speakukrainian/shared';
import { FIRESTORE } from '../src/infra/firestore/firestore.tokens.js';
import { LocalesService } from '../src/locales/locales.service.js';
import { authOf, createTestApp, signInAs, type TestUser } from './emulator.js';

// Valid BCP-47 codes that are not among the seeds. One per test that creates a
// locale, so a failure mid-test cannot fail the next one on a leftover 409.
const TEST_CODE = 'zu';
const SWITCH_CODE = 'sw';
const FILTER_CODE = 'yo';
const CREATED_CODES: readonly string[] = [TEST_CODE, SWITCH_CODE, FILTER_CODE];

describe('locales (e2e)', () => {
  let app: INestApplication;
  let auth: Auth;
  let firestore: Firestore;
  let admin: TestUser;
  let student: TestUser;

  const server = (): ReturnType<INestApplication['getHttpServer']> => app.getHttpServer();
  const dropTestLocales = (): Promise<unknown> =>
    Promise.all(
      CREATED_CODES.map((code) => firestore.collection(COLLECTIONS.locales).doc(code).delete()),
    );
  const listLocales = async (query = ''): Promise<PublicLocale[]> => {
    const response = await request(server()).get(`/api/locales${query}`).expect(200);
    return response.body as PublicLocale[];
  };

  /**
   * `dropTestLocales` deletes straight through Firestore, so it bypasses the
   * service's "the default cannot be deleted" rule: dropping a test locale
   * that holds the flag leaves the collection with zero defaults, and nothing
   * recovers from that on its own — seeding only writes locales that are
   * *missing*, so it never restores the flag on one already stored.
   *
   * Handing the flag back before the drop repairs only the damage this suite
   * can do, and only where it does it. Repairing whatever state is *found*
   * instead would also repair a boot that genuinely seeded no default, which
   * is the failure `seeds the site locales on boot` exists to catch.
   */
  const releaseDefaultFromTestLocales = async (): Promise<void> => {
    const locales = app.get(LocalesService);
    const stored = await locales.list({});
    if (stored.some((locale) => locale.isDefault && CREATED_CODES.includes(locale.code))) {
      await locales.setDefault(DEFAULT_LOCALE, 'e2e-setup');
    }
  };

  beforeAll(async () => {
    app = await createTestApp();
    auth = authOf(app);
    firestore = app.get<Firestore>(FIRESTORE);
    // A run killed before its teardown would otherwise poison the next one.
    await releaseDefaultFromTestLocales();
    await dropTestLocales();
    [admin, student] = await Promise.all([signInAs(auth, 'admin'), signInAs(auth, 'student')]);
  });

  // Guarded on what setup actually reached: when `beforeAll` fails, an
  // unguarded teardown throws over the top of it and hides why.
  afterAll(async () => {
    if (app && firestore) {
      await releaseDefaultFromTestLocales();
      await dropTestLocales();
    }
    const created = [admin, student].filter((user) => user !== undefined);
    await Promise.all(created.map((user) => auth.deleteUser(user.uid)));
    if (app) {
      await app.close();
    }
  });

  it('seeds the site locales on boot and serves them to anonymous callers', async () => {
    const response = await request(server()).get('/api/locales').expect(200);
    const locales = response.body as PublicLocale[];

    expect(locales.map((locale) => locale.code)).toEqual(expect.arrayContaining([...SEED_LOCALES]));
    expect(locales.filter((locale) => locale.isDefault)).toHaveLength(1);
  });

  it('keeps the audit uids out of the public response (ADR-010)', async () => {
    const response = await request(server()).get('/api/locales').expect(200);
    const locales = response.body as PublicLocale[];

    expect(locales.length).toBeGreaterThan(0);
    for (const locale of locales) {
      expect(locale).not.toHaveProperty('audit');
    }
  });

  it('writes nothing when the seed runs a second time', async () => {
    await expect(app.get(LocalesService).seed()).resolves.toBe(0);
  });

  it('refuses a mutation without a token', async () => {
    await request(server())
      .post('/api/locales')
      .send({ code: TEST_CODE, name: 'Zulu', nativeName: 'isiZulu' })
      .expect(401);
  });

  it('refuses a mutation from a student', async () => {
    await request(server())
      .post('/api/locales')
      .set('Authorization', `Bearer ${student.idToken}`)
      .send({ code: TEST_CODE, name: 'Zulu', nativeName: 'isiZulu' })
      .expect(403);
  });

  it('lets an admin create, patch and delete a locale', async () => {
    const created = await request(server())
      .post('/api/locales')
      .set('Authorization', `Bearer ${admin.idToken}`)
      .send({
        code: TEST_CODE,
        name: 'Zulu',
        nativeName: 'isiZulu',
        direction: 'rtl',
        enabled: true,
        sortOrder: 42,
      })
      .expect(201);

    expect((created.body as Locale).audit.createdBy).toBe(admin.uid);

    const listed = await request(server()).get('/api/locales').expect(200);
    expect((listed.body as PublicLocale[]).map((locale) => locale.code)).toContain(TEST_CODE);

    // A patch names one field and must leave the rest of the stored document
    // alone — the defect the schema split fixed, here against real Firestore.
    const patched = await request(server())
      .patch(`/api/locales/${TEST_CODE}`)
      .set('Authorization', `Bearer ${admin.idToken}`)
      .send({ name: 'Renamed' })
      .expect(200);

    expect(patched.body as Locale).toMatchObject({
      code: TEST_CODE,
      name: 'Renamed',
      nativeName: 'isiZulu',
      direction: 'rtl',
      enabled: true,
      sortOrder: 42,
      isDefault: false,
    });

    await request(server())
      .delete(`/api/locales/${TEST_CODE}`)
      .set('Authorization', `Bearer ${admin.idToken}`)
      .expect(204);

    const afterDelete = await request(server()).get('/api/locales').expect(200);
    expect((afterDelete.body as PublicLocale[]).map((locale) => locale.code)).not.toContain(
      TEST_CODE,
    );
  });

  it('moves the default to another locale in one request', async () => {
    const previousDefault = (await listLocales()).find((locale) => locale.isDefault);
    if (!previousDefault) {
      throw new Error('there is no default locale to move: the seed did not run');
    }

    await request(server())
      .post('/api/locales')
      .set('Authorization', `Bearer ${admin.idToken}`)
      .send({ code: SWITCH_CODE, name: 'Swahili', nativeName: 'Kiswahili' })
      .expect(201);

    const promoted = await request(server())
      .put(`/api/locales/${SWITCH_CODE}/default`)
      .set('Authorization', `Bearer ${admin.idToken}`)
      .expect(200);
    expect((promoted.body as Locale).isDefault).toBe(true);

    // The transaction has to clear the previous flag as it sets the new one:
    // two defaults at rest is the invariant this route exists to protect, and
    // a test double cannot prove Firestore keeps it.
    const afterSwitch = await listLocales();
    expect(afterSwitch.filter((locale) => locale.isDefault).map((locale) => locale.code)).toEqual([
      SWITCH_CODE,
    ]);

    await request(server())
      .put(`/api/locales/${previousDefault.code}/default`)
      .set('Authorization', `Bearer ${admin.idToken}`)
      .expect(200);

    const restored = await listLocales();
    expect(restored.filter((locale) => locale.isDefault).map((locale) => locale.code)).toEqual([
      previousDefault.code,
    ]);

    await request(server())
      .delete(`/api/locales/${SWITCH_CODE}`)
      .set('Authorization', `Bearer ${admin.idToken}`)
      .expect(204);
  });

  it('drops a disabled locale from ?enabled=true and refuses to make it the default', async () => {
    await request(server())
      .post('/api/locales')
      .set('Authorization', `Bearer ${admin.idToken}`)
      .send({ code: FILTER_CODE, name: 'Yoruba', nativeName: 'Èdè Yorùbá' })
      .expect(201);

    expect((await listLocales('?enabled=true')).map((locale) => locale.code)).toContain(
      FILTER_CODE,
    );

    await request(server())
      .patch(`/api/locales/${FILTER_CODE}`)
      .set('Authorization', `Bearer ${admin.idToken}`)
      .send({ enabled: false })
      .expect(200);

    const enabled = await listLocales('?enabled=true');
    expect(enabled.map((locale) => locale.code)).not.toContain(FILTER_CODE);
    expect(enabled.every((locale) => locale.enabled)).toBe(true);
    // The admin's own list is unfiltered, so the locale is still editable.
    expect((await listLocales()).map((locale) => locale.code)).toContain(FILTER_CODE);

    // A locale no reader can see must not become the fallback for every reader.
    await request(server())
      .put(`/api/locales/${FILTER_CODE}/default`)
      .set('Authorization', `Bearer ${admin.idToken}`)
      .expect(409);

    await request(server())
      .delete(`/api/locales/${FILTER_CODE}`)
      .set('Authorization', `Bearer ${admin.idToken}`)
      .expect(204);
  });

  it('refuses to delete the default locale', async () => {
    const response = await request(server()).get('/api/locales').expect(200);
    const fallback = (response.body as PublicLocale[]).find((locale) => locale.isDefault);
    expect(fallback).toBeDefined();

    await request(server())
      .delete(`/api/locales/${fallback?.code}`)
      .set('Authorization', `Bearer ${admin.idToken}`)
      .expect(409);
  });
});
