import { describe, expect, it } from 'vitest';
import { updateUserRoleSchema } from './user.js';

describe('updateUserRoleSchema', () => {
  it('accepts a known role', () => {
    expect(updateUserRoleSchema.parse({ role: 'editor' })).toEqual({ role: 'editor' });
  });

  it('rejects a role outside the hierarchy', () => {
    expect(updateUserRoleSchema.safeParse({ role: 'owner' }).success).toBe(false);
  });

  it('rejects a body with no role', () => {
    expect(updateUserRoleSchema.safeParse({}).success).toBe(false);
  });
});
