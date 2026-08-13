import { Inject, Injectable } from '@nestjs/common';
import type { Firestore } from '@google-cloud/firestore';
import {
  COLLECTIONS,
  h5pContentSchema,
  type CreateH5pContentInput,
  type H5pContent,
  type ListH5pContentQuery,
  type Page,
  type UpdateH5pContentInput,
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
   * Brings the index row into line with what a save just wrote to storage.
   *
   * **A transaction because the audit is read and written**: `touchAudit` keeps
   * `createdAt`/`createdBy` from the stored row and replaces only the updated
   * half, so a plain read-then-write could lose a concurrent save's stamp.
   *
   * **The input is `{ title, mainLibrary, sizeBytes }` and nothing else.**
   * `storagePath` is derived from the id and cannot change; `pageId` is `null`
   * today and nothing sets it, but attaching an exercise to a page is the first
   * thing the admin exercise screen does, and a row rewritten from the save's
   * own fields would silently detach it. Merging over the *stored* row is what
   * keeps both.
   *
   * **`null` rather than a thrown 404**, mirroring `findById`: the service owns
   * the wording an editor sees, and `null` is also the honest answer to a row
   * deleted between an existence check and this commit.
   */
  async update(
    id: string,
    input: UpdateH5pContentInput,
    actorId: string,
  ): Promise<H5pContent | null> {
    return this.firestore.runTransaction(async (tx) => {
      const ref = this.collection.doc(id);
      const doc = await tx.get(ref);
      if (!doc.exists) {
        return null;
      }

      const existing = this.fromDocument(doc.id, doc.data()!);
      const updated = h5pContentSchema.parse({
        ...existing,
        ...input,
        audit: this.touchAudit(existing.audit, actorId),
      });

      tx.set(ref, toDocumentData(updated));
      return updated;
    });
  }

  /**
   * Existence without a parse, the way `PagesRepository.remove` reads the
   * document it is about to delete: one corrupt row would otherwise turn the
   * only route that can remove it into a 500, and nothing on the delete path
   * needs the rest of the document. `findById` keeps its parse, because a read
   * that answers with a document does have to trust its shape.
   */
  async exists(id: string): Promise<boolean> {
    return (await this.collection.doc(id).get()).exists;
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
