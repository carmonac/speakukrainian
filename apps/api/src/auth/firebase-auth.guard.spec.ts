import 'reflect-metadata';
import {
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Auth, DecodedIdToken } from 'firebase-admin/auth';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { AUTH_UNAVAILABLE_MESSAGE } from './auth-failure.js';
import {
  FirebaseAuthGuard,
  type AuthenticatedUser,
  type RequestWithUser,
} from './firebase-auth.guard.js';
import { Public } from './public.decorator.js';

/** Two handlers with real metadata, so the `Reflector` reads what the decorator wrote. */
class Routes {
  @Public()
  open(): void {}

  guarded(): void {}
}

/** The shape `firebase-admin` rejects with: an `Error` carrying a `<prefix>/<code>`. */
const firebaseError = (code: string, message = 'Decoding Firebase ID token failed'): Error =>
  Object.assign(new Error(message), { code });

/**
 * An `Auth` whose `verifyIdToken` accepts exactly one token.
 *
 * Everything else rejects, which is what makes the "already identified" case
 * below able to fail: if the branch under test were removed, that request would
 * reach this double with no header at all.
 *
 * The rejection is SDK-shaped — a bare `Error` would now be read as a failure of
 * this server's rather than of the token — and `rejection` chooses which failure
 * a test drives, since the guard's answer depends on which one it is.
 */
function createAuth(
  accepted: string,
  decoded: Partial<DecodedIdToken>,
  rejection: unknown = firebaseError('auth/argument-error'),
): Auth {
  return {
    verifyIdToken: (idToken: string): Promise<DecodedIdToken> =>
      idToken === accepted ? Promise.resolve(decoded as DecodedIdToken) : Promise.reject(rejection),
  } as unknown as Auth;
}

function contextFor(
  request: Partial<RequestWithUser>,
  handler: (...args: never[]) => unknown,
): { context: ExecutionContext; request: RequestWithUser } {
  const built = { headers: {}, ...request } as RequestWithUser;

  return {
    request: built,
    context: {
      getHandler: () => handler,
      getClass: () => Routes,
      switchToHttp: () => ({ getRequest: () => built }),
    } as unknown as ExecutionContext,
  };
}

const GOOD_TOKEN = 'a-token-the-emulator-would-have-issued';

describe('FirebaseAuthGuard', () => {
  let guard: FirebaseAuthGuard;
  let logged: MockInstance<Logger['error']>;

  /** The guard over a double that fails every verification the given way. */
  const guardFailingWith = (rejection: unknown): FirebaseAuthGuard =>
    new FirebaseAuthGuard(createAuth(GOOD_TOKEN, { uid: 'uid-1' }, rejection), new Reflector());

  beforeEach(() => {
    logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    guard = new FirebaseAuthGuard(
      createAuth(GOOD_TOKEN, { uid: 'uid-1', email: 'e@x.local', role: 'editor' }),
      new Reflector(),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lets a public route through without looking at the header', async () => {
    const { context, request } = contextFor({}, Routes.prototype.open);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toBeUndefined();
  });

  it('refuses a request with no bearer header', async () => {
    const { context } = contextFor({}, Routes.prototype.guarded);

    await expect(guard.canActivate(context)).rejects.toThrow('Missing bearer token');
  });

  it('refuses a header that is not a bearer token', async () => {
    const { context } = contextFor(
      { headers: { authorization: `Basic ${GOOD_TOKEN}` } },
      Routes.prototype.guarded,
    );

    await expect(guard.canActivate(context)).rejects.toThrow('Missing bearer token');
  });

  it('refuses a bearer token Firebase does not accept', async () => {
    const { context, request } = contextFor(
      { headers: { authorization: 'Bearer forged' } },
      Routes.prototype.guarded,
    );

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    expect(request.user).toBeUndefined();
  });

  it.each(['app/network-error', 'auth/internal-error'])(
    'answers %s with a 503 about this server rather than a 401 about the caller',
    async (code) => {
      // A 401 here would be a lie *and* a harm: the admin's interceptor bounces
      // any 401 to /login, so an Auth outage would throw every author out of
      // what they were editing into a login screen that also cannot work.
      const { context, request } = contextFor(
        { headers: { authorization: 'Bearer a-token-that-is-probably-fine' } },
        Routes.prototype.guarded,
      );

      const rejected: unknown = await guardFailingWith(
        Object.assign(new Error('the backend could not be reached'), { code }),
      )
        .canActivate(context)
        .catch((error: unknown) => error);

      expect(rejected).toBeInstanceOf(ServiceUnavailableException);
      expect((rejected as ServiceUnavailableException).getStatus()).toBe(503);
      expect((rejected as ServiceUnavailableException).message).toBe(AUTH_UNAVAILABLE_MESSAGE);
      expect(request.user).toBeUndefined();
      expect(logged).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['auth/id-token-revoked', 'auth/user-not-found'])(
    'answers %s with a 401 and logs nothing, because only the caller can replace that token',
    async (code) => {
      const { context, request } = contextFor(
        { headers: { authorization: 'Bearer a-token-that-was-good-once' } },
        Routes.prototype.guarded,
      );

      const rejected: unknown = await guardFailingWith(
        Object.assign(new Error('that token no longer identifies anyone'), { code }),
      )
        .canActivate(context)
        .catch((error: unknown) => error);

      expect(rejected).toBeInstanceOf(UnauthorizedException);
      expect((rejected as UnauthorizedException).message).toBe('Invalid or expired token');
      expect(request.user).toBeUndefined();
      expect(logged).not.toHaveBeenCalled();
    },
  );

  it('attaches the caller from a verified token', async () => {
    const { context, request } = contextFor(
      { headers: { authorization: `Bearer ${GOOD_TOKEN}` } },
      Routes.prototype.guarded,
    );

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual({
      uid: 'uid-1',
      email: 'e@x.local',
      role: 'editor',
    } satisfies AuthenticatedUser);
  });

  it('defaults a caller with no role claim to student', async () => {
    guard = new FirebaseAuthGuard(
      createAuth(GOOD_TOKEN, { uid: 'uid-2', email: undefined }),
      new Reflector(),
    );
    const { context, request } = contextFor(
      { headers: { authorization: `Bearer ${GOOD_TOKEN}` } },
      Routes.prototype.guarded,
    );

    await guard.canActivate(context);

    expect(request.user?.role).toBe('student');
  });

  it('lets a request whose caller another guard already established through unchanged', async () => {
    // The composition with `H5pUrlTokenGuard`: it runs first and identifies the
    // caller from a signed URL token, and this guard must not then demand a
    // header the H5P client was never going to send. The double here rejects
    // everything but `GOOD_TOKEN`, and this request carries no header at all —
    // so removing the branch turns this into a 401.
    const already: AuthenticatedUser = { uid: 'uid-3', email: 'other@x.local', role: 'editor' };
    const { context, request } = contextFor({ user: already }, Routes.prototype.guarded);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toBe(already);
  });
});
