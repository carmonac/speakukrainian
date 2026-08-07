import { Injectable, computed, inject, signal } from '@angular/core';
// The `/roles` entry point carries no Zod: importing the comparison from the
// barrel puts the whole schema package in the eager bundle.
import { hasAtLeastRole } from '@speakukrainian/shared/roles';
import type { UserRole } from '@speakukrainian/shared';
import { FIREBASE_AUTH, type FirebaseUser } from './firebase-auth';

export interface AdminUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  role: UserRole;
}

/**
 * Wraps Firebase Auth. The current user is exposed as a signal so guards,
 * the shell and interceptors all read the same source of truth.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly auth = inject(FIREBASE_AUTH);

  private readonly currentUser = signal<AdminUser | null>(null);
  /** `null` while the first auth state callback is still pending. */
  private readonly initialized = signal(false);

  readonly user = this.currentUser.asReadonly();
  readonly ready = this.initialized.asReadonly();
  readonly isAuthenticated = computed(() => this.currentUser() !== null);
  readonly isAdmin = computed(() => this.currentUser()?.role === 'admin');
  /** Roles are hierarchical, so an admin is staff too. */
  readonly isStaff = computed(() => {
    const role = this.currentUser()?.role;
    return role ? hasAtLeastRole(role, 'editor') : false;
  });

  constructor() {
    this.auth.onIdTokenChanged(async (user: FirebaseUser | null) => {
      this.currentUser.set(user ? await toAdminUser(user) : null);
      this.initialized.set(true);
    });
  }

  async signIn(email: string, password: string): Promise<void> {
    await this.auth.signIn(email, password);
    // A claim granted since the last session is only in a freshly minted token.
    await this.refreshClaims();
  }

  /**
   * Forces a new ID token and re-reads its claims. Deliberately not called from
   * `onIdTokenChanged` — minting a token there would re-enter the callback.
   */
  async refreshClaims(): Promise<AdminUser | null> {
    const user = this.auth.currentUser;
    const next = user ? await toAdminUser(user, true) : null;
    this.currentUser.set(next);
    this.initialized.set(true);
    return next;
  }

  async signOut(): Promise<void> {
    await this.auth.signOut();
  }

  /** Fresh ID token for the API call about to be made, or null when signed out. */
  async getIdToken(): Promise<string | null> {
    return (await this.auth.currentUser?.getIdToken()) ?? null;
  }
}

async function toAdminUser(user: FirebaseUser, forceRefresh = false): Promise<AdminUser> {
  const token = await user.getIdTokenResult(forceRefresh);
  return {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
    role: (token.claims['role'] as UserRole | undefined) ?? 'student',
  };
}
