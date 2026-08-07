import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { FIREBASE_AUTH, type FirebaseAuth, type FirebaseUser } from './firebase-auth';
import { AuthService } from './auth.service';

/**
 * The fake token deliberately disagrees with itself: a cached read says
 * `student` and a forced refresh says `admin`. Any path that forgets to force
 * the refresh therefore reports the stale role and fails these tests.
 */
const signedIn: FirebaseUser = {
  uid: 'uid-1',
  email: 'ada@example.com',
  displayName: 'Ada',
  getIdToken: () => Promise.resolve('id-token'),
  getIdTokenResult: (forceRefresh?: boolean) =>
    Promise.resolve({ claims: { role: forceRefresh ? 'admin' : 'student' } }),
};

/**
 * Handed to the service through DI rather than by mocking `firebase/auth`:
 * see the comment on `FirebaseAuth`. A provider cannot fail to be applied, so
 * these tests can never fall through to the real SDK and the network.
 */
function fakeFirebaseAuth(): FirebaseAuth & { setUser(user: FirebaseUser | null): void } {
  let currentUser: FirebaseUser | null = null;
  return {
    get currentUser(): FirebaseUser | null {
      return currentUser;
    },
    setUser: (user) => {
      currentUser = user;
    },
    onIdTokenChanged: () => undefined,
    signIn: () => {
      currentUser = signedIn;
      return Promise.resolve();
    },
    signOut: () => {
      currentUser = null;
      return Promise.resolve();
    },
  };
}

describe('AuthService', () => {
  let firebase: ReturnType<typeof fakeFirebaseAuth>;

  beforeEach(() => {
    firebase = fakeFirebaseAuth();
    TestBed.configureTestingModule({
      providers: [AuthService, { provide: FIREBASE_AUTH, useValue: firebase }],
    });
  });

  it('uses the freshly minted token after signing in', async () => {
    const service = TestBed.inject(AuthService);

    await service.signIn('ada@example.com', 'password');

    expect(service.user()?.role).toBe('admin');
    expect(service.user()?.email).toBe('ada@example.com');
    expect(service.isStaff()).toBe(true);
    expect(service.ready()).toBe(true);
  });

  it('reports a student as authenticated but not staff', async () => {
    const service = TestBed.inject(AuthService);
    firebase.setUser({
      ...signedIn,
      getIdTokenResult: () => Promise.resolve({ claims: { role: 'student' } }),
    });

    await service.refreshClaims();

    expect(service.isAuthenticated()).toBe(true);
    expect(service.isStaff()).toBe(false);
    expect(service.isAdmin()).toBe(false);
  });

  it('clears the user when refreshing claims while signed out', async () => {
    const service = TestBed.inject(AuthService);
    await service.signIn('ada@example.com', 'password');

    firebase.setUser(null);
    const result = await service.refreshClaims();

    expect(result).toBeNull();
    expect(service.user()).toBeNull();
    expect(service.isAuthenticated()).toBe(false);
  });

  it('signs the session out through the SDK, not only in the signals', async () => {
    const service = TestBed.inject(AuthService);
    await service.signIn('ada@example.com', 'password');

    await service.signOut();

    // `onIdTokenChanged` is what clears the signals in the real SDK, so what
    // this pins is that the session itself was ended.
    expect(firebase.currentUser).toBeNull();
    expect(await service.getIdToken()).toBeNull();
  });
});
