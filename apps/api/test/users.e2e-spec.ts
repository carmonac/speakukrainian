import type { INestApplication } from '@nestjs/common';
import type { Firestore } from '@google-cloud/firestore';
import type { Auth } from 'firebase-admin/auth';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COLLECTIONS,
  userProfileSchema,
  type Page,
  type UserProfile,
} from '@speakukrainian/shared';
import { FIRESTORE } from '../src/infra/firestore/firestore.tokens.js';
import { authOf, createTestApp, signInAs, type TestUser } from './emulator.js';

/**
 * A uid Firebase Auth creates without complaint and Firestore refuses to store
 * a document under. The account has to exist for the route to get past
 * `auth.getUser`, which is the whole point: the old reasoning for leaving
 * `:uid` unvalidated was that a missing account 404s first.
 */
const RESERVED_UID = '__name__';

/** A uid from an identity provider that is not Firebase — legal, and not a Firestore auto-id shape. */
const IMPORTED_UID = 'auth0|5f2c1b2e6f7a4c2b';

/**
 * A second profile, with an email that sorts after the imported one — the list
 * is ordered by email — so a page ending at the imported profile has a page
 * after it and therefore a `nextCursor`.
 */
const NEIGHBOUR_UID = 'auth0|9b8a7c6d5e4f3a2b';

/** 20 characters, the shape of a Firestore auto-id, and no account has it. */
const UNKNOWN_ID = 'zzzz0000zzzz0000zzzz';

interface ErrorBody {
  statusCode: number;
  message: string;
}

describe('users (e2e)', () => {
  let app: INestApplication;
  let auth: Auth;
  let firestore: Firestore;
  let admin: TestUser;

  const server = (): ReturnType<INestApplication['getHttpServer']> => app.getHttpServer();
  const bearer = (user: TestUser): string => `Bearer ${user.idToken}`;

  const setRole = (uid: string, role: string): request.Test =>
    request(server())
      .patch(`/api/users/${encodeURIComponent(uid)}/role`)
      .set('Authorization', bearer(admin))
      .send({ role });

  /** Created by hand rather than through `signInAs`, which cannot choose a uid. */
  const createAccount = async (uid: string, email: string): Promise<void> => {
    await auth.createUser({ uid, email });
  };

  const list = (query: string): request.Test =>
    request(server()).get(`/api/users${query}`).set('Authorization', bearer(admin));

  const listProfiles = async (query: string): Promise<Page<UserProfile>> => {
    const response = await list(query).expect(200);
    const page = response.body as Page<UserProfile>;
    return { ...page, items: page.items.map((item) => userProfileSchema.parse(item)) };
  };

  /** The claim `RolesGuard` reads, as a value an assertion can compare. */
  const roleClaim = async (uid: string): Promise<unknown> =>
    (await auth.getUser(uid)).customClaims?.['role'] as unknown;

  const dropAccount = async (uid: string): Promise<void> => {
    await auth.deleteUser(uid).catch(() => undefined);
  };

  beforeAll(async () => {
    app = await createTestApp();
    auth = authOf(app);
    firestore = app.get<Firestore>(FIRESTORE);
    admin = await signInAs(auth, 'admin');
    // A run killed before its teardown would otherwise fail the next one on a
    // uid that is already taken.
    await Promise.all([RESERVED_UID, IMPORTED_UID, NEIGHBOUR_UID].map((uid) => dropAccount(uid)));
    await Promise.all([
      createAccount(RESERVED_UID, 'reserved-uid@e2e.local'),
      createAccount(IMPORTED_UID, 'imported-uid@e2e.local'),
      createAccount(NEIGHBOUR_UID, 'zzz-neighbour-uid@e2e.local'),
    ]);
  });

  afterAll(async () => {
    if (firestore) {
      // Only these two can have a profile document: writing one under the
      // reserved uid is precisely what Firestore refuses.
      await Promise.all(
        [IMPORTED_UID, NEIGHBOUR_UID].map((uid) =>
          firestore.collection(COLLECTIONS.users).doc(uid).delete(),
        ),
      );
    }
    if (auth) {
      await Promise.all([
        ...[RESERVED_UID, IMPORTED_UID, NEIGHBOUR_UID].map((uid) => dropAccount(uid)),
        admin ? auth.deleteUser(admin.uid) : Promise.resolve(),
      ]);
    }
    if (app) {
      await app.close();
    }
  });

  it('refuses a role change for a uid Firestore cannot store, and still 404s an unknown one', async () => {
    // The account exists, so `auth.getUser` cannot be what refuses this. Before
    // the pipe, the uid reached `.doc(uid).set(…)` and the request ended as an
    // unhandled 500 with a stack in the log.
    const refused = await setRole(RESERVED_UID, 'editor').expect(400);
    expect((refused.body as ErrorBody).statusCode).toBe(400);

    // The refusal refused: no claim was written, so nothing was authorized.
    expect(await roleClaim(RESERVED_UID)).toBeUndefined();

    // 400 and 404 stay distinguishable: "that is not an id" against "that is an
    // id and there is no such account".
    await setRole(UNKNOWN_ID, 'editor').expect(404);
  });

  it('still changes the role of a uid carrying characters no Firestore auto-id has', async () => {
    // The other half of the decision: the alphabet belongs to the auth
    // provider, so `documentIdSchema` is deliberately *not* on this parameter —
    // an imported subject with a `|` must not become a 400.
    const response = await setRole(IMPORTED_UID, 'editor').expect(200);
    const profile: UserProfile = userProfileSchema.parse(response.body);

    expect(profile.id).toBe(IMPORTED_UID);
    expect(profile.role).toBe('editor');
    expect(await roleClaim(IMPORTED_UID)).toBe('editor');
  });

  it('refuses a list cursor that is not a document id, including an empty one', async () => {
    await list('').expect(200);
    await list(`?cursor=${RESERVED_UID}`).expect(400);
    // A deliberate 2xx → 400: `?cursor=` used to page from the beginning.
    await list('?cursor=').expect(400);
  });

  it('takes back the provider-shaped cursor it hands out for this collection', async () => {
    // The users collection is keyed by uids, so `nextCursor` is whatever an
    // auth provider minted. Under `documentIdSchema` the API answered 400 to
    // the very cursor it had just produced, and page two of the admin user list
    // was unreachable for an imported account.
    await setRole(IMPORTED_UID, 'editor').expect(200);
    await setRole(NEIGHBOUR_UID, 'editor').expect(200);

    const all = await listProfiles('?limit=100');
    const index = all.items.findIndex((profile) => profile.id === IMPORTED_UID);
    expect(index).toBeGreaterThanOrEqual(0);
    // Ordered by email, and the neighbour's sorts last, so there is a page after.
    expect(all.items.length).toBeGreaterThan(index + 1);

    const firstPage = await listProfiles(`?limit=${index + 1}`);
    expect(firstPage.nextCursor).toBe(IMPORTED_UID);

    const rest = await listProfiles(`?limit=100&cursor=${encodeURIComponent(IMPORTED_UID)}`);
    expect(rest.items.map((profile) => profile.id)).toEqual(
      all.items.slice(index + 1).map((profile) => profile.id),
    );
  });
});
