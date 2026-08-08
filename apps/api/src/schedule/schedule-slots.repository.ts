import { Inject, Injectable } from '@nestjs/common';
import type { Firestore, Query } from '@google-cloud/firestore';
import type { z } from 'zod';
import {
  COLLECTIONS,
  scheduleSlotSchema,
  type ListScheduleSlotsQuery,
  type ScheduleSlot,
  type UpdateScheduleSlotInput,
} from '@speakukrainian/shared';
import { BaseRepository, deepConvertTimestamps } from '../infra/firestore/base.repository.js';
import { FIRESTORE } from '../infra/firestore/firestore.tokens.js';
import {
  MAX_SLOT_DURATION_HOURS,
  MAX_SLOT_DURATION_MS,
  exceedsMaxDuration,
  firstStoredOverlap,
  toInstant,
  type SlotDraft,
} from './schedule.rules.js';

/**
 * The overlap check reads the owner's slots around the window being written.
 * More than this many means an owner with a pathological calendar, and
 * truncating the read would answer "no overlap" from a partial picture.
 */
export const MAX_OVERLAP_WINDOW_SLOTS = 2000;

/** A range read is bounded by the range *and* by this: the response is a plain array. */
export const MAX_LIST_SLOTS = 1000;

/**
 * The most occurrences one series delete may remove. This is not a policy
 * number: Firestore commits at most 500 writes in one batch, and the delete is
 * one batch, so reading further would only assemble a commit the server
 * rejects. The emulator does not enforce the limit, which is exactly why the
 * number is stated here and pinned by a test rather than trusted to `test:e2e`.
 *
 * Deliberately not `MAX_RECURRENCE_SLOTS`: this API cannot create a series
 * longer than 200, so the only way past that is hand-written documents joining
 * one — the very case the read exists to clean up.
 */
export const MAX_SERIES_DELETE_SLOTS = 500;

/** `id` is the document id, so it is not duplicated inside the document body. */
export function toDocumentData(slot: ScheduleSlot): Record<string, unknown> {
  const { id: _id, ...data } = slot;
  return data;
}

/** Metadata every slot of one write shares. Kept apart from the per-slot times. */
export interface SlotMeta {
  timeZone: string;
  note?: string;
  recurrenceId: string | null;
}

/** Why a write was refused. The repository reports; the service maps to HTTP. */
export type ScheduleWriteFailure =
  | { reason: 'not-found' }
  | { reason: 'overlap'; startsAt: string; conflictId: string }
  | { reason: 'self-overlap'; startsAt: string }
  | { reason: 'duration-too-long'; limitHours: number }
  | { reason: 'cap-exceeded'; limit: number }
  | { reason: 'recurrence-empty' }
  | { reason: 'window-too-dense'; limit: number }
  | { reason: 'series-too-large'; limit: number }
  | { reason: 'invalid'; issues: z.core.$ZodIssue[] };

export type ScheduleWriteRejection = { ok: false } & ScheduleWriteFailure;
export type ScheduleWriteResult = { ok: true; slots: ScheduleSlot[] } | ScheduleWriteRejection;
export type ScheduleDeleteResult = { ok: true } | ScheduleWriteRejection;
export type ScheduleSeriesDeleteResult = { ok: true; deleted: number } | ScheduleWriteRejection;

/** More slots in the range than {@link MAX_LIST_SLOTS} — truncating would hide time. */
export type ScheduleListResult =
  { ok: true; slots: ScheduleSlot[] } | { ok: false; overflow: true };

type WindowResult = { ok: true; slots: ScheduleSlot[] } | ScheduleWriteRejection;

@Injectable()
export class ScheduleSlotsRepository extends BaseRepository<ScheduleSlot> {
  constructor(@Inject(FIRESTORE) firestore: Firestore) {
    super(firestore, COLLECTIONS.scheduleSlots);
  }

  /**
   * Parsing on read means a hand-edited or seed-written document with the wrong
   * shape fails loudly instead of flowing into an API response.
   */
  protected override fromDocument(id: string, data: FirebaseFirestore.DocumentData): ScheduleSlot {
    return scheduleSlotSchema.parse({ id, ...(deepConvertTimestamps(data) as object) });
  }

  /** A server-minted id shared by every occurrence of one series. */
  newRecurrenceId(): string {
    return this.collection.doc().id;
  }

