import {
  documentIdSchema,
  timeZoneSchema,
  wallClockIn,
  wallClockToInstant,
  weekdayOf,
  type CreateScheduleSlotInput,
  type LocalizedText,
  type RichText,
  type ScheduleSlot,
  type UpdateScheduleSlotInput,
} from '@speakukrainian/shared';
import { fromPlainLocalized, toPlainLocalized } from '../../shared/rich-text/localized-plain-text';
import {
  addCivilDays,
  formatCivilDate,
  parseCivilDate,
  sameZone,
  type CivilDate,
} from './schedule.model';

/**
 * Every decision the slot form makes, as pure functions — `schedule.model.ts`'s
 * arrangement, and its two rules hold here too. `now` is always a parameter,
 * never a `new Date()` inside; and no `Intl.DateTimeFormat` is constructed here,
 * because every zone conversion goes through `packages/shared`'s `wallClockIn` /
 * `wallClockToInstant` (ADR-014 — the ±24 h offset probe is not to be
 * reimplemented, and a naive local-time-to-instant conversion is wrong by an
 * hour for any wall clock within ~14 h of a transition, silently).
 *
 * A value import of the shared barrel is deliberate: two of the decisions below
 * are the API's own schemas asked directly rather than restated (rule 1), and
 * this feature is lazily loaded, as `shared/forms/slug.ts` and
 * `locale-form-page.ts` already are.
 */

/** The time of day the native `<input type="time">` holds, to the minute. */
export interface ClockTime {
  hour: number;
  minute: number;
}

/** The form's value as the template binds it. Times are strings, never `Date`s. */
export interface SlotFormValue {
  /** `YYYY-MM-DD`, on the slot's own clock. */
  date: string;
  /** `HH:mm`, on the slot's own clock. */
  startTime: string;
  endTime: string;
  timeZone: string;
  note: RichText;
  repeats: boolean;
  /** 0 = Sunday … 6 = Saturday, `weekdayOf`'s numbering and the schema's. */
  daysOfWeek: number[];
  /** `YYYY-MM-DD`, the last day an occurrence may start on. */
  until: string;
}

const DEFAULT_START: ClockTime = { hour: 9, minute: 0 };

/**
 * The time of day a new slot opens on, and how long it lasts by default.
 * `DEFAULT_SLOT_START` is derived from the same value the form defaults to, so
 * the week view's `?time=` and the form's fallback cannot drift apart.
 */
export const DEFAULT_SLOT_START = formatClockTime(DEFAULT_START);
export const DEFAULT_SLOT_MINUTES = 60;

/** Mon-first display order over `weekdayOf`'s 0-6 numbering. */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

const MINUTES_PER_DAY = 1440;

/**
 * `HH:mm` and `HH:mm:ss` both, because both are what a real time input hands
 * back: Chromium emits seconds once `step` drops below 60, and jsdom treats the
 * field as a text input and hands back whatever was typed. Seconds are read and
 * dropped rather than refused — nothing this product authors has any, and a
 * value carrying them is normalised to the minute on its next save.
 *
 * An empty string is `null`, not midnight. Chromium emits `''` while the field
 * is being edited, and reading that as 00:00 would compose an interval the admin
 * never asked for.
 */
export function parseClockTime(value: string | null | undefined): ClockTime | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = /^(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(value);
  if (match === null) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    return null;
  }
  return { hour, minute };
}

/** `HH:mm`, zero-padded, which is what a time input wants written back. */
export function formatClockTime(time: ClockTime): string {
  return `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`;
}

