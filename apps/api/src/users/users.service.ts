import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Auth, UserRecord } from 'firebase-admin/auth';
import {
  userRoleSchema,
  type AuthClaims,
  type Page,
  type PaginationQuery,
  type UserProfile,
  type UserRole,
} from '@speakukrainian/shared';
import { FIREBASE_AUTH } from '../auth/auth.tokens.js';
import type { AuthenticatedUser } from '../auth/firebase-auth.guard.js';
import { UsersRepository } from './users.repository.js';

/** What the token currently claims, which is what a rolled-back document has to match. */
function claimedRole(record: UserRecord): UserRole {
  const claims: unknown = record.customClaims;
  const role =
    typeof claims === 'object' && claims !== null
      ? (claims as Record<string, unknown>)['role']
      : undefined;
  const parsed = userRoleSchema.safeParse(role);
  return parsed.success ? parsed.data : 'student';
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

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
   * The custom claim is what `RolesGuard` reads, so the profile document is
   * written first and the claim second: a failed Firestore write must not leave
   * a token granting access the profile does not reflect. If the claim write is
   * the one that fails, the document is put back where the token still stands.
   *
   * Refresh tokens are deliberately not revoked: `FirebaseAuthGuard` verifies
   * with `checkRevoked`, so revoking here would sign the user out mid-session
   * instead of quietly re-issuing their claims.
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

    const updated =
      (await this.repository.setRole(uid, role, actor.uid)) ??
      (await this.provision(record, role, actor.uid));

    try {
      await this.auth.setCustomUserClaims(uid, { role } satisfies AuthClaims);
    } catch (error) {
      await this.rollbackRole(uid, claimedRole(record), actor.uid);
      throw error;
    }

    return updated;
  }

  private async provision(
    record: UserRecord,
    role: UserRole,
    actorId: string,
  ): Promise<UserProfile> {
    if (!record.email) {
      throw new BadRequestException(`User ${record.uid} has no email address`);
    }

    return this.repository.create(
      { id: record.uid, email: record.email, displayName: record.displayName, role },
      actorId,
    );
  }

  private async rollbackRole(uid: string, role: UserRole, actorId: string): Promise<void> {
    try {
      await this.repository.setRole(uid, role, actorId);
    } catch (error) {
      // Reporting the claim failure matters more than this one, so it is logged
      // rather than thrown — but the two stores are now out of step.
      this.logger.error(
        `Failed to roll ${uid} back to "${role}" after the claim write failed; the profile document and the token now disagree.`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  async list(query: PaginationQuery): Promise<Page<UserProfile>> {
    return this.repository.list(query);
  }
}
