import { describe, expect, it } from 'vitest';
import {
  addDaysToWallClock,
  wallClockIn,
  wallClockToInstant,
  weekdayOf,
  zoneOffsetMs,
  type WallClock,
} from './schedule.time.js';

const wall = (
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): WallClock => ({ year, month, day, hour, minute, second });

const iso = (epochMs: number): string => new Date(epochMs).toISOString();

/**
 * A `small-icu` Node build resolves every named zone to UTC, which would make
 * the DST expectations below fail in confusing ways. This asserts the runtime
 * actually has the zone data first, so that failure reads as what it is.
 */
describe('Intl time-zone data', () => {
  it('knows Europe/Madrid is an hour ahead of UTC in winter and two in summer', () => {
    expect(zoneOffsetMs(new Date('2026-01-15T12:00:00Z'), 'Europe/Madrid')).toBe(3_600_000);
    expect(zoneOffsetMs(new Date('2026-07-15T12:00:00Z'), 'Europe/Madrid')).toBe(7_200_000);
  });
});

describe('wallClockIn', () => {
  it('reads 09:00 Madrid on both sides of the March transition', () => {
    expect(wallClockIn(new Date('2026-03-25T08:00:00Z'), 'Europe/Madrid')).toEqual(
      wall(2026, 3, 25, 9),
    );
    expect(wallClockIn(new Date('2026-04-01T07:00:00Z'), 'Europe/Madrid')).toEqual(
      wall(2026, 4, 1, 9),
    );
  });

  it('reads midnight as hour 0 on the next day, not hour 24', () => {
    // `hour12: false` yields "24" here in V8, which would date the slot a day early.
    expect(wallClockIn(new Date('2026-01-01T23:00:00Z'), 'Europe/Madrid')).toEqual(
      wall(2026, 1, 2, 0),
    );
  });
});

describe('zoneOffsetMs', () => {
  it('returns the offset in force on each side of a transition', () => {
    expect(zoneOffsetMs(new Date('2026-03-29T00:30:00Z'), 'Europe/Madrid')).toBe(3_600_000);
    expect(zoneOffsetMs(new Date('2026-03-29T01:30:00Z'), 'Europe/Madrid')).toBe(7_200_000);
  });

  it('handles a zone whose offset is not a whole number of hours', () => {
    expect(zoneOffsetMs(new Date('2026-03-29T00:30:00Z'), 'Asia/Kolkata')).toBe(19_800_000);
  });

  it('ignores the milliseconds of the instant it probes', () => {
    // Without flooring to the second, the formatted parts (which carry no
    // milliseconds) make this 3_600_000 - 123.
    expect(zoneOffsetMs(new Date('2026-01-15T12:00:00.123Z'), 'Europe/Madrid')).toBe(3_600_000);
  });
});

describe('wallClockToInstant', () => {
  it('round-trips a plain winter and a plain summer wall clock', () => {
    expect(iso(wallClockToInstant(wall(2026, 3, 25, 9), 'Europe/Madrid'))).toBe(
      '2026-03-25T08:00:00.000Z',
    );
    expect(iso(wallClockToInstant(wall(2026, 4, 1, 9), 'Europe/Madrid'))).toBe(
      '2026-04-01T07:00:00.000Z',
    );
  });

  it('round-trips a zone that is not the runtime default', () => {
    expect(iso(wallClockToInstant(wall(2026, 3, 25, 9), 'Europe/Kyiv'))).toBe(
      '2026-03-25T07:00:00.000Z',
    );
    expect(iso(wallClockToInstant(wall(2026, 4, 1, 9), 'Europe/Kyiv'))).toBe(
      '2026-04-01T06:00:00.000Z',
    );
  });

  it('shifts a wall clock inside the spring-forward gap forward by the gap', () => {
    // 02:30 does not exist on 29 March in Madrid; the clock jumps 02:00 → 03:00.
    const instant = wallClockToInstant(wall(2026, 3, 29, 2, 30), 'Europe/Madrid');

    expect(iso(instant)).toBe('2026-03-29T01:30:00.000Z');
    expect(wallClockIn(new Date(instant), 'Europe/Madrid')).toEqual(wall(2026, 3, 29, 3, 30));
  });

  it('picks the earlier of two instants for a wall clock that happens twice', () => {
    // 02:30 happens twice on 25 October in Madrid, at 00:30Z and again at 01:30Z.
    const instant = wallClockToInstant(wall(2026, 10, 25, 2, 30), 'Europe/Madrid');

    expect(iso(instant)).toBe('2026-10-25T00:30:00.000Z');
    expect(wallClockIn(new Date(instant), 'Europe/Madrid')).toEqual(wall(2026, 10, 25, 2, 30));
  });

  it('resolves midnight in a zone that is behind UTC', () => {
    expect(iso(wallClockToInstant(wall(2026, 6, 15, 0), 'America/New_York'))).toBe(
      '2026-06-15T04:00:00.000Z',
    );
  });
});

describe('addDaysToWallClock', () => {
  it('rolls over into a leap day', () => {
    expect(addDaysToWallClock(wall(2028, 2, 28, 9), 1)).toEqual(wall(2028, 2, 29, 9));
  });

  it('rolls over the end of a year', () => {
    expect(addDaysToWallClock(wall(2026, 12, 31, 23, 30), 1)).toEqual(wall(2027, 1, 1, 23, 30));
  });

  it('keeps the time of day across a week', () => {
    expect(addDaysToWallClock(wall(2026, 3, 25, 9), 7)).toEqual(wall(2026, 4, 1, 9));
  });
});

describe('weekdayOf', () => {
  it('names the day of the week a civil date falls on', () => {
    expect(weekdayOf(wall(2026, 9, 7))).toBe(1);
    expect(weekdayOf(wall(2026, 9, 9))).toBe(3);
    expect(weekdayOf(wall(2026, 9, 13))).toBe(0);
  });
});
