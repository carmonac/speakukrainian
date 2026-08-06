import type { Routes } from '@angular/router';
import { unsavedChangesGuard } from '../../core/router/unsaved-changes.guard';
import { sectionFormResolver } from './section-form.resolver';
import { sectionMoveResolver } from './section-move.resolver';

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
    // Declared before `:id` for readability only: unlike `new`, the two differ
    // in segment count, so the order cannot decide which one matches.
    path: ':id/move',
    loadComponent: () => import('./section-move-page').then((m) => m.SectionMovePage),
    title: 'Move section',
    resolve: { formData: sectionMoveResolver },
  },
  {
    path: ':id',
    loadComponent: () => import('./section-form-page').then((m) => m.SectionFormPage),
    title: 'Edit section',
    resolve: { formData: sectionFormResolver },
    canDeactivate: [unsavedChangesGuard],
  },
];
