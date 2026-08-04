import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  RedirectCommand,
  Router,
  provideRouter,
  type ActivatedRouteSnapshot,
  type RouterStateSnapshot,
} from '@angular/router';
import { firstValueFrom, isObservable } from 'rxjs';
import { describe, expect, it } from 'vitest';
import type { UserRole } from '@speakukrainian/shared';
import { AuthService, type AdminUser } from './auth.service';
import { STAFF_DENIED_MESSAGE, staffGuard } from './staff.guard';

const ATTEMPTED_URL = '/sections/sec-1';

function adminUser(role: UserRole): AdminUser {
  return { uid: 'uid-1', email: 'ada@example.com', displayName: 'Ada', role };
}

interface AuthFake {
  service: AuthService;
  ready: WritableSignal<boolean>;
  user: WritableSignal<AdminUser | null>;
  refreshCount: () => number;
}

/**
 * Signals stand in for the real service's state so a test can flip `ready` mid
 * flight and watch the guard react.
 */
function createAuthFake(options: {
  ready?: boolean;
  role?: UserRole | null;
  refreshedRole?: UserRole;
}): AuthFake {
  const ready = signal(options.ready ?? true);
  const user = signal<AdminUser | null>(options.role ? adminUser(options.role) : null);
  let refreshCount = 0;

  const service = {
    ready: ready.asReadonly(),
    user: user.asReadonly(),
    isAuthenticated: () => user() !== null,
    isStaff: () => {
      const role = user()?.role;
      return role === 'admin' || role === 'editor';
    },
    refreshClaims: () => {
      refreshCount += 1;
      if (options.refreshedRole) {
        user.set(adminUser(options.refreshedRole));
      }
      return Promise.resolve(user());
    },
  } as unknown as AuthService;

  return { service, ready, user, refreshCount: () => refreshCount };
}

function runGuard(fake: AuthFake) {
  TestBed.configureTestingModule({
    providers: [provideRouter([]), { provide: AuthService, useValue: fake.service }],
  });

  const route = {} as ActivatedRouteSnapshot;
  const state = { url: ATTEMPTED_URL } as RouterStateSnapshot;
  const result = TestBed.runInInjectionContext(() => staffGuard(route, state));

  if (!isObservable(result)) {
    throw new Error('staffGuard is expected to return an observable');
  }
  return result;
}

/** `toObservable` propagates through an effect, so change detection has to run. */
async function resolveGuard(fake: AuthFake): Promise<boolean | RedirectCommand> {
  const settled = firstValueFrom(runGuard(fake));
  TestBed.tick();
  return settled as Promise<boolean | RedirectCommand>;
}

describe('staffGuard', () => {
  it('lets an admin through without minting a new token', async () => {
    const fake = createAuthFake({ role: 'admin' });

    expect(await resolveGuard(fake)).toBe(true);
    expect(fake.refreshCount()).toBe(0);
  });

  it('lets an editor through without minting a new token', async () => {
    const fake = createAuthFake({ role: 'editor' });

    expect(await resolveGuard(fake)).toBe(true);
    expect(fake.refreshCount()).toBe(0);
  });

  it('admits a user promoted since their cached token was minted', async () => {
    // Acceptance criterion: granting `editor` and refreshing gets them in with
    // no sign-out, which only works if the guard forces one token refresh.
    const fake = createAuthFake({ role: 'student', refreshedRole: 'editor' });

    expect(await resolveGuard(fake)).toBe(true);
    expect(fake.refreshCount()).toBe(1);
  });

  it('bounces a student to login with an explanation and the attempted URL', async () => {
    const fake = createAuthFake({ role: 'student' });

    const result = await resolveGuard(fake);

    expect(result).toBeInstanceOf(RedirectCommand);
    const redirect = result as RedirectCommand;
    expect(TestBed.inject(Router).serializeUrl(redirect.redirectTo)).toBe('/login');
    expect(redirect.navigationBehaviorOptions?.state).toEqual({
      returnUrl: ATTEMPTED_URL,
      message: STAFF_DENIED_MESSAGE,
    });
  });

  it('does not claim a signed out visitor lacks access', async () => {
    const fake = createAuthFake({ role: null });

    const result = (await resolveGuard(fake)) as RedirectCommand;

    expect(result.navigationBehaviorOptions?.state).toEqual({ returnUrl: ATTEMPTED_URL });
  });

  it('emits nothing until the session has been restored', async () => {
    const fake = createAuthFake({ ready: false, role: 'admin' });

    let emitted: unknown;
    const subscription = runGuard(fake).subscribe((value) => (emitted = value));
    TestBed.tick();
    await Promise.resolve();
    expect(emitted).toBeUndefined();

    fake.ready.set(true);
    TestBed.tick();
    await Promise.resolve();
    expect(emitted).toBe(true);
    subscription.unsubscribe();
  });
});
