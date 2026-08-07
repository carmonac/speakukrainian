import { FormControl } from '@angular/forms';
import { describe, expect, it } from 'vitest';
import { showOnceEdited } from './show-once-edited';

/** The matcher only ever reads the control; the form is not part of its answer. */
function isError(control: FormControl | null): boolean {
  return showOnceEdited.isErrorState(control, null);
}

function invalid(): FormControl {
  return new FormControl('', (c) => (c.value === '' ? { required: true } : null));
}

describe('showOnceEdited', () => {
  it('stays quiet on an invalid field nobody has touched yet', () => {
    // A create form opens with an empty required slug. Material's default
    // matcher would be quiet here too — but one keyed on `invalid` alone would
    // paint the whole form red and replace every hint with an error.
    expect(isError(invalid())).toBe(false);
  });

  it('speaks once the field has been edited', () => {
    const control = invalid();
    control.markAsDirty();

    expect(isError(control)).toBe(true);
  });

  it('speaks once the field has been touched, without waiting for a submit', () => {
    // The regression this exists for: Save is disabled while the form is
    // invalid, so `ngSubmit` never fires and Material's default matcher would
    // never show the error that says why.
    const control = invalid();
    control.markAsTouched();

    expect(isError(control)).toBe(true);
  });

  it('says nothing about a valid field, however edited', () => {
    const control = new FormControl('present-simple');
    control.markAsDirty();
    control.markAsTouched();

    expect(isError(control)).toBe(false);
  });

  it('says nothing for a control that is not there', () => {
    expect(isError(null)).toBe(false);
  });
});
