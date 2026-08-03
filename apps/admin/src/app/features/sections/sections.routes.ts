import type { Routes } from '@angular/router';

/**
 * Placeholder route table for the Sections feature. Replaced by the feature
 * implementation — see the Phase 1 GitHub issues for the intended screens.
 */
export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./sections-page').then((m) => m.SectionsPage),
    title: 'Sections',
  },
];
