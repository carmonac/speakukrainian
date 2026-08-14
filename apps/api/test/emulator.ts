import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Auth } from 'firebase-admin/auth';
import type { AuthClaims, UserRole } from '@speakukrainian/shared';
import { ConfigService } from '@nestjs/config';
import { AppModule } from '../src/app.module.js';
import { FIREBASE_AUTH } from '../src/auth/auth.tokens.js';
import { useJsonBodyParser } from '../src/common/body-parser.js';
import { securityHeaders } from '../src/common/security-headers.js';
import type { Env } from '../src/config/configuration.js';

/**
 * Boots the real application against the emulators, prefixed the way `main.ts`
 * prefixes it and parsing bodies the way `main.ts` parses them — the routes
 * under test are the ones the front ends call, and a suite running at a
 * different body limit tests a server that does not exist. The two bootstraps
 * can drift, so what decides whether a request is answered at all belongs here.
 *
 * **Helmet is mirrored, and that used to be the opposite claim.** The sentence
 * here said supertest is not a browser so helmet changes nothing observable;
 * that is false for one header. `Cross-Origin-Resource-Policy` is on the wire
 * and it is what decides whether a browser loads the 50 scripts, styles,
 * library files and content files the H5P widget needs — so without helmet in
 * this chain, an assertion that an H5P route answers `cross-origin` would only
 * prove the route sets a header, not that it beats the global `same-origin` it
 * has to override. `securityHeaders` is the one definition both bootstraps use.
 *
 * **CORS is still not mirrored**, and for the original reason, which is true of
 * CORS alone: supertest sends no `Origin`, so `enableCors` adds nothing to any
 * response these tests can observe.
 *
 * It listens on an ephemeral port rather than stopping at `init()`: supertest
 * binds and closes a fresh port per request against a non-listening server, and
 * under rapid succession the client then reads a response that belongs to
 * another request (a 401 the guard never raised, a 200 for a DELETE) or an
 * ECONNRESET. `app.close()` releases the listener.
 *
 * The host is pinned to the address supertest dials rather than left to
 * default to the `::` wildcard. On BSD kernels — macOS, so developer machines,
 * not the Linux CI runner, where the wildcard already refuses this — a wildcard
 * listener does not reserve `127.0.0.1:<port>`: another process may still bind
 * that exact pair, and because the more specific bind wins the demux, every
 * request supertest sends reaches *that* process, which answers 404 to routes it
 * has never heard of while this app sits healthy and listening. Binding the pair
 * outright refuses such a competitor with EADDRINUSE instead of silently
 * rerouting the suite. It does not change which ports `listen(0)` picks.
 */
export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  app.setGlobalPrefix('api', { exclude: ['healthz', 'readyz'] });
  app.use(securityHeaders(app.get(ConfigService<Env, true>).get('NODE_ENV', { infer: true })));
  useJsonBodyParser(app);
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
