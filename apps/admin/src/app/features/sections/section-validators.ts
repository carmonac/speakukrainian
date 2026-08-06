import type { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';
import { editableSectionFields, slugSchema } from '@speakukrainian/shared';

// The form's own copy of what the API would refuse, so the author is pointed at
// the field rather than at an anonymous toast quoting Zod. Each one delegates to
// the schema it mirrors; no rule is restated here (rule 1).

export const slugValidator: ValidatorFn = (control: AbstractControl): ValidationErrors | null =>
  slugSchema.safeParse(control.value).success ? null : { slug: true };

/**
 * Emptiness is `Validators.required`'s business — the create route leaves the
 * field blank on purpose, meaning "append after the last sibling".
 */
export const sortOrderValidator: ValidatorFn = (
  control: AbstractControl,
): ValidationErrors | null => {
  if (control.value === null || control.value === '') {
    return null;
  }
  return editableSectionFields.sortOrder.safeParse(control.value).success
    ? null
    : { sortOrder: true };
};
