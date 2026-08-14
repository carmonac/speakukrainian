import { Inject, Injectable } from '@nestjs/common';
import type { CollectionReference, Firestore } from '@google-cloud/firestore';
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

/** Why `setPageId` refused. The repository reports; the service words the HTTP. */
export type SetPageIdResult =
  | { ok: true; content: H5pContent }
  | { ok: false; reason: 'content-not-found' }
  | { ok: false; reason: 'page-not-found' }
  | { ok: false; reason: 'attached-elsewhere'; pageId: string };

/**
 * The admin-facing index over H5P content. The files themselves live in Cloud
 * Storage under `storagePath`; this collection is what makes them listable.
 */
@Injectable()
export class H5pContentRepository extends BaseRepository<H5pContent> {
  /**
   * Read straight from the pages collection rather than through a port
   * `PagesModule` exports, for the reason `PagesRepository`'s own `this.sections`
   * gives: the document has to be read *inside* this repository's transaction to
   * be a read-before-write. The rule that separates the two patterns is what the
   * foreign module is asked for — `SectionsRepository` reaches pages through the
   * exported `SectionPagesRepository` because it **writes** them, carrying page
   * rules with it. This is a one-document existence read that carries no page
   * rule and never writes, so a new exported port and an import edge between two
   * modules that have never touched would buy one boolean.
   */
  private readonly pages: CollectionReference;

  constructor(@Inject(FIRESTORE) firestore: Firestore) {
    super(firestore, COLLECTIONS.h5pContent);
    this.pages = firestore.collection(COLLECTIONS.pages);
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
   * `storagePath` is derived from the id and cannot change; `pageId` is written
   * by `setPageId` and by nothing else, so a row rewritten from the save's own
   * fields would silently detach an exercise from the page an author had just
   * attached it to. Merging over the *stored* row is what keeps both, and now
   * that the field really is written that is load-bearing rather than a
   * precaution.
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
   * Attaches an exercise to a page, or detaches it, and touches nothing else
   * about the row.
   *
   * **Not a widening of `update`.** A save posts the fields it recomputed, so
   * letting it carry `pageId` would mean every save decides where the exercise
   * lives — and a save that omitted the field would detach it. `pageId` is a
   * scalar parameter here rather than a member of an input object, so there is
   * no object for a stray key to ride in on.
   *
   * **Attaching to the page it already names writes nothing at all**, rather
   * than writing the same value again: the admin attaches as part of a save
   * sequence, so a retry after a dropped response is ordinary, and
   * `audit.updatedAt` means "when this exercise was last changed". That check
   * runs *before* the page read, so re-attaching to a page that has since been
   * deleted is still a no-op rather than a refusal over a world that moved.
   *
   * **An exercise already attached to another page is refused, not moved.** The
   * field is a single nullable scalar, so the data model says at most one page;
   * a silent overwrite would turn it into "the last page anyone attached this
   * to". Moving is detach then attach, and `detach` is unconditional so the
   * escape always exists.
   *
   * **The page is read inside the transaction**, which is what makes it a
   * read-before-write and stops a page delete interleaving with this commit. It
   * buys almost nothing on its own: nothing clears `pageId` when a page is
   * deleted afterwards, so a row naming a page that no longer exists is a
   * normal and permanent state. The read is a guard against a typo or a client
   * bug at write time, not a guarantee about what the field holds at read time.
   */
  async setPageId(id: string, pageId: string | null, actorId: string): Promise<SetPageIdResult> {
    return this.firestore.runTransaction(async (tx) => {
      // Every read happens before every write — Firestore rejects the reverse.
      const ref = this.collection.doc(id);
      const doc = await tx.get(ref);
      if (!doc.exists) {
        return { ok: false, reason: 'content-not-found' };
      }

      const existing = this.fromDocument(doc.id, doc.data()!);
      if (existing.pageId === pageId) {
        return { ok: true, content: existing };
      }

      if (pageId !== null) {
        if (!(await tx.get(this.pages.doc(pageId))).exists) {
          return { ok: false, reason: 'page-not-found' };
        }
        if (existing.pageId !== null) {
          return { ok: false, reason: 'attached-elsewhere', pageId: existing.pageId };
        }
      }

      const updated = h5pContentSchema.parse({
        ...existing,
        pageId,
        audit: this.touchAudit(existing.audit, actorId),
      });

      tx.set(ref, toDocumentData(updated));
      return { ok: true, content: updated };
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
