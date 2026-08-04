import { describe, expect, it } from 'vitest';
import type { UserProfile, UserRole } from '@speakukrainian/shared';
import {
  DEFAULT_DISPLAY_NAME,
  DEFAULT_EMAIL,
  DEFAULT_PASSWORD,
  SEED_ACTOR,
  assertEmulator,
  parseOptions,
  seedAdmin,
  type SeedAuth,
  type SeedOptions,
  type SeedProfiles,
} from './seed-admin.ts';

const bothHosts: NodeJS.ProcessEnv = {
  FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099',
  FIRESTORE_EMULATOR_HOST: 'localhost:8081',
};

interface AuthAccount {
  uid: string;
  email: string;
  password: string;
  displayName: string;
}

function createAuthDouble(seeded: AuthAccount[] = []): {
  auth: SeedAuth;
  accounts: Map<string, AuthAccount>;
  claims: Map<string, { role: UserRole }>;
} {
  const accounts = new Map(seeded.map((account) => [account.uid, account]));
  const claims = new Map<string, { role: UserRole }>();
  let nextUid = 1;

  const auth: SeedAuth = {
    getUserByEmail(email) {
      const found = [...accounts.values()].find((account) => account.email === email);
      if (!found) {
        return Promise.reject(
          Object.assign(new Error('not found'), { code: 'auth/user-not-found' }),
        );
      }
      return Promise.resolve({ uid: found.uid, displayName: found.displayName });
    },
    createUser(props) {
      const uid = `uid-${nextUid++}`;
      accounts.set(uid, {
        uid,
        email: props.email,
        password: props.password,
        displayName: props.displayName,
      });
      return Promise.resolve({ uid });
    },
    updateUser(uid, props) {
      const existing = accounts.get(uid);
      if (!existing) {
        return Promise.reject(new Error(`no account ${uid}`));
      }
      accounts.set(uid, { ...existing, ...props });
      return Promise.resolve({ uid });
    },
    setCustomUserClaims(uid, next) {
      claims.set(uid, next as { role: UserRole });
      return Promise.resolve();
    },
  };

  return { auth, accounts, claims };
}

function createProfilesDouble(): { profiles: SeedProfiles; stored: Map<string, UserProfile> } {
  const stored = new Map<string, UserProfile>();
  const profiles: SeedProfiles = {
    get: (uid) => Promise.resolve(stored.get(uid) ?? null),
    set: (uid, profile) => {
      stored.set(uid, profile);
      return Promise.resolve();
    },
  };
  return { profiles, stored };
}

const options: SeedOptions = {
  email: DEFAULT_EMAIL,
  password: DEFAULT_PASSWORD,
  displayName: DEFAULT_DISPLAY_NAME,
  role: 'admin',
  resetPassword: false,
};

describe('parseOptions', () => {
  it('falls back to the documented defaults', () => {
    expect(parseOptions([], {})).toEqual({
      email: DEFAULT_EMAIL,
      password: DEFAULT_PASSWORD,
      displayName: DEFAULT_DISPLAY_NAME,
      role: 'admin',
      resetPassword: false,
    });
  });

  it('reads the environment when no flags are given', () => {
    const result = parseOptions([], {
      SEED_ADMIN_EMAIL: 'env@example.com',
      SEED_ADMIN_PASSWORD: 'env-secret',
      SEED_ADMIN_NAME: 'Env Admin',
    });

    expect(result).toEqual({
      email: 'env@example.com',
      password: 'env-secret',
      displayName: 'Env Admin',
      role: 'admin',
      resetPassword: false,
    });
  });

  it('accepts --reset-password as a switch', () => {
    expect(parseOptions(['--reset-password'], {}).resetPassword).toBe(true);
  });

  it('prefers a flag over the environment', () => {
    const result = parseOptions(['--email=flag@example.com', '--role=editor'], {
      SEED_ADMIN_EMAIL: 'env@example.com',
    });

    expect(result.email).toBe('flag@example.com');
    expect(result.role).toBe('editor');
  });

  it('rejects a role outside the hierarchy before anything is written', () => {
    expect(() => parseOptions(['--role=owner'], {})).toThrow();
  });

  it('rejects an unknown flag', () => {
    expect(() => parseOptions(['--admin=true'], {})).toThrow(/Unsupported argument/);
  });

  it('rejects a flag given without a value', () => {
    expect(() => parseOptions(['--email'], {})).toThrow(/Unsupported argument/);
  });
});

