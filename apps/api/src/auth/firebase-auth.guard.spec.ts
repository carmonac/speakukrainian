import 'reflect-metadata';
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Auth, DecodedIdToken } from 'firebase-admin/auth';
import { beforeEach, describe, expect, it } from 'vitest';
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

/**
 * An `Auth` whose `verifyIdToken` accepts exactly one token.
 *
 * Everything else rejects, which is what makes the "already identified" case
 * below able to fail: if the branch under test were removed, that request would
 * reach this double with no header at all.
 */
function createAuth(accepted: string, decoded: Partial<DecodedIdToken>): Auth {
  return {
    verifyIdToken: (idToken: string): Promise<DecodedIdToken> =>
      idToken === accepted
        ? Promise.resolve(decoded as DecodedIdToken)
        : Promise.reject(new Error('Decoding Firebase ID token failed')),
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

  beforeEach(() => {
    guard = new FirebaseAuthGuard(
      createAuth(GOOD_TOKEN, { uid: 'uid-1', email: 'e@x.local', role: 'editor' }),
      new Reflector(),
    );
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
