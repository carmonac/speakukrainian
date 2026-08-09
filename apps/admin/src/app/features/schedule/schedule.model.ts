import {
  addDaysToWallClock,
  resolveLocalized,
  wallClockIn,
  wallClockToInstant,
  weekdayOf,
  type LocaleCode,
  type ScheduleSlot,
  type WallClock,
} from '@speakukrainian/shared';
import { MONTH_LABELS, WEEKDAY_LABELS } from './schedule-messages';

/**
 * Every decision the week view makes, as pure functions — the
 * `sections.model.ts` arrangement, where the component measures and dispatches
 * and decides nothing.
 *
 * Two rules hold throughout. No function here reads a clock or a zone it was
 * not given: `now` is always a parameter, never a `new Date()` inside. And
 * nothing here constructs an `Intl.DateTimeFormat` — every zone decision goes
 * through `packages/shared`'s time helpers, which keeps the `hourCycle`
 * midnight trap solved in one place, keeps that module's formatter cache the
 * only one, and makes every label a fixed string a test can assert rather than
 * whatever ICU decides for the machine's locale.
 */

/** A date on the calendar with no zone and no time attached. `month` is 1-12. */
export interface CivilDate {
  year: number;
  month: number;
  day: number;
}

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

function atMidnight(date: CivilDate): WallClock {
  return { ...date, hour: 0, minute: 0, second: 0 };
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/**
 * `null` for anything that is not a real calendar date, which the caller turns
 * into a redirect to this week.
 *
 * The shape test is not enough on its own: `Date.UTC` happily normalises
 * `2026-02-31` into 3 March, so a typed URL would silently open a week the
 * admin never asked for. Reading the fields back is what refuses it.
 */
export function parseCivilDate(value: string | null | undefined): CivilDate | null {
  if (typeof value !== 'string' || !CIVIL_DATE.test(value)) {
    return null;
  }

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() + 1 !== month ||
    utc.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

/** Zero-padded `YYYY-MM-DD`, which is both the URL value and a column key. */
export function formatCivilDate(date: CivilDate): string {
  return `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}`;
}

export function sameCivilDate(a: CivilDate, b: CivilDate): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

/**
 * `days` later on the calendar. No zone is consulted, because a civil date is
 * not an instant — adding elapsed milliseconds to one is the bug ADR-014 exists
 * to avoid, and it is wrong exactly twice a year.
 */
export function addCivilDays(date: CivilDate, days: number): CivilDate {
  const shifted = addDaysToWallClock(atMidnight(date), days);
  return { year: shifted.year, month: shifted.month, day: shifted.day };
}

/**
 * The Monday of the week `date` falls in. Monday-first because the product's
 * locales — `en`, `es`, `uk` — all read a week that way in practice; the shift
 * maps Sunday (`weekdayOf` 0) to six days back rather than to the day after.
 */
export function startOfWeek(date: CivilDate): CivilDate {
  return addCivilDays(date, -((weekdayOf(atMidnight(date)) + 6) % 7));
}

/** The calendar date an instant falls on in `timeZone`. */
export function civilDateIn(instant: string, timeZone: string): CivilDate {
  const wall = wallClockIn(new Date(instant), timeZone);
  return { year: wall.year, month: wall.month, day: wall.day };
}

export function todayIn(timeZone: string, now: Date): CivilDate {
  const wall = wallClockIn(now, timeZone);
  return { year: wall.year, month: wall.month, day: wall.day };
}

/**
 * The absolute range the API is asked for: midnight to midnight in the view
 * zone, which is exactly the week on screen and nothing else.
 *
 * `to` is the civil date seven days on, converted **on its own**. Deriving it
 * as `from + 7 × 86_400_000` is ADR-014's mistake one layer up: a week is 167
 * or 169 hours twice a year, and the two DST weeks would then request an hour
 * of the wrong week and miss an hour of the right one.
 */
export function weekRange(monday: CivilDate, viewZone: string): { from: string; to: string } {
  return {
    from: new Date(wallClockToInstant(atMidnight(monday), viewZone)).toISOString(),
    to: new Date(wallClockToInstant(atMidnight(addCivilDays(monday, 7)), viewZone)).toISOString(),
  };
}

/**
 * Case-folded, never `===`: ADR-014 stores a slot's zone exactly as the admin
 * spelled it, so `Europe/Madrid` and `europe/madrid` are one zone and two
 * strings.
 *
 * Case is as far as it goes. `Europe/Kyiv` and `Europe/Kiev` are one zone and
 * stay two strings here, because resolving a backward-compatibility link means
 * canonicalising, which ADR-014 refuses to do behind the admin's back. What
 * stops that showing up on screen is {@link viewIntervalFor}, which decides on
 * what the second line would say rather than on the two names.
 */
export function sameZone(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** `HH:mm` in `timeZone`, on a 24-hour clock. */
export function timeLabel(instant: string, timeZone: string): string {
  const wall = wallClockIn(new Date(instant), timeZone);
  return `${pad(wall.hour)}:${pad(wall.minute)}`;
}

/** `HH:mm–HH:mm` in `timeZone` (en dash). */
export function intervalLabel(startsAt: string, endsAt: string, timeZone: string): string {
  return `${timeLabel(startsAt, timeZone)}–${timeLabel(endsAt, timeZone)}`;
}

/** `Mon`, `Tue`, … */
export function weekdayLabel(date: CivilDate): string {
  return WEEKDAY_LABELS[weekdayOf(atMidnight(date))] ?? '';
}

/** `2 Mar`, for a day column heading. */
export function monthDayLabel(date: CivilDate): string {
  return `${date.day} ${MONTH_LABELS[date.month - 1] ?? ''}`;
}

/** `2 Mar 2026`, for the header's week label. */
export function fullDateLabel(date: CivilDate): string {
  return `${monthDayLabel(date)} ${date.year}`;
}

/**
 * The note in the default locale, then any locale that has text, then nothing.
 *
 * The same fallback `sectionTitle` uses and for the same reason: stopping at
 * the default locale would blank every note the moment an admin makes a locale
 * default that the notes were not authored in, a state `/locales` can put the
 * site into. Unlike a title there is **no placeholder** — a slot with no note
 * is a perfectly ordinary slot, so the chip simply shows no note line.
 */
export function slotNote(slot: ScheduleSlot, defaultCode: LocaleCode | null): string {
  const note = slot.note;
  if (note === undefined) {
    return '';
  }
  if (defaultCode !== null) {
    const preferred = resolveLocalized(note, defaultCode, defaultCode);
    if (preferred.length > 0) {
      return preferred;
    }
  }
  for (const text of Object.values(note)) {
    if (text.trim().length > 0) {
      return text;
    }
  }
  return '';
}

/** One slot as the template renders it. Every `null` means "do not draw that bit". */
export interface SlotView {
  slot: ScheduleSlot;
  /** The interval in the zone the slot was authored in — the primary line. */
  ownInterval: string;
  ownZone: string;
  /** Set only when the slot's own civil day differs from the column it is drawn in. */
  ownWeekday: string | null;
  /** The interval in the view zone — see {@link viewIntervalFor} for when it is set. */
  viewInterval: string | null;
  note: string;
  startsBeforeWeek: boolean;
}

/** One day of the grid. Always rendered, whether or not it holds slots. */
export interface DayColumn {
  date: CivilDate;
  /** The formatted civil date, which is also what slots are grouped by. */
  key: string;
  label: string;
  isToday: boolean;
  slots: SlotView[];
}

/**
 * The seven columns to draw, in Monday-first order.
 *
 * **Geometry is one clock, labels are the slot's clock.** A slot lands in the
 * day column its `startsAt` falls on *in the view zone*, because a grid whose
 * rows are drawn on different clocks says two slots clash when they do not. The
 * chip then says which clock it was authored on, which is what stops a slot
 * authored 23:30 Friday in Madrid, drawn in Saturday's column from Kyiv, from
 * reading as a placement bug.
 *
 * Every column is emitted even when empty, so the grid does not reflow around a
 * quiet day. A slot outside all seven columns is drawn in the first one rather
 * than dropped: the API answers slots that *intersect* the range, so one that
 * began last week and runs into Monday comes back with no column of its own,
 * and an admin hunting a clash has to see it.
 */
export function buildWeek(
  monday: CivilDate,
  viewZone: string,
  slots: readonly ScheduleSlot[],
  defaultCode: LocaleCode | null,
  today: CivilDate,
): DayColumn[] {
  const columns: DayColumn[] = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const date = addCivilDays(monday, offset);
    columns.push({
      date,
      key: formatCivilDate(date),
      label: `${weekdayLabel(date)} ${monthDayLabel(date)}`,
      isToday: sameCivilDate(date, today),
      slots: [],
    });
  }

  const mondayKey = formatCivilDate(monday);
  const byKey = new Map(columns.map((column) => [column.key, column]));

  for (const slot of slots) {
    const startsOn = civilDateIn(slot.startsAt, viewZone);
    const startKey = formatCivilDate(startsOn);
    const column = byKey.get(startKey) ?? columns[0]!;
    const ownDate = civilDateIn(slot.startsAt, slot.timeZone);
    const ownInterval = intervalLabel(slot.startsAt, slot.endsAt, slot.timeZone);

    column.slots.push({
      slot,
      ownInterval,
      ownZone: slot.timeZone,
      ownWeekday: sameCivilDate(ownDate, column.date) ? null : weekdayLabel(ownDate),
      viewInterval: viewIntervalFor(slot, viewZone, ownInterval),
      note: slotNote(slot, defaultCode),
      // Zero-padded dates compare lexicographically, so this is the calendar
      // comparison without a second conversion to an instant.
      startsBeforeWeek: startKey < mondayKey,
    });
  }

  for (const column of columns) {
    // Sorted here rather than relied on: the API's ordering is a repository
    // detail, and a client that quietly depends on it breaks the day it changes.
    column.slots.sort((a, b) => Date.parse(a.slot.startsAt) - Date.parse(b.slot.startsAt));
  }

  return columns;
}

/**
 * The second time line, or `null` when it would say nothing new.
 *
 * The zone check alone is not enough, and a real browser is where that shows.
 * Chromium answers `Europe/Kiev` for a machine set to `Europe/Kyiv`, so every
 * slot an admin in Kyiv authors — the product's own audience — is stored under
 * one spelling and viewed under the other, and a zone-name comparison then
 * draws the identical interval twice on every chip. Two zones at the same
 * offset for this slot (`Europe/Madrid` and `Europe/Paris`) read the same way.
 *
 * So the deciding question is what the line would *say*: its whole job is to
 * give the interval on the clock the grid is drawn on, and if that is
 * character-for-character the line above it, there is nothing to add. Nothing
 * is hidden by this, because the primary line still names the slot's own zone.
 *
 * It is not canonicalisation, which ADR-014 refuses: no stored value is
 * rewritten and no zone name is resolved to another. `sameZone` stays as the
 * cheap path for the common case and keeps the case-folding rule visible.
 */
function viewIntervalFor(slot: ScheduleSlot, viewZone: string, ownInterval: string): string | null {
  if (sameZone(slot.timeZone, viewZone)) {
    return null;
  }
  const inViewZone = intervalLabel(slot.startsAt, slot.endsAt, viewZone);
  return inViewZone === ownInterval ? null : inViewZone;
}
