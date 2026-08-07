import { Inject, Injectable } from '@nestjs/common';
import type { Firestore, Query, Transaction } from '@google-cloud/firestore';
import type { z } from 'zod';
import {
  COLLECTIONS,
  MAX_SECTION_DEPTH,
  SECTION_ROOT_PARENT,
  sectionSchema,
  type CreateSectionInput,
  type ListSectionsQuery,
  type MoveSectionInput,
  type Page,
  type Section,
  type UpdateSectionInput,
} from '@speakukrainian/shared';
import { BaseRepository, deepConvertTimestamps } from '../infra/firestore/base.repository.js';
import { FIRESTORE } from '../infra/firestore/firestore.tokens.js';
// A value import, not `import type`: Nest resolves constructor injection from
// `emitDecoratorMetadata`, which a type-only import is erased before.
import { SectionPagesRepository, type PagePathRow } from '../pages/section-pages.repository.js';
import {
  buildPath,
  deepestAfterMove,
  isSamePlacement,
  placeUnder,
  renumberSiblings,
  rewriteDescendant,
  type Placement,
} from './sections.tree.js';

/**
 * Firestore commits at most this many writes in one transaction. A write that
 * would exceed it is refused rather than split across commits: see ADR-002 —
 * half a rewritten subtree is a set of broken public URLs with no way back.
 */
export const MAX_TRANSACTION_WRITES = 500;

/**
 * The node itself takes one of the transaction's writes, so this is what is
 * left for its subtree. Derived rather than written out, because a move now
 * spends the same budget on the node, its descendants and the destination's
 * renumbered siblings together, and two constants that could drift apart would
 * let a move be accepted that the commit then refuses.
 *
 * The budget is shared with the pages under the subtree as well: a rename
 * commits `1 + descendants + pages`, a move `1 + descendants + changed
 * siblings + pages`, and whatever is left after the sections have claimed
 * their share is what the page scan may spend.
 */
export const MAX_DESCENDANT_REWRITES = MAX_TRANSACTION_WRITES - 1;

/** The tree is assembled in memory, so the read behind it has to be bounded. */
export const MAX_TREE_SECTIONS = 1000;

/** `id` is the document id, so it is not duplicated inside the document body. */
export function toDocumentData(section: Section): Record<string, unknown> {
  const { id: _id, ...data } = section;
  return data;
}

/** Why a write was refused. The repository reports; the service maps to HTTP. */
export type SectionWriteFailure =
  | { reason: 'not-found' }
  | { reason: 'parent-not-found'; parentId: string }
  | { reason: 'slug-taken'; slug: string }
  | { reason: 'has-children' }
  | { reason: 'depth-exceeded'; depth: number }
  | { reason: 'move-into-descendant' }
  | { reason: 'has-pages' }
  | { reason: 'subtree-too-large'; limit: number }
  | { reason: 'move-too-large'; limit: number }
  | { reason: 'pages-too-large'; limit: number }
  | { reason: 'invalid'; issues: z.core.$ZodIssue[] };

export type SectionWriteRejection = { ok: false } & SectionWriteFailure;
export type SectionWriteResult = { ok: true; section: Section } | SectionWriteRejection;
export type SectionDeleteResult = { ok: true } | SectionWriteRejection;

/** More sections than {@link MAX_TREE_SECTIONS} — truncating would hide content. */
export type SectionListResult = { ok: true; sections: Section[] } | { ok: false; overflow: true };

type DescendantsResult = { ok: true; sections: Section[] } | SectionWriteRejection;

@Injectable()
export class SectionsRepository extends BaseRepository<Section> {
  constructor(
    @Inject(FIRESTORE) firestore: Firestore,
    private readonly pages: SectionPagesRepository,
  ) {
    super(firestore, COLLECTIONS.sections);
  }

  /**
   * Parsing on read means a hand-edited or seed-written document with the wrong
   * shape fails loudly instead of flowing into an API response.
   */
  protected override fromDocument(id: string, data: FirebaseFirestore.DocumentData): Section {
    return sectionSchema.parse({ id, ...(deepConvertTimestamps(data) as object) });
  }

