import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { describe, expect, it } from 'vitest';
import type { UserRole } from '@speakukrainian/shared';
import { AuthService, type AdminUser } from '../../core/auth/auth.service';
import { STAFF_DENIED_MESSAGE, staffGuard } from '../../core/auth/staff.guard';
import { LoginPage } from './login-page';

@Component({ selector: 'app-shell-stub', template: 'shell' })
class ShellStub {}

interface AuthFake {
  service: AuthService;
  role: (next: UserRole) => void;
}

/** Only what `LoginPage` and `staffGuard` reach for; the real one boots Firebase. */
function createAuthFake(role: UserRole): AuthFake {
  const user = signal<AdminUser | null>(null);
  let signedInAs = role;

  const service = {
    ready: signal(true).asReadonly(),
    user: user.asReadonly(),
    isAuthenticated: () => user() !== null,
    isStaff: () => {
      const current = user()?.role;
      return current === 'admin' || current === 'editor';
    },
    refreshClaims: () => Promise.resolve(user()),
    signIn: (email: string) => {
      user.set({ uid: 'uid-1', email, displayName: null, role: signedInAs });
      return Promise.resolve();
    },
  } as unknown as AuthService;

  return {
    service,
    role: (next: UserRole) => {
      signedInAs = next;
    },
  };
}

function setup(role: UserRole): AuthFake {
  const auth = createAuthFake(role);
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        { path: 'login', component: LoginPage },
        { path: 'sections', component: ShellStub, canActivate: [staffGuard] },
      ]),
      { provide: AuthService, useValue: auth.service },
    ],
  });
  return auth;
}

function requireElement<T extends Element>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) {
    throw new Error(`Expected the login page to render "${selector}"`);
  }
  return found;
}

function loginElement(harness: RouterTestingHarness): HTMLElement {
  const element = harness.routeNativeElement;
  if (!(element instanceof HTMLElement)) {
    throw new Error('Expected the login page to be the activated route');
  }
  return element;
}

function alertText(harness: RouterTestingHarness): string | null {
  harness.detectChanges();
  return loginElement(harness).querySelector('[role="alert"]')?.textContent?.trim() ?? null;
}

async function signIn(harness: RouterTestingHarness): Promise<void> {
  const root = loginElement(harness);
  const [email, password] = Array.from(root.querySelectorAll('input'));
  for (const [input, value] of [
    [email, 'student@example.com'],
    [password, 'password'],
  ] as const) {
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }
  harness.detectChanges();

  requireElement(root, 'form').dispatchEvent(new Event('submit'));
  await harness.fixture.whenStable();
  harness.detectChanges();
}

describe('LoginPage', () => {
  it('explains the refusal when a guard bounces the user straight back', async () => {
    // The router reuses the already-activated `LoginPage` for the redirect, so
    // nothing re-runs a field initializer — the regression this covers is a
    // student landing back on an empty form with no explanation at all.
    const auth = setup('student');
    const harness = await RouterTestingHarness.create('/login');
    const page = harness.routeDebugElement?.componentInstance as LoginPage;

    await signIn(harness);

    expect(TestBed.inject(Router).url).toBe('/login');
    expect(harness.routeDebugElement?.componentInstance).toBe(page);
    expect(alertText(harness)).toBe(STAFF_DENIED_MESSAGE);
    expect(auth.service.isAuthenticated()).toBe(true);
  });

  it('explains the refusal on a cold load of /login', async () => {
    setup('student');
    const harness = await RouterTestingHarness.create();

    await TestBed.inject(Router).navigate(['/login'], {
      state: { returnUrl: '/sections', message: STAFF_DENIED_MESSAGE },
    });

    expect(alertText(harness)).toBe(STAFF_DENIED_MESSAGE);
  });

  it('shows no alert when /login is reached without guard state', async () => {
    setup('student');
    const harness = await RouterTestingHarness.create('/login');

    expect(alertText(harness)).toBeNull();
  });

  it('takes a promoted user to the URL the guard handed back', async () => {
    const auth = setup('student');
    const harness = await RouterTestingHarness.create('/login');
    await signIn(harness);

    auth.role('editor');
    await signIn(harness);

    expect(TestBed.inject(Router).url).toBe('/sections');
  });
});
