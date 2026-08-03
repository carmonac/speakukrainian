import type { Routes } from '@angular/router';

/**
 * The public site mirrors the admin's section tree. `:localeCode` is the first
 * segment (`/en/grammar-points/...`); everything after it is a catch-all that
 * the content resolver looks up against the `path` field stored on sections
 * and pages in Firestore.
 */
export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () => import('./features/home/home-page').then((m) => m.HomePage),
  },
  {
    path: ':localeCode',
    children: [
      {
        path: '',
        pathMatch: 'full',
        loadComponent: () => import('./features/home/home-page').then((m) => m.HomePage),
      },
      {
        // One route resolves any depth of section / subsection / page path.
        path: '**',
        loadComponent: () => import('./features/content/content-page').then((m) => m.ContentPage),
      },
    ],
  },
];
