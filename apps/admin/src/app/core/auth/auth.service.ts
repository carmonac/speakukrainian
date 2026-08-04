import { Injectable, computed, signal } from '@angular/core';
import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  connectAuthEmulator,
  getAuth,
  onIdTokenChanged,
  signInWithEmailAndPassword,
  signOut,
  type Auth,
  type User,
} from 'firebase/auth';
import { hasAtLeastRole, type UserRole } from '@speakukrainian/shared';
import { environment } from '../../../environments/environment';

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
  private readonly app: FirebaseApp = initializeApp(environment.firebase);
  private readonly auth: Auth = getAuth(this.app);

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
    if (environment.authEmulatorUrl) {
      connectAuthEmulator(this.auth, environment.authEmulatorUrl, { disableWarnings: true });
    }

    onIdTokenChanged(this.auth, async (user: User | null) => {
      this.currentUser.set(user ? await toAdminUser(user) : null);
      this.initialized.set(true);
    });
  }

  async signIn(email: string, password: string): Promise<void> {
    await signInWithEmailAndPassword(this.auth, email, password);
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
    await signOut(this.auth);
  }

  /** Fresh ID token for the API call about to be made, or null when signed out. */
  async getIdToken(): Promise<string | null> {
    return (await this.auth.currentUser?.getIdToken()) ?? null;
  }
}

async function toAdminUser(user: User, forceRefresh = false): Promise<AdminUser> {
  const token = await user.getIdTokenResult(forceRefresh);
  return {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
    role: (token.claims['role'] as UserRole | undefined) ?? 'student',
  };
}
