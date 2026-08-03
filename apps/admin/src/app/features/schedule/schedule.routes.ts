import type { Routes } from '@angular/router';

/**
 * Placeholder route table for the Schedule slots feature. Replaced by the feature
 * implementation — see the Phase 1 GitHub issues for the intended screens.
 */
export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./schedule-page').then((m) => m.SchedulePage),
    title: 'Schedule slots',
  },
];
