import { Inject, Injectable } from '@nestjs/common';
import type { CollectionReference, Firestore, Query, Transaction } from '@google-cloud/firestore';
import type { z } from 'zod';
import {
  COLLECTIONS,
  contentPageSchema,
  sectionSchema,
  type ContentPage,
  type CreateContentPageInput,
  type ListPagesQuery,
  type Page,
  type UpdateContentPageInput,
} from '@speakukrainian/shared';
import { BaseRepository, deepConvertTimestamps } from '../infra/firestore/base.repository.js';
import { FIRESTORE } from '../infra/firestore/firestore.tokens.js';
import { nextPublishedAt, pagePath, sectionPathOf } from './pages.rules.js';

/** `id` is the document id, so it is not duplicated inside the document body. */
export function toDocumentData(page: ContentPage): Record<string, unknown> {
  const { id: _id, ...data } = page;
  return data;
}

/** Why a write was refused. The repository reports; the service maps to HTTP. */
export type PageWriteFailure =
  | { reason: 'not-found' }
  | { reason: 'section-not-found'; sectionId: string }
  | { reason: 'section-is-link' }
  | { reason: 'slug-taken'; slug: string }
  | { reason: 'invalid'; issues: z.core.$ZodIssue[] };

export type PageWriteRejection = { ok: false } & PageWriteFailure;
export type PageWriteResult = { ok: true; page: ContentPage } | PageWriteRejection;
export type PageDeleteResult = { ok: true } | PageWriteRejection;

@Injectable()
export class PagesRepository extends BaseRepository<ContentPage> {
  /**
   * Read straight from the sections collection rather than through
   * `SectionsService`: the owning section has to be read *inside* this
   * repository's transaction, or a concurrent rename would leave the new page
   * on a path that no longer exists. Reaching for the sections module would
   * also close a cycle — `SectionsModule` imports `PagesModule`, for the page
   * path rewrite that rides the section transaction.
   */
  private readonly sections: CollectionReference;

  constructor(@Inject(FIRESTORE) firestore: Firestore) {
    super(firestore, COLLECTIONS.pages);
    this.sections = firestore.collection(COLLECTIONS.sections);
  }

  /**
   * Parsing on read means a hand-edited or seed-written document with the wrong
   * shape fails loudly instead of flowing into an API response.
   */
  protected override fromDocument(id: string, data: FirebaseFirestore.DocumentData): ContentPage {
    return contentPageSchema.parse({ id, ...(deepConvertTimestamps(data) as object) });
  }

  /**
   * Slug uniqueness inside a section is best-effort under concurrency: a
   * Firestore read-write transaction locks the documents it reads, not the
   * query range, so two simultaneous creates of the same slug can both find the
   * range empty. The result is repairable by renaming one of them and the admin
   * is a handful of staff, so a uniqueness-token collection is not worth its
   * cost here.
   */
  async create(input: CreateContentPageInput, actorId: string): Promise<PageWriteResult> {
    return this.firestore.runTransaction(async (tx) => {
      // Every read happens before every write — Firestore rejects the reverse.
      const sectionDoc = await tx.get(this.sections.doc(input.sectionId));
      if (!sectionDoc.exists) {
        return { ok: false, reason: 'section-not-found', sectionId: input.sectionId };
      }
      const section = sectionSchema.parse({
        id: sectionDoc.id,
        ...(deepConvertTimestamps(sectionDoc.data()!) as object),
      });
      if (section.kind === 'link') {
        return { ok: false, reason: 'section-is-link' };
      }

      const taken = await tx.get(this.slugQuery(input.sectionId, input.slug));
      if (!taken.empty) {
        return { ok: false, reason: 'slug-taken', slug: input.slug };
      }

      const sortOrder = input.sortOrder ?? (await this.nextSortOrder(tx, input.sectionId));
      const ref = this.collection.doc();
      const parsed = contentPageSchema.safeParse({
        ...input,
        id: ref.id,
        path: pagePath(section.path, input.slug),
        sortOrder,
        publishedAt: nextPublishedAt(null, input.status, new Date().toISOString()),
        audit: this.newAudit(actorId),
      });
      if (!parsed.success) {
        return { ok: false, reason: 'invalid', issues: parsed.error.issues };
      }

      tx.create(ref, toDocumentData(parsed.data));
      return { ok: true, page: parsed.data };
    });
  }

