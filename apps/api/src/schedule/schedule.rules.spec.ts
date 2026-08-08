import { describe, expect, it } from 'vitest';
import type { ScheduleSlot } from '@speakukrainian/shared';
import {
  MAX_RECURRENCE_SLOTS,
  MAX_SLOT_DURATION_MS,
  exceedsMaxDuration,
  expandRecurrence,
  firstSelfOverlap,
  firstStoredOverlap,
  overlaps,
  toInstant,
  type SlotDraft,
} from './schedule.rules.js';

const draft = (startsAt: string, endsAt: string): SlotDraft => ({ startsAt, endsAt });

const localTimeIn = (instant: string, timeZone: string): string =>
  new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(instant));

const storedSlot = (id: string, startsAt: string, endsAt: string): ScheduleSlot => ({
  id,
  ownerId: 'admin-uid',
  startsAt,
  endsAt,
  timeZone: 'Europe/Madrid',
  status: 'open',
  recurrenceId: null,
  bookedBy: null,
  bookedAt: null,
  audit: {
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'admin-uid',
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'admin-uid',
  },
});

describe('toInstant', () => {
  it('normalises every spelling of one instant to the same string', () => {
    // Firestore compares `startsAt` lexicographically, so the offset form would
    // sort outside a range expressed in `Z` and drop out of the query.
    expect(toInstant('2026-03-30T09:00:00+02:00')).toBe('2026-03-30T07:00:00.000Z');
    expect(toInstant('2026-03-30T07:00:00Z')).toBe('2026-03-30T07:00:00.000Z');
    expect(toInstant('2026-03-30T07:00:00.000Z')).toBe('2026-03-30T07:00:00.000Z');
  });
});

describe('overlaps', () => {
  it('treats back-to-back slots as free', () => {
    expect(
      overlaps(
        draft('2026-09-07T09:00:00.000Z', '2026-09-07T10:00:00.000Z'),
        draft('2026-09-07T10:00:00.000Z', '2026-09-07T11:00:00.000Z'),
      ),
    ).toBe(false);
  });

  it('finds a partial overlap in either direction', () => {
    const morning = draft('2026-09-07T09:00:00.000Z', '2026-09-07T10:00:00.000Z');
    const straddling = draft('2026-09-07T09:30:00.000Z', '2026-09-07T10:30:00.000Z');

    expect(overlaps(morning, straddling)).toBe(true);
    expect(overlaps(straddling, morning)).toBe(true);
  });

  it('finds a slot wholly inside another', () => {
    expect(
      overlaps(
        draft('2026-09-07T09:00:00.000Z', '2026-09-07T12:00:00.000Z'),
        draft('2026-09-07T10:00:00.000Z', '2026-09-07T11:00:00.000Z'),
      ),
    ).toBe(true);
  });
});

describe('exceedsMaxDuration', () => {
  it('allows exactly the cap and refuses a millisecond more', () => {
    const start = '2026-09-07T09:00:00.000Z';
    const atCap = new Date(Date.parse(start) + MAX_SLOT_DURATION_MS).toISOString();
    const overCap = new Date(Date.parse(start) + MAX_SLOT_DURATION_MS + 1).toISOString();

    expect(exceedsMaxDuration(start, atCap)).toBe(false);
    expect(exceedsMaxDuration(start, overCap)).toBe(true);
  });
});

describe('firstSelfOverlap', () => {
  it('finds two occurrences at the same instant', () => {
    const duplicate = draft('2026-09-07T09:00:00.000Z', '2026-09-07T10:00:00.000Z');

    expect(firstSelfOverlap([duplicate, duplicate])).toEqual([duplicate, duplicate]);
  });

  it('finds a collision regardless of the order the drafts arrive in', () => {
    const later = draft('2026-09-07T09:30:00.000Z', '2026-09-07T10:30:00.000Z');
    const earlier = draft('2026-09-07T09:00:00.000Z', '2026-09-07T10:00:00.000Z');

    expect(firstSelfOverlap([later, earlier])).toEqual([earlier, later]);
  });

  it('accepts distinct weekdays even at the maximum slot duration', () => {
    // 24-hour slots on Monday and Wednesday touch nothing, which is why
    // `daysOfWeek: [1, 1]` is the only way a request collides with itself.
    const result = expandRecurrence(
      {
        startsAt: '2026-09-07T09:00:00.000Z',
        endsAt: new Date(
          Date.parse('2026-09-07T09:00:00.000Z') + MAX_SLOT_DURATION_MS,
        ).toISOString(),
        timeZone: 'Europe/Madrid',
      },
      { frequency: 'weekly', daysOfWeek: [1, 3], until: '2026-09-13T23:59:59Z' },
    );

    expect(result.ok).toBe(true);
    expect(firstSelfOverlap(result.ok ? result.drafts : [])).toBeNull();
  });
});

describe('firstStoredOverlap', () => {
  it('names the stored slot a draft collides with', () => {
    const stored = [
      storedSlot('early', '2026-09-07T07:00:00.000Z', '2026-09-07T08:00:00.000Z'),
      storedSlot('clash', '2026-09-07T09:30:00.000Z', '2026-09-07T10:30:00.000Z'),
    ];

    const found = firstStoredOverlap(
      draft('2026-09-07T09:00:00.000Z', '2026-09-07T10:00:00.000Z'),
      stored,
    );

    expect(found?.id).toBe('clash');
  });

  it('returns null when the window is clear', () => {
    expect(
      firstStoredOverlap(draft('2026-09-07T09:00:00.000Z', '2026-09-07T10:00:00.000Z'), [
        storedSlot('early', '2026-09-07T07:00:00.000Z', '2026-09-07T08:00:00.000Z'),
      ]),
    ).toBeNull();
  });
});

