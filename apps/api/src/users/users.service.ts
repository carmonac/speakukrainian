import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Auth } from 'firebase-admin/auth';
import type {
  AuthClaims,
  Page,
  PaginationQuery,
  UserProfile,
  UserRole,
} from '@speakukrainian/shared';
import { FIREBASE_AUTH } from '../auth/auth.tokens.js';
import type { AuthenticatedUser } from '../auth/firebase-auth.guard.js';
import { UsersRepository } from './users.repository.js';

@Injectable()
export class UsersService {
  constructor(
    private readonly repository: UsersRepository,
    @Inject(FIREBASE_AUTH) private readonly auth: Auth,
  ) {}

  /**
   * Reads the caller's profile, writing one on first sight. The role comes from
   * the verified token — `FirebaseAuthGuard` has already defaulted it to
   * `student` for a caller with no claim — so the document can never contradict
   * the token that authorized the request.
   */
  async getOrProvision(caller: AuthenticatedUser): Promise<UserProfile> {
    const existing = await this.repository.findById(caller.uid);
    if (existing) {
      return existing;
    }

    if (!caller.email) {
      throw new BadRequestException('Account has no email address');
    }

    return this.repository.create(
      { id: caller.uid, email: caller.email, role: caller.role },
      caller.uid,
    );
  }

  /**
   * The custom claim is what `RolesGuard` reads, so it is written first and the
   * profile document mirrors it. Refresh tokens are deliberately not revoked:
   * `FirebaseAuthGuard` verifies with `checkRevoked`, so revoking here would
   * sign the user out mid-session instead of quietly re-issuing their claims.
   */
  async setRole(uid: string, role: UserRole, actor: AuthenticatedUser): Promise<UserProfile> {
    if (uid === actor.uid) {
      // There is no user-management UI in this phase, so a self-demotion would
      // lock everyone out of the admin-only routes with no way back.
      throw new BadRequestException('You cannot change your own role');
    }

    const record = await this.auth.getUser(uid).catch(() => {
      throw new NotFoundException(`User ${uid} not found`);
    });

    await this.auth.setCustomUserClaims(uid, { role } satisfies AuthClaims);

    const updated = await this.repository.setRole(uid, role, actor.uid);
    if (updated) {
      return updated;
    }

    if (!record.email) {
      throw new BadRequestException(`User ${uid} has no email address`);
    }

    return this.repository.create(
      { id: uid, email: record.email, displayName: record.displayName, role },
      actor.uid,
    );
  }

  async list(query: PaginationQuery): Promise<Page<UserProfile>> {
    return this.repository.list(query);
  }
}