  /**
   * Writes a whole request's slots — one, or a whole expanded series — in a
   * single `WriteBatch`.
   *
   * Deliberately not a transaction. A Firestore read-write transaction locks
   * the documents it reads, not the query *range*, which is the same fact
   * `SectionsRepository.create` documents about sibling slugs: it would buy
   * nothing against a concurrent insert into the window and would cost
   * contention over a range that may hold thousands of documents. Overlap
   * rejection is therefore best-effort under concurrency — two simultaneous
   * creates can both find the window clear — and repairable by cancelling one.
   *
   * What a batch does buy is "refused before anything is written": it is
   * assembled in memory and `commit()` is the only write, so every refusal
   * below short-circuits ahead of it. `MAX_RECURRENCE_SLOTS` is 200 and the
   * batch limit is 500, so this is always exactly one commit and never a
   * half-written series (ADR-002).
   */
  async createMany(
    drafts: SlotDraft[],
    meta: SlotMeta,
    actorId: string,
  ): Promise<ScheduleWriteResult> {
    const tooLong = drafts.find((slot) => exceedsMaxDuration(slot.startsAt, slot.endsAt));
    if (tooLong) {
      return { ok: false, reason: 'duration-too-long', limitHours: MAX_SLOT_DURATION_HOURS };
    }

    const window = await this.overlapWindow(actorId, drafts);
    if (!window.ok) {
      return window;
    }

    const batch = this.firestore.batch();
    const written: ScheduleSlot[] = [];
    for (const slot of drafts) {
      const conflict = firstStoredOverlap(slot, window.slots);
      if (conflict) {
        return { ok: false, reason: 'overlap', startsAt: slot.startsAt, conflictId: conflict.id };
      }

      const ref = this.collection.doc();
      // Built field by field on purpose: `{ ...input, ownerId: actorId }` is one
      // reordering away from letting the request name the owner, and a field
      // added to the create schema later would ride in with the spread.
      const parsed = scheduleSlotSchema.safeParse({
        id: ref.id,
        ownerId: actorId,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        timeZone: meta.timeZone,
        status: 'open',
        recurrenceId: meta.recurrenceId,
        ...(meta.note !== undefined ? { note: meta.note } : {}),
        bookedBy: null,
        bookedAt: null,
        audit: this.newAudit(actorId),
      });
      if (!parsed.success) {
        return { ok: false, reason: 'invalid', issues: parsed.error.issues };
      }

      batch.create(ref, toDocumentData(parsed.data));
      written.push(parsed.data);
    }

    await batch.commit();
    return { ok: true, slots: written };
  }

  /**
   * Slots intersecting `[from, to)`, which is not the same set as slots
   * *starting* in it: one that began before `from` and runs into it intersects
   * too. Firestore takes an inequality on one field only, so the query's lower
   * bound is widened by the maximum slot duration and the ones that really do
   * end before `from` are dropped in memory. That widening is exactly as sound
   * as {@link MAX_SLOT_DURATION_HOURS} is enforced.
   *
   * `status` stays in the query rather than the filter because it has an index
   * — `scheduleSlots (status ASC, startsAt ASC)`.
   */
  async list(query: ListScheduleSlotsQuery): Promise<ScheduleListResult> {
    const from = toInstant(query.from);
    const to = toInstant(query.to);

    let scoped: Query = this.collection;
    if (query.status !== undefined) {
      scoped = scoped.where('status', '==', query.status);
    }
    const snapshot = await scoped
      .where('startsAt', '>=', new Date(Date.parse(from) - MAX_SLOT_DURATION_MS).toISOString())
      .where('startsAt', '<', to)
      .orderBy('startsAt')
      .limit(MAX_LIST_SLOTS + 1)
      .get();
    if (snapshot.size > MAX_LIST_SLOTS) {
      return { ok: false, overflow: true };
    }

    return {
      ok: true,
      slots: snapshot.docs
        .map((doc) => this.fromDocument(doc.id, doc.data()))
        .filter((slot) => slot.endsAt > from),
    };
  }

  /**
   * A single slot is read and rewritten, which is the lost-update problem a
   * transaction really does solve, so this one is a transaction — unlike
   * {@link createMany}, which has no document to lock.
   */
  async update(
    id: string,
    input: UpdateScheduleSlotInput,
    actorId: string,
  ): Promise<ScheduleWriteResult> {
    return this.firestore.runTransaction(async (tx) => {
      const ref = this.collection.doc(id);
      const doc = await tx.get(ref);
      if (!doc.exists) {
        return { ok: false, reason: 'not-found' };
      }
      const existing = this.fromDocument(doc.id, doc.data()!);

      // A JSON body cannot express `undefined`, but an in-process caller can,
      // and spreading it would clobber the stored value with nothing.
      const patch: UpdateScheduleSlotInput = { ...input };
      for (const key of Object.keys(patch) as (keyof UpdateScheduleSlotInput)[]) {
        if (patch[key] === undefined) {
          delete patch[key];
        }
      }

      const merged = { ...existing, ...patch };
      merged.startsAt = toInstant(merged.startsAt);
      merged.endsAt = toInstant(merged.endsAt);

      if (exceedsMaxDuration(merged.startsAt, merged.endsAt)) {
        return { ok: false, reason: 'duration-too-long', limitHours: MAX_SLOT_DURATION_HOURS };
      }

      // A cancelled slot blocks nothing, so it needs no window read. Otherwise
      // the check runs whether or not the times moved: it is one bounded read,
      // and there is no combination of stored and patched state where skipping
      // it on an unchanged time is right and running it is wrong.
      if (merged.status !== 'cancelled') {
        // Every read happens before every write — Firestore rejects the reverse.
        const window = await this.overlapWindow(existing.ownerId, [merged], tx);
        if (!window.ok) {
          return window;
        }
        const conflict = firstStoredOverlap(
          merged,
          window.slots.filter((slot) => slot.id !== id),
        );
        if (conflict) {
          return {
            ok: false,
            reason: 'overlap',
            startsAt: merged.startsAt,
            conflictId: conflict.id,
          };
        }
      }

      const parsed = scheduleSlotSchema.safeParse({
        ...merged,
        audit: this.touchAudit(existing.audit, actorId),
      });
      if (!parsed.success) {
        return { ok: false, reason: 'invalid', issues: parsed.error.issues };
      }

      tx.set(ref, toDocumentData(parsed.data));
      return { ok: true, slots: [parsed.data] };
    });
  }