  async list(query: ListPagesQuery): Promise<Page<ContentPage>> {
    let scoped: Query = this.collection;
    if (query.sectionId !== undefined) {
      scoped = scoped.where('sectionId', '==', query.sectionId);
    }
    if (query.status !== undefined) {
      scoped = scoped.where('status', '==', query.status);
    }
    if (query.type !== undefined) {
      // A caller says `type`; the document carries it inside the body variant.
      scoped = scoped.where('body.type', '==', query.type);
    }
    // Firestore appends `__name__` to the ordering implicitly, so the cursor is
    // stable even though `sortOrder` is not unique within a section.
    return this.paginate(scoped.orderBy('sortOrder'), query.limit, query.cursor);
  }

  async update(
    id: string,
    input: UpdateContentPageInput,
    actorId: string,
  ): Promise<PageWriteResult> {
    return this.firestore.runTransaction(async (tx) => {
      const ref = this.collection.doc(id);
      const doc = await tx.get(ref);
      if (!doc.exists) {
        return { ok: false, reason: 'not-found' };
      }
      const existing = this.fromDocument(doc.id, doc.data()!);

      // A JSON body cannot express `undefined`, but an in-process caller can,
      // and spreading it would clobber the stored value with nothing.
      const patch: UpdateContentPageInput = { ...input };
      for (const key of Object.keys(patch) as (keyof UpdateContentPageInput)[]) {
        if (patch[key] === undefined) {
          delete patch[key];
        }
      }

      const merged = { ...existing, ...patch };

      if (merged.slug !== existing.slug) {
        const taken = await tx.get(this.slugQuery(existing.sectionId, merged.slug));
        if (taken.docs.some((page) => page.id !== id)) {
          return { ok: false, reason: 'slug-taken', slug: merged.slug };
        }
        // The section's path is the page's own path minus its last segment, so
        // a rename does not need a second document read.
        merged.path = pagePath(sectionPathOf(existing.path), merged.slug);
      }

      merged.publishedAt = nextPublishedAt(
        existing.publishedAt,
        merged.status,
        new Date().toISOString(),
      );

      const parsed = contentPageSchema.safeParse({
        ...merged,
        audit: this.touchAudit(existing.audit, actorId),
      });
      if (!parsed.success) {
        return { ok: false, reason: 'invalid', issues: parsed.error.issues };
      }

      tx.set(ref, toDocumentData(parsed.data));
      return { ok: true, page: parsed.data };
    });
  }

  /** Reading inside the transaction is what makes the 404 answer about this commit. */
  async remove(id: string): Promise<PageDeleteResult> {
    return this.firestore.runTransaction(async (tx) => {
      const ref = this.collection.doc(id);
      const doc = await tx.get(ref);
      if (!doc.exists) {
        return { ok: false, reason: 'not-found' };
      }

      tx.delete(ref);
      return { ok: true };
    });
  }

  /**
   * Appending at the end is what makes a new page land at the bottom of its
   * section. A descending `orderBy` is a distinct index from the ascending one
   * and the emulator serves the query either way, so
   * `pages (sectionId ASC, sortOrder DESC)` in
   * `docker/firebase/firestore.indexes.json` is what keeps this working in
   * production.
   */
  private async nextSortOrder(tx: Transaction, sectionId: string): Promise<number> {
    const last = await tx.get(
      this.collection.where('sectionId', '==', sectionId).orderBy('sortOrder', 'desc').limit(1),
    );
    const highest = last.docs[0];
    return highest ? this.fromDocument(highest.id, highest.data()).sortOrder + 1 : 0;
  }

  /** Limit 2 so the "excluding the page itself" check still sees a real conflict. */
  private slugQuery(sectionId: string, slug: string): Query {
    return this.collection.where('sectionId', '==', sectionId).where('slug', '==', slug).limit(2);
  }
}
