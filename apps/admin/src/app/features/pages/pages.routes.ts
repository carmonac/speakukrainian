import type { Routes } from '@angular/router';
import { unsavedChangesGuard } from '../../core/router/unsaved-changes.guard';
import { h5pExerciseResolver } from './h5p-exercise.resolver';
import { pageFormResolver } from './page-form.resolver';
import { pagesListResolver } from './pages-list.resolver';

/** `new` is declared before `:id`, or `/pages/new` resolves as a page id. */
export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./pages-page').then((m) => m.PagesPage),
    title: 'Pages',
    resolve: { listData: pagesListResolver },
    // Angular's default is `paramsChange`, which ignores a query-param change:
    // without this, a change of `?sectionId=` would not re-run the resolver.
    runGuardsAndResolvers: 'paramsOrQueryParamsChange',
  },
  {
    path: 'new',
    loadComponent: () => import('./page-form-page').then((m) => m.PageFormPage),
    title: 'New page',
    resolve: { formData: pageFormResolver },
    canDeactivate: [unsavedChangesGuard],
  },
  {
    // Declared before `:id` for readability only: unlike `new`, the two differ
    // in segment count, so the order cannot decide which one matches. It takes
    // no query parameters and must not grow any — `h5pExerciseResolver` says
    // what the widget does with `window.location.search`.
    path: ':id/exercise',
    loadComponent: () => import('./h5p-exercise-page').then((m) => m.H5pExercisePage),
    title: 'Edit exercise',
    resolve: { exerciseData: h5pExerciseResolver },
    canDeactivate: [unsavedChangesGuard],
  },
  {
    path: ':id',
    loadComponent: () => import('./page-form-page').then((m) => m.PageFormPage),
    title: 'Edit page',
    resolve: { formData: pageFormResolver },
    canDeactivate: [unsavedChangesGuard],
  },
];
