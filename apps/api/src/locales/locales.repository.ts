import { Inject, Injectable } from '@nestjs/common';
import type { Firestore } from '@google-cloud/firestore';
import {
  COLLECTIONS,
  localeSchema,
  type CreateLocaleInput,
  type Locale,
  type UpdateLocaleInput,
} from '@speakukrainian/shared';
import { BaseRepository, deepConvertTimestamps } from '../infra/firestore/base.repository.js';
import { FIRESTORE } from '../infra/firestore/firestore.tokens.js';

/** A site has a handful of languages; the cap exists so no read is unbounded. */
export const MAX_LOCALES = 100;

/** gRPC status 6. Firestore's `create()` uses it for "document already exists". */
const ALREADY_EXISTS = 6;

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === ALREADY_EXISTS
  );
}

/** `id` is the document id (the locale code), so it is not repeated in the body. */
export function toDocumentData(locale: Locale): Record<string, unknown> {
  const { id: _id, ...data } = locale;
  return data;
}

@Injectable()
export class LocalesRepository extends BaseRepository<Locale> {
  constructor(@Inject(FIRESTORE) firestore: Firestore) {
    super(firestore, COLLECTIONS.locales);
  }

  /**
   * Parsing on read means a hand-edited or seed-written document with the wrong
   * shape fails loudly instead of flowing into an API response.
   */
  protected override fromDocument(id: string, data: FirebaseFirestore.DocumentData): Locale {
    return localeSchema.parse({ id, ...(deepConvertTimestamps(data) as object) });
  }

  async list(): Promise<Locale[]> {
    const snapshot = await this.allQuery().get();
    return snapshot.docs.map((doc) => this.fromDocument(doc.id, doc.data())).sort(byOrderThenCode);
  }

  /**
   * Returns `null` when the code is taken. `create()` rather than `set()` is
   * what makes seeding idempotent and safe when several instances boot at once:
   * the conflict is decided by Firestore, not by a read this code then races.
   */
  async create(
    input: CreateLocaleInput,
    actorId: string,
    isDefault = false,
  ): Promise<Locale | null> {
    const locale = localeSchema.parse({
      ...input,
      id: input.code,
      isDefault,
      audit: this.newAudit(actorId),
    });

    try {
      await this.collection.doc(locale.id).create(toDocumentData(locale));
    } catch (error) {
      if (isAlreadyExists(error)) {
        return null;
      }
      throw error;
    }
    return locale;
  }

  /** Returns `null` when no document exists for `code`. */
  async update(code: string, input: UpdateLocaleInput, actorId: string): Promise<Locale | null> {
    const existing = await this.findById(code);
    if (!existing) {
      return null;
    }

    // A JSON body cannot express `undefined`, but an in-process caller can, and
    // spreading it would clobber the stored value with nothing.
    const patch = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    );
    const next = localeSchema.parse({
      ...existing,
      ...patch,
      audit: this.touchAudit(existing.audit, actorId),
    });

    await this.collection.doc(code).set(toDocumentData(next));
    return next;
  }

  /**
   * Moves the default flag to `code` in one transaction, so there is never an
   * instant with zero or two defaults. Reading the whole (capped) collection
   * rather than a `where` query puts every document that might be written into
   * the transaction's read set, so two concurrent switches cannot interleave.
   */
  async setDefault(code: string, actorId: string): Promise<Locale | null> {
    return this.firestore.runTransaction(async (tx) => {
      const targetRef = this.collection.doc(code);
      // Every read happens before every write — Firestore rejects the reverse.
      const [target, all] = await Promise.all([tx.get(targetRef), tx.get(this.allQuery())]);
      if (!target.exists) {
        return null;
      }

      for (const doc of all.docs) {
        const locale = this.fromDocument(doc.id, doc.data());
        if (locale.isDefault && locale.code !== code) {
          tx.set(
            doc.ref,
            toDocumentData({
              ...locale,
              isDefault: false,
              audit: this.touchAudit(locale.audit, actorId),
            }),
          );
        }
      }

      const current = this.fromDocument(target.id, target.data()!);
      const written: Locale = {
        ...current,
        isDefault: true,
        audit: this.touchAudit(current.audit, actorId),
      };
      tx.set(targetRef, toDocumentData(written));
      return written;
    });
  }

  private allQuery(): FirebaseFirestore.Query {
    return this.collection.orderBy('sortOrder').limit(MAX_LOCALES);
  }
}

/** Equal `sortOrder` values still have to produce one stable order everywhere. */
function byOrderThenCode(a: Locale, b: Locale): number {
  return a.sortOrder - b.sortOrder || a.code.localeCompare(b.code);
}
