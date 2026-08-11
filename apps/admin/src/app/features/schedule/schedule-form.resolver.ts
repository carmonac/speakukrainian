import { inject } from '@angular/core';
import { RedirectCommand, Router, type ResolveFn } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type { ScheduleSlot } from '@speakukrainian/shared';
import { BROWSER_TIME_ZONE } from '../../core/time/browser-time-zone';
import { ScheduleApi } from './schedule.api';
import { parseClockTime, type ClockTime } from './schedule-form.model';
import { parseCivilDate, type CivilDate } from './schedule.model';

/** What the form route hands the form. `slot` is `null` on `/schedule/new`. */
export interface ScheduleFormData {
  slot: ScheduleSlot | null;
  /** The browser's own zone, for the second time line. Never the slot's. */
  viewZone: string;
  requestedDate: CivilDate | null;
  requestedTime: ClockTime | null;
}

/**
 * Loads the form's data before the route activates, which is what makes a cold
 * deep link to `/schedule/:id` paint populated instead of flashing empty.
 *
 * **`?date=` and `?time=` are read and never redirected on.** They are a
 * convenience the week view's own links fill in, so an unusable one simply falls
 * back to today and the default start — there is nothing to canonicalise and no
 * URL to correct. Copying the week resolver's `RedirectCommand` here would
 * reintroduce the class of bug #15 spent two passes on: a redirect target the
 * next pass refuses is a navigation that never completes, which a vitest `it`
 * timeout does not reclaim.
 */
export const scheduleFormResolver: ResolveFn<ScheduleFormData> = async (route) => {
  const api = inject(ScheduleApi);
  const router = inject(Router);
  const viewZone = inject(BROWSER_TIME_ZONE);

  const requested = {
    viewZone,
    requestedDate: parseCivilDate(route.queryParamMap.get('date')),
    requestedTime: parseClockTime(route.queryParamMap.get('time')),
  };

  const id = route.paramMap.get('id');
  if (id === null) {
    return { slot: null, ...requested };
  }

  try {
    return { slot: await firstValueFrom(api.get(id)), ...requested };
  } catch {
    // The error interceptor has already toasted the API's own 404/403 wording,
    // so a second message here would only repeat it. `RedirectCommand` is how a
    // resolver bounces a navigation (`sectionFormResolver`); a rejected resolver
    // would leave a cold deep link nowhere at all.
    return new RedirectCommand(router.createUrlTree(['/schedule']));
  }
};