  /**
   * Sibling-slug uniqueness is best-effort under concurrency: a Firestore
   * read-write transaction locks the documents it reads, not the query range,
   * so two simultaneous creates of the same slug can both find the range empty.
   * The result is repairable by renaming one of them and the admin is a handful
   * of staff, so a uniqueness-token collection is not worth its cost here.
   */
  async create(input: CreateSectionInput, actorId: string): Promise<SectionWriteResult> {
    return this.firestore.runTransaction(async (tx) => {
      // Every read happens before every write — Firestore rejects the reverse.
      let parent: Section | null = null;
      if (input.parentId !== null) {
        const parentDoc = await tx.get(this.collection.doc(input.parentId));
        if (!parentDoc.exists) {
          return { ok: false, reason: 'parent-not-found', parentId: input.parentId };
        }
        parent = this.fromDocument(parentDoc.id, parentDoc.data()!);
        if (parent.depth + 1 > MAX_SECTION_DEPTH) {
          return { ok: false, reason: 'depth-exceeded', depth: parent.depth + 1 };
        }
      }

      const siblings = await tx.get(this.siblingSlugQuery(input.parentId, input.slug));
      if (!siblings.empty) {
        return { ok: false, reason: 'slug-taken', slug: input.slug };
      }

      const sortOrder = input.sortOrder ?? (await this.nextSortOrder(tx, input.parentId));
      const ref = this.collection.doc();
      const placement = placeUnder(parent, input.slug);
      const parsed = sectionSchema.safeParse({
        ...input,
        ...placement,
        id: ref.id,
        sortOrder,
        audit: this.newAudit(actorId),
      });
      if (!parsed.success) {
        return { ok: false, reason: 'invalid', issues: parsed.error.issues };
      }

      tx.create(ref, toDocumentData(parsed.data));
      return { ok: true, section: parsed.data };
    });
  }

  async list(query: ListSectionsQuery): Promise<Page<Section>> {
    let scoped: Query = this.collection;
    if (query.parentId !== undefined) {
      const parentId = query.parentId === SECTION_ROOT_PARENT ? null : query.parentId;
      scoped = scoped.where('parentId', '==', parentId);
    }
    if (query.status !== undefined) {
      scoped = scoped.where('status', '==', query.status);
    }
    // Firestore appends `__name__` to the ordering implicitly, so the cursor is
    // stable even though `sortOrder` is not unique among siblings.
    return this.paginate(scoped.orderBy('sortOrder'), query.limit, query.cursor);
  }

  /**
   * Reads one document past the cap so a truncated tree is detectable. It backs
   * the public menu as well as the admin tree: the menu's ordering depends on
   * ancestors it does not itself show, so it cannot be served by a query that
   * filters them out.
   */
  async listAllForTree(): Promise<SectionListResult> {
    const snapshot = await this.collection
      .orderBy('sortOrder')
      .limit(MAX_TREE_SECTIONS + 1)
      .get();
    if (snapshot.size > MAX_TREE_SECTIONS) {
      return { ok: false, overflow: true };
    }
    return {
      ok: true,
      sections: snapshot.docs.map((doc) => this.fromDocument(doc.id, doc.data())),
    };
  }

