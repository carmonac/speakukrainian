import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Auth } from 'firebase-admin/auth';
import type { UserProfile, UserRole } from '@speakukrainian/shared';
import type { AuthenticatedUser } from '../auth/firebase-auth.guard.js';
import type { CreateUserProfileInput, UsersRepository } from './users.repository.js';
import { UsersService } from './users.service.js';

interface AuthRecord {
  uid: string;
  email?: string;
  displayName?: string;
  customClaims?: { role: UserRole };
}

/** Keeps claims as state so assertions read what was written, not that a spy fired. */
function createAuthDouble(
  records: AuthRecord[],
  options: { claimWriteFails?: boolean } = {},
): {
  auth: Auth;
  claims: Map<string, { role: UserRole }>;
} {
  const byUid = new Map(records.map((record) => [record.uid, record]));
  const claims = new Map<string, { role: UserRole }>();

  const auth = {
    getUser: (uid: string) => {
      const record = byUid.get(uid);
      return record ? Promise.resolve(record) : Promise.reject(new Error('no such user'));
    },
    setCustomUserClaims: (uid: string, next: { role: UserRole }) => {
      if (options.claimWriteFails) {
        return Promise.reject(new Error('auth backend unavailable'));
      }
      claims.set(uid, next);
      return Promise.resolve();
    },
  } as unknown as Auth;

  return { auth, claims };
}

function createRepositoryDouble(options: { profileWriteFails?: boolean } = {}): {
  repository: UsersRepository;
  profiles: Map<string, UserProfile>;
} {
  const profiles = new Map<string, UserProfile>();
  const audit = {
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'seed',
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'seed',
  };

  const repository = {
    findById: (id: string) => Promise.resolve(profiles.get(id) ?? null),
    create: (input: CreateUserProfileInput, actorId: string) => {
      const profile: UserProfile = {
        ...input,
        disabled: false,
        audit: { ...audit, createdBy: actorId, updatedBy: actorId },
      };
      profiles.set(profile.id, profile);
      return Promise.resolve(profile);
    },
    setRole: (id: string, role: UserRole, actorId: string) => {
      if (options.profileWriteFails) {
        return Promise.reject(new Error('firestore unavailable'));
      }
      const existing = profiles.get(id);
      if (!existing) {
        return Promise.resolve(null);
      }
      const next: UserProfile = {
        ...existing,
        role,
        audit: { ...existing.audit, updatedBy: actorId },
      };
      profiles.set(id, next);
      return Promise.resolve(next);
    },
  } as unknown as UsersRepository;

  return { repository, profiles };
}

const admin: AuthenticatedUser = { uid: 'admin-uid', email: 'admin@example.com', role: 'admin' };

