import { inject } from '@angular/core';
import { RedirectCommand, Router, type ResolveFn } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type { ScheduleSlot } from '@speakukrainian/shared';
import { BROWSER_TIME_ZONE } from '../../core/time/browser-time-zone';
import { ScheduleApi } from './schedule.api';
import {
  formatCivilDate,
  parseCivilDate,
  sameCivilDate,
  startOfWeek,
  todayIn,
  weekRange,
  type CivilDate,
} from './schedule.model';

export interface ScheduleWeekData {
  /** The Monday of the visible week, as a civil date in the view zone. */
  monday: CivilDate;
  viewZone: string;
  from: string;
  to: string;
  slots: ScheduleSlot[];
  /** True when the read failed, so an outage never renders as a free week. */
  failed: boolean;
}

/**
 * Reads the week `?from=` names, canonicalising the query param first.
 *
 * Absent, malformed or an impossible date resolves to the Monday of today's
 * week; a valid date that is not a Monday snaps back to its own Monday. Both
 * are a redirect rather than a silent correction, so the URL always says which
 * week is on screen and the corrected address is the only feedback needed — no
 * toast for a value only a hand-typed URL can produce.
 *
 * **The redirect cannot loop**: its target is always a Monday and always
 * parses, so the second pass falls through to the fetch. The obvious edit that
 * breaks that invariant is redirecting on anything else unexpected, which is
 * why the fetch failure below resolves data instead.
 *
 * `RedirectCommand` and not `createUrlTree`, for the reason
 * `sectionFormResolver` gives: a resolver cannot bounce a navigation with a
 * tree alone.
 *
 * A failed read resolves `{ slots: [], failed: true }` rather than rejecting —
 * a rejected resolver cancels the navigation and a cold deep link then lands
 * nowhere (`pagesListResolver`'s comment). The HTTP error interceptor has
 * already toasted, including the API's own "narrow the range" 422, so nothing
 * here raises a second message.
 */
export const scheduleWeekResolver: ResolveFn<ScheduleWeekData> = async (route) => {
  const api = inject(ScheduleApi);
  const router = inject(Router);
  const viewZone = inject(BROWSER_TIME_ZONE);

  const requested = parseCivilDate(route.queryParamMap.get('from'));
  const monday = startOfWeek(requested ?? todayIn(viewZone, new Date()));

  if (requested === null || !sameCivilDate(requested, monday)) {
    return new RedirectCommand(
      router.createUrlTree(['/schedule'], { queryParams: { from: formatCivilDate(monday) } }),
      // Replaced, so paging back through the browser's history does not bounce
      // off the uncanonical URL the admin arrived on.
      { replaceUrl: true },
    );
  }

  const { from, to } = weekRange(monday, viewZone);
  try {
    const slots = await firstValueFrom(api.list({ from, to }));
    return { monday, viewZone, from, to, slots, failed: false };
  } catch {
    // Reported by the HTTP error interceptor.
    return { monday, viewZone, from, to, slots: [], failed: true };
  }
};
