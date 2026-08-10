import { Inject, Injectable } from '@nestjs/common';
import type { Firestore } from '@google-cloud/firestore';
import {
  COLLECTIONS,
  h5pContentSchema,
  type CreateH5pContentInput,
  type H5pContent,
  type ListH5pContentQuery,
  type Page,
} from '@speakukrainian/shared';
import { BaseRepository, deepConvertTimestamps } from '../infra/firestore/base.repository.js';
import { FIRESTORE } from '../infra/firestore/firestore.tokens.js';

/** `id` is the document id, so it is not duplicated inside the document body. */
export function toDocumentData(content: H5pContent): Record<string, unknown> {
  const { id: _id, ...data } = content;
  return data;
}

/**
 * The admin-facing index over H5P content. The files themselves live in Cloud
 * Storage under `storagePath`; this collection is what makes them listable.
 */
@Injectable()
export class H5pContentRepository extends BaseRepository<H5pContent> {
  constructor(@Inject(FIRESTORE) firestore: Firestore) {
    super(firestore, COLLECTIONS.h5pContent);
  }

  /**
   * Parsing on read means a hand-edited or seed-written document with the wrong
   * shape fails loudly instead of flowing into an API response.
   */
  protected override fromDocument(id: string, data: FirebaseFirestore.DocumentData): H5pContent {
    return h5pContentSchema.parse({ id, ...(deepConvertTimestamps(data) as object) });
  }

  /**
   * `create`, never `set`: the document id *is* the H5P content id, so a
   * collision means the id generator handed out a duplicate. Overwriting would
   * silently detach an existing exercise from its files.
   */
  async create(input: CreateH5pContentInput, actorId: string): Promise<H5pContent> {
    const content = h5pContentSchema.parse({ ...input, audit: this.newAudit(actorId) });

    await this.collection.doc(content.id).create(toDocumentData(content));
    return content;
  }

  /**
   * Newest first, which is the order an admin who has just uploaded something
   * reads this index in.
   *
   * `audit.createdAt` is `newAudit`'s `toISOString()`, always the millisecond
   * `…Z` form, so lexicographic order is chronological order. Firestore appends
   * `__name__` to the ordering implicitly, so two uploads in the same
   * millisecond still order deterministically and the cursor is stable. One
   * `orderBy` and no `where`, so no composite index is needed.
   */
  async list(query: ListH5pContentQuery): Promise<Page<H5pContent>> {
    return this.paginate(
      this.collection.orderBy('audit.createdAt', 'desc'),
      query.limit,
      query.cursor,
    );
  }
}