describe('assertEmulator', () => {
  it('passes when both emulator hosts are set', () => {
    expect(() => assertEmulator(bothHosts)).not.toThrow();
  });

  it('refuses to run without the Auth emulator host', () => {
    expect(() => assertEmulator({ FIRESTORE_EMULATOR_HOST: 'localhost:8081' })).toThrow(
      /FIREBASE_AUTH_EMULATOR_HOST/,
    );
  });

  it('refuses to run without the Firestore emulator host', () => {
    expect(() => assertEmulator({ FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099' })).toThrow(
      /FIRESTORE_EMULATOR_HOST/,
    );
  });
});

describe('seedAdmin', () => {
  it('creates the account, sets the admin claim and stores the profile', async () => {
    const { auth, accounts, claims } = createAuthDouble();
    const { profiles, stored } = createProfilesDouble();

    const result = await seedAdmin(auth, profiles, options, () => '2026-01-01T00:00:00.000Z');

    expect(result).toEqual({
      uid: 'uid-1',
      email: DEFAULT_EMAIL,
      role: 'admin',
      created: true,
      passwordReset: true,
    });
    expect(accounts.get('uid-1')?.password).toBe(DEFAULT_PASSWORD);
    expect(claims.get('uid-1')).toEqual({ role: 'admin' });
    expect(stored.get('uid-1')).toMatchObject({
      id: 'uid-1',
      email: DEFAULT_EMAIL,
      displayName: DEFAULT_DISPLAY_NAME,
      role: 'admin',
      disabled: false,
    });
    expect(stored.get('uid-1')?.audit).toEqual({
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: SEED_ACTOR,
      updatedAt: '2026-01-01T00:00:00.000Z',
      updatedBy: SEED_ACTOR,
    });
  });

  it('leaves exactly one account and one profile when run twice', async () => {
    const { auth, accounts } = createAuthDouble();
    const { profiles, stored } = createProfilesDouble();

    const first = await seedAdmin(auth, profiles, options, () => '2026-01-01T00:00:00.000Z');
    const second = await seedAdmin(auth, profiles, options, () => '2026-02-02T00:00:00.000Z');

    expect(accounts.size).toBe(1);
    expect(stored.size).toBe(1);
    expect(second.uid).toBe(first.uid);
    expect(second.created).toBe(false);
    expect(stored.get(first.uid)?.audit).toEqual({
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: SEED_ACTOR,
      updatedAt: '2026-02-02T00:00:00.000Z',
      updatedBy: SEED_ACTOR,
    });
  });

  it('updates an account that already exists rather than re-creating it', async () => {
    const { auth, accounts, claims } = createAuthDouble([
      { uid: 'existing', email: DEFAULT_EMAIL, password: 'chosen', displayName: 'Old name' },
    ]);
    const { profiles } = createProfilesDouble();

    const result = await seedAdmin(auth, profiles, { ...options, role: 'editor' });

    expect(result.uid).toBe('existing');
    expect(result.created).toBe(false);
    expect(accounts.size).toBe(1);
    expect(accounts.get('existing')?.displayName).toBe(DEFAULT_DISPLAY_NAME);
    expect(claims.get('existing')).toEqual({ role: 'editor' });
  });

  it('leaves the password of an existing account alone', async () => {
    // Re-setting it moves `validSince`, and the API verifies with
    // `checkRevoked`, so a repeat run would 401 every open session.
    const { auth, accounts } = createAuthDouble([
      {
        uid: 'existing',
        email: DEFAULT_EMAIL,
        password: 'chosen',
        displayName: DEFAULT_DISPLAY_NAME,
      },
    ]);
    const { profiles } = createProfilesDouble();

    const result = await seedAdmin(auth, profiles, options);

    expect(accounts.get('existing')?.password).toBe('chosen');
    expect(result.passwordReset).toBe(false);
  });

  it('resets the password of an existing account when asked', async () => {
    const { auth, accounts } = createAuthDouble([
      { uid: 'existing', email: DEFAULT_EMAIL, password: 'forgotten', displayName: 'Old name' },
    ]);
    const { profiles } = createProfilesDouble();

    const result = await seedAdmin(auth, profiles, { ...options, resetPassword: true });

    expect(accounts.get('existing')).toMatchObject({
      password: DEFAULT_PASSWORD,
      displayName: DEFAULT_DISPLAY_NAME,
    });
    expect(result.passwordReset).toBe(true);
  });

  it('propagates an error that is not a missing account', async () => {
    const { auth } = createAuthDouble();
    const { profiles, stored } = createProfilesDouble();
    const failing: SeedAuth = {
      ...auth,
      getUserByEmail: () => Promise.reject(new Error('emulator unreachable')),
    };

    await expect(seedAdmin(failing, profiles, options)).rejects.toThrow('emulator unreachable');
    expect(stored.size).toBe(0);
  });
});