describe('expandRecurrence', () => {
  const anchorAt = (startsAt: string, hours = 1) => ({
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + hours * 3_600_000).toISOString(),
    timeZone: 'Europe/Madrid',
  });

  it('emits every listed weekday up to `until`', () => {
    // Anchor Monday 7 Sep 2026 09:00 Madrid, Mondays and Wednesdays for six weeks.
    const result = expandRecurrence(anchorAt('2026-09-07T07:00:00.000Z'), {
      frequency: 'weekly',
      daysOfWeek: [1, 3],
      until: '2026-10-18T23:59:59Z',
    });

    expect(result.ok).toBe(true);
    const drafts = result.ok ? result.drafts : [];
    expect(drafts).toHaveLength(12);
    const weekdays = new Set(drafts.map((slot) => new Date(slot.startsAt).getUTCDay()));
    expect([...weekdays].sort()).toEqual([1, 3]);
  });

  it('ignores the anchor weekday when it is not listed', () => {
    // Anchor Friday, asked for Mondays: the anchor supplies the time of day and
    // the start date, not an occurrence of its own.
    const result = expandRecurrence(anchorAt('2026-09-11T07:00:00.000Z'), {
      frequency: 'weekly',
      daysOfWeek: [1],
      until: '2026-09-21T23:59:59Z',
    });

    expect(result.ok && result.drafts.map((slot) => slot.startsAt)).toEqual([
      '2026-09-14T07:00:00.000Z',
      '2026-09-21T07:00:00.000Z',
    ]);
  });

  it('keeps a 09:00 Madrid slot at 09:00 local across the March transition', () => {
    // Anchor Wednesday 25 March 2026 09:00 Madrid = 08:00Z; the clocks go
    // forward on 29 March, so the following Wednesdays are 07:00Z.
    const result = expandRecurrence(anchorAt('2026-03-25T08:00:00.000Z'), {
      frequency: 'weekly',
      daysOfWeek: [3],
      until: '2026-04-08T23:59:59Z',
    });

    expect(result.ok).toBe(true);
    const drafts = result.ok ? result.drafts : [];
    // An implementation stepping by 7 * 86_400_000 ms produces
    // 2026-04-01T08:00:00.000Z here, which reads as 10:00 in Madrid.
    expect(drafts.map((slot) => slot.startsAt)).toEqual([
      '2026-03-25T08:00:00.000Z',
      '2026-04-01T07:00:00.000Z',
      '2026-04-08T07:00:00.000Z',
    ]);
    for (const slot of drafts) {
      expect(localTimeIn(slot.startsAt, 'Europe/Madrid')).toBe('09:00');
    }
  });

  it('does the same in a zone with a different offset', () => {
    const result = expandRecurrence(
      { ...anchorAt('2026-03-25T07:00:00.000Z'), timeZone: 'Europe/Kyiv' },
      { frequency: 'weekly', daysOfWeek: [3], until: '2026-04-08T23:59:59Z' },
    );

    expect(result.ok && result.drafts.map((slot) => slot.startsAt)).toEqual([
      '2026-03-25T07:00:00.000Z',
      '2026-04-01T06:00:00.000Z',
      '2026-04-08T06:00:00.000Z',
    ]);
  });

  it('preserves the duration in absolute terms across a transition', () => {
    const result = expandRecurrence(anchorAt('2026-03-25T08:00:00.000Z', 2), {
      frequency: 'weekly',
      daysOfWeek: [3],
      until: '2026-04-08T23:59:59Z',
    });

    const drafts = result.ok ? result.drafts : [];
    expect(drafts).toHaveLength(3);
    for (const slot of drafts) {
      expect(Date.parse(slot.endsAt) - Date.parse(slot.startsAt)).toBe(2 * 3_600_000);
    }
  });

  it('emits one draft per listed weekday, so a repeat is not deduplicated', () => {
    const result = expandRecurrence(anchorAt('2026-09-07T07:00:00.000Z'), {
      frequency: 'weekly',
      daysOfWeek: [1, 1],
      until: '2026-09-07T23:59:59Z',
    });

    const drafts = result.ok ? result.drafts : [];
    expect(drafts).toHaveLength(2);
    expect(firstSelfOverlap(drafts)).not.toBeNull();
  });

  it('reports an empty expansion when `until` precedes the anchor', () => {
    const result = expandRecurrence(anchorAt('2026-09-07T07:00:00.000Z'), {
      frequency: 'weekly',
      daysOfWeek: [1],
      until: '2026-09-01T00:00:00Z',
    });

    expect(result).toEqual({ ok: false, reason: 'recurrence-empty' });
  });

  it('accepts an expansion of exactly the cap', () => {
    const start = '2026-01-05T08:00:00.000Z';
    // 200 Mondays from the anchor, inclusive.
    const until = new Date(Date.parse(start) + 199 * 7 * 86_400_000 + 3_600_000).toISOString();

    const result = expandRecurrence(anchorAt(start), {
      frequency: 'weekly',
      daysOfWeek: [1],
      until,
    });

    expect(result.ok && result.drafts).toHaveLength(MAX_RECURRENCE_SLOTS);
  });

  it('refuses a far-future `until` without walking to it', () => {
    const started = Date.now();

    const result = expandRecurrence(anchorAt('2026-09-07T07:00:00.000Z'), {
      frequency: 'weekly',
      daysOfWeek: [1, 3],
      until: '2076-09-07T00:00:00Z',
    });

    expect(result).toEqual({ ok: false, reason: 'cap-exceeded' });
    // A walk that ran to `until` instead of stopping at the cap takes 18 000
    // iterations of `Intl` formatting; this bounds it well below that.
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
