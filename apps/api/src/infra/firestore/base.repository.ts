import { NotFoundException } from '@nestjs/common';
import { Timestamp, type CollectionReference, type Firestore } from '@google-cloud/firestore';
import type { Audit, Page } from '@speakukrainian/shared';

/**
 * Shared Firestore access for the domain repositories. Concrete repositories
 * extend this and add their own queries — see `SectionsRepository` for the
 * reference implementation.
 *
 * Timestamps are stored natively as Firestore `Timestamp`s and converted to
 * ISO strings on read, so the rest of the app only ever sees plain JSON.
 */
export abstract class BaseRepository<T extends { id: string }> {
  protected readonly collection: CollectionReference;

  protected constructor(
    protected readonly firestore: Firestore,
    collectionName: string,
  ) {
    this.collection = firestore.collection(collectionName);
  }

  async findById(id: string): Promise<T | null> {
    const snapshot = await this.collection.doc(id).get();
    return snapshot.exists ? this.fromDocument(snapshot.id, snapshot.data()!) : null;
  }

  async findByIdOrFail(id: string): Promise<T> {
    const found = await this.findById(id);
    if (!found) {
      throw new NotFoundException(`${this.collection.id}/${id} not found`);
    }
    return found;
  }

  async delete(id: string): Promise<void> {
    await this.collection.doc(id).delete();
  }

  /** Converts a Firestore document into the domain shape. */
  protected fromDocument(id: string, data: FirebaseFirestore.DocumentData): T {
    return { id, ...(deepConvertTimestamps(data) as Record<string, unknown>) } as T;
  }

  protected async paginate(
    query: FirebaseFirestore.Query,
    limit: number,
    cursor?: string,
  ): Promise<Page<T>> {
    let scoped = query.limit(limit + 1);
    if (cursor) {
      const cursorDoc = await this.collection.doc(cursor).get();
      if (cursorDoc.exists) {
        scoped = scoped.startAfter(cursorDoc);
      }
    }

    const snapshot = await scoped.get();
    const docs = snapshot.docs.slice(0, limit);
    const hasMore = snapshot.docs.length > limit;

    return {
      items: docs.map((doc) => this.fromDocument(doc.id, doc.data())),
      nextCursor: hasMore ? (docs[docs.length - 1]?.id ?? null) : null,
    };
  }

  protected newAudit(actorId: string): Audit {
    const now = new Date().toISOString();
    return { createdAt: now, createdBy: actorId, updatedAt: now, updatedBy: actorId };
  }

  protected touchAudit(existing: Audit, actorId: string): Audit {
    return { ...existing, updatedAt: new Date().toISOString(), updatedBy: actorId };
  }
}

/** Recursively replaces Firestore `Timestamp`s with ISO-8601 strings. */
export function deepConvertTimestamps(value: unknown): unknown {
  if (value instanceof Timestamp) {
    return value.toDate().toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(deepConvertTimestamps);
  }
  if (value && typeof value === 'object' && value.constructor === Object) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        deepConvertTimestamps(v),
      ]),
    );
  }
  return value;
}