/** `minutes` later on the clock, wrapping past midnight. */
function addClockMinutes(time: ClockTime, minutes: number): ClockTime {
  const total =
    (((time.hour * 60 + time.minute + minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) %
    MINUTES_PER_DAY;
  return { hour: Math.floor(total / 60), minute: total % 60 };
}

/**
 * A zone `packages/shared/src/time.ts` may be called with.
 *
 * That module's formatter cache is bounded only because every zone reaching it
 * has been through `timeZoneSchema`, and this file is where a raw form field
 * would otherwise arrive. The select's options are all resolvable, so this can
 * only fire for a value set in code — which is exactly why it is here and not
 * left to the component's own validator: the validator says which field to fix,
 * this keeps the obligation true at the call site either way.
 */
function usableZone(timeZone: string): boolean {
  return timeZoneSchema.safeParse(timeZone).success;
}

function instantOf(date: CivilDate, time: ClockTime, timeZone: string): string {
  return new Date(wallClockToInstant({ ...date, ...time, second: 0 }, timeZone)).toISOString();
}

/**
 * The interval the fields describe, or `null` when they do not describe one yet.
 *
 * **An end at or before the start means the next day**, and is not an error: the
 * week view already draws a 23:30-00:30 Madrid slot, so a form that refused
 * `end < start` could not author the slot the screen it belongs to renders. Equal
 * times *are* refused — a zero-length slot is not a slot, and 00:00→00:00 read as
 * "the next day" would silently create a 24-hour one, which
 * `MAX_SLOT_DURATION_HOURS` accepts. The crossing is never silent; the caller
 * draws `crossesMidnight`.
 *
 * The end is converted **on its own civil date**, never as `startsAt` plus
 * elapsed minutes — the same reason `weekRange` derives `to` separately (ADR-014).
 */
export function composeInterval(
  value: Pick<SlotFormValue, 'date' | 'startTime' | 'endTime' | 'timeZone'>,
): { startsAt: string; endsAt: string; crossesMidnight: boolean } | null {
  const date = parseCivilDate(value.date);
  const start = parseClockTime(value.startTime);
  const end = parseClockTime(value.endTime);
  if (date === null || start === null || end === null || !usableZone(value.timeZone)) {
    return null;
  }

  const startLabel = formatClockTime(start);
  const endLabel = formatClockTime(end);
  if (startLabel === endLabel) {
    return null;
  }

  const crossesMidnight = endLabel < startLabel;
  const endDate = crossesMidnight ? addCivilDays(date, 1) : date;
  return {
    startsAt: instantOf(date, start, value.timeZone),
    endsAt: instantOf(endDate, end, value.timeZone),
    crossesMidnight,
  };
}

/**
 * The end of the `until` day in the slot's own zone, which is what makes the
 * date the admin picked an inclusive one.
 *
 * `expandRecurrence` compares each occurrence's **start** against `until`,
 * inclusive, so midnight would drop every occurrence on the last day.
 */
export function untilInstant(until: string, timeZone: string): string | null {
  const date = parseCivilDate(until);
  if (date === null || !usableZone(timeZone)) {
    return null;
  }
  return new Date(
    wallClockToInstant({ ...date, hour: 23, minute: 59, second: 59 }, timeZone),
  ).toISOString();
}

/**
 * What both routes open on.
 *
 * On edit the fields are read in **the slot's own zone**, so a Madrid slot
 * opened from a Kyiv browser says 09:00 and not 10:00, and `timeZone` is the
 * **stored spelling verbatim** — canonicalising it behind the admin's back is
 * what ADR-014 refuses, and it is how a slot silently changes the clock it was
 * authored on. Seconds are dropped to the minute: nothing this product creates
 * has any, and a hand-written slot that does is normalised on its next save.
 *
 * `repeats` is always false on edit. `updateScheduleSlotSchema` omits
 * `recurrence` and there is no series-update route, so editing an occurrence of
 * a series changes that occurrence and nothing else; `daysOfWeek` and `until`
 * are then only there to keep the disabled group well formed.
 */
export function initialFormValue(
  slot: ScheduleSlot | null,
  requestedDate: CivilDate | null,
  requestedTime: ClockTime | null,
  browserZone: string,
  now: Date,
): SlotFormValue {
  if (slot !== null) {
    const startWall = wallClockIn(new Date(slot.startsAt), slot.timeZone);
    const endWall = wallClockIn(new Date(slot.endsAt), slot.timeZone);
    const date = { year: startWall.year, month: startWall.month, day: startWall.day };
    return {
      date: formatCivilDate(date),
      startTime: formatClockTime(startWall),
      endTime: formatClockTime(endWall),
      timeZone: slot.timeZone,
      note: fromPlainLocalized(slot.note),
      repeats: false,
      daysOfWeek: [weekdayOfDate(date)],
      until: formatCivilDate(date),
    };
  }

  const wall = wallClockIn(now, browserZone);
  const date = requestedDate ?? { year: wall.year, month: wall.month, day: wall.day };
  const start = requestedTime ?? DEFAULT_START;
  return {
    date: formatCivilDate(date),
    startTime: formatClockTime(start),
    endTime: formatClockTime(addClockMinutes(start, DEFAULT_SLOT_MINUTES)),
    timeZone: browserZone,
    note: {},
    daysOfWeek: [weekdayOfDate(date)],
    repeats: false,
    until: formatCivilDate(date),
  };
}

function weekdayOfDate(date: CivilDate): number {
  return weekdayOf({ ...date, hour: 0, minute: 0, second: 0 });
}

/**
 * Only what actually changed.
 *
 * The omission is not an optimisation: it is what makes "open a slot, save it,
 * nothing moved" true **by construction** rather than by a wall-clock round trip
 * happening to be exact. It is not exact in the autumn overlap, where the second
 * 02:30 reads back as the first, and leaving the field out confines that residual
 * to an admin who really did edit into the repeated hour — where resolving to the
 * earlier instant is ADR-014's documented behaviour.
 *
 * Both sides of the instant comparison are normalised first, because
 * `isoDateTimeSchema` accepts three spellings of one instant and a stored slot
 * may carry any of them. `timeZone` is compared **exactly**: two spellings of one
 * zone are two values ADR-014 keeps apart, and rewriting `Europe/Kiev` to
 * `Europe/Kyiv` on an unrelated save is the silent re-zoning this whole file is
 * arranged against.
 *
 * `status` is never sent. It belongs to the actions that own it, and a save that
 * carried it would quietly re-open a cancelled slot.
 */
export function buildSlotPatch(
  value: SlotFormValue,
  stored: ScheduleSlot,
): UpdateScheduleSlotInput {
  const patch: UpdateScheduleSlotInput = {};
  const interval = composeInterval(value);
  if (interval !== null) {
    if (interval.startsAt !== normaliseInstant(stored.startsAt)) {
      patch.startsAt = interval.startsAt;
    }
    if (interval.endsAt !== normaliseInstant(stored.endsAt)) {
      patch.endsAt = interval.endsAt;
    }
  }
  if (value.timeZone !== stored.timeZone) {
    patch.timeZone = value.timeZone;
  }

  const note = toPlainLocalized(value.note);
  if (hasText(note) || stored.note !== undefined) {
    // The `menuLabelOf` rule: an omitted key means "leave it alone", so a note
    // nobody typed is left out rather than written as `{}` on every save — and
    // it is still sent, empty, when the stored slot has one, because omitting it
    // is also the only thing that would stop an admin clearing it.
    patch.note = note;
  }
  return patch;
}

/** Every field the create route needs, and only the ones the form really set. */
export function buildSlotCreate(value: SlotFormValue): CreateScheduleSlotInput | null {
  const interval = composeInterval(value);
  if (interval === null) {
    return null;
  }

  const note = toPlainLocalized(value.note);
  const until = untilInstant(value.until, value.timeZone);
  return {
    startsAt: interval.startsAt,
    endsAt: interval.endsAt,
    timeZone: value.timeZone,
    ...(hasText(note) ? { note } : {}),
    // Keyed on `repeats`, never on whether the group holds days: `getRawValue()`
    // answers for disabled controls too, so a one-off slot whose author once
    // ticked a weekday would otherwise ship a recurrence. `until` is `null` only
    // for a date the form's own validator refuses.
    ...(value.repeats && until !== null
      ? {
          recurrence: {
            frequency: 'weekly' as const,
            // Sorted and left as ticked otherwise: the API refuses a duplicated
            // weekday as a self-overlap rather than halving it, so nothing here
            // may deduplicate on its behalf.
            daysOfWeek: [...value.daysOfWeek].sort((a, b) => a - b),
            until,
          },
        }
      : {}),
  };
}

function hasText(text: LocalizedText): boolean {
  return Object.values(text).some((entry) => entry.trim() !== '');
}

function normaliseInstant(instant: string): string {
  return new Date(instant).toISOString();
}

/**
 * The conflicting slot's id out of the API's 409, or `null`.
 *
 * **The caller must gate on `status === 409` first.** Three *422* messages
 * (`cap-exceeded`, `recurrence-empty`, `series-too-large`) also quote a token in
 * backticks — `until`, `daysOfWeek` — and `documentIdSchema` accepts all three
 * happily. Behind that gate the only two messages that reach here are the
 * overlap one, which quotes the id, and the self-overlap one, which quotes
 * nothing and so correctly yields no link.
 *
 * It degrades to `null` rather than to a wrong link if the wording ever changes;
 * the API's sentence is still shown either way.
 */
export function conflictSlotId(message: string | undefined): string | null {
  const match = /`([^`]+)`/.exec(message ?? '');
  if (match === null) {
    return null;
  }
  const candidate = match[1] ?? '';
  return documentIdSchema.safeParse(candidate).success ? candidate : null;
}

/**
 * The zone select's options: the runtime's own list, plus the selected zone when
 * that list does not carry it.
 *
 * This is the guard against a silent re-zoning. `Intl.supportedValuesOf` is
 * canonical names only, so it holds `Europe/Kiev` and not `Europe/Kyiv`,
 * `Asia/Calcutta` and not `Asia/Kolkata`, and neither `US/Eastern` nor `UTC` nor
 * any `Etc/*` — while `timeZoneSchema` accepts every one of those and stores the
 * spelling it was given. A select built from the raw list opens a slot stored in
 * one of them with no matching option, shows blank, and writes whatever the admin
 * picks next over a zone they never meant to touch.
 *
 * Matched with `sameZone`, so a stored `europe/madrid` selects the list's
 * `Europe/Madrid` rather than adding a second entry for one zone. The select
 * needs the same `compareWith`, and the control keeps the stored spelling until
 * the admin picks another — which is what keeps an untouched save out of
 * `buildSlotPatch`'s `timeZone` branch.
 */
export function timeZoneOptions(supported: readonly string[], selected: string): string[] {
  if (supported.some((zone) => sameZone(zone, selected))) {
    return [...supported];
  }
  return [...supported, selected].sort();
}
