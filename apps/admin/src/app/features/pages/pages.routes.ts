import type { Routes } from '@angular/router';
import { unsavedChangesGuard } from '../../core/router/unsaved-changes.guard';
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
    path: ':id',
    loadComponent: () => import('./page-form-page').then((m) => m.PageFormPage),
    title: 'Edit page',
    resolve: { formData: pageFormResolver },
    canDeactivate: [unsavedChangesGuard],
  },
];
