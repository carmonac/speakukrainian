import { z } from 'zod';
import { auditSchema } from './common.js';

export const userRoleSchema = z.enum(['admin', 'editor', 'student']);
export type UserRole = z.infer<typeof userRoleSchema>;

/**
 * Identity comes from Firebase Auth; this document holds the app-level profile
 * and role. `id` is the Firebase Auth uid.
 */
export const userProfileSchema = z.object({
  id: z.string().min(1),
  email: z.email(),
  displayName: z.string().min(1).optional(),
  photoUrl: z.url().optional(),
  role: userRoleSchema.default('student'),
  preferredLocale: z.string().optional(),
  disabled: z.boolean().default(false),
  audit: auditSchema,
});
export type UserProfile = z.infer<typeof userProfileSchema>;

/** Custom claims mirrored onto the Firebase Auth token for cheap authorization. */
export interface AuthClaims {
  role: UserRole;
}

/** Body of `PATCH /api/users/:uid/role`. */
export const updateUserRoleSchema = z.object({ role: userRoleSchema });
export type UpdateUserRoleInput = z.infer<typeof updateUserRoleSchema>;
