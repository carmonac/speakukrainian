import { describe, expect, it } from 'vitest';
import type { ScheduleSlot } from '@speakukrainian/shared';
import {
  addCivilDays,
  buildWeek,
  civilDateIn,
  formatCivilDate,
  fullDateLabel,
  intervalLabel,
  parseCivilDate,
  sameZone,
  slotNote,
  startOfWeek,
  weekRange,
  type CivilDate,
} from './schedule.model';

/**
 * Nothing here injects anything, and no function under test reads a clock or a
 * zone it was not given — which is what makes these assertions independent of
 * the machine the suite runs on. The component spec covers the one place a zone
 * is read from the environment, through an overridden `BROWSER_TIME_ZONE`.
 */

const MADRID = 'Europe/Madrid';
const KYIV = 'Europe/Kyiv';

const audit = {
  createdAt: '2026-01-01T00:00:00Z',
  createdBy: 'admin',
  updatedAt: '2026-01-01T00:00:00Z',
  updatedBy: 'admin',
};

function slot(id: string, overrides: Partial<ScheduleSlot> = {}): ScheduleSlot {
  return {
    id,
    ownerId: 'teacher',
    startsAt: '2026-03-02T08:00:00Z',
    endsAt: '2026-03-02T09:00:00Z',
    timeZone: MADRID,
    status: 'open',
    recurrenceId: null,
    bookedBy: null,
    bookedAt: null,
    audit,
    ...overrides,
  };
}

function date(value: string): CivilDate {
  const parsed = parseCivilDate(value);
  if (parsed === null) {
    throw new Error(`${value} is not a civil date`);
  }
  return parsed;
}

/** How many hours a requested range spans, which is what the DST weeks pin. */
function spanHours(range: { from: string; to: string }): number {
  return (Date.parse(range.to) - Date.parse(range.from)) / 3_600_000;
}

describe('parseCivilDate', () => {
  it('accepts a zero-padded calendar date', () => {
    expect(parseCivilDate('2026-03-02')).toEqual({ year: 2026, month: 3, day: 2 });
  });

  it('refuses anything that is not one, rather than normalising it', () => {
    // `2026-02-31` is the one that matters: `Date.UTC` turns it into 3 March,
    // so without the round-trip a typed URL would open a week nobody asked for.
    expect(parseCivilDate('2026-02-31')).toBeNull();
    expect(parseCivilDate('2026-3-2')).toBeNull();
    expect(parseCivilDate('2026-13-01')).toBeNull();
    expect(parseCivilDate('')).toBeNull();
    expect(parseCivilDate(null)).toBeNull();
    expect(parseCivilDate(undefined)).toBeNull();
    expect(parseCivilDate('nonsense')).toBeNull();
  });

  it('refuses a real date in a year no slot can be scheduled in', () => {
    // `9999-12-27` is the one that matters. Its week ends in the year 10000,
    // which `toISOString` spells `+010000-01-02T22:00:00.000Z` and the API
    // rejects — so left in, one unusable `?from=` fails differently from every
    // other one.
    expect(parseCivilDate('9999-12-27')).toBeNull();
    expect(parseCivilDate('3000-01-01')).toBeNull();
    expect(parseCivilDate('1969-12-29')).toBeNull();
    expect(parseCivilDate('0000-01-03')).toBeNull();

    // The bounds themselves are dates, not the first refusal.
    expect(parseCivilDate('1970-01-01')).toEqual({ year: 1970, month: 1, day: 1 });
    expect(parseCivilDate('2999-12-31')).toEqual({ year: 2999, month: 12, day: 31 });
  });
});

