import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { hasAtLeastRole, type UserRole } from '@speakukrainian/shared';
import { ROLES_KEY } from './roles.decorator.js';
import type { RequestWithUser } from './firebase-auth.guard.js';

/**
 * Enforces `@Roles(...)`. Runs after {@link FirebaseAuthGuard}, so
 * `request.user` is already populated. Roles are hierarchical: an `admin`
 * satisfies a requirement of `editor`.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) {
      return true;
    }

    const user = context.switchToHttp().getRequest<RequestWithUser>().user;
    if (!user) {
      throw new ForbiddenException('Not authenticated');
    }

    const allowed = required.some((role) => hasAtLeastRole(user.role, role));
    if (!allowed) {
      throw new ForbiddenException(`Requires one of: ${required.join(', ')}`);
    }
    return true;
  }
}
