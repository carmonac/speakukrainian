import type { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';
import { MAX_SLOT_NOTE_LENGTH, timeZoneSchema, type RichText } from '@speakukrainian/shared';
import { toPlainLocalized } from '../../shared/rich-text/localized-plain-text';
import { formatClockTime, parseClockTime } from './schedule-form.model';
import { parseCivilDate } from './schedule.model';

// The form's own copy of what the API would refuse, so the admin is pointed at
// the field rather than at an anonymous toast quoting Zod. Each one delegates to
// the schema it mirrors; no rule is restated here (rule 1).

/**
 * A zone `packages/shared/src/time.ts` will resolve.
 *
 * It cannot fire through the select, whose every option is resolvable. It is
 * here because `time.ts` places a live obligation on its callers — its formatter
 * cache is bounded only because every zone reaching it went through
 * `timeZoneSchema` — and this screen is where a zone comes off a form field and
 * reaches that module without touching the API first. Asserted directly rather
 * than through the UI, for the same reason.
 */
export const timeZoneValidator: ValidatorFn = (
  control: AbstractControl,
): ValidationErrors | null => {
  if (control.value === '' || control.value === null) {
    // Emptiness is `Validators.required`'s business.
    return null;
  }
  return timeZoneSchema.safeParse(control.value).success ? null : { timeZone: true };
};

/** A real calendar date, which `<input type="date">` gives and a typed one may not. */
export const civilDateValidator: ValidatorFn = (
  control: AbstractControl,
): ValidationErrors | null => {
  if (control.value === '' || control.value === null) {
    return null;
  }
  return parseCivilDate(control.value as string) === null ? { civilDate: true } : null;
};

/** `HH:mm` or `HH:mm:ss`, the two spellings a real time input produces. */
export const clockTimeValidator: ValidatorFn = (
  control: AbstractControl,
): ValidationErrors | null => {
  if (control.value === '' || control.value === null) {
    return null;
  }
  return parseClockTime(control.value as string) === null ? { clockTime: true } : null;
};

/**
 * A zero-length slot, which is not a slot.
 *
 * An end *before* the start is deliberately not refused — it means the next day,
 * which is how the week view's 23:30-00:30 slot is authored. Equal times are the
 * one case that has to go, and it has to go here rather than being read as
 * "24 hours later", which `MAX_SLOT_DURATION_HOURS` would accept.
 */
export const distinctTimesValidator: ValidatorFn = (
  control: AbstractControl,
): ValidationErrors | null => {
  const start = parseClockTime(control.get('startTime')?.value as string | null);
  const end = parseClockTime(control.get('endTime')?.value as string | null);
  if (start === null || end === null) {
    return null;
  }
  return formatClockTime(start) === formatClockTime(end) ? { zeroLength: true } : null;
};

/** At least one weekday ticked, which `slotRecurrenceSchema` requires of a series. */
export const atLeastOneDayValidator: ValidatorFn = (
  control: AbstractControl,
): ValidationErrors | null => {
  const days = control.value as number[] | null;
  return days !== null && days.length > 0 ? null : { noDays: true };
};

/**
 * The repeat's last day, which cannot fall before the day the series starts.
 *
 * The start date is read through `dateOf` rather than off a sibling control, so
 * the validator has no opinion about the shape of the group it sits in — the
 * `linkHrefValidator` arrangement. Angular does not re-run a control's
 * validators when another control changes, so the form re-runs this one itself
 * when the date moves.
 *
 * Both values are zero-padded `YYYY-MM-DD`, so the string comparison is the
 * calendar comparison.
 */
export function untilNotBeforeValidator(dateOf: () => string): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const until = control.value as string;
    if (until === '' || until === null) {
      return null;
    }
    if (parseCivilDate(until) === null) {
      return { civilDate: true };
    }
    return until < dateOf() ? { untilBeforeStart: true } : null;
  };
}

/**
 * The note's per-locale length, reported with the locales that are over.
 *
 * The API's own refusal reaches the toast as "Too big: expected string to have
 * <=500 characters" with the path stripped, which names neither the field nor
 * the language it was typed in.
 *
 * The bound is `slotNoteSchema`'s own constant rather than a number written down
 * again, and it is applied **per locale** because that is how the schema applies
 * it — a total across the tabs would fail the sixth translation for text already
 * authored in five. The stored value is the plain text, so that is what is
 * measured, not the editor's markup.
 */
export const noteLengthValidator: ValidatorFn = (
  control: AbstractControl,
): ValidationErrors | null => {
  const over = localesOverNoteLength(control.value as RichText | null);
  return over.length > 0 ? { noteTooLong: over } : null;
};

/**
 * Exported so the screen can name the locales without re-deriving the rule from
 * the control's error object, which is not a signal and so is invisible to
 * zoneless change detection.
 */
export function localesOverNoteLength(value: RichText | null): string[] {
  return Object.entries(toPlainLocalized(value))
    .filter(([, text]) => text.length > MAX_SLOT_NOTE_LENGTH)
    .map(([locale]) => locale);
}