describe('startOfWeek', () => {
  it('snaps every day of one week back to the same Monday', () => {
    const week = [
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
      '2026-03-05',
      '2026-03-06',
      '2026-03-07',
      '2026-03-08',
    ];
    for (const day of week) {
      expect(formatCivilDate(startOfWeek(date(day)))).toBe('2026-03-02');
    }
  });

  it('takes a Sunday back six days, not forward one', () => {
    // `weekdayOf` is Sunday-first, so this is the shift that is off by one if
    // the Monday-first correction is written the obvious way.
    expect(formatCivilDate(startOfWeek(date('2026-03-01')))).toBe('2026-02-23');
  });

  it('crosses a month boundary', () => {
    expect(formatCivilDate(startOfWeek(date('2026-01-01')))).toBe('2025-12-29');
  });
});

describe('addCivilDays', () => {
  it('moves by calendar days across a month and a year boundary', () => {
    expect(formatCivilDate(addCivilDays(date('2026-03-02'), 7))).toBe('2026-03-09');
    expect(formatCivilDate(addCivilDays(date('2026-03-02'), -7))).toBe('2026-02-23');
    expect(formatCivilDate(addCivilDays(date('2025-12-29'), 7))).toBe('2026-01-05');
  });
});

describe('weekRange', () => {
  it('asks for midnight to midnight in the view zone', () => {
    // Madrid is an hour ahead of UTC in winter, so the week does not start at
    // 00:00Z. Computing the bounds in UTC fails here.
    expect(weekRange(date('2026-03-02'), MADRID)).toEqual({
      from: '2026-03-01T23:00:00.000Z',
      to: '2026-03-08T23:00:00.000Z',
    });
    expect(spanHours(weekRange(date('2026-03-02'), MADRID))).toBe(168);
  });

  it('asks for 167 hours across the spring-forward week', () => {
    // 29 March 2026, when Madrid loses an hour. `from + 7 × 86_400_000` would
    // ask for an hour of the next week and miss an hour of this one.
    const range = weekRange(date('2026-03-23'), MADRID);
    expect(range).toEqual({
      from: '2026-03-22T23:00:00.000Z',
      to: '2026-03-29T22:00:00.000Z',
    });
    expect(spanHours(range)).toBe(167);
  });

  it('asks for 169 hours across the autumn-back week', () => {
    const range = weekRange(date('2026-10-19'), MADRID);
    expect(range).toEqual({
      from: '2026-10-18T22:00:00.000Z',
      to: '2026-10-25T23:00:00.000Z',
    });
    expect(spanHours(range)).toBe(169);
  });

  it('is the same civil week on a different clock in a different zone', () => {
    expect(weekRange(date('2026-03-02'), KYIV)).toEqual({
      from: '2026-03-01T22:00:00.000Z',
      to: '2026-03-08T22:00:00.000Z',
    });
  });
});

describe('civilDateIn', () => {
  it('reads the calendar date the instant falls on in that zone, not in UTC', () => {
    expect(civilDateIn('2026-03-06T22:30:00Z', KYIV)).toEqual({ year: 2026, month: 3, day: 7 });
    expect(civilDateIn('2026-03-06T22:30:00Z', MADRID)).toEqual({ year: 2026, month: 3, day: 6 });
  });
});

describe('intervalLabel', () => {
  it('zero-pads a midnight start', () => {
    // Pins the padding only. It cannot fail for the historical `hour12: false`
    // "24" bug — this runtime answers `00` for both spellings, and the
    // formatter belongs to `packages/shared` anyway.
    expect(intervalLabel('2026-03-06T23:00:00Z', '2026-03-07T00:00:00Z', MADRID)).toBe(
      '00:00–01:00',
    );
  });

  it('reads the same instant differently in two zones', () => {
    expect(intervalLabel('2026-03-06T08:00:00Z', '2026-03-06T09:00:00Z', MADRID)).toBe(
      '09:00–10:00',
    );
    expect(intervalLabel('2026-03-06T08:00:00Z', '2026-03-06T09:00:00Z', KYIV)).toBe('10:00–11:00');
  });
});