  async update(
    id: string,
    input: UpdateSectionInput,
    actorId: string,
  ): Promise<SectionWriteResult> {
    return this.firestore.runTransaction(async (tx) => {
      const ref = this.collection.doc(id);
      const doc = await tx.get(ref);
      if (!doc.exists) {
        return { ok: false, reason: 'not-found' };
      }
      const existing = this.fromDocument(doc.id, doc.data()!);

      // A JSON body cannot express `undefined`, but an in-process caller can,
      // and spreading it would clobber the stored value with nothing.
      const patch: UpdateSectionInput = { ...input };
      for (const key of Object.keys(patch) as (keyof UpdateSectionInput)[]) {
        if (patch[key] === undefined) {
          delete patch[key];
        }
      }
      // `null` means "clear this field" (see `updateSectionSchema`); an omitted
      // field is left alone. `tx.set` rewrites the whole document, so dropping
      // the key is what removes it — no `FieldValue.delete()` is needed here.
      const clearImage = patch.image === null;
      if (clearImage) {
        delete patch.image;
      }

      const merged = { ...existing, ...patch };
      if (clearImage) {
        delete merged.image;
      }

      // Dropping the stored link is the only way a patch can say "this is a
      // content section now" — a PATCH body has no way to remove an optional
      // object, and `sectionSchema` refuses a content section that still has a
      // link. A patch that *sends* a link for a content section is a different
      // thing: a contradiction, which the refinement below refuses with the
      // issue pathed to `link`. Dropping it silently would answer 200 to a
      // write that did not happen. The `undefined`-stripping loop above has
      // already run, so this really does mean "the request carried none".
      if (merged.kind === 'content' && patch.link === undefined) {
        delete merged.link;
      }

      let descendants: Section[] = [];
      let pages: PagePathRow[] = [];
      let moved: { oldPath: string; next: Placement } | null = null;

      if (merged.slug !== existing.slug) {
        const siblings = await tx.get(this.siblingSlugQuery(existing.parentId, merged.slug));
        if (siblings.docs.some((sibling) => sibling.id !== id)) {
          return { ok: false, reason: 'slug-taken', slug: merged.slug };
        }

        // The parent's path is the node's own path minus its last segment, so
        // renaming does not need a second document read.
        const parentPath = existing.path.slice(0, existing.path.lastIndexOf('/')) || null;
        moved = {
          oldPath: existing.path,
          next: {
            parentId: existing.parentId,
            ancestorIds: existing.ancestorIds,
            depth: existing.depth,
            path: buildPath(parentPath, merged.slug),
          },
        };
        merged.path = moved.next.path;

        const found = await this.descendantsInTransaction(tx, id);
        if (!found.ok) {
          return found;
        }
        descendants = found.sections;

        // The node and its descendants have already claimed their share of the
        // commit, so what is left is what the pages beneath them may spend.
        // Their paths are rewritten in *this* transaction (ADR-002): a second
        // write afterwards would leave live URLs pointing nowhere if a crash
        // landed between the two.
        const scanned = await this.pages.scanUnder(
          tx,
          existing.path,
          MAX_TRANSACTION_WRITES - (1 + descendants.length),
        );
        if (!scanned.ok) {
          return { ok: false, reason: 'pages-too-large', limit: MAX_TRANSACTION_WRITES };
        }
        pages = scanned.pages;
      }

      const parsed = sectionSchema.safeParse({
        ...merged,
        audit: this.touchAudit(existing.audit, actorId),
      });
      if (!parsed.success) {
        return { ok: false, reason: 'invalid', issues: parsed.error.issues };
      }

      tx.set(ref, toDocumentData(parsed.data));
      if (moved) {
        this.writeDescendants(tx, descendants, { id, ...moved }, actorId);
        this.pages.rewrite(tx, pages, moved.oldPath, moved.next.path, actorId);
      }
      return { ok: true, section: parsed.data };
    });
  }

