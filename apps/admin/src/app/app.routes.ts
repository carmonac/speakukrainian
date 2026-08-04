import type { Routes } from '@angular/router';
import { authGuard } from './core/auth/auth.guard';
import { staffGuard } from './core/auth/staff.guard';

/**
 * Every admin screen is a real route with its own URL, so the browser back and
 * forward buttons, deep links and refresh all behave. Transient UI state
 * (which panel is open, an unsaved draft carried between screens) travels in
 * `history.state` via `router.navigate(..., { state })` — never in a service
 * that a refresh would wipe out.
 */
export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () => import('./features/auth/login-page').then((m) => m.LoginPage),
    title: 'Sign in',
  },
  {
    path: '',
    loadComponent: () => import('./layout/admin-shell').then((m) => m.AdminShell),
    // Guards run in order and stop at the first non-`true` result, so a signed
    // out visitor is redirected by `authGuard` before `staffGuard` sees them.
    canActivate: [authGuard, staffGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'sections' },
      {
        path: 'sections',
        loadChildren: () => import('./features/sections/sections.routes').then((m) => m.routes),
      },
      {
        path: 'pages',
        loadChildren: () => import('./features/pages/pages.routes').then((m) => m.routes),
      },
      {
        path: 'locales',
        loadChildren: () => import('./features/locales/locales.routes').then((m) => m.routes),
      },
      {
        path: 'schedule',
        loadChildren: () => import('./features/schedule/schedule.routes').then((m) => m.routes),
      },
      {
        path: 'media',
        loadChildren: () => import('./features/media/media.routes').then((m) => m.routes),
      },
    ],
  },
  {
    path: '**',
    loadComponent: () => import('./features/not-found/not-found-page').then((m) => m.NotFoundPage),
    title: 'Not found',
  },
];