describe('sameZone', () => {
  it('folds case, because a zone is stored as the admin spelled it', () => {
    expect(sameZone(MADRID, 'europe/madrid')).toBe(true);
    expect(sameZone(MADRID, KYIV)).toBe(false);
  });

  it('treats a link name as a different zone, which is the accepted limitation', () => {
    // `Europe/Kiev` and `Europe/Kyiv` are one zone and two strings, so a slot
    // stored under the link name gets a redundant second time line. Resolving
    // that means canonicalising, which ADR-014 refuses.
    expect(sameZone(KYIV, 'Europe/Kiev')).toBe(false);
  });
});

describe('fullDateLabel', () => {
  it('reads as a date without going near a locale-sensitive formatter', () => {
    expect(fullDateLabel(date('2026-03-02'))).toBe('2 Mar 2026');
  });
});

describe('slotNote', () => {
  it('prefers the default locale', () => {
    expect(slotNote(slot('a', { note: { en: 'Beginners', uk: 'Початківці' } }), 'en')).toBe(
      'Beginners',
    );
  });

  it('falls back to any locale that has text', () => {
    // Further than ADR-009 goes, deliberately: stopping at the default locale
    // would blank every note the day someone makes a locale default that the
    // notes were not authored in.
    expect(slotNote(slot('a', { note: { uk: 'Початківці' } }), 'en')).toBe('Початківці');
    expect(slotNote(slot('a', { note: { en: '  ', uk: 'Початківці' } }), 'en')).toBe('Початківці');
    expect(slotNote(slot('a', { note: { uk: 'Початківці' } }), null)).toBe('Початківці');
  });

  it('is empty for a slot with no note, which is an ordinary slot', () => {
    expect(slotNote(slot('a'), 'en')).toBe('');
    expect(slotNote(slot('a', { note: {} }), 'en')).toBe('');
    expect(slotNote(slot('a', { note: { en: '   ' } }), 'en')).toBe('');
  });
});

