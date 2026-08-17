import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Auth, UserRecord } from 'firebase-admin/auth';
import type { UserRole } from '@speakukrainian/shared';
import { authUnavailable, meansUnknownUser } from '../auth/auth-failure.js';
import { FIREBASE_AUTH } from '../auth/auth.tokens.js';
import type { RequestWithUser } from '../auth/firebase-auth.guard.js';
import { H5pUrlTokenService } from './h5p-url-token.service.js';
import { H5P_URL_TOKEN_KEY } from './h5p.url-token.decorator.js';
import {
  H5P_URL_TOKEN_EXPIRED_MESSAGE,
  H5P_URL_TOKEN_INVALID_MESSAGE,
  H5P_URL_TOKEN_PARAM,
  H5P_URL_TOKEN_QUERY,
  H5P_URL_TOKEN_UNKNOWN_USER_MESSAGE,
} from './h5p.url-token.js';

/**
 * Identifies the caller of the three routes Joubel's editor client drives
 * itself, from a token in the URL rather than from a bearer header.
 *
 * **It is inert everywhere else.** Without `@H5pUrlToken()` on the handler or
 * its class it returns immediately, which is every route in this API but three.
 *
 * **It runs first among the global guards, and that order is load-bearing:**
 * `FirebaseAuthGuard` would otherwise have already refused a request with no
 * `Authorization` header, and a route guard cannot rescue one.
 *
 * **Composition.** An *absent* token is not an error — it means the request is
 * using the other credential, so the bearer path takes over. A token that is
 * *present and bad* is refused here and never falls through, because falling
 * through would answer an expired editing session with a sentence about a
 * header the caller was never going to send. A token that is *present and
 * valid* wins over an `Authorization` header on the same request, and that
 * header is never verified: the caller demonstrably holds a credential naming
 * the token's user, so honouring the header instead would reach nothing a
 * token-only request could not already reach, and this way a tokenised URL
 * means the same thing wherever it is loaded from rather than depending on
 * whatever credential the surrounding page happens to attach to it.
 *
 * **What it costs, and why that is paid.** One Firebase Auth read per
 * token-authenticated request, to resolve the caller's *current* role. That is
 * what keeps the token from being a role grant: it carries no role, so a
 * demotion takes effect immediately rather than at the end of the token's
 * lifetime. The alternative — a role in the payload — would remove the read and
 * introduce a staleness window of the whole lifetime. An Auth outage therefore
 * breaks the editor's previews; that is the accepted side of the trade, and it
 * is now *answered as an outage* — a logged 503 — rather than reported to the
 * author as an account that can no longer sign in.
 */
@Injectable()
export class H5pUrlTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: H5pUrlTokenService,
    @Inject(FIREBASE_AUTH) private readonly auth: Auth,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const accepted = this.reflector.getAllAndOverride<boolean>(H5P_URL_TOKEN_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!accepted) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const token = tokenIn(request);
    if (token === undefined) {
      return true;
    }

    const result = this.tokens.verify(token);
    if (!result.ok) {
      throw new UnauthorizedException(
        result.reason === 'expired' ? H5P_URL_TOKEN_EXPIRED_MESSAGE : H5P_URL_TOKEN_INVALID_MESSAGE,
      );
    }

    const record = await this.recordOf(result.uid);
    request.user = {
      uid: result.uid,
      email: record.email,
      // The same default `FirebaseAuthGuard` applies, deliberately: one answer
      // to "a caller with no role claim", not two that can drift.
      role: (record.customClaims?.['role'] as UserRole | undefined) ?? 'student',
    };
    return true;
  }

  /**
   * The caller's current record, or a refusal — of one of two kinds.
   *
   * An account that is gone or disabled is the caller's problem and answers
   * 401; any other Auth failure is this server's and answers a logged 503, so
   * an outage is never reported to an author as a dead account.
   * `auth-failure.ts` states that rule for both authentication guards.
   */
  private async recordOf(uid: string): Promise<UserRecord> {
    const record = await this.auth.getUser(uid).catch((error: unknown) => {
      if (meansUnknownUser(error)) {
        throw new UnauthorizedException(H5P_URL_TOKEN_UNKNOWN_USER_MESSAGE);
      }
      throw authUnavailable(`the H5P editor URL token for uid ${uid}`, error);
    });

    if (record.disabled) {
      throw new UnauthorizedException(H5P_URL_TOKEN_UNKNOWN_USER_MESSAGE);
    }
    return record;
  }
}

/**
 * The token a request carries, from the query parameter the ajax URLs use or
 * the path segment the preview URL uses.
 *
 * One rule for both routes rather than an argument on the decorator, and a
 * value that is not a string is treated as **absent** rather than coerced:
 * Express parses `?token=a&token=b` into an array, and `String(value)` on that
 * would hand `"a,b"` to the verifier.
 */
function tokenIn(request: RequestWithUser): string | undefined {
  const queried: unknown = request.query[H5P_URL_TOKEN_QUERY];
  if (typeof queried === 'string' && queried !== '') {
    return queried;
  }

  const named: unknown = (request.params as Record<string, unknown>)[H5P_URL_TOKEN_PARAM];
  return typeof named === 'string' && named !== '' ? named : undefined;
}
