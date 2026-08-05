import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Auth } from 'firebase-admin/auth';
import type { AuthClaims, UserRole } from '@speakukrainian/shared';
import { AppModule } from '../src/app.module.js';
import { FIREBASE_AUTH } from '../src/auth/auth.tokens.js';

/**
 * Boots the real application against the emulators, prefixed the way `main.ts`
 * prefixes it — the routes under test are the ones the front ends call.
 *
 * It listens on an ephemeral port rather than stopping at `init()`: supertest
 * binds and closes a fresh port per request against a non-listening server, and
 * under rapid succession the client then reads a response that belongs to
 * another request (a 401 the guard never raised, a 200 for a DELETE) or an
 * ECONNRESET. `app.close()` releases the listener.
 *
 * The host is pinned to the address supertest dials rather than left to
 * default to the `::` wildcard. A wildcard listener does not reserve
 * `127.0.0.1:<port>`: any other process may still bind that exact pair, and
 * because the more specific bind wins the demux, every request supertest sends
 * then reaches *that* process — which answers 404 to routes it has never heard
 * of, while this app sits healthy and listening. Binding the pair outright
 * makes the kernel skip ports already taken on it and refuse a later
 * competitor with EADDRINUSE instead of silently rerouting the suite.
 */
export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api', { exclude: ['healthz', 'readyz'] });
  await app.listen(0, '127.0.0.1');
  return app;
}

export function authOf(app: INestApplication): Auth {
  return app.get<Auth>(FIREBASE_AUTH);
}

export interface TestUser {
  uid: string;
  email: string;
  idToken: string;
}

const TEST_PASSWORD = 'emulator-password';

/**
 * Creates an account in the Auth emulator with `role` as a custom claim and
 * signs it in for a real ID token. The claim has to be set before the sign-in:
 * it is baked into the token at issue time, not read on verification.
 */
export async function signInAs(auth: Auth, role: UserRole): Promise<TestUser> {
  const email = `${role}-${randomUUID()}@e2e.local`;
  const { uid } = await auth.createUser({ email, password: TEST_PASSWORD, emailVerified: true });
  await auth.setCustomUserClaims(uid, { role } satisfies AuthClaims);

  const host = process.env['FIREBASE_AUTH_EMULATOR_HOST'];
  if (!host) {
    throw new Error('FIREBASE_AUTH_EMULATOR_HOST is not set; start the emulators first.');
  }

  // The emulator accepts any API key, but the parameter is still required.
  const response = await fetch(
    `http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=emulator`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: TEST_PASSWORD, returnSecureToken: true }),
    },
  );

  const body = (await response.json()) as { idToken?: string; error?: { message?: string } };
  if (!response.ok || !body.idToken) {
    throw new Error(`Auth emulator sign-in failed: ${body.error?.message ?? response.status}`);
  }

  return { uid, email, idToken: body.idToken };
}
