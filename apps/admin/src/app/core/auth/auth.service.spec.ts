import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service';

/**
 * The fake token deliberately disagrees with itself: a cached read says
 * `student` and a forced refresh says `admin`. Any path that forgets to force
 * the refresh therefore reports the stale role and fails these tests.
 *
 * Built with `vi.hoisted` because `vi.mock` factories are hoisted above imports.
 */
const firebase = vi.hoisted(() => {
  const user = {
    uid: 'uid-1',
    email: 'ada@example.com',
    displayName: 'Ada',
    getIdTokenResult: (forceRefresh?: boolean) =>
      Promise.resolve({ claims: { role: forceRefresh ? 'admin' : 'student' } }),
  };

  const auth: { currentUser: typeof user | null } = { currentUser: null };
  return { user, auth };
});

vi.mock('firebase/app', () => ({ initializeApp: () => ({}) }));

vi.mock('firebase/auth', () => ({
  getAuth: () => firebase.auth,
  connectAuthEmulator: () => undefined,
  onIdTokenChanged: () => () => undefined,
  signInWithEmailAndPassword: () => {
    firebase.auth.currentUser = firebase.user;
    return Promise.resolve({ user: firebase.user });
  },
  signOut: () => {
    firebase.auth.currentUser = null;
    return Promise.resolve();
  },
}));

describe('AuthService', () => {
  beforeEach(() => {
    firebase.auth.currentUser = null;
    TestBed.configureTestingModule({ providers: [AuthService] });
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
    firebase.auth.currentUser = {
      ...firebase.user,
      getIdTokenResult: () => Promise.resolve({ claims: { role: 'student' } }),
    };

    await service.refreshClaims();

    expect(service.isAuthenticated()).toBe(true);
    expect(service.isStaff()).toBe(false);
    expect(service.isAdmin()).toBe(false);
  });

  it('clears the user when refreshing claims while signed out', async () => {
    const service = TestBed.inject(AuthService);
    await service.signIn('ada@example.com', 'password');

    firebase.auth.currentUser = null;
    const result = await service.refreshClaims();

    expect(result).toBeNull();
    expect(service.user()).toBeNull();
    expect(service.isAuthenticated()).toBe(false);
  });
});
