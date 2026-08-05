import type { INestApplication } from '@nestjs/common';
import type { Firestore } from '@google-cloud/firestore';
import type { Auth } from 'firebase-admin/auth';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COLLECTIONS, SEED_LOCALES, type Locale, type PublicLocale } from '@speakukrainian/shared';
import { FIRESTORE } from '../src/infra/firestore/firestore.tokens.js';
import { LocalesService } from '../src/locales/locales.service.js';
import { authOf, createTestApp, signInAs, type TestUser } from './emulator.js';

/** Zulu: a valid BCP-47 code that is not one of the seeds. */
const TEST_CODE = 'zu';

describe('locales (e2e)', () => {
  let app: INestApplication;
  let auth: Auth;
  let firestore: Firestore;
  let admin: TestUser;
  let student: TestUser;

  const server = (): ReturnType<INestApplication['getHttpServer']> => app.getHttpServer();
  const dropTestLocale = (): Promise<unknown> =>
    firestore.collection(COLLECTIONS.locales).doc(TEST_CODE).delete();

  beforeAll(async () => {
    app = await createTestApp();
    auth = authOf(app);
    firestore = app.get<Firestore>(FIRESTORE);
    // A run that failed half way through would otherwise poison the next one.
    await dropTestLocale();
    [admin, student] = await Promise.all([signInAs(auth, 'admin'), signInAs(auth, 'student')]);
  });

  afterAll(async () => {
    await dropTestLocale();
    await Promise.all([auth.deleteUser(admin.uid), auth.deleteUser(student.uid)]);
    await app.close();
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
