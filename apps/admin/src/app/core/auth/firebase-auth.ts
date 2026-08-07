import { InjectionToken } from '@angular/core';
import { initializeApp } from 'firebase/app';
import {
  connectAuthEmulator,
  getAuth,
  onIdTokenChanged,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from 'firebase/auth';
import { environment } from '../../../environments/environment';

/**
 * The user fields the admin reads. Firebase's own `User` satisfies it, so the
 * SDK object is passed straight through; naming the four members is what lets a
 * test stand in a plain object instead of a hundred-member stub.
 */
export interface FirebaseUser {
  readonly uid: string;
  readonly email: string | null;
  readonly displayName: string | null;
  getIdToken(forceRefresh?: boolean): Promise<string>;
  getIdTokenResult(forceRefresh?: boolean): Promise<{ claims: Record<string, unknown> }>;
}

/**
 * The slice of Firebase Auth this app uses, reached through a token rather than
 * by importing the SDK's functions where they are called.
 *
 * The seam exists so a test can replace the SDK by overriding a provider.
 * Replacing it with `vi.mock('firebase/auth')` is not reliable here: the
 * Angular unit-test builder runs Vitest with `isolate: false`, so every spec in
 * a worker shares one module registry. A spec that imports `AuthService`
 * without mocking — the guard and login-page specs both do, for the type —
 * leaves that module evaluated and bound to the real SDK, and a later spec in
 * the same worker gets the cached copy however well its own mock landed. The
 * real `signInWithEmailAndPassword` then runs and reaches the network, which is
 * a unit suite failing on whether an emulator happens to hold a user.
 */
export interface FirebaseAuth {
  /** Read on every call: the SDK replaces it as the session changes. */
  readonly currentUser: FirebaseUser | null;
  onIdTokenChanged(next: (user: FirebaseUser | null) => void): void;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
}

export const FIREBASE_AUTH = new InjectionToken<FirebaseAuth>('FIREBASE_AUTH', {
  providedIn: 'root',
  factory: () => firebaseAuthSdk(),
});

function firebaseAuthSdk(): FirebaseAuth {
  const auth = getAuth(initializeApp(environment.firebase));
  if (environment.authEmulatorUrl) {
    connectAuthEmulator(auth, environment.authEmulatorUrl, { disableWarnings: true });
  }

  return {
    get currentUser(): User | null {
      return auth.currentUser;
    },
    onIdTokenChanged: (next) => {
      // Never unsubscribed: this listener is the app's own session, and the
      // token it is provided by lives as long as the root injector.
      onIdTokenChanged(auth, next);
    },
    signIn: async (email, password) => {
      await signInWithEmailAndPassword(auth, email, password);
    },
    signOut: () => signOut(auth),
  };
}
