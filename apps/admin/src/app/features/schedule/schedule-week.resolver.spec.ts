import { EnvironmentInjector, runInInjectionContext } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  RedirectCommand,
  convertToParamMap,
  provideRouter,
  type ActivatedRouteSnapshot,
  type RouterStateSnapshot,
} from '@angular/router';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduleSlot } from '@speakukrainian/shared';
import { BROWSER_TIME_ZONE } from '../../core/time/browser-time-zone';
import { ScheduleApi } from './schedule.api';
import { scheduleWeekResolver } from './schedule-week.resolver';

const KYIV = 'Europe/Kyiv';

/** A route with no `?from=` at all, which is the branch that falls back. */
function snapshotWithoutFrom(): ActivatedRouteSnapshot {
  return {
    queryParams: {},
    queryParamMap: convertToParamMap({}),
  } as unknown as ActivatedRouteSnapshot;
}

describe('scheduleWeekResolver', () => {
  beforeEach(() => {
    // Only `Date`, as in `schedule-page.spec.ts` — the resolver awaits the read.
    vi.useFakeTimers({ toFake: ['Date'] });

    TestBed.configureTestingModule({
      providers: [
        // Only to serialise the redirect's `UrlTree`; nothing here navigates.
        provideRouter([]),
        // Injected before the branch under test, never called on it.
        {
          provide: ScheduleApi,
          useValue: { list: () => of<ScheduleSlot[]>([]) } as unknown as ScheduleApi,
        },
        { provide: BROWSER_TIME_ZONE, useValue: KYIV },
      ],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * The fallback is `fallbackMonday`, not the `startOfWeek(todayIn(...))` it
   * reads like, and this is the assertion that stops the simplification: on a
   * clock past the last schedulable year the plain form redirects to a Monday
   * `parseCivilDate` refuses, which the next pass refuses again, for ever.
   *
   * A **resolver** test and deliberately not a routing one. Driven through the
   * router the defect is a hang — the navigation never settles, an `it` timeout
   * does not reclaim it and the file stops reporting at all — so it cannot be
   * asserted there. Called directly, the resolver runs one pass and hands back
   * its redirect without navigating, so the same defect is an ordinary
   * assertion failure in milliseconds. That is the whole reason this can be
   * pinned: `schedule.model.spec.ts` pins what the clamp answers, and this pins
   * that the resolver asks it.
   */
  it('clamps the fallback week into range on a clock past the last schedulable year', async () => {
    vi.setSystemTime(new Date('3000-01-15T12:00:00Z'));

    const result = await runInInjectionContext(TestBed.inject(EnvironmentInjector), () =>
      scheduleWeekResolver(snapshotWithoutFrom(), {} as RouterStateSnapshot),
    );

    if (!(result instanceof RedirectCommand)) {
      throw new Error('Expected the resolver to redirect rather than resolve a week');
    }
    // Unclamped this is `3000-01-13`, and the navigation never terminates.
    expect(result.redirectTo.toString()).toBe('/schedule?from=2999-12-30');
  });
});
