import type { Routes } from '@angular/router';
import { scheduleWeekResolver } from './schedule-week.resolver';

/**
 * One week per URL. Creating, editing and cancelling slots are a separate issue
 * and add `new` and `:id` alongside this route.
 */
export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./schedule-page').then((m) => m.SchedulePage),
    title: 'Schedule slots',
    resolve: { weekData: scheduleWeekResolver },
    // The default, spelled out because the whole screen depends on it: without
    // it, moving to the next week would change `?from=` and never re-resolve.
    runGuardsAndResolvers: 'paramsOrQueryParamsChange',
  },
];
