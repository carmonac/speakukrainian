/**
 * Wall clock ↔ absolute instant, using `Intl` alone — no date library.
 *
 * A recurring slot is authored as a local time in an IANA zone ("09:00 in
 * Europe/Madrid"), and every occurrence has to keep that local time across a
 * daylight-saving change. That means the conversion has to run per occurrence,
 * from civil date fields, and never from elapsed milliseconds.
 */

/** A civil date and time with no zone attached. `month` is 1-12. */
export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const DAY_MS = 86_400_000;

/**
 * Constructing a formatter is expensive and a 200-occurrence expansion asks for
 * one several hundred times. The map is keyed by zone and lives for the process:
 * zone rules do not change between two calls, and this module is API-only, so
 * no SSR render shares it.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) {
    return cached;
  }
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    // `hourCycle: 'h23'` rather than `hour12: false`: V8 answers "24" for
    // midnight under the latter, which would put every midnight slot on the
    // previous day.
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  formatters.set(timeZone, formatter);
  return formatter;
}

/** The local date and time an instant reads as in `timeZone`. */
export function wallClockIn(instant: Date, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (!part) {
      throw new Error(`Intl gave no "${type}" part for time zone "${timeZone}"`);
    }
    return Number(part.value);
  };

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

function asUtcMs(wall: WallClock): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
}

/**
 * The offset `timeZone` was at during `instant`, in milliseconds east of UTC.
 *
 * The instant is floored to the second because the formatted parts carry no
 * milliseconds: subtracting the raw epoch value instead would return an offset
 * out by up to 999 ms and desynchronise every derived instant.
 */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
  const flooredMs = Math.floor(instant.getTime() / 1000) * 1000;
  return asUtcMs(wallClockIn(instant, timeZone)) - flooredMs;
}

function readsBackAs(epochMs: number, wall: WallClock, timeZone: string): boolean {
  const actual = wallClockIn(new Date(epochMs), timeZone);
  return (
    actual.year === wall.year &&
    actual.month === wall.month &&
    actual.day === wall.day &&
    actual.hour === wall.hour &&
    actual.minute === wall.minute &&
    actual.second === wall.second
  );
}

/**
 * The instant at which `timeZone` reads `wall`, as epoch milliseconds.
 *
 * It is not `wall − zoneOffsetMs(wall)`: the offset in force depends on the
 * instant being computed, which is the thing not yet known. So probe the offset
 * ±24 h either side of the wall clock read as if it were UTC — no zone
 * transitions twice inside 48 h, so those two probes are exactly the offsets on
 * either side of any transition — and take the candidate that formats back to
 * what was asked for.
 *
 * The two hard cases fall out of that one rule, both matching `Temporal`'s
 * `disambiguation: 'compatible'`:
 *
 * - **Autumn overlap** (a wall clock that happens twice): both candidates read
 *   back correctly and `before` is returned, so a repeated 02:30 means the
 *   first one, still on summer time.
 * - **Spring-forward gap** (a wall clock that never happens): neither candidate
 *   reads back, and the fallback returns `before`, which is arithmetically the
 *   requested time shifted forward by the size of the gap — 02:30 becomes
 *   03:30. Skipping the occurrence instead would break the "exact expected
 *   number of slots" promise, and refusing the series would refuse one that is
 *   fine on the other 51 weeks.
 */
export function wallClockToInstant(wall: WallClock, timeZone: string): number {
  const naive = asUtcMs(wall);
  const before = naive - zoneOffsetMs(new Date(naive - DAY_MS), timeZone);
  const after = naive - zoneOffsetMs(new Date(naive + DAY_MS), timeZone);

  if (readsBackAs(before, wall, timeZone)) {
    return before;
  }
  if (readsBackAs(after, wall, timeZone)) {
    return after;
  }
  return before;
}

/**
 * Civil-date arithmetic: `days` later on the calendar, same time of day. Month
 * and year rollover come free from `Date.UTC`, which normalises an out-of-range
 * day, and no zone is consulted — a wall clock is not an instant, so adding
 * elapsed milliseconds to one is the bug this exists to avoid.
 */
export function addDaysToWallClock(wall: WallClock, days: number): WallClock {
  const shifted = new Date(
    Date.UTC(wall.year, wall.month - 1, wall.day + days, wall.hour, wall.minute, wall.second),
  );
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

/** The day of the week a civil date falls on: 0 = Sunday … 6 = Saturday. */
export function weekdayOf(wall: WallClock): number {
  return new Date(asUtcMs(wall)).getUTCDay();
}
