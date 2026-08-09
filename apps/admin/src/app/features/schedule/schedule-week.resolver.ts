import { inject } from '@angular/core';
import { RedirectCommand, Router, type ResolveFn } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type { ScheduleSlot } from '@speakukrainian/shared';
import { BROWSER_TIME_ZONE } from '../../core/time/browser-time-zone';
import { ScheduleApi } from './schedule.api';
import {
  fallbackMonday,
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
 * **The redirect cannot loop.** Its target is always a Monday, and a target
 * `parseCivilDate` still refuses only sends the pass after it to the fallback —
 * so the invariant that has to hold is that the fallback is a Monday that
 * parses, on any clock at all. That is what `fallbackMonday` guarantees and why
 * the fallback is not the plain `startOfWeek(todayIn(...))` it reads like: the
 * canonicalisation runs *after* the parse, so a bound `startOfWeek` can reach
 * past leaves the fallback itself unparseable and the resolver redirects to the
 * same URL for ever. A lower bound of 1970 did it at the epoch and the surviving
 * upper bound does it in the year 3000 — a hang rather than a wrong week, which
 * is why `schedule.model.spec.ts` pins the clamp as a unit assertion: a routing
 * test for it hangs instead of failing.
 *
 * One other edit breaks it: redirecting on anything else unexpected, which is
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
  const monday =
    requested === null ? fallbackMonday(todayIn(viewZone, new Date())) : startOfWeek(requested);

  if (requested === null || !sameCivilDate(requested, monday)) {
    return new RedirectCommand(
      router.createUrlTree(['/schedule'], {
        // Every other param carried over by hand rather than with
        // `queryParamsHandling: 'merge'`: the router's current URL during a
        // resolver is still the screen being navigated away from, so `merge`
        // would merge the params of the page the admin came from.
        queryParams: { ...route.queryParams, from: formatCivilDate(monday) },
      }),
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
