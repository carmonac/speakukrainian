import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Auth } from 'firebase-admin/auth';
import type { Request } from 'express';
import type { UserRole } from '@speakukrainian/shared';
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
    const header = request.headers.authorization;

    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }

    try {
      const decoded = await this.auth.verifyIdToken(header.slice('Bearer '.length), true);
      request.user = {
        uid: decoded.uid,
        email: decoded.email,
        role: (decoded['role'] as UserRole | undefined) ?? 'student',
      };
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
