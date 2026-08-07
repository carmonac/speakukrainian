import { Inject, Injectable } from '@nestjs/common';
import type { CollectionReference, Firestore, Transaction } from '@google-cloud/firestore';
import { COLLECTIONS } from '@speakukrainian/shared';
import { FIRESTORE } from '../infra/firestore/firestore.tokens.js';
import { pagePathRange, rewritePagePath } from './pages.rules.js';

/** A page reduced to what a path rewrite needs, and nothing else. */
export interface PagePathRow {
  id: string;
  path: string;
}

/** More pages under the section than the caller's remaining write budget. */
export type PageScanResult = { ok: true; pages: PagePathRow[] } | { ok: false; overflow: true };

/**
 * The narrow port `SectionsRepository` reaches pages through: a section rename
 * or move rewrites the paths of the pages beneath it in the *same* transaction
 * as the section write, because a crash between two commits leaves live URLs
 * pointing nowhere (ADR-002).
 *
 * Deliberately not a `BaseRepository` subclass. It never parses a whole page
 * document, so one page whose body no longer satisfies `contentPageSchema`
 * cannot make its section unrenameable — and it never gains `create` or
 * `remove`, which the section transaction has no business holding.
 */
@Injectable()
export class SectionPagesRepository {
  private readonly collection: CollectionReference;

  constructor(@Inject(FIRESTORE) firestore: Firestore) {
    this.collection = firestore.collection(COLLECTIONS.pages);
  }

  /**
   * Whether a section still holds pages, read inside the caller's transaction
   * so a page created concurrently is not orphaned in the common case.
   */
  async hasPages(tx: Transaction, sectionId: string): Promise<boolean> {
    const snapshot = await tx.get(this.collection.where('sectionId', '==', sectionId).limit(1));
    return !snapshot.empty;
  }

  /**
   * Page paths under `sectionPath`, including every descendant section's pages:
   * a descendant page's path starts with the same prefix, so one range query
   * finds them all and no `sectionId in [...]` chunking is needed.
   *
   * `.select('path')` keeps whole rich-text bodies out of the transaction's
   * 10 MiB budget — the rewrite is a single-field update and needs nothing
   * else. `orderBy` is not cosmetic: it makes the write order deterministic,
   * which is what lets the atomicity test fail on a specific write.
   *
   * `budget` is what the caller has left of `MAX_TRANSACTION_WRITES`; it can
   * legitimately be 0, in which case "no pages" is still accepted and one page
   * is refused.
   */
  async scanUnder(tx: Transaction, sectionPath: string, budget: number): Promise<PageScanResult> {
    const capped = Math.max(budget, 0);
    const { start, end } = pagePathRange(sectionPath);
    const snapshot = await tx.get(
      this.collection
        .where('path', '>=', start)
        .where('path', '<', end)
        .orderBy('path')
        .select('path')
        .limit(capped + 1),
    );
    if (snapshot.size > capped) {
      return { ok: false, overflow: true };
    }
    return {
      ok: true,
      // The cast cannot change a value: `DocumentSnapshot.get` is untyped, and a
      // document whose `path` is missing or not a string sorts outside a string
      // range, so this query never returns one.
      pages: snapshot.docs.map((doc) => ({ id: doc.id, path: String(doc.get('path')) })),
    };
  }

  /**
   * Stages the rewrite. Reads nothing: the caller has already done every read,
   * and Firestore rejects a read that follows a write in one transaction.
   *
   * The audit *is* stamped, unlike a renumbered sibling in a move: the page's
   * public URL really did change, which is something an author can see.
   */
  rewrite(
    tx: Transaction,
    pages: readonly PagePathRow[],
    oldSectionPath: string,
    newSectionPath: string,
    actorId: string,
  ): void {
    const now = new Date().toISOString();
    for (const page of pages) {
      tx.update(this.collection.doc(page.id), {
        path: rewritePagePath(page.path, oldSectionPath, newSectionPath),
        'audit.updatedAt': now,
        'audit.updatedBy': actorId,
      });
    }
  }
}
