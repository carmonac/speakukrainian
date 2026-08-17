import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Auth, DecodedIdToken } from 'firebase-admin/auth';
import type { Request } from 'express';
import type { UserRole } from '@speakukrainian/shared';
import { authUnavailable, meansBadCredential } from './auth-failure.js';
import { FIREBASE_AUTH } from './auth.tokens.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';

export interface AuthenticatedUser {
  uid: string;
  email: string | undefined;
  role: UserRole;
}

/** Request augmented with the verified caller. Set by {@link FirebaseAuthGuard}. */
export interface RequestWithUser extends Request {
  user?: AuthenticatedUser;
}

/**
 * Verifies the `Authorization: Bearer <idToken>` header against Firebase Auth
 * and attaches the caller to the request. Routes marked `@Public()` skip it.
 *
 * A request that already carries a caller is let through, because another guard
 * has already established one. **The rule that keeps that from being a hole:
 * `request.user` may be assigned only by an authentication guard, and never
 * from request input.** Today the only other assignment in the tree is
 * `H5pUrlTokenGuard`, which is metadata-gated to three routes and derives the
 * caller from a signed token plus a live Firebase Auth read. A middleware that
 * ever set `request.user` from a header or a body would be an authentication
 * bypass.
 *
 * That early return is also the precedence when a request carries **both**
 * credentials: the caller `H5pUrlTokenGuard` established stands and the header
 * below is never verified, even if it names someone else. `H5pUrlTokenGuard`'s
 * docblock says why that is the right way round.
 *
 * **A refusal here says whose fault it is.** An expired, revoked, malformed or
 * unsigned token, a disabled account and an account deleted since the token was
 * issued are the caller's, and stay a 401; every other Auth failure is this
 * server's and becomes a logged 503. `auth-failure.ts` states that rule — for
 * this guard and for `H5pUrlTokenGuard` — and is where the reasoning lives.
 */
@Injectable()
export class FirebaseAuthGuard implements CanActivate {
  constructor(
    @Inject(FIREBASE_AUTH) private readonly auth: Auth,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    if (request.user) {
      return true;
    }

    const header = request.headers.authorization;

    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }

    // Only the awaited call is inside the `try`, so nothing after it can be
    // misclassified as an Auth failure and answered as one.
    let decoded: DecodedIdToken;
    try {
      decoded = await this.auth.verifyIdToken(header.slice('Bearer '.length), true);
    } catch (error) {
      if (!meansBadCredential(error)) {
        throw authUnavailable('a bearer token', error);
      }
      throw new UnauthorizedException('Invalid or expired token');
    }

    request.user = {
      uid: decoded.uid,
      email: decoded.email,
      role: (decoded['role'] as UserRole | undefined) ?? 'student',
    };
    return true;
  }
}