describe('buildWeek', () => {
  const monday = date('2026-03-02');
  const today = date('2026-03-04');

  it('always draws seven columns, Monday first, even for an empty week', () => {
    const columns = buildWeek(monday, MADRID, [], 'en', today);

    expect(columns.map((column) => column.key)).toEqual([
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
      '2026-03-05',
      '2026-03-06',
      '2026-03-07',
      '2026-03-08',
    ]);
    expect(columns.map((column) => column.label)).toEqual([
      'Mon 2 Mar',
      'Tue 3 Mar',
      'Wed 4 Mar',
      'Thu 5 Mar',
      'Fri 6 Mar',
      'Sat 7 Mar',
      'Sun 8 Mar',
    ]);
    expect(columns.map((column) => column.isToday)).toEqual([
      false,
      false,
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  it('places a slot in the column its start falls on in the view zone', () => {
    // 23:30 Friday in Madrid is 00:30 Saturday in Kyiv, so from Kyiv it belongs
    // in Saturday's column — and the chip says `Fri` so that reads as correct
    // rather than as a placement bug.
    const columns = buildWeek(
      monday,
      KYIV,
      [
        slot('late', {
          startsAt: '2026-03-06T22:30:00Z',
          endsAt: '2026-03-06T23:30:00Z',
          timeZone: MADRID,
        }),
      ],
      'en',
      today,
    );

    const saturday = columns[5]!;
    expect(saturday.key).toBe('2026-03-07');
    expect(saturday.slots.map((view) => view.slot.id)).toEqual(['late']);
    expect(saturday.slots[0]).toMatchObject({
      ownInterval: '23:30–00:30',
      ownZone: MADRID,
      ownWeekday: 'Fri',
      viewInterval: '00:30–01:30',
      startsBeforeWeek: false,
    });
  });

  it('leaves the weekday off when the slot’s own day is the column it is in', () => {
    const columns = buildWeek(
      monday,
      KYIV,
      [
        slot('morning', {
          startsAt: '2026-03-06T08:00:00Z',
          endsAt: '2026-03-06T09:00:00Z',
          timeZone: MADRID,
        }),
      ],
      'en',
      today,
    );

    expect(columns[4]!.slots[0]).toMatchObject({
      ownWeekday: null,
      ownInterval: '09:00–10:00',
      viewInterval: '10:00–11:00',
    });
  });

  it('draws one time line when the slot was authored in the view zone', () => {
    const columns = buildWeek(
      monday,
      MADRID,
      [
        slot('local', {
          startsAt: '2026-03-06T08:00:00Z',
          endsAt: '2026-03-06T09:00:00Z',
          timeZone: 'europe/madrid',
        }),
      ],
      'en',
      today,
    );

    // A different spelling of the same zone is the same zone, so no second line.
    expect(columns[4]!.slots[0]?.viewInterval).toBeNull();
    expect(columns[4]!.slots[0]?.ownInterval).toBe('09:00–10:00');
  });

  it('draws one time line when the second would repeat the first word for word', () => {
    // Chromium answers `Europe/Kiev` for a machine set to `Europe/Kyiv`, so the
    // zone comparison alone puts the identical interval on every chip an admin
    // in Kyiv authored — which is this product's own audience.
    const columns = buildWeek(
      monday,
      'Europe/Kiev',
      [
        slot('link-name', {
          startsAt: '2026-03-06T08:00:00Z',
          endsAt: '2026-03-06T09:00:00Z',
          timeZone: KYIV,
        }),
        // Two genuinely different zones that happen to read the same, which the
        // second line has nothing to add to either.
        slot('same-clock', {
          startsAt: '2026-03-06T12:00:00Z',
          endsAt: '2026-03-06T13:00:00Z',
          timeZone: 'Europe/Helsinki',
        }),
      ],
      'en',
      today,
    );

    expect(columns[4]!.slots.map((view) => view.viewInterval)).toEqual([null, null]);
    // The zone the slot was authored in is still named, so nothing is lost.
    expect(columns[4]!.slots.map((view) => view.ownZone)).toEqual([KYIV, 'Europe/Helsinki']);
  });

  it('keeps a slot that began before the week, in the first column and flagged', () => {
    // The API answers slots that *intersect* the range, so this one comes back
    // with no column of its own. Dropping it hides the clash it causes.
    const columns = buildWeek(
      monday,
      MADRID,
      [
        slot('overnight', {
          startsAt: '2026-03-01T22:00:00Z',
          endsAt: '2026-03-02T01:00:00Z',
          timeZone: MADRID,
        }),
      ],
      'en',
      today,
    );

    expect(columns[0]!.slots.map((view) => view.slot.id)).toEqual(['overnight']);
    expect(columns[0]!.slots[0]).toMatchObject({
      startsBeforeWeek: true,
      ownWeekday: 'Sun',
      ownInterval: '23:00–02:00',
    });
    expect(columns.slice(1).flatMap((column) => column.slots)).toEqual([]);
  });

  it('sorts each column by start, rather than trusting the order it was given', () => {
    const columns = buildWeek(
      monday,
      MADRID,
      [
        slot('late', { startsAt: '2026-03-04T16:00:00Z', endsAt: '2026-03-04T17:00:00Z' }),
        slot('early', { startsAt: '2026-03-04T08:00:00Z', endsAt: '2026-03-04T09:00:00Z' }),
        slot('middle', { startsAt: '2026-03-04T12:00:00Z', endsAt: '2026-03-04T13:00:00Z' }),
      ],
      'en',
      today,
    );

    expect(columns[2]!.slots.map((view) => view.slot.id)).toEqual(['early', 'middle', 'late']);
  });

  it('carries the note through, resolved for the admin’s default locale', () => {
    const columns = buildWeek(
      monday,
      MADRID,
      [
        slot('noted', {
          startsAt: '2026-03-04T08:00:00Z',
          endsAt: '2026-03-04T09:00:00Z',
          note: { en: 'Beginners only', uk: 'Тільки початківці' },
        }),
      ],
      'en',
      today,
    );

    expect(columns[2]!.slots[0]?.note).toBe('Beginners only');
  });
});
