import type { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';
import { slugSchema } from '@speakukrainian/shared';

/**
 * Suggests a slug from a title. Accents are folded rather than dropped, so
 * "Café" suggests `cafe` and not `caf`.
 *
 * Everything outside `[a-z0-9]` goes, which means a title written in a
 * non-Latin script suggests `''` and the author types the slug themselves. A
 * transliteration table is a separate piece of work.
 */
export function slugify(value: string): string {
  const kebab = value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  // The length comes off the schema so the limit is stated once (rule 1). The
  // slice can land on a hyphen, which `slugSchema` refuses, so it is trimmed
  // again afterwards.
  const max = slugSchema.maxLength;
  const capped = max === null ? kebab : kebab.slice(0, max);
  return capped.replace(/-+$/, '');
}

/** Delegates to `slugSchema`; the kebab-case regex is never restated here. */
export const slugValidator: ValidatorFn = (control: AbstractControl): ValidationErrors | null =>
  slugSchema.safeParse(control.value).success ? null : { slug: true };
