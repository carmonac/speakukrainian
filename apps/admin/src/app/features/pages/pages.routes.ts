import type { Routes } from '@angular/router';

/**
 * Placeholder route table for the Pages feature. Replaced by the feature
 * implementation — see the Phase 1 GitHub issues for the intended screens.
 */
export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./pages-page').then((m) => m.PagesPage),
    title: 'Pages',
  },
];
