import { describe, expect, it } from 'vitest';
import {
  MAX_SCHEDULE_RANGE_DAYS,
  createScheduleSlotSchema,
  listScheduleSlotsQuerySchema,
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
