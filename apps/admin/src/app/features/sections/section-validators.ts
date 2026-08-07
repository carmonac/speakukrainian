import type { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';
import { editableSectionFields, linkTargetSchema, type LinkTarget } from '@speakukrainian/shared';

// The form's own copy of what the API would refuse, so the author is pointed at
// the field rather than at an anonymous toast quoting Zod. Each one delegates to
// the schema it mirrors; no rule is restated here (rule 1). The slug rule is not
// here: it mentions nothing about a section, so it lives in `shared/forms/slug`
// with `slugify`.

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

/**
 * The href rule is `linkTargetSchema`'s — the schema the API validates a request
 * body with — parsed through a whole target because the rule depends on `type`.
 * Nothing is restated here (rule 1).
 *
 * The type is read through `typeOf` rather than off a sibling control, so the
 * validator has no opinion about the shape of the group it sits in and no
 * unwritten default for the case where that sibling is not there yet. Angular
 * does not re-run a control's validators when another control changes, so the
 * form re-runs this one itself when `type` moves.
 */
export function linkHrefValidator(typeOf: () => LinkTarget['type']): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    if (control.value === '' || control.value === null) {
      // Emptiness is `Validators.required`'s business.
      return null;
    }
    return linkTargetSchema.safeParse({ type: typeOf(), href: control.value }).success
      ? null
      : { href: true };
  };
}
