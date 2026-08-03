import { describe, expect, it } from 'vitest';
import { createScheduleSlotSchema } from './schedule.js';

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
