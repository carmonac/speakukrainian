import type { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';
import {
  editableSectionFields,
  linkTargetSchema,
  slugSchema,
  type LinkTarget,
} from '@speakukrainian/shared';

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

/**
 * The href rule is `linkTargetSchema`'s, parsed through a whole target because
 * the rule depends on `type`. Nothing is restated here (rule 1).
 *
 * It reads its sibling control, and Angular does not re-run a control's
 * validators when a sibling changes — the form re-runs this one itself when
 * `type` moves.
 */
export function linkHrefValidator(control: AbstractControl): ValidationErrors | null {
  if (control.value === '' || control.value === null) {
    // Emptiness is `Validators.required`'s business.
    return null;
  }
  const type = control.parent?.get('type')?.value as LinkTarget['type'] | undefined;
  return linkTargetSchema.safeParse({ type: type ?? 'internal', href: control.value }).success
    ? null
    : { href: true };
}