  /**
   * Re-parents and repositions in one transaction. A move that keeps the same
   * parent is an ordinary reorder and takes the same code path: the placement
   * it computes is the one the node already has, so only `sortOrder` changes
   * and the subtree below is left alone.
   */
  async move(id: string, input: MoveSectionInput, actorId: string): Promise<SectionWriteResult> {
    return this.firestore.runTransaction(async (tx) => {
      const ref = this.collection.doc(id);
      const doc = await tx.get(ref);
      if (!doc.exists) {
        return { ok: false, reason: 'not-found' };
      }
      const existing = this.fromDocument(doc.id, doc.data()!);

      if (input.parentId === id) {
        return { ok: false, reason: 'move-into-descendant' };
      }

      let parent: Section | null = null;
      if (input.parentId !== null) {
        const parentDoc = await tx.get(this.collection.doc(input.parentId));
        if (!parentDoc.exists) {
          return { ok: false, reason: 'parent-not-found', parentId: input.parentId };
        }
        parent = this.fromDocument(parentDoc.id, parentDoc.data()!);
        if (parent.ancestorIds.includes(id)) {
          return { ok: false, reason: 'move-into-descendant' };
        }
      }

      // The destination's whole child list, because the renumbering below
      // rewrites it. It also subsumes the narrow sibling-slug query this used
      // to make: a clash is by definition one of these children.
      const destination = await this.destinationChildren(tx, input.parentId);
      if (!destination.ok) {
        return destination;
      }
      const children = destination.sections;

      // Two children of one parent sharing a slug would produce two identical
      // paths, and the public site resolves a URL by exactly one path lookup.
      if (children.some((child) => child.id !== id && child.slug === existing.slug)) {
        return { ok: false, reason: 'slug-taken', slug: existing.slug };
      }

      const placement = placeUnder(parent, existing.slug);
      // A reorder under the same parent lands the node exactly where it already
      // is, so no descendant path changes. Reading and rewriting the subtree
      // then only stamps a fresh audit on pages nobody edited, and would refuse
      // a subtree of more than MAX_DESCENDANT_REWRITES nodes that the reorder
      // never needed to touch.
      const reparented = !isSamePlacement(existing, placement);

      let descendants: Section[] = [];
      if (reparented) {
        const found = await this.descendantsInTransaction(tx, id);
        if (!found.ok) {
          return found;
        }
        descendants = found.sections;

        const deepest = deepestAfterMove(existing, descendants, placement.depth);
        if (deepest > MAX_SECTION_DEPTH) {
          return { ok: false, reason: 'depth-exceeded', depth: deepest };
        }
      }

      // `input.sortOrder` is a position, not a number to store: the whole
      // destination child list comes back contiguously numbered from 0, so the
      // position the caller asked for is the number that lands on the node.
      const ordered = renumberSiblings(
        children.filter((child) => child.id !== id),
        id,
        input.sortOrder,
      );
      const stored = new Map(children.map((child) => [child.id, child.sortOrder]));
      const moved = ordered.find((entry) => entry.id === id)!;
      const changed = ordered.filter(
        (entry) => entry.id !== id && stored.get(entry.id) !== entry.sortOrder,
      );

      if (1 + descendants.length + changed.length > MAX_TRANSACTION_WRITES) {
        return { ok: false, reason: 'move-too-large', limit: MAX_TRANSACTION_WRITES };
      }

      // A pure reorder changes no path, so it scans nothing and spends nothing
      // — the short-circuit above is what keeps a reorder cheap.
      //
      // Refusal order is load-bearing and is the same in `update`: the cheapest
      // read refuses first, so an oversized subtree is reported as
      // `subtree-too-large` and never scanned for pages. Moving this scan above
      // the descendant read or the `move-too-large` check would spend a range
      // query to answer a request already known to be refused.
      let pages: PagePathRow[] = [];
      if (reparented) {
        const scanned = await this.pages.scanUnder(
          tx,
          existing.path,
          MAX_TRANSACTION_WRITES - (1 + descendants.length + changed.length),
        );
        if (!scanned.ok) {
          return { ok: false, reason: 'pages-too-large', limit: MAX_TRANSACTION_WRITES };
        }
        pages = scanned.pages;
      }

      const parsed = sectionSchema.safeParse({
        ...existing,
        ...placement,
        sortOrder: moved.sortOrder,
        audit: this.touchAudit(existing.audit, actorId),
      });
      if (!parsed.success) {
        return { ok: false, reason: 'invalid', issues: parsed.error.issues };
      }

      tx.set(ref, toDocumentData(parsed.data));
      if (reparented) {
        this.writeDescendants(
          tx,
          descendants,
          { id, oldPath: existing.path, next: placement },
          actorId,
        );
        this.pages.rewrite(tx, pages, existing.path, placement.path, actorId);
      }
      // `update` of the one field, and no audit stamp: `sortOrder` is a plain
      // int that cannot invalidate a document, and stamping `updatedBy` on
      // every sibling of every reorder would make the audit trail claim an
      // editor opened sections they never touched — the same argument the
      // reorder short-circuit above makes about descendants.
      for (const sibling of changed) {
        tx.update(this.collection.doc(sibling.id), { sortOrder: sibling.sortOrder });
      }
      return { ok: true, section: parsed.data };
    });
  }

