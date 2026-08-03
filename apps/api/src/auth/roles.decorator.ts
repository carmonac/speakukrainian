import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '@speakukrainian/shared';

export const ROLES_KEY = 'roles';

/** Restricts a route to callers holding at least one of the given roles. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
