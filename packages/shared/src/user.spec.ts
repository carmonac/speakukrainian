import { describe, expect, it } from 'vitest';
import { hasAtLeastRole, updateUserRoleSchema, type UserRole } from './user.js';

describe('hasAtLeastRole', () => {
  // Both the API's RolesGuard and the admin's staffGuard branch on this, so the
  // full matrix is spelled out rather than spot-checked.
  const cases: [actual: UserRole, required: UserRole, expected: boolean][] = [
    ['admin', 'admin', true],
    ['admin', 'editor', true],
    ['admin', 'student', true],
    ['editor', 'admin', false],
    ['editor', 'editor', true],
    ['editor', 'student', true],
    ['student', 'admin', false],
    ['student', 'editor', false],
    ['student', 'student', true],
  ];

  for (const [actual, required, expected] of cases) {
    it(`${actual} ${expected ? 'satisfies' : 'does not satisfy'} ${required}`, () => {
      expect(hasAtLeastRole(actual, required)).toBe(expected);
    });
  }
});

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
