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
    // Angular's default is `paramsChange`, which ignores a query-param change:
    // without this, moving to the next week would change `?from=` and never
    // re-resolve.
    runGuardsAndResolvers: 'paramsOrQueryParamsChange',
  },
];
