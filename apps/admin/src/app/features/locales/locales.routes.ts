import type { Routes } from '@angular/router';

/** `new` is declared before `:code`, or `/locales/new` resolves as a locale code. */
export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./locales-page').then((m) => m.LocalesPage),
    title: 'Locales',
  },
  {
    path: 'new',
    loadComponent: () => import('./locale-form-page').then((m) => m.LocaleFormPage),
    title: 'New locale',
  },
  {
    path: ':code',
    loadComponent: () => import('./locale-form-page').then((m) => m.LocaleFormPage),
    title: 'Edit locale',
  },
];
