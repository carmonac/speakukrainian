import { inject } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import type { CanDeactivateFn } from '@angular/router';
import { map, of } from 'rxjs';
import { ConfirmDialog, type ConfirmDialogData } from '../../shared/dialogs/confirm-dialog';

/** Implemented by any form page that {@link unsavedChangesGuard} protects. */
export interface HasUnsavedChanges {
  hasUnsavedChanges(): boolean;
}

export const UNSAVED_CHANGES_DIALOG: ConfirmDialogData = {
  title: 'Discard unsaved changes?',
  message: 'This form has edits that have not been saved.',
  confirmLabel: 'Discard',
};

/**
 * Asks before leaving a form the author has edited and not saved.
 *
 * Returning `false` cancels the navigation and leaves the URL where it was, so
 * this guard never redirects and has nothing to carry: `RedirectCommand` is the
 * tool for a guard or resolver that *does* redirect (`staffGuard`,
 * `sectionFormResolver`).
 */
export const unsavedChangesGuard: CanDeactivateFn<HasUnsavedChanges> = (component) => {
  if (!component.hasUnsavedChanges()) {
    return of(true);
  }

  return inject(MatDialog)
    .open<ConfirmDialog, ConfirmDialogData, boolean>(ConfirmDialog, {
      data: UNSAVED_CHANGES_DIALOG,
    })
    .afterClosed()
    .pipe(
      // Material emits `undefined` when the dialog is dismissed with Escape or
      // a backdrop click, and `undefined` is not a `GuardResult`.
      map((confirmed) => confirmed === true),
    );
};