  /** Reading inside the transaction is what makes the 404 answer about this commit. */
  async remove(id: string): Promise<ScheduleDeleteResult> {
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
   * Drops the occurrences of a series that start at or after `from`, leaving
   * the earlier ones as a record of time that was really offered.
   *
   * Phase 2 obligation: once a learner can book, a `booked` occurrence must not
   * vanish from under them — it needs cancelling and telling them about, not
   * deleting. Nothing can be booked yet, so that branch would be dead and
   * untestable through the API today.
   *
   * The overflow refusal is defensive: this API cannot create a series longer
   * than the cap, but a hand-written document can join one. It is bounded at
   * {@link MAX_SERIES_DELETE_SLOTS} because the deletes go out as one batch, and
   * a batch holds 500 writes — refusing is the only honest answer to a series
   * that cannot be removed in one commit.
   */
  async removeSeries(recurrenceId: string, from: string): Promise<ScheduleSeriesDeleteResult> {
    const snapshot = await this.collection
      .where('recurrenceId', '==', recurrenceId)
      .where('startsAt', '>=', toInstant(from))
      .orderBy('startsAt')
      .limit(MAX_SERIES_DELETE_SLOTS + 1)
      .get();
    if (snapshot.size > MAX_SERIES_DELETE_SLOTS) {
      return { ok: false, reason: 'series-too-large', limit: MAX_SERIES_DELETE_SLOTS };
    }

    const batch = this.firestore.batch();
    for (const doc of snapshot.docs) {
      batch.delete(doc.ref);
    }
    await batch.commit();
    return { ok: true, deleted: snapshot.size };
  }

  /**
   * Every slot of one owner that could possibly overlap `drafts`, in one range
   * query — `scheduleSlots (ownerId ASC, startsAt ASC)` is its index.
   *
   * The lower bound is the part that is easy to get wrong. `startsAt < maxEnd`
   * alone matches everything back to 1970, and a lower bound of `minStart`
   * would miss a stored slot that started before the window and ends inside it.
   * Subtracting {@link MAX_SLOT_DURATION_MS} is complete only because no slot
   * may be longer than that — the cap is what makes a single-field range query
   * answer this question at all.
   *
   * Known limitation: a document hand-written with a longer duration is
   * invisible here. A second inequality on `endsAt` cannot express the OR
   * anyway, and would need a third index to read a superset.
   *
   * `status` is filtered in memory: a cancelled slot blocks nothing, and adding
   * it to the query would need an `(ownerId, status, startsAt)` index for no
   * gain over a read already bounded by the window.
   */
  private async overlapWindow(
    ownerId: string,
    drafts: SlotDraft[],
    tx?: FirebaseFirestore.Transaction,
  ): Promise<WindowResult> {
    const minStart = drafts.reduce(
      (earliest, slot) => (slot.startsAt < earliest ? slot.startsAt : earliest),
      drafts[0]!.startsAt,
    );
    const maxEnd = drafts.reduce(
      (latest, slot) => (slot.endsAt > latest ? slot.endsAt : latest),
      drafts[0]!.endsAt,
    );

    const query = this.collection
      .where('ownerId', '==', ownerId)
      .where('startsAt', '>=', new Date(Date.parse(minStart) - MAX_SLOT_DURATION_MS).toISOString())
      .where('startsAt', '<', maxEnd)
      .orderBy('startsAt')
      .limit(MAX_OVERLAP_WINDOW_SLOTS + 1);

    const snapshot = await (tx ? tx.get(query) : query.get());
    if (snapshot.size > MAX_OVERLAP_WINDOW_SLOTS) {
      return { ok: false, reason: 'window-too-dense', limit: MAX_OVERLAP_WINDOW_SLOTS };
    }

    return {
      ok: true,
      slots: snapshot.docs
        .map((doc) => this.fromDocument(doc.id, doc.data()))
        .filter((slot) => slot.status !== 'cancelled'),
    };
  }
}
