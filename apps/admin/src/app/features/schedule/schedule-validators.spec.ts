import { FormControl, FormGroup } from '@angular/forms';
import { describe, expect, it } from 'vitest';
import { MAX_SLOT_NOTE_LENGTH, type RichText } from '@speakukrainian/shared';
import {
  atLeastOneDayValidator,
  civilDateValidator,
  clockTimeValidator,
  distinctTimesValidator,
  localesOverNoteLength,
  noteLengthValidator,
  timeZoneValidator,
  untilNotBeforeValidator,
} from './schedule-validators';

/**
 * Asserted directly rather than through the UI. The zone rule in particular
 * cannot fire through the select, whose every option is resolvable — it is there
 * for the obligation `packages/shared/src/time.ts` places on its callers, which
 * a click cannot exercise.
 */

function control(value: unknown): FormControl {
  return new FormControl(value);
}

describe('timeZoneValidator', () => {
  it('accepts a zone the runtime resolves, including a link name', () => {
    expect(timeZoneValidator(control('Europe/Madrid'))).toBeNull();
    // `Intl.supportedValuesOf` carries neither, and `timeZoneSchema` accepts
    // both — which is the gap `timeZoneOptions` exists for.
    expect(timeZoneValidator(control('Europe/Kyiv'))).toBeNull();
    expect(timeZoneValidator(control('US/Eastern'))).toBeNull();
  });

  it('refuses a zone the runtime cannot resolve, and a fixed offset', () => {
    expect(timeZoneValidator(control('Nowhere/Nothing'))).toEqual({ timeZone: true });
    // An offset never observes DST, which is the only reason the field exists.
    expect(timeZoneValidator(control('+02:00'))).toEqual({ timeZone: true });
  });

  it('leaves emptiness to `Validators.required`', () => {
    expect(timeZoneValidator(control(''))).toBeNull();
  });
});

describe('civilDateValidator', () => {
  it('refuses a date the calendar does not have', () => {
    expect(civilDateValidator(control('2026-03-09'))).toBeNull();
    expect(civilDateValidator(control('2026-02-31'))).toEqual({ civilDate: true });
    expect(civilDateValidator(control(''))).toBeNull();
  });
});

describe('clockTimeValidator', () => {
  it('accepts both spellings a time input produces and refuses the rest', () => {
    expect(clockTimeValidator(control('09:00'))).toBeNull();
    expect(clockTimeValidator(control('09:00:30'))).toBeNull();
    expect(clockTimeValidator(control('24:00'))).toEqual({ clockTime: true });
    expect(clockTimeValidator(control(''))).toBeNull();
  });
});

describe('distinctTimesValidator', () => {
  function times(startTime: string, endTime: string): FormGroup {
    return new FormGroup({
      startTime: new FormControl(startTime),
      endTime: new FormControl(endTime),
    });
  }

  it('refuses a zero-length slot', () => {
    expect(distinctTimesValidator(times('09:00', '09:00'))).toEqual({ zeroLength: true });
    // Read as "the next day" this would be a silent 24-hour slot, which
    // `MAX_SLOT_DURATION_HOURS` accepts.
    expect(distinctTimesValidator(times('00:00', '00:00'))).toEqual({ zeroLength: true });
    expect(distinctTimesValidator(times('09:00', '09:00:00'))).toEqual({ zeroLength: true });
  });

  it('allows an end before the start, which means the next day', () => {
    expect(distinctTimesValidator(times('23:30', '00:30'))).toBeNull();
    expect(distinctTimesValidator(times('09:00', '10:00'))).toBeNull();
  });

  it('says nothing while either field is still incomplete', () => {
    expect(distinctTimesValidator(times('', ''))).toBeNull();
    expect(distinctTimesValidator(times('09:00', ''))).toBeNull();
  });
});

describe('atLeastOneDayValidator', () => {
  it('requires a weekday, which `slotRecurrenceSchema` does too', () => {
    expect(atLeastOneDayValidator(control([1]))).toBeNull();
    expect(atLeastOneDayValidator(control([]))).toEqual({ noDays: true });
  });
});

describe('untilNotBeforeValidator', () => {
  const validator = untilNotBeforeValidator(() => '2026-03-09');

  it('accepts the start date itself, which is a one-occurrence series', () => {
    expect(validator(control('2026-03-09'))).toBeNull();
    expect(validator(control('2026-04-30'))).toBeNull();
  });

  it('refuses a last day before the start, and a date that is not one', () => {
    expect(validator(control('2026-03-08'))).toEqual({ untilBeforeStart: true });
    expect(validator(control('2026-02-31'))).toEqual({ civilDate: true });
    expect(validator(control(''))).toBeNull();
  });
});

describe('noteLengthValidator', () => {
  const long = 'x'.repeat(MAX_SLOT_NOTE_LENGTH + 1);

  it('names every locale that is over the bound', () => {
    // Per locale, exactly as `slotNoteSchema` applies it: a total across the
    // tabs would fail the sixth translation for text already authored in five.
    const value: RichText = { en: `<p>${long}</p>`, uk: '<p>Коротко</p>', es: `<p>${long}</p>` };
    expect(noteLengthValidator(control(value))).toEqual({ noteTooLong: ['en', 'es'] });
  });

  it('measures the stored plain text, not the editor’s markup', () => {
    // The markup is not what gets stored, so a note near the bound must not be
    // failed by its own paragraph tags.
    const value: RichText = { en: `<p><strong>${'x'.repeat(MAX_SLOT_NOTE_LENGTH)}</strong></p>` };
    expect(noteLengthValidator(control(value))).toBeNull();
    expect(localesOverNoteLength(value)).toEqual([]);
  });

  it('says nothing about an empty note', () => {
    expect(noteLengthValidator(control({}))).toBeNull();
    expect(noteLengthValidator(control(null))).toBeNull();
  });
});
