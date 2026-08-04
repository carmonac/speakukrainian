import type { UserRole } from './user.js';

/**
 * Deliberately free of runtime imports and published as its own entry point:
 * the admin's route guard needs nothing but this comparison, and reaching it
 * through the barrel drags every Zod schema — and Zod itself — into the eager
 * browser bundle.
 */
export const ROLE_HIERARCHY: Record<UserRole, number> = {
  student: 0,
  editor: 1,
  admin: 2,
};

export function hasAtLeastRole(actual: UserRole, required: UserRole): boolean {
  return ROLE_HIERARCHY[actual] >= ROLE_HIERARCHY[required];
}
