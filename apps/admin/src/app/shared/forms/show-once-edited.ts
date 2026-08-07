import type { ErrorStateMatcher } from '@angular/material/core';

/**
 * When a field on an admin form shows its error — one answer for all of them, so
 * a field added later inherits the policy instead of inventing a third variant.
 *
 * Material's default matcher waits for a blur or a submit, and these forms offer
 * neither: Save is disabled while the form is invalid, so `ngSubmit` never
 * fires, and clicking a disabled button does not move focus, so an author who
 * types `1.5` or a slug with spaces and reaches for Save would be left with a
 * dead button and no reason for it. `dirty || touched` is what keeps a pristine
 * `/sections/new` from opening painted red with its hints replaced by errors.
 *
 * This is the admin-wide policy. A form opts in by providing it per component:
 * `providers: [{ provide: ErrorStateMatcher, useValue: showOnceEdited }]`.
 */
export const showOnceEdited: ErrorStateMatcher = {
  isErrorState: (control) =>
    control !== null && control.invalid && (control.dirty || control.touched),
};
