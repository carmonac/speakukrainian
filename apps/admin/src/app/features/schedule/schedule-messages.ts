import type { SlotStatus } from '@speakukrainian/shared';

// The schedule's copy in one file (the `page-messages.ts` precedent), so a spec
// asserts a constant rather than a string copied into a template.

/** Distinguished from the empty state, so an outage never reads as a free week. */
export const SLOTS_LOAD_FAILED = 'Could not load the schedule.';

export const NO_SLOTS_THIS_WEEK = 'No slots this week.';

/** Prefixed to the view zone in the header, which is the clock the grid is drawn on. */
export const TIMES_SHOWN_IN = 'Times shown in ';

/**
 * The API answers slots that *intersect* the week, so one that began last week
 * and runs into Monday comes back with no column of its own. It is drawn in the
 * first column and says so rather than being dropped.
 */
export const STARTED_EARLIER = 'Started before this week';

/**
 * Derived from the shared union rather than restated, so a fifth status fails
 * to compile here instead of rendering as a blank chip.
 */
export const SLOT_STATUS_LABELS: Record<SlotStatus, string> = {
  open: 'Open',
  booked: 'Booked',
  cancelled: 'Cancelled',
  completed: 'Completed',
};

/**
 * Indexed by `weekdayOf`, so the array order matches the recurrence schema's
 * `0 = Sunday`. The Monday-first *display* order is a separate concern and
 * lives in `buildWeek`.
 */
export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Indexed by `month - 1`, since `WallClock.month` is 1-12. */
export const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** The header's week label, e.g. `Week of 2 Mar 2026`. */
export const WEEK_OF = 'Week of ';

// The slot form's copy.

/**
 * Shown on `/schedule/:id` for an occurrence of a series, in place of the repeat
 * controls rather than beside them: `updateScheduleSlotSchema` omits
 * `recurrence` and there is no series-update route, so a repeat fieldset here —
 * even a disabled one — would advertise a capability the API does not have.
 */
export const EDITING_ONE_OCCURRENCE =
  'This is one occurrence of a repeating slot. Changes apply to this occurrence only.';

/**
 * `patchableSlotStatusSchema` excludes `booked`, so this screen cannot *create* a
 * booked slot — but nothing in `ScheduleSlotsRepository.update` refuses a patch
 * to one, so this refusal is the admin's alone. It says where the capability is
 * going, because Phase 2 owning `bookedBy`/`bookedAt` is exactly the reasoning
 * that would justify removing it.
 */
export const BOOKED_READ_ONLY =
  'This slot is booked, so it cannot be changed here. Booking arrives in Phase 2, which will own cancelling and rescheduling a booked slot.';

/** Used only if a 409 arrives with no sentence of its own to quote. */
export const OVERLAP_FALLBACK = 'That time overlaps a slot that already exists.';

/** Drawn on the composed interval when the end time is on the following day. */
export const CROSSES_MIDNIGHT = 'ends the next day';

/** Prefixed to the slot's own zone, above the time fields. */
export const TIMES_ARE_IN = 'Times are in ';

/** Wraps the browser's zone on the second time line, when it says something new. */
export const ALSO_IN_BROWSER_ZONE_PREFIX = 'In this browser’s zone (';
export const ALSO_IN_BROWSER_ZONE_SUFFIX = ')';

/**
 * The ticked days are authoritative and the start date's own weekday is not
 * implied — `expandRecurrence`'s rule, and the one that surprises people: an
 * anchor on a Friday with Monday and Wednesday ticked produces Mondays and
 * Wednesdays and no Friday.
 */
export const REPEAT_DAYS_HINT =
  'Occurrences land on the days ticked here. The start date sets the time of day and where the series begins, not which days it repeats on.';

/** Inclusive of the day picked, which is what `untilInstant` makes true. */
export const REPEAT_UNTIL_HINT = 'The last day an occurrence may start on, included.';

export const SLOT_CREATED = 'Slot created.';
export const SLOT_SAVED = 'Slot saved.';

/** A series answers with every occurrence it wrote, so the toast can say how many. */
export function slotsCreatedMessage(count: number): string {
  return count === 1 ? SLOT_CREATED : `Created ${count} slots.`;
}
