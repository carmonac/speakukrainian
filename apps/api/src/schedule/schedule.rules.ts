import type { ScheduleSlot, SlotRecurrence } from '@speakukrainian/shared';
import { addDaysToWallClock, wallClockIn, wallClockToInstant, weekdayOf } from './schedule.time.js';

/**
 * The arithmetic behind a slot, kept apart from Firestore so it is reachable
 * without an emulator — `pages.rules.ts` is the same idea for page paths.
 */

/**
 * The most occurrences one recurrence may expand into, so an `until` far in the
 * future cannot run away with writes. Deliberately well under Firestore's
 * 500-write limit, which is what lets the expansion commit as a single
 * `WriteBatch` and never be split across commits (ADR-002: half a written
 * series is worse than none).
 */
export const MAX_RECURRENCE_SLOTS = 200;

/**
 * The longest a single slot may be. **Load-bearing, not decoration:** the
 * overlap and list queries filter on `startsAt` alone, and their lower bound is
 * widened by exactly this much so a slot that started before the window but
 * still runs into it is inside the range read. Raise or remove this and both
 * queries silently start missing slots.
 */
export const MAX_SLOT_DURATION_HOURS = 24;
export const MAX_SLOT_DURATION_MS = MAX_SLOT_DURATION_HOURS * 3_600_000;

/** A slot's times before it becomes a document. Both are normalised instants. */
export interface SlotDraft {
  startsAt: string;
  endsAt: string;
}

/**
 * The one normalised spelling of an instant, `…Z` with milliseconds.
 *
 * `isoDateTimeSchema` accepts `2026-03-30T09:00:00+02:00`, `…T07:00:00Z` and
 * `…T07:00:00.000Z` — the same instant in three spellings that sort three
 * different ways. Firestore compares `startsAt` as a **string**, so an
 * unnormalised value silently drops out of a range query. Every instant goes
 * through here before it is stored and before it is used as a query bound.
 */
export function toInstant(iso: string): string {
  return new Date(iso).toISOString();
}

/**
 * The lower bound of a `startsAt` range read that has to catch slots which
 * began before the window and run into it.
 *
 * Firestore takes an inequality on one field only, so both range reads — the
 * overlap window and the list — filter on `startsAt` and widen the bound by
 * exactly {@link MAX_SLOT_DURATION_MS}. That widening is complete **only
 * because** no slot may be longer than {@link MAX_SLOT_DURATION_HOURS}: a slot
 * overlapping the window must then have started no earlier than this. The two
 * reads rest on the same argument, so they take the same bound from here —
 * changing the cap has to move both or neither.
 */
export function windowLowerBound(instant: string): string {
  return new Date(Date.parse(instant) - MAX_SLOT_DURATION_MS).toISOString();
}

/** Half-open `[startsAt, endsAt)`: 09:00-10:00 and 10:00-11:00 are back-to-back, not overlapping. */
export function overlaps(a: SlotDraft, b: SlotDraft): boolean {
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt;
}

export function exceedsMaxDuration(startsAt: string, endsAt: string): boolean {
  return Date.parse(endsAt) - Date.parse(startsAt) > MAX_SLOT_DURATION_MS;
}

/**
 * The first pair of drafts in one request that collide with each other, sorted
 * by start so only adjacent pairs need comparing.
 *
 * A duplicated weekday (`daysOfWeek: [1, 1]`) is what reaches this: the
 * expansion deliberately does not deduplicate, because two identical
 * occurrences are a contradiction worth reporting rather than a request to
 * silently halve.
 */
export function firstSelfOverlap(drafts: SlotDraft[]): [SlotDraft, SlotDraft] | null {
  const sorted = [...drafts].sort((a, b) => (a.startsAt < b.startsAt ? -1 : 1));
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;
    if (overlaps(previous, current)) {
      return [previous, current];
    }
  }
  return null;
}

export function firstStoredOverlap(draft: SlotDraft, stored: ScheduleSlot[]): ScheduleSlot | null {
  return stored.find((slot) => overlaps(draft, slot)) ?? null;
}

export type ExpansionResult =
  | { ok: true; drafts: SlotDraft[] }
  | { ok: false; reason: 'cap-exceeded' }
  | { ok: false; reason: 'recurrence-empty' };

/**
 * Expands a weekly recurrence into concrete occurrences, in the zone it was
 * authored in.
 *
 * The walk steps **civil dates** — 25 March plus seven days is 1 April — and
 * converts each one to an instant separately, which is what keeps a 09:00 slot
 * at 09:00 local on both sides of a daylight-saving change. Adding
 * `7 * 86_400_000` ms to the previous instant instead moves the slot to 10:00
 * local for half the year.
 *
 * The anchor supplies the local time of day and the date the walk starts from,
 * nothing else: `daysOfWeek` is authoritative, so an anchor on a Friday with
 * `daysOfWeek: [1, 3]` produces Mondays and Wednesdays and no Friday. That is
 * deliberately unlike RFC 5545, where `DTSTART` is always an instance — the
 * admin ticks weekdays in a picker, and a slot on a day they did not tick reads
 * as a bug.
 *
 * The duration is preserved in **absolute** terms: each occurrence ends
 * `endsAt - startsAt` after it begins. An occurrence that straddles the
 * transition itself therefore ends at a different wall clock than the anchor
 * did; converting `endsAt`'s wall clock separately would instead turn a
 * one-hour lesson into a zero- or two-hour one on exactly one day of the year,
 * and a zero-hour one is not a slot at all.
 */
export function expandRecurrence(
  anchor: { startsAt: string; endsAt: string; timeZone: string },
  recurrence: SlotRecurrence,
): ExpansionResult {
  const startMs = Date.parse(anchor.startsAt);
  const durationMs = Date.parse(anchor.endsAt) - startMs;
  // `until` is an absolute instant, compared against each occurrence's start,
  // inclusive. Re-reading it as a local date in the authoring zone would be a
  // second, invisible conversion of a value the client already pinned.
  const untilMs = Date.parse(recurrence.until);

  const drafts: SlotDraft[] = [];
  let cursor = wallClockIn(new Date(startMs), anchor.timeZone);

  for (;;) {
    const occurrenceMs = wallClockToInstant(cursor, anchor.timeZone);
    if (occurrenceMs > untilMs) {
      break;
    }

    // One draft per matching entry, not per matching day: `daysOfWeek: [1, 1]`
    // really does ask for two slots at the same instant, and it is refused as a
    // self-overlap rather than quietly halved.
    const repeats = recurrence.daysOfWeek.filter((weekday) => weekday === weekdayOf(cursor)).length;
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      drafts.push({
        startsAt: new Date(occurrenceMs).toISOString(),
        endsAt: new Date(occurrenceMs + durationMs).toISOString(),
      });
    }

    // Stopping one past the cap keeps an `until` in the year 3000 to 201
    // emissions instead of tens of thousands, so the refusal is cheap.
    if (drafts.length > MAX_RECURRENCE_SLOTS) {
      return { ok: false, reason: 'cap-exceeded' };
    }

    cursor = addDaysToWallClock(cursor, 1);
  }

  if (drafts.length === 0) {
    return { ok: false, reason: 'recurrence-empty' };
  }
  return { ok: true, drafts };
}
