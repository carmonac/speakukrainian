import type { SlotStatus } from '@speakukrainian/shared';

// The week view's copy in one file (the `page-messages.ts` precedent), so a
// spec asserts a constant rather than a string copied into a template.

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
