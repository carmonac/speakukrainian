import 'reflect-metadata';
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { UserProfile, UserRole } from '@speakukrainian/shared';
import { ROLES_KEY } from '../auth/roles.decorator.js';
import type { AuthenticatedUser } from '../auth/firebase-auth.guard.js';
import { UsersController } from './users.controller.js';
import type { UsersService } from './users.service.js';

const profile: UserProfile = {
  id: 'uid-1',
  email: 'ada@example.com',
  role: 'editor',
  disabled: false,
  audit: {
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'seed',
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'seed',
  },
};

function createServiceDouble(): UsersService {
  return {
    getOrProvision: (caller: AuthenticatedUser) => Promise.resolve({ ...profile, id: caller.uid }),
  } as unknown as UsersService;
}

describe('UsersController.me', () => {
  it('rejects a request with no verified caller attached', () => {
    const controller = new UsersController(createServiceDouble());
    expect(() => controller.me()).toThrow(UnauthorizedException);
  });

  it('returns the profile for the attached caller', async () => {
    const controller = new UsersController(createServiceDouble());

    const result = await controller.me({ uid: 'uid-9', email: 'ada@example.com', role: 'editor' });

    expect(result.id).toBe('uid-9');
  });
});

describe('UsersController role metadata', () => {
  // Rule 8: every mutating route carries a role guard. Asserting the metadata
  // keeps a dropped decorator from silently opening the route to any caller.
  const roles = (handler: object): UserRole[] | undefined =>
    Reflect.getMetadata(ROLES_KEY, handler) as UserRole[] | undefined;

  it('restricts the role change to admins', () => {
    expect(roles(UsersController.prototype.setRole)).toEqual(['admin']);
  });

  it('restricts the user list to admins', () => {
    expect(roles(UsersController.prototype.list)).toEqual(['admin']);
  });

  it('leaves /me open to any authenticated caller', () => {
    expect(roles(UsersController.prototype.me)).toBeUndefined();
  });
});