describe('UsersService.getOrProvision', () => {
  it('returns the stored profile without rewriting it', async () => {
    const { repository, profiles } = createRepositoryDouble();
    const { auth } = createAuthDouble([]);
    const service = new UsersService(repository, auth);

    await repository.create({ id: 'uid-1', email: 'ada@example.com', role: 'editor' }, 'seed');
    const before = profiles.get('uid-1');

    const result = await service.getOrProvision({
      uid: 'uid-1',
      email: 'ada@example.com',
      role: 'student',
    });

    expect(result.role).toBe('editor');
    expect(profiles.get('uid-1')).toBe(before);
  });

  it("provisions a profile carrying the token's role", async () => {
    const { repository, profiles } = createRepositoryDouble();
    const { auth } = createAuthDouble([]);
    const service = new UsersService(repository, auth);

    const result = await service.getOrProvision(admin);

    expect(result.role).toBe('admin');
    expect(profiles.get('admin-uid')?.role).toBe('admin');
  });

  it('refuses a caller whose uid Firestore cannot store, before reading anything', async () => {
    // Firebase creates `__name__` happily and Firestore refuses to hold a
    // document under it, so without this the account's first request reaches
    // `.doc(uid)` and comes back as an unhandled 500. No pipe sees this uid: it
    // arrives on the verified token, not on the request.
    const { repository, profiles } = createRepositoryDouble();
    const { auth } = createAuthDouble([]);
    const service = new UsersService(repository, auth);

    await expect(
      service.getOrProvision({ uid: '__name__', email: 'ada@example.com', role: 'student' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(profiles.size).toBe(0);
  });

  it('provisions a caller whose uid carries a character no Firestore auto-id has', async () => {
    // The alphabet belongs to the auth provider: an imported subject must still
    // get a profile, which is why the check is not `documentIdSchema`.
    const { repository, profiles } = createRepositoryDouble();
    const { auth } = createAuthDouble([]);
    const service = new UsersService(repository, auth);

    const result = await service.getOrProvision({
      uid: 'auth0|5f2c1b2e',
      email: 'ada@example.com',
      role: 'student',
    });

    expect(result.id).toBe('auth0|5f2c1b2e');
    expect(profiles.get('auth0|5f2c1b2e')?.role).toBe('student');
  });

  it('refuses to provision a caller with no email address', async () => {
    const { repository, profiles } = createRepositoryDouble();
    const { auth } = createAuthDouble([]);
    const service = new UsersService(repository, auth);

    await expect(
      service.getOrProvision({ uid: 'uid-1', email: undefined, role: 'student' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(profiles.size).toBe(0);
  });
});

describe('UsersService.setRole', () => {
  let repository: UsersRepository;
  let profiles: Map<string, UserProfile>;
  let auth: Auth;
  let claims: Map<string, { role: UserRole }>;
  let service: UsersService;

  beforeEach(async () => {
    ({ repository, profiles } = createRepositoryDouble());
    ({ auth, claims } = createAuthDouble([
      { uid: 'uid-1', email: 'ada@example.com', displayName: 'Ada' },
      { uid: 'admin-uid', email: 'admin@example.com' },
    ]));
    service = new UsersService(repository, auth);
    await repository.create({ id: 'uid-1', email: 'ada@example.com', role: 'student' }, 'seed');
  });

  it('moves both the custom claim and the profile document to the new role', async () => {
    const result = await service.setRole('uid-1', 'editor', admin);

    expect(claims.get('uid-1')).toEqual({ role: 'editor' });
    expect(profiles.get('uid-1')?.role).toBe('editor');
    expect(profiles.get('uid-1')?.audit.updatedBy).toBe('admin-uid');
    expect(result.role).toBe('editor');
  });

  it('throws NotFound and touches nothing when the account does not exist', async () => {
    await expect(service.setRole('ghost', 'editor', admin)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(claims.has('ghost')).toBe(false);
    expect(profiles.has('ghost')).toBe(false);
  });

  it('refuses a self-demotion and leaves the claim untouched', async () => {
    await expect(service.setRole('admin-uid', 'student', admin)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(claims.has('admin-uid')).toBe(false);
  });

  it('leaves the custom claim untouched when the profile write fails', async () => {
    // The claim is what authorizes requests, so a failed Firestore write must
    // not leave a token that grants access the profile does not reflect.
    const repo = createRepositoryDouble({ profileWriteFails: true });
    const double = createAuthDouble([{ uid: 'uid-1', email: 'ada@example.com' }]);
    const failing = new UsersService(repo.repository, double.auth);

    await expect(failing.setRole('uid-1', 'admin', admin)).rejects.toThrow('firestore unavailable');
    expect(double.claims.has('uid-1')).toBe(false);
  });

  it('refuses an account with no email before writing anything', async () => {
    const repo = createRepositoryDouble();
    const double = createAuthDouble([{ uid: 'uid-2' }]);
    const failing = new UsersService(repo.repository, double.auth);

    await expect(failing.setRole('uid-2', 'editor', admin)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(double.claims.has('uid-2')).toBe(false);
    expect(repo.profiles.has('uid-2')).toBe(false);
  });

  it('puts the profile back to the role the token still carries when the claim write fails', async () => {
    const repo = createRepositoryDouble();
    const double = createAuthDouble(
      [{ uid: 'uid-1', email: 'ada@example.com', customClaims: { role: 'student' } }],
      { claimWriteFails: true },
    );
    const failing = new UsersService(repo.repository, double.auth);
    await repo.repository.create(
      { id: 'uid-1', email: 'ada@example.com', role: 'student' },
      'seed',
    );

    await expect(failing.setRole('uid-1', 'admin', admin)).rejects.toThrow(
      'auth backend unavailable',
    );
    expect(repo.profiles.get('uid-1')?.role).toBe('student');
  });

  it('creates a profile from the Auth record when none exists yet', async () => {
    profiles.delete('uid-1');

    const result = await service.setRole('uid-1', 'editor', admin);

    expect(result).toMatchObject({
      id: 'uid-1',
      email: 'ada@example.com',
      displayName: 'Ada',
      role: 'editor',
    });
    expect(profiles.get('uid-1')?.role).toBe('editor');
    expect(claims.get('uid-1')).toEqual({ role: 'editor' });
  });
});
