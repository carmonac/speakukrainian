import { z } from 'zod';
import { auditSchema, isoDateTimeSchema, localeCodeSchema } from './common.js';

export const slotStatusSchema = z.enum(['open', 'booked', 'cancelled', 'completed']);
export type SlotStatus = z.infer<typeof slotStatusSchema>;

/**
 * Zones the runtime has resolved before, keyed by the **lower-cased** name.
 *
 * `Intl` matches zone ids case-insensitively, so `Europe/Madrid`,
 * `europe/madrid` and `eUrOpE/mAdRiD` all resolve to the same zone. Keyed by
 * the string as received, one zone would occupy 2048 entries and a caller could
 * grow the set for as long as it kept inventing spellings. Lower-casing
 * collapses them onto one key — no two zone names differ only by case.
 *
 * The other half of the bound is structural, and lives in `timeZoneSchema`: the
 * only code path that reaches the `add` below is one that has already decided
 * the value is a zone name the schema accepts. Nothing the field refuses can
 * key this set, so it holds zone names and nothing else.
 */
const resolvableTimeZones = new Set<string>();

/**
 * Exported so a test can observe the bound the comment above claims. Nothing in
 * the application needs it: a cache that silently stopped being bounded is
 * exactly how the unbounded version shipped.
 */
export function resolvableTimeZoneCacheSize(): number {
  return resolvableTimeZones.size;
}

/**
 * The rule that separates a zone name from a fixed offset: a zone name starts
 * with an ASCII letter, and an offset cannot.
 *
 * `Intl` accepts an offset (`+05:30`, `-08`, `+0530`) wherever it accepts a zone
 * name, and this field refuses one — see `timeZoneSchema` for why. Testing for
 * the *sign* is what an earlier version did, with `/^[+-]/`, and it was wrong:
 * `Intl` also reads U+2212 MINUS SIGN as a sign, so `−05:30` passed the test and
 * was stored. Enumerating the signs would only have been right until ICU
 * accepted a fourth one, so the test runs the other way round and asks what a
 * zone name looks like:
 *
 * - an offset must begin with a sign — `Intl` resolves nothing offset-shaped
 *   without one — and no sign is an ASCII letter, so no offset can pass;
 * - every zone name begins with an ASCII letter, so no zone name is refused.
 *
 * Both halves were swept on this runtime: of all 1 114 112 code points exactly
 * three (U+002B, U+002D, U+2212) are accepted ahead of an offset body, and of
 * the 418 canonical names plus every backward-compatibility link that resolves,
 * none begins with anything but an ASCII letter. A test pins each half.
 */
const ZONE_NAME_START = /^[A-Za-z]/;

/**
 * Says what the value must be rather than what it was taken for. The rule
 * refuses everything that is not a zone name, so the likeliest real trigger is a
 * copy-paste with a leading space, and an earlier wording told that admin their
 * value was a fixed offset that never observes DST. Choosing between two
 * messages would mean asking `Intl` about a value on the path that refused it,
 * which is the shape of bug this field already has one rule against.
 */
const NOT_A_ZONE_NAME =
  'A time zone must be an IANA name such as `Europe/Madrid`; anything else — a fixed offset included, because an offset never observes DST — is refused';

const UNRESOLVABLE_ZONE = 'Unknown IANA time zone — use a name such as `Europe/Madrid`';

function isResolvableTimeZone(value: string): boolean {
  const key = value.toLowerCase();
  if (resolvableTimeZones.has(key)) {
    return true;
  }
  try {
    Intl.DateTimeFormat('en-US', { timeZone: value });
  } catch {
    return false;
  }
  resolvableTimeZones.add(key);
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
 *
 * A **fixed offset is refused** even though `Intl` resolves it. The field
 * exists so that a recurrence keeps its local time across a daylight-saving
 * change, and an offset never observes one — a series authored in `+02:00`
 * would drift an hour against Madrid for half the year, silently. A zone that
 * genuinely has no DST is still expressible by its name (`UTC`, `Etc/GMT+5`,
 * `Asia/Kolkata`); what is refused is the offset syntax, which is not a zone
 * name at all. `ZONE_NAME_START` carries the argument for why that test is
 * exact.
 *
 * The two checks are **one** check, in this order, on purpose. Zod runs every
 * refinement in a chain whatever failed before it, so as two `.refine()` calls
 * the resolvability lookup still ran for a value the offset test had already
 * refused — and cached it, which is the growth the cache above is not allowed
 * to have. Written as one check that returns, the lookup is unreachable for
 * anything the field refuses, so the set can hold nothing but zone names.
 *
 * The value is stored **as the caller spelled it**. Canonicalising through
 * `resolvedOptions().timeZone` would rewrite `US/Eastern` to `America/New_York`
 * behind the admin's back, so anything comparing two `timeZone` values must
 * compare them case-insensitively rather than with `===`.
 */
export const timeZoneSchema = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    if (value.length === 0) {
      // `.min(1)` has already reported this one, and it runs whether or not
      // this check does.
      return;
    }
    if (!ZONE_NAME_START.test(value)) {
      ctx.addIssue({ code: 'custom', message: NOT_A_ZONE_NAME });
      return;
    }
    if (!isResolvableTimeZone(value)) {
      ctx.addIssue({ code: 'custom', message: UNRESOLVABLE_ZONE });
    }
  });

/**
 * Longest a note may be **in each locale**, not in total across them: a total
 * bound would make the sixth translation fail for text already authored in five
 * languages, and report it against whichever locale happened to be saved last.
 */
export const MAX_SLOT_NOTE_LENGTH = 500;

/**
 * Free-form note shown to the learner before booking, as localized plain text.
 *
 * Plain text and not `richTextSchema`: this route runs no `RichTextSanitizer`,
 * `scheduleSlotSchema` carries no `audioAssets`/`imageAssets` for the orphan
 * sweep to read so any embedded media would be untracked, and one range read
 * carries up to `MAX_LIST_SLOTS` of these. A locale with no translation falls
 * back per ADR-009, and a slot with no note at all shows nothing.
 */
export const slotNoteSchema = z.record(localeCodeSchema, z.string().max(MAX_SLOT_NOTE_LENGTH));

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
    note: slotNoteSchema.optional(),
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
  note: slotNoteSchema.optional(),
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
