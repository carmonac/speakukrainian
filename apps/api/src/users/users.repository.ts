import { Inject, Injectable } from '@nestjs/common';
import type { Firestore } from '@google-cloud/firestore';
import {
  COLLECTIONS,
  userProfileSchema,
  type Page,
  type PaginationQuery,
  type UserProfile,
  type UserRole,
} from '@speakukrainian/shared';
import { BaseRepository, deepConvertTimestamps } from '../infra/firestore/base.repository.js';
import { FIRESTORE } from '../infra/firestore/firestore.tokens.js';

export interface CreateUserProfileInput {
  id: string;
  email: string;
  displayName?: string;
  photoUrl?: string;
  role: UserRole;
}

/** `id` is the document id, so it is not duplicated inside the document body. */
export function toDocumentData(profile: UserProfile): Record<string, unknown> {
  const { id: _id, ...data } = profile;
  return data;
}

@Injectable()
export class UsersRepository extends BaseRepository<UserProfile> {
  constructor(@Inject(FIRESTORE) firestore: Firestore) {
    super(firestore, COLLECTIONS.users);
  }

  /**
   * Parsing on read means a hand-edited or seed-written document with the wrong
   * shape fails loudly instead of flowing into an API response.
   */
  protected override fromDocument(id: string, data: FirebaseFirestore.DocumentData): UserProfile {
    return userProfileSchema.parse({ id, ...(deepConvertTimestamps(data) as object) });
  }

  async create(input: CreateUserProfileInput, actorId: string): Promise<UserProfile> {
    const profile = userProfileSchema.parse({
      ...input,
      disabled: false,
      audit: this.newAudit(actorId),
    });
    await this.collection.doc(profile.id).set(toDocumentData(profile));
    return profile;
  }

  /** Returns `null` when no profile document exists; the caller decides how to provision one. */
  async setRole(id: string, role: UserRole, actorId: string): Promise<UserProfile | null> {
    const existing = await this.findById(id);
    if (!existing) {
      return null;
    }

    const next: UserProfile = { ...existing, role, audit: this.touchAudit(existing.audit, actorId) };
    await this.collection.doc(id).set(toDocumentData(next));
    return next;
  }

  async list(query: PaginationQuery): Promise<Page<UserProfile>> {
    return this.paginate(this.collection.orderBy('email'), query.limit, query.cursor);
  }
}
