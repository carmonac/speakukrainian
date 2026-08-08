import { describe, expect, it } from 'vitest';
import {
  MAX_SCHEDULE_RANGE_DAYS,
  createScheduleSlotSchema,
  listScheduleSlotsQuerySchema,
  resolvableTimeZoneCacheSize,
  timeZoneSchema,
  updateScheduleSlotSchema,
} from './schedule.js';

const DAY_MS = 86_400_000;

const rangeFrom = (spanDays: number): { from: string; to: string } => {
  const from = Date.parse('2026-01-01T00:00:00Z');
  return {
    from: new Date(from).toISOString(),
    to: new Date(from + spanDays * DAY_MS).toISOString(),
  };
};

describe('createScheduleSlotSchema', () => {
  it('accepts a well-formed slot', () => {
    const result = createScheduleSlotSchema.parse({
      startsAt: '2026-09-01T09:00:00Z',
      endsAt: '2026-09-01T10:00:00Z',
      timeZone: 'Europe/Madrid',
    });
    expect(result.timeZone).toBe('Europe/Madrid');
  });

  it('rejects a timestamp with no offset', () => {
    const result = createScheduleSlotSchema.safeParse({
      startsAt: '2026-09-01T09:00:00',
      endsAt: '2026-09-01T10:00:00Z',
      timeZone: 'Europe/Madrid',
    });
    expect(result.success).toBe(false);
  });

  it.each([
    ['a zone that does not exist', 'Mars/Olympus'],
    ['a zone-shaped string', 'Not/AZone'],
    ['blank', ' '],
    ['empty', ''],
  ])('rejects %s as a time zone', (_name, timeZone) => {
    // Anything that reaches `Intl.DateTimeFormat` unchecked is a RangeError, and
    // anything merely stored is a document #15 cannot draw.
    const result = createScheduleSlotSchema.safeParse({
      startsAt: '2026-09-01T09:00:00Z',
      endsAt: '2026-09-01T10:00:00Z',
      timeZone,
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['timeZone']);
  });

  it('accepts a backward-compatibility link the canonical list omits', () => {
    // `Intl.supportedValuesOf('timeZone')` is canonical names only; the schema
    // asks the runtime instead, so an alias every calendar accepts still parses.
    const result = createScheduleSlotSchema.safeParse({
      startsAt: '2026-09-01T09:00:00Z',
      endsAt: '2026-09-01T10:00:00Z',
      timeZone: 'Asia/Calcutta',
    });

    expect(result.success).toBe(true);
  });
});

describe('timeZoneSchema', () => {
  it('caches a zone once however it is spelled', () => {
    // `Intl` matches zone ids case-insensitively, so every spelling below is a
    // *hit* on the same zone. Keyed by the raw string they were three more
    // entries each, retained for the life of the process, and a caller could
    // grow the set by inventing spellings — the boundedness the cache is
    // justified by is only true if the key is normalised.
    timeZoneSchema.parse('Pacific/Auckland');
    const cached = resolvableTimeZoneCacheSize();

    for (const spelling of ['pacific/auckland', 'PACIFIC/AUCKLAND', 'pAcIfIc/AuCkLaNd']) {
      // The value is stored as spelled; only the cache key is normalised.
      expect(timeZoneSchema.parse(spelling)).toBe(spelling);
    }

    expect(resolvableTimeZoneCacheSize()).toBe(cached);
  });

  it('caches nothing for zones it cannot resolve', () => {
    const cached = resolvableTimeZoneCacheSize();

    for (const junk of ['Mars/Olympus', 'Mars/Olympus2', 'Mars/Olympus3']) {
      expect(timeZoneSchema.safeParse(junk).success).toBe(false);
    }

    expect(resolvableTimeZoneCacheSize()).toBe(cached);
  });

  // The U+2212 spellings are written as escapes on purpose: rendered, they are
  // indistinguishable from the ASCII ones, and the difference is the whole
  // point — the ASCII spelling was refused while the U+2212 one was stored.
  it.each([
    ['+05:30', 'ASCII plus'],
    ['+23:00', 'ASCII plus, the largest offset'],
    ['-08', 'ASCII hyphen-minus, hours only'],
    ['+0530', 'ASCII plus, no separator'],
    ['\u221205:30', 'U+2212 minus sign'],
    ['\u221208', 'U+2212 minus sign, hours only'],
    ['\u22120530', 'U+2212 minus sign, no separator'],
  ])('refuses the fixed offset %s (%s) and caches nothing for it', (timeZone) => {
    // `Intl` resolves all of these; the field refuses them because an offset
    // never observes DST, which is the one thing it exists to survive. Since
    // `Intl` resolves them, they are also the inputs that can grow the cache on
    // a path the schema refuses — so the size is part of the assertion.
    const cached = resolvableTimeZoneCacheSize();

    const result = timeZoneSchema.safeParse(timeZone);

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('DST');
    expect(resolvableTimeZoneCacheSize()).toBe(cached);
  });

  it('refuses every fixed offset the runtime resolves, whichever sign spells it', () => {
    // A sweep rather than a handful of examples: the previous rule tested for a
    // leading `+` or `-` and let all 1440 U+2212 spellings through. Sweeping
    // every sign the runtime accepts against every hour and minute is what
    // makes "no offset gets through" a measurement instead of a claim.
    const cached = resolvableTimeZoneCacheSize();
    const accepted = new Set<string>();

    for (const sign of ['+', '-', '\u2212']) {
      for (let hour = 0; hour < 24; hour += 1) {
        const hh = String(hour).padStart(2, '0');
        for (let minute = 0; minute < 60; minute += 1) {
          const mm = String(minute).padStart(2, '0');
          for (const spelling of [`${sign}${hh}:${mm}`, `${sign}${hh}${mm}`]) {
            if (timeZoneSchema.safeParse(spelling).success) {
              accepted.add(spelling);
            }
          }
        }
      }
      for (let hour = 0; hour < 24; hour += 1) {
        const spelling = `${sign}${String(hour).padStart(2, '0')}`;
        if (timeZoneSchema.safeParse(spelling).success) {
          accepted.add(spelling);
        }
      }
    }

    expect([...accepted]).toEqual([]);
    expect(resolvableTimeZoneCacheSize()).toBe(cached);
  });

  it('accepts every zone name the runtime knows, so the refusal costs no real zone', () => {
    // The other half of the rule in `ZONE_NAME_START`. Refusing everything that
    // does not start with an ASCII letter is only exact if no zone name starts
    // with anything else, and that is a property of whichever zone database the
    // runtime carries — so ask the runtime, rather than pin a list that a later
    // tzdata could outgrow.
    const canonical = Intl.supportedValuesOf('timeZone');
    expect(canonical.length).toBeGreaterThan(300);

    const refused = canonical.filter((zone) => !timeZoneSchema.safeParse(zone).success);

    expect(refused).toEqual([]);
  });

  it.each(['UTC', 'Etc/GMT+5', 'Asia/Kolkata'])(
    'accepts %s, a named zone that never shifts',
    (timeZone) => {
      expect(timeZoneSchema.parse(timeZone)).toBe(timeZone);
    },
  );
});

describe('updateScheduleSlotSchema', () => {
  /**
   * `updateScheduleSlotSchema` is `createScheduleSlotSchema.partial()`, so a
   * `.default()` added to any create field would start riding into every patch
   * and silently resetting the stored value. This locks that: an empty patch
   * must stay empty.
   */
  it('parses an empty patch to an empty object', () => {
    expect(updateScheduleSlotSchema.parse({})).toEqual({});
  });

  it('accepts a status change', () => {
    expect(updateScheduleSlotSchema.parse({ status: 'cancelled' })).toEqual({
      status: 'cancelled',
    });
  });

  it('refuses to book a slot through the generic patch', () => {
    const result = updateScheduleSlotSchema.safeParse({ status: 'booked' });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['status']);
    expect(result.error?.issues[0]?.message).toContain('Phase 2');
  });

  it('still accepts the statuses an admin owns', () => {
    for (const status of ['open', 'cancelled', 'completed'] as const) {
      expect(updateScheduleSlotSchema.parse({ status })).toEqual({ status });
    }
  });

  it('refuses a time zone the runtime cannot resolve', () => {
    const result = updateScheduleSlotSchema.safeParse({ timeZone: 'Not/AZone' });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['timeZone']);
  });

  it('strips a recurrence rather than honouring it', () => {
    const result = updateScheduleSlotSchema.parse({
      status: 'open',
      recurrence: { frequency: 'weekly', daysOfWeek: [1], until: '2026-09-01T09:00:00Z' },
    });

    expect(result).not.toHaveProperty('recurrence');
  });
});

describe('listScheduleSlotsQuerySchema', () => {
  it('refuses a query with no range', () => {
    expect(listScheduleSlotsQuerySchema.safeParse({}).success).toBe(false);
  });

  it('refuses a half-open range', () => {
    expect(listScheduleSlotsQuerySchema.safeParse({ from: '2026-01-01T00:00:00Z' }).success).toBe(
      false,
    );
  });

  it('refuses `to` at or before `from`', () => {
    const result = listScheduleSlotsQuerySchema.safeParse({
      from: '2026-01-02T00:00:00Z',
      to: '2026-01-01T00:00:00Z',
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['to']);
  });

  it(`accepts a span of exactly ${MAX_SCHEDULE_RANGE_DAYS} days`, () => {
    const range = rangeFrom(MAX_SCHEDULE_RANGE_DAYS);

    expect(listScheduleSlotsQuerySchema.parse(range)).toEqual(range);
  });

  it('refuses a span longer than the cap', () => {
    const result = listScheduleSlotsQuerySchema.safeParse(rangeFrom(MAX_SCHEDULE_RANGE_DAYS + 1));

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(String(MAX_SCHEDULE_RANGE_DAYS));
  });
});
