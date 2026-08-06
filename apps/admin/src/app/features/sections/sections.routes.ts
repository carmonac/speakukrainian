import type { Routes } from '@angular/router';
import { unsavedChangesGuard } from '../../core/router/unsaved-changes.guard';
import { sectionFormResolver } from './section-form.resolver';

/** `new` is declared before `:id`, or `/sections/new` resolves as a section id. */
export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./sections-page').then((m) => m.SectionsPage),
    title: 'Sections',
  },
  {
    path: 'new',
    loadComponent: () => import('./section-form-page').then((m) => m.SectionFormPage),
    title: 'New section',
    resolve: { formData: sectionFormResolver },
    canDeactivate: [unsavedChangesGuard],
  },
  {
    path: ':id',
    loadComponent: () => import('./section-form-page').then((m) => m.SectionFormPage),
    title: 'Edit section',
    resolve: { formData: sectionFormResolver },
    canDeactivate: [unsavedChangesGuard],
  },
];