  /**
   * Checking for children and pages inside the transaction is what stops one
   * created concurrently from being orphaned in the common case.
   */
  async remove(id: string): Promise<SectionDeleteResult> {
    return this.firestore.runTransaction(async (tx) => {
      const ref = this.collection.doc(id);
      const doc = await tx.get(ref);
      if (!doc.exists) {
        return { ok: false, reason: 'not-found' };
      }

      const children = await tx.get(this.collection.where('parentId', '==', id).limit(1));
      if (!children.empty) {
        return { ok: false, reason: 'has-children' };
      }

      if (await this.pages.hasPages(tx, id)) {
        return { ok: false, reason: 'has-pages' };
      }

      tx.delete(ref);
      return { ok: true };
    });
  }

  /**
   * `orderBy` is not cosmetic: it makes the write order deterministic, which is
   * what lets the atomicity test fail on a specific write. This is the query
   * the `ancestorIds` composite index exists for.
   */
  private async descendantsInTransaction(tx: Transaction, id: string): Promise<DescendantsResult> {
    const snapshot = await tx.get(
      this.collection
        .where('ancestorIds', 'array-contains', id)
        .orderBy('sortOrder')
        .limit(MAX_DESCENDANT_REWRITES + 1),
    );
    if (snapshot.size > MAX_DESCENDANT_REWRITES) {
      return { ok: false, reason: 'subtree-too-large', limit: MAX_DESCENDANT_REWRITES };
    }
    return {
      ok: true,
      sections: snapshot.docs.map((doc) => this.fromDocument(doc.id, doc.data())),
    };
  }

  /**
   * The destination's children, in `sortOrder`, for a move to renumber. Reading
   * the whole list is what makes the renumbering correct, so a list too long to
   * rewrite in one commit is refused rather than truncated: renumbering only
   * the children that were read would hand them numbers the unread ones still
   * hold. `sections (parentId ASC, sortOrder ASC)` is the composite index.
   */
  private async destinationChildren(
    tx: Transaction,
    parentId: string | null,
  ): Promise<DescendantsResult> {
    const snapshot = await tx.get(
      this.collection
        .where('parentId', '==', parentId)
        .orderBy('sortOrder')
        .limit(MAX_TRANSACTION_WRITES + 1),
    );
    if (snapshot.size > MAX_TRANSACTION_WRITES) {
      return { ok: false, reason: 'move-too-large', limit: MAX_TRANSACTION_WRITES };
    }
    return {
      ok: true,
      sections: snapshot.docs.map((doc) => this.fromDocument(doc.id, doc.data())),
    };
  }

  /**
   * A descendant that cannot be rewritten throws out of the transaction, which
   * commits nothing: corrupt stored data must not be cemented by a guess.
   * The audit is touched because the descendant's public URL really did change.
   */
  private writeDescendants(
    tx: Transaction,
    descendants: Section[],
    node: { id: string; oldPath: string; next: Placement },
    actorId: string,
  ): void {
    for (const descendant of descendants) {
      const rewritten = sectionSchema.parse({
        ...rewriteDescendant(descendant, node),
        audit: this.touchAudit(descendant.audit, actorId),
      });
      tx.set(this.collection.doc(rewritten.id), toDocumentData(rewritten));
    }
  }

  /**
   * Appending at the end is what makes a new section land at the bottom of the
   * tree. The descending order needs its own composite index — a descending
   * `orderBy` is a distinct index from the ascending one, and the emulator
   * serves the query either way, so a missing entry only surfaces in
   * production. `sections (parentId ASC, sortOrder DESC)` in
   * `docker/firebase/firestore.indexes.json` is that entry.
   */
  private async nextSortOrder(tx: Transaction, parentId: string | null): Promise<number> {
    const last = await tx.get(
      this.collection.where('parentId', '==', parentId).orderBy('sortOrder', 'desc').limit(1),
    );
    const highest = last.docs[0];
    return highest ? this.fromDocument(highest.id, highest.data()).sortOrder + 1 : 0;
  }

  /** Limit 2 so the "excluding the node itself" check still sees a real conflict. */
  private siblingSlugQuery(parentId: string | null, slug: string): Query {
    return this.collection.where('parentId', '==', parentId).where('slug', '==', slug).limit(2);
  }
}
