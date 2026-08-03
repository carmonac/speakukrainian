import type { Routes } from '@angular/router';

/**
 * Placeholder route table for the Locales feature. Replaced by the feature
 * implementation — see the Phase 1 GitHub issues for the intended screens.
 */
export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./locales-page').then((m) => m.LocalesPage),
    title: 'Locales',
  },
];
