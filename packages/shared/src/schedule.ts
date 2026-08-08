import { z } from 'zod';
import { auditSchema, isoDateTimeSchema } from './common.js';

export const slotStatusSchema = z.enum(['open', 'booked', 'cancelled', 'completed']);
export type SlotStatus = z.infer<typeof slotStatusSchema>;

/**
 * Zones the runtime has resolved before. Only successful lookups are cached, so
 * the set is bounded by the zone database however much junk is thrown at it.
 */
const resolvableTimeZones = new Set<string>();

function isResolvableTimeZone(value: string): boolean {
  if (resolvableTimeZones.has(value)) {
    return true;
  }
  try {
    Intl.DateTimeFormat('en-US', { timeZone: value });
  } catch {
    return false;
  }
  resolvableTimeZones.add(value);
  return true;
}

/**
 * An IANA zone name the runtime can actually resolve.
 *
 * The check is a formatter construction rather than a lookup in
 * `Intl.supportedValuesOf('timeZone')`: that list is canonical names only, and
 * would refuse the backward-compatibility links (`Asia/Calcutta`, `US/Eastern`)
 * that `Intl` itself resolves happily.
 *
 * It belongs to the schema rather than to the code that expands a recurrence
 * because both halves of the field have to close: an unresolvable zone thrown
 * at `Intl.DateTimeFormat` is a `RangeError`, and one merely *stored* is a
 * document every later reader trips over.
 */
export const timeZoneSchema = z.string().min(1).refine(isResolvableTimeZone, {
  message: 'Unknown IANA time zone — use a name such as `Europe/Madrid`',
});

/**
 * A window of the admin's time that a learner can book. Times are stored as
 * absolute UTC instants plus the IANA zone they were authored in, so recurring
 * slots survive daylight-saving shifts.
 */
export const scheduleSlotSchema = z
  .object({
    id: z.string().min(1),
    /** The teacher/admin offering the slot. */
    ownerId: z.string().min(1),
    startsAt: isoDateTimeSchema,
    endsAt: isoDateTimeSchema,
    /** IANA zone the slot was authored in, e.g. `Europe/Madrid`. */
    timeZone: timeZoneSchema,
    status: slotStatusSchema.default('open'),
    /** Set when the slot was generated from a recurrence rule. */
    recurrenceId: z.string().min(1).nullable().default(null),
    /** Free-form note shown to the learner before booking. */
    note: z.string().max(500).optional(),
    /** Populated once `status === 'booked'`. Booking itself is Phase 2. */
    bookedBy: z.string().min(1).nullable().default(null),
    bookedAt: z.string().nullable().default(null),
    audit: auditSchema,
  })
  .refine((s) => new Date(s.endsAt) > new Date(s.startsAt), {
    message: '`endsAt` must be after `startsAt`',
    path: ['endsAt'],
  });

export type ScheduleSlot = z.infer<typeof scheduleSlotSchema>;

/** Weekly recurrence, expanded into concrete slots up to `until`. */
export const slotRecurrenceSchema = z.object({
  frequency: z.literal('weekly'),
  /** 0 = Sunday … 6 = Saturday. */
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1),
  until: isoDateTimeSchema,
});
export type SlotRecurrence = z.infer<typeof slotRecurrenceSchema>;

export const createScheduleSlotSchema = z.object({
  startsAt: isoDateTimeSchema,
  endsAt: isoDateTimeSchema,
  timeZone: timeZoneSchema,
  note: z.string().max(500).optional(),
  recurrence: slotRecurrenceSchema.optional(),
});
export type CreateScheduleSlotInput = z.infer<typeof createScheduleSlotSchema>;

/**
 * `booked` is not a status a patch may set. Booking is Phase 2 and will own
 * `bookedBy`/`bookedAt` alongside the status; letting the generic patch set it
 * on its own stores a slot that reads as booked with nobody attached, which
 * blocks overlap and contradicts `scheduleSlotSchema`'s own promise about
 * `bookedBy`. Phase 2 replaces this with a booking route, not with a wider enum.
 */
export const patchableSlotStatusSchema = slotStatusSchema.exclude(['booked'], {
  error: 'Booking is Phase 2 — `booked` cannot be set through this route',
});

export const updateScheduleSlotSchema = createScheduleSlotSchema
  .partial()
  .omit({ recurrence: true })
  .extend({ status: patchableSlotStatusSchema.optional() });
export type UpdateScheduleSlotInput = z.infer<typeof updateScheduleSlotSchema>;

/**
 * The longest range a caller may ask for, in days. 366 rather than 365 so a
 * full leap year is expressible in one request.
 *
 * This bounds the *question*; the API applies its own, smaller bound on the
 * number of documents an answer may contain.
 */
export const MAX_SCHEDULE_RANGE_DAYS = 366;

const DAY_MS = 86_400_000;

/**
 * The range is mandatory and capped, so no caller can ask the API for an
 * unbounded read of the collection.
 */
export const listScheduleSlotsQuerySchema = z
  .object({
    from: isoDateTimeSchema,
    to: isoDateTimeSchema,
    status: slotStatusSchema.optional(),
  })
  .refine((query) => new Date(query.to) > new Date(query.from), {
    message: '`to` must be after `from`',
    path: ['to'],
  })
  .refine(
    (query) =>
      new Date(query.to).getTime() - new Date(query.from).getTime() <=
      MAX_SCHEDULE_RANGE_DAYS * DAY_MS,
    {
      message: `A schedule range cannot be longer than ${MAX_SCHEDULE_RANGE_DAYS} days`,
      path: ['to'],
    },
  );
export type ListScheduleSlotsQuery = z.infer<typeof listScheduleSlotsQuerySchema>;
