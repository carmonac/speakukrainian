import 'reflect-metadata';
import {
  Logger,
  ServiceUnavailableException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { H5PConfig } from '@lumieducation/h5p-server';
import type { Auth } from 'firebase-admin/auth';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { Env } from '../config/configuration.js';
import { H5pUrlTokenGuard } from '../h5p/h5p-url-token.guard.js';
import { H5pUrlTokenService } from '../h5p/h5p-url-token.service.js';
import { H5pUrlToken } from '../h5p/h5p.url-token.decorator.js';
import { signH5pUrlToken } from '../h5p/h5p.url-token.js';
import { AUTH_UNAVAILABLE_MESSAGE } from './auth-failure.js';
import { FirebaseAuthGuard, type RequestWithUser } from './firebase-auth.guard.js';

const SECRET = 'a-signing-key-long-enough-to-be-one-0123456789';
const UID = 'the-editor-who-opened-the-widget';

class Routes {
  @H5pUrlToken()
  tokenised(): void {}
}

/** One outage, seen through both of the SDK calls the two guards make. */
const OUTAGE = Object.assign(new Error('socket hang up'), { code: 'app/network-error' });

function createAuth(): Auth {
  return {
    getUser: (): Promise<never> => Promise.reject(OUTAGE),
    verifyIdToken: (): Promise<never> => Promise.reject(OUTAGE),
  } as unknown as Auth;
}

function contextFor(request: Partial<RequestWithUser>): ExecutionContext {
  const built = { query: {}, params: {}, headers: {}, ...request } as RequestWithUser;

  return {
    getHandler: () => Routes.prototype.tokenised,
    getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => built }),
  } as unknown as ExecutionContext;
}

async function refusalFrom(guard: CanActivate, context: ExecutionContext): Promise<unknown> {
  return Promise.resolve(guard.canActivate(context)).then(
    (allowed) => new Error(`the guard allowed the request (${String(allowed)})`),
    (error: unknown) => error,
  );
}

/**
 * The two authentication guards answer an Auth outage identically, which is the
 * property a future change to one of them could silently break. Every assertion
 * compares the two refusals against **each other**; the constants are only there
 * to pin which shared answer they agreed on.
 */
describe('the authentication guards, under one Auth outage', () => {
  let bearer: FirebaseAuthGuard;
  let urlToken: H5pUrlTokenGuard;
  let error: MockInstance<Logger['error']>;
  let warn: MockInstance<Logger['warn']>;

  beforeEach(() => {
    error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const auth = createAuth();
    const config = { get: () => SECRET } as unknown as ConfigService<Env, true>;
    bearer = new FirebaseAuthGuard(auth, new Reflector());
    urlToken = new H5pUrlTokenGuard(
      new Reflector(),
      new H5pUrlTokenService(config, new H5PConfig(undefined)),
      auth,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuse it the same way, with the same status and the same sentence', async () => {
    const fromBearer = await refusalFrom(
      bearer,
      contextFor({ headers: { authorization: 'Bearer a-token-that-is-probably-fine' } }),
    );
    const fromUrlToken = await refusalFrom(
      urlToken,
      contextFor({ query: { token: signH5pUrlToken(SECRET, UID, Date.now() + 60_000) } }),
    );

    expect(fromBearer).toBeInstanceOf(ServiceUnavailableException);
    expect(fromUrlToken).toBeInstanceOf(ServiceUnavailableException);

    const bearerRefusal = fromBearer as ServiceUnavailableException;
    const urlTokenRefusal = fromUrlToken as ServiceUnavailableException;

    expect(bearerRefusal.getStatus()).toBe(urlTokenRefusal.getStatus());
    expect(bearerRefusal.getStatus()).toBe(503);
    expect(bearerRefusal.message).toBe(urlTokenRefusal.message);
    expect(bearerRefusal.message).toBe(AUTH_UNAVAILABLE_MESSAGE);
  });

  it('both record it, at the same level and in the same quantity', async () => {
    await refusalFrom(
      bearer,
      contextFor({ headers: { authorization: 'Bearer a-token-that-is-probably-fine' } }),
    );
    const fromBearer = error.mock.calls.length;

    await refusalFrom(
      urlToken,
      contextFor({ query: { token: signH5pUrlToken(SECRET, UID, Date.now() + 60_000) } }),
    );
    const fromUrlToken = error.mock.calls.length - fromBearer;

    expect(fromUrlToken).toBe(fromBearer);
    expect(fromBearer).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
