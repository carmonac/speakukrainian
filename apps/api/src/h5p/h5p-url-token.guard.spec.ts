import 'reflect-metadata';
import {
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { H5PConfig } from '@lumieducation/h5p-server';
import type { Auth, UserRecord } from 'firebase-admin/auth';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { AUTH_UNAVAILABLE_MESSAGE } from '../auth/auth-failure.js';
import type { AuthenticatedUser, RequestWithUser } from '../auth/firebase-auth.guard.js';
import type { Env } from '../config/configuration.js';
import { H5pUrlTokenService } from './h5p-url-token.service.js';
import { H5pUrlTokenGuard } from './h5p-url-token.guard.js';
import { H5pUrlToken } from './h5p.url-token.decorator.js';
import {
  H5P_URL_TOKEN_EXPIRED_MESSAGE,
  H5P_URL_TOKEN_INVALID_MESSAGE,
  H5P_URL_TOKEN_UNKNOWN_USER_MESSAGE,
  signH5pUrlToken,
} from './h5p.url-token.js';

const SECRET = 'a-signing-key-long-enough-to-be-one-0123456789';
const UID = 'the-editor-who-opened-the-widget';

/** Two handlers with real metadata, so the `Reflector` reads what the decorator wrote. */
class Routes {
  @H5pUrlToken()
  accepts(): void {}

  unmarked(): void {}
}

interface AuthDouble {
  auth: Auth;
  /** Every record the double will answer with, by uid. */
  records: Map<string, Partial<UserRecord>>;
  /** How a lookup fails, by uid. Consulted before {@link AuthDouble.records}. */
  failures: Map<string, unknown>;
}

/**
 * An `Auth` that fails the way the SDK does: an `Error` carrying a
 * `<prefix>/<code>`. A bare `Error` would be read as a failure of this server's,
 * which is a different answer.
 */
function createAuth(): AuthDouble {
  const records = new Map<string, Partial<UserRecord>>();
  const failures = new Map<string, unknown>();

  const auth = {
    getUser: (uid: string): Promise<UserRecord> => {
      const failure = failures.get(uid);
      if (failure !== undefined) {
        return Promise.reject(failure);
      }

      const record = records.get(uid);
      return record
        ? Promise.resolve(record as UserRecord)
        : Promise.reject(
            Object.assign(new Error('there is no user record corresponding to the provided uid'), {
              code: 'auth/user-not-found',
            }),
          );
    },
  } as unknown as Auth;

  return { auth, records, failures };
}

function createService(): H5pUrlTokenService {
  const config = { get: () => SECRET } as unknown as ConfigService<Env, true>;
  return new H5pUrlTokenService(config, new H5PConfig(undefined));
}

function contextFor(
  request: Partial<RequestWithUser>,
  handler: (...args: never[]) => unknown,
): { context: ExecutionContext; request: RequestWithUser } {
  const built = { query: {}, params: {}, headers: {}, ...request } as RequestWithUser;

  return {
    request: built,
    context: {
      getHandler: () => handler,
      getClass: () => Routes,
      switchToHttp: () => ({ getRequest: () => built }),
    } as unknown as ExecutionContext,
  };
}

describe('H5pUrlTokenGuard', () => {
  let guard: H5pUrlTokenGuard;
  let authDouble: AuthDouble;
  let logged: MockInstance<Logger['error']>;

  const editorRecord = (uid = UID): Partial<UserRecord> => ({
    uid,
    email: 'editor@example.local',
    disabled: false,
    customClaims: { role: 'editor' },
  });

  const validToken = (uid = UID): string =>
    signH5pUrlToken(SECRET, uid, Date.now() + 60 * 60 * 1000);

  const expiredToken = (uid = UID): string => signH5pUrlToken(SECRET, uid, Date.now() - 1);

  beforeEach(() => {
    logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    authDouble = createAuth();
    guard = new H5pUrlTokenGuard(new Reflector(), createService(), authDouble.auth);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does nothing at all on a route that does not accept a URL token', async () => {
    // The assertion that this guard is inert on every route in the API but
    // three: a token in the query of an unmarked route identifies nobody.
    authDouble.records.set(UID, editorRecord());
    const { context, request } = contextFor(
      { query: { token: validToken() } },
      Routes.prototype.unmarked,
    );

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toBeUndefined();
  });

  it('leaves a marked route with no token to the bearer guard', async () => {
    const { context, request } = contextFor({}, Routes.prototype.accepts);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toBeUndefined();
  });

  it('identifies the caller from a token in the query', async () => {
    authDouble.records.set(UID, editorRecord());
    const { context, request } = contextFor(
      { query: { token: validToken() } },
      Routes.prototype.accepts,
    );

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual({
      uid: UID,
      email: 'editor@example.local',
      role: 'editor',
    } satisfies AuthenticatedUser);
  });

  it('identifies the caller from a token in the path, which is how the preview arrives', async () => {
    authDouble.records.set(UID, editorRecord());
    const { context, request } = contextFor(
      { params: { token: validToken(), path: ['images', 'image-aB34xQz9.png'] } },
      Routes.prototype.accepts,
    );

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user?.uid).toBe(UID);
  });

  it('resolves the role from the current claims rather than from the token', async () => {
    // The token names who is asking and nothing else, so a claim that changed
    // after it was minted is the one that decides. Here the caller comes out an
    // admin from a token that says nothing about roles.
    authDouble.records.set(UID, { ...editorRecord(), customClaims: { role: 'admin' } });
    const { context, request } = contextFor(
      { query: { token: validToken() } },
      Routes.prototype.accepts,
    );

    await guard.canActivate(context);

    expect(request.user?.role).toBe('admin');
  });

  it('answers a caller with no role claim the way the bearer guard does', async () => {
    // `student`, so that `@Roles('editor')` on the route makes it a 403 rather
    // than an accident. The 403 itself is the e2e's job.
    authDouble.records.set(UID, { ...editorRecord(), customClaims: undefined });
    const { context, request } = contextFor(
      { query: { token: validToken() } },
      Routes.prototype.accepts,
    );

    await guard.canActivate(context);

    expect(request.user?.role).toBe('student');
  });

  it('refuses an expired token with a sentence about the editing session', async () => {
    authDouble.records.set(UID, editorRecord());
    const { context, request } = contextFor(
      { query: { token: expiredToken() } },
      Routes.prototype.accepts,
    );

    await expect(guard.canActivate(context)).rejects.toThrow(H5P_URL_TOKEN_EXPIRED_MESSAGE);
    expect(request.user).toBeUndefined();
  });

  it('refuses a tampered token with a different sentence from an expired one', async () => {
    authDouble.records.set(UID, editorRecord());
    const token = validToken();
    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    const { context, request } = contextFor(
      { query: { token: tampered } },
      Routes.prototype.accepts,
    );

    await expect(guard.canActivate(context)).rejects.toThrow(H5P_URL_TOKEN_INVALID_MESSAGE);
    expect(request.user).toBeUndefined();
  });

  it('refuses a token naming an account that no longer exists', async () => {
    const { context, request } = contextFor(
      { query: { token: validToken('somebody-who-was-deleted') } },
      Routes.prototype.accepts,
    );

    await expect(guard.canActivate(context)).rejects.toThrow(H5P_URL_TOKEN_UNKNOWN_USER_MESSAGE);
    expect(request.user).toBeUndefined();
  });

  it('refuses a token naming a disabled account', async () => {
    authDouble.records.set(UID, { ...editorRecord(), disabled: true });
    const { context, request } = contextFor(
      { query: { token: validToken() } },
      Routes.prototype.accepts,
    );

    await expect(guard.canActivate(context)).rejects.toThrow(H5P_URL_TOKEN_UNKNOWN_USER_MESSAGE);
    expect(request.user).toBeUndefined();
  });

  it('treats a repeated query parameter as no token at all rather than joining it', async () => {
    // Express parses `?token=a&token=b` into an array. `String(value)` here
    // would hand `"a,b"` to the verifier; treating it as absent means the
    // request falls through to the bearer guard and is refused there.
    authDouble.records.set(UID, editorRecord());
    const { context, request } = contextFor(
      { query: { token: [validToken(), validToken()] } },
      Routes.prototype.accepts,
    );

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toBeUndefined();
  });

  it('refuses a malformed token with a 401 and never a 500', async () => {
    const { context } = contextFor(
      { query: { token: 'not.a.token.at.all' } },
      Routes.prototype.accepts,
    );

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('answers an Auth outage with a 503 that names the cause in the log', async () => {
    authDouble.failures.set(
      UID,
      Object.assign(new Error('socket hang up'), { code: 'app/network-error' }),
    );
    const { context, request } = contextFor(
      { query: { token: validToken() } },
      Routes.prototype.accepts,
    );

    const rejected: unknown = await guard.canActivate(context).catch((error: unknown) => error);

    expect(rejected).toBeInstanceOf(ServiceUnavailableException);
    expect((rejected as ServiceUnavailableException).getStatus()).toBe(503);
    expect((rejected as ServiceUnavailableException).message).toBe(AUTH_UNAVAILABLE_MESSAGE);
    expect(request.user).toBeUndefined();
    expect(logged).toHaveBeenCalledTimes(1);
    const line = logged.mock.calls[0]?.[0];
    expect(line).toContain(UID);
    expect(line).toContain('firebase code: app/network-error');
  });

  it('does not tell an author their account is gone when Auth is down', async () => {
    authDouble.records.set(UID, editorRecord());
    authDouble.failures.set(
      UID,
      Object.assign(new Error('the backend is unavailable'), { code: 'auth/internal-error' }),
    );
    const { context } = contextFor({ query: { token: validToken() } }, Routes.prototype.accepts);

    const rejected: unknown = await guard.canActivate(context).catch((error: unknown) => error);

    expect((rejected as Error).message).not.toBe(H5P_URL_TOKEN_UNKNOWN_USER_MESSAGE);
  });
});
