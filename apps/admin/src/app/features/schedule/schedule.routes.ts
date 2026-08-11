import type { Routes } from '@angular/router';
import { unsavedChangesGuard } from '../../core/router/unsaved-changes.guard';
import { scheduleFormResolver } from './schedule-form.resolver';
import { scheduleWeekResolver } from './schedule-week.resolver';

/** `new` is declared before `:id`, or `/schedule/new` resolves as a slot id. */
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
  {
    path: 'new',
    loadComponent: () => import('./schedule-form-page').then((m) => m.ScheduleFormPage),
    title: 'New slot',
    resolve: { formData: scheduleFormResolver },
    canDeactivate: [unsavedChangesGuard],
  },
  {
    path: ':id',
    loadComponent: () => import('./schedule-form-page').then((m) => m.ScheduleFormPage),
    title: 'Edit slot',
    resolve: { formData: scheduleFormResolver },
    canDeactivate: [unsavedChangesGuard],
  },
];
