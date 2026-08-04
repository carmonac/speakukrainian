import { pathToFileURL } from 'node:url';
import {
  COLLECTIONS,
  userProfileSchema,
  userRoleSchema,
  type AuthClaims,
  type UserProfile,
  type UserRole,
} from '@speakukrainian/shared';

export const DEFAULT_EMAIL = 'admin@speakukrainian.local';
export const DEFAULT_PASSWORD = 'password';
export const DEFAULT_DISPLAY_NAME = 'Admin';
export const SEED_ACTOR = 'seed';

export interface SeedOptions {
  email: string;
  password: string;
  displayName: string;
  role: UserRole;
}

const SUPPORTED_FLAGS = ['--email', '--password', '--name', '--role'] as const;

export function parseOptions(argv: string[], env: NodeJS.ProcessEnv): SeedOptions {
  const flags = new Map<string, string>();

  for (const arg of argv) {
    const separator = arg.indexOf('=');
    const name = separator === -1 ? arg : arg.slice(0, separator);
    if (!SUPPORTED_FLAGS.includes(name as (typeof SUPPORTED_FLAGS)[number]) || separator === -1) {
      throw new Error(
        `Unsupported argument "${arg}". Supported: ${SUPPORTED_FLAGS.map((flag) => `${flag}=<value>`).join(', ')}`,
      );
    }
    flags.set(name, arg.slice(separator + 1));
  }

  return {
    email: flags.get('--email') ?? env['SEED_ADMIN_EMAIL'] ?? DEFAULT_EMAIL,
    password: flags.get('--password') ?? env['SEED_ADMIN_PASSWORD'] ?? DEFAULT_PASSWORD,
    displayName: flags.get('--name') ?? env['SEED_ADMIN_NAME'] ?? DEFAULT_DISPLAY_NAME,
    role: userRoleSchema.parse(flags.get('--role') ?? env['SEED_ADMIN_ROLE'] ?? 'admin'),
  };
}

/**
 * The script writes an account and a Firestore document, so both emulator hosts
 * must be set. Pointing either at a real project is the same class of accident.
 */
export function assertEmulator(env: NodeJS.ProcessEnv): void {
  const missing = (['FIREBASE_AUTH_EMULATOR_HOST', 'FIRESTORE_EMULATOR_HOST'] as const).filter(
    (name) => !env[name],
  );

  if (missing.length > 0) {
    throw new Error(
      `Refusing to run: ${missing.join(' and ')} not set. This script only ever targets the local emulators — copy .env.example to .env and start them with \`pnpm emulators:up\`.`,
    );
  }
}

/** Structural subset of `firebase-admin`'s `Auth`, so the spec needs no SDK. */
export interface SeedAuth {
  getUserByEmail(email: string): Promise<{ uid: string }>;
  createUser(props: {
    email: string;
    password: string;
    displayName: string;
    emailVerified: boolean;
  }): Promise<{ uid: string }>;
  updateUser(uid: string, props: { password: string; displayName: string }): Promise<{ uid: string }>;
  setCustomUserClaims(uid: string, claims: object | null): Promise<void>;
}

export interface SeedProfiles {
  get(uid: string): Promise<UserProfile | null>;
  set(uid: string, profile: UserProfile): Promise<void>;
}

export interface SeedResult {
  uid: string;
  email: string;
  role: UserRole;
  created: boolean;
}

function isUserNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'auth/user-not-found'
  );
}

/**
 * Idempotent: a second run reuses the existing account and rewrites the same
 * profile document, so there is never a duplicate of either.
 */
export async function seedAdmin(
  auth: SeedAuth,
  profiles: SeedProfiles,
  options: SeedOptions,
  now: () => string = () => new Date().toISOString(),
): Promise<SeedResult> {
  const { email, password, displayName, role } = options;

  const found = await auth.getUserByEmail(email).catch((error: unknown) => {
    if (isUserNotFound(error)) {
      return null;
    }
    throw error;
  });

  let uid: string;
  const created = found === null;

  if (found) {
    uid = found.uid;
    // Repeat runs keep the documented password and name working.
    await auth.updateUser(uid, { password, displayName });
  } else {
    ({ uid } = await auth.createUser({ email, password, displayName, emailVerified: true }));
  }

  await auth.setCustomUserClaims(uid, { role } satisfies AuthClaims);

  const existing = await profiles.get(uid);
  const timestamp = now();
  const profile = userProfileSchema.parse({
    id: uid,
    email,
    displayName,
    role,
    disabled: false,
    audit: {
      createdAt: existing?.audit.createdAt ?? timestamp,
      createdBy: existing?.audit.createdBy ?? SEED_ACTOR,
      updatedAt: timestamp,
      updatedBy: SEED_ACTOR,
    },
  });
  await profiles.set(uid, profile);

  return { uid, email, role, created };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2), process.env);
  assertEmulator(process.env);

  // Imported only after the guard above: a static import is evaluated before
  // any statement in this file, so the SDK would initialize before we could
  // refuse to touch a real project.
  const { getApps, initializeApp } = await import('firebase-admin/app');
  const { getAuth } = await import('firebase-admin/auth');
  const { Firestore } = await import('@google-cloud/firestore');

  const projectId = process.env['GOOGLE_CLOUD_PROJECT'] ?? 'speakukrainian-local';
  // No credential: the Auth emulator accepts any, matching `auth.module.ts`.
  const app = getApps()[0] ?? initializeApp({ projectId });
  const auth = getAuth(app);
  const firestore = new Firestore({ projectId, ignoreUndefinedProperties: true });
  const collection = firestore.collection(COLLECTIONS.users);

  const profiles: SeedProfiles = {
    async get(uid) {
      const snapshot = await collection.doc(uid).get();
      return snapshot.exists ? userProfileSchema.parse({ id: uid, ...snapshot.data() }) : null;
    },
    async set(uid, profile) {
      const { id: _id, ...data } = profile;
      await collection.doc(uid).set(data);
    },
  };

  try {
    const result = await seedAdmin(auth, profiles, options);
    console.log(
      `${result.created ? 'Created' : 'Updated'} ${result.email} (uid ${result.uid}) with role "${result.role}".`,
    );
  } finally {
    await firestore.terminate();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
