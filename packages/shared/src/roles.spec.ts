import { describe, expect, it } from 'vitest';
import { hasAtLeastRole } from './roles.js';
import type { UserRole } from './user.js';

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
