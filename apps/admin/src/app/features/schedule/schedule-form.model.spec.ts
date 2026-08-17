import { describe, expect, it } from 'vitest';
import type { ScheduleSlot } from '@speakukrainian/shared';
import {
  DEFAULT_SLOT_START,
  buildSlotCreate,
  buildSlotPatch,
  composeInterval,
  conflictSlotId,
  formatClockTime,
  initialFormValue,
  parseClockTime,
  timeZoneOptions,
  untilInstant,
  type SlotFormValue,
} from './schedule-form.model';
import { parseCivilDate } from './schedule.model';

/**
 * Nothing here injects anything, and no function under test reads a clock or a
 * zone it was not given — which is what makes these assertions independent of
 * the machine the suite runs on. Every instant is written out in full rather
 * than computed, so a test cannot agree with the implementation by repeating
 * its arithmetic.
 */

const MADRID = 'Europe/Madrid';
const KYIV = 'Europe/Kyiv';
/** A backward-compatibility link `Intl.supportedValuesOf` does not carry. */
const US_EASTERN = 'US/Eastern';

const audit = {
  createdAt: '2026-01-01T00:00:00Z',
  createdBy: 'admin',
  updatedAt: '2026-01-01T00:00:00Z',
  updatedBy: 'admin',
};

function slot(overrides: Partial<ScheduleSlot> = {}): ScheduleSlot {
  return {
    id: 'slot-1',
    ownerId: 'teacher',
    startsAt: '2026-03-06T08:00:00Z',
    endsAt: '2026-03-06T09:00:00Z',
    timeZone: MADRID,
    status: 'open',
    recurrenceId: null,
    bookedBy: null,
    bookedAt: null,
    audit,
    ...overrides,
  };
}

function value(overrides: Partial<SlotFormValue> = {}): SlotFormValue {
  return {
    date: '2026-03-09',
    startTime: '09:00',
    endTime: '10:00',
    timeZone: MADRID,
    note: {},
    repeats: false,
    daysOfWeek: [1],
    until: '2026-03-09',
    ...overrides,
  };
}

function civil(value: string) {
  const parsed = parseCivilDate(value);
  if (parsed === null) {
    throw new Error(`${value} is not a civil date`);
  }
  return parsed;
}

describe('parseClockTime', () => {
  it('reads both spellings a real time input produces', () => {
    expect(parseClockTime('09:05')).toEqual({ hour: 9, minute: 5 });
    // Chromium emits seconds once `step` drops below 60, and they are dropped
    // rather than refused.
    expect(parseClockTime('09:05:30')).toEqual({ hour: 9, minute: 5 });
    expect(parseClockTime('00:00')).toEqual({ hour: 0, minute: 0 });
    expect(parseClockTime('23:59')).toEqual({ hour: 23, minute: 59 });
  });

  it('refuses everything that is not a time, midway edits included', () => {
    // Chromium emits `''` while the field is being edited; read as midnight it
    // would compose an interval nobody asked for.
    expect(parseClockTime('')).toBeNull();
    expect(parseClockTime(null)).toBeNull();
    expect(parseClockTime(undefined)).toBeNull();
    expect(parseClockTime('9:00')).toBeNull();
    expect(parseClockTime('24:00')).toBeNull();
    expect(parseClockTime('09:60')).toBeNull();
    expect(parseClockTime('nonsense')).toBeNull();
  });
});

describe('formatClockTime', () => {
  it('zero-pads, which is what a time input wants written back', () => {
    expect(formatClockTime({ hour: 9, minute: 0 })).toBe('09:00');
    expect(formatClockTime({ hour: 0, minute: 5 })).toBe('00:05');
  });
});

describe('composeInterval', () => {
  it('reads the fields on the slot’s own clock', () => {
    // Madrid is +01:00 on 9 March 2026. Reading the wall clock as UTC gives
    // 09:00Z, and taking the offset at the wrong instant gives 07:00Z.
    expect(composeInterval(value())).toEqual({
      startsAt: '2026-03-09T08:00:00.000Z',
      endsAt: '2026-03-09T09:00:00.000Z',
      crossesMidnight: false,
    });
  });

  it('keeps the same wall clock on both sides of a daylight-saving change', () => {
    // The DST week is 29 March 2026. Anything deriving an occurrence by adding
    // elapsed milliseconds gives 08:00Z on 1 April, which reads as 10:00 in
    // Madrid (ADR-014's table).
    expect(composeInterval(value({ date: '2026-03-25' }))?.startsAt).toBe(
      '2026-03-25T08:00:00.000Z',
    );
    expect(composeInterval(value({ date: '2026-04-01' }))?.startsAt).toBe(
      '2026-04-01T07:00:00.000Z',
    );
  });

  it('reads an end at or before the start as the next day', () => {
    // The week view's own fixtures include this slot, so a form that refused it
    // could not author what the screen beside it already draws. The end is
    // converted on its own civil date, never as the start plus elapsed minutes.
    expect(
      composeInterval(value({ date: '2026-03-06', startTime: '23:30', endTime: '00:30' })),
    ).toEqual({
      startsAt: '2026-03-06T22:30:00.000Z',
      endsAt: '2026-03-06T23:30:00.000Z',
      crossesMidnight: true,
    });
  });

  it('describes no interval at all when the fields do not', () => {
    // A zero-length slot is not a slot, and 00:00→00:00 read as "the next day"
    // would silently create a 24-hour one.
    expect(composeInterval(value({ endTime: '09:00' }))).toBeNull();
    expect(composeInterval(value({ startTime: '00:00', endTime: '00:00' }))).toBeNull();
    expect(composeInterval(value({ date: '2026-02-31' }))).toBeNull();
    expect(composeInterval(value({ date: '' }))).toBeNull();
    expect(composeInterval(value({ startTime: '' }))).toBeNull();
    // `wallClockToInstant` throws a `RangeError` on a zone `Intl` cannot
    // resolve, and this is the one place a form field reaches it.
    expect(composeInterval(value({ timeZone: 'Nowhere/Nothing' }))).toBeNull();
    expect(composeInterval(value({ timeZone: '+02:00' }))).toBeNull();
  });
});

describe('untilInstant', () => {
  it('is the end of the chosen day in the slot’s own zone', () => {
    // `expandRecurrence` compares each occurrence's start against `until`,
    // inclusive, so midnight would drop every occurrence on the last day.
    expect(untilInstant('2026-04-30', MADRID)).toBe('2026-04-30T21:59:59.000Z');
    expect(untilInstant('2026-04-30', KYIV)).toBe('2026-04-30T20:59:59.000Z');
  });

  it('is null for anything that is not a date', () => {
    expect(untilInstant('2026-02-31', MADRID)).toBeNull();
    expect(untilInstant('', MADRID)).toBeNull();
  });
});

describe('initialFormValue', () => {
  it('reads a stored slot on its own clock, not on the browser’s', () => {
    // The silent-shift bug: a Madrid slot opened from Kyiv reads 10:00 if the
    // fields are read in the browser's zone, and the next save moves it.
    const initial = initialFormValue(slot(), null, null, KYIV, new Date('2026-03-04T12:00:00Z'));

    expect(initial.date).toBe('2026-03-06');
    expect(initial.startTime).toBe('09:00');
    expect(initial.endTime).toBe('10:00');
    expect(initial.timeZone).toBe(MADRID);
    expect(initial.repeats).toBe(false);
  });

  it('keeps a stored zone spelling verbatim', () => {
    // ADR-014 forbids canonicalising it behind the admin's back, and
    // `Intl.supportedValuesOf` carries neither of these two names.
    const eastern = initialFormValue(
      slot({ timeZone: US_EASTERN }),
      null,
      null,
      KYIV,
      new Date('2026-03-04T12:00:00Z'),
    );
    expect(eastern.timeZone).toBe(US_EASTERN);

    const kyiv = initialFormValue(
      slot({ timeZone: KYIV }),
      null,
      null,
      MADRID,
      new Date('2026-03-04T12:00:00Z'),
    );
    expect(kyiv.timeZone).toBe(KYIV);
  });

  it('opens a stored note in the editor’s own spelling', () => {
    // Without the inbound half, a note reading `Modal verbs <can>` opens
    // truncated and the next save writes the truncation back.
    const initial = initialFormValue(
      slot({ note: { en: 'Modal verbs <can>' } }),
      null,
      null,
      KYIV,
      new Date('2026-03-04T12:00:00Z'),
    );
    expect(initial.note).toEqual({ en: 'Modal verbs &lt;can&gt;' });
  });

  it('opens a new slot on the requested date and time', () => {
    const initial = initialFormValue(
      null,
      civil('2026-03-09'),
      { hour: 14, minute: 30 },
      KYIV,
      new Date('2026-03-04T12:00:00Z'),
    );

    expect(initial.date).toBe('2026-03-09');
    expect(initial.startTime).toBe('14:30');
    expect(initial.endTime).toBe('15:30');
    expect(initial.timeZone).toBe(KYIV);
    // Monday, so the repeat opens ticking the day the series would start on.
    expect(initial.daysOfWeek).toEqual([1]);
    expect(initial.until).toBe('2026-03-09');
  });

  it('falls back to today in the browser’s zone, and to the default start', () => {
    const initial = initialFormValue(null, null, null, KYIV, new Date('2026-03-04T22:30:00Z'));

    // 22:30Z on 4 March is already 5 March in Kyiv: the fallback reads the
    // parameter's clock, not the machine's.
    expect(initial.date).toBe('2026-03-05');
    expect(initial.startTime).toBe(DEFAULT_SLOT_START);
    expect(initial.endTime).toBe('10:00');
  });

  it('wraps the default end past midnight rather than backwards', () => {
    const initial = initialFormValue(
      null,
      civil('2026-03-09'),
      { hour: 23, minute: 30 },
      KYIV,
      new Date('2026-03-04T12:00:00Z'),
    );
    expect(initial.endTime).toBe('00:30');
  });
});

describe('buildSlotPatch', () => {
  const now = new Date('2026-03-04T12:00:00Z');

  it('sends no times at all when nothing was edited', () => {
    // "Open a slot, save it, nothing moved" is true by construction here rather
    // than by a wall-clock round trip happening to be exact.
    const stored = slot({ timeZone: KYIV });
    const untouched = initialFormValue(stored, null, null, MADRID, now);

    expect(buildSlotPatch(untouched, stored)).toEqual({});
  });

  it('sends no times when the stored instant is spelled another way', () => {
    // `isoDateTimeSchema` accepts three spellings of one instant, and a stored
    // slot may carry any of them.
    const stored = slot({ startsAt: '2026-03-06T09:00:00+01:00', endsAt: '2026-03-06T09:00:00Z' });
    const untouched = initialFormValue(stored, null, null, KYIV, now);

    expect(buildSlotPatch(untouched, stored)).toEqual({});
  });

  it('sends both instants when the slot moves an hour, and never a status', () => {
    const stored = slot();
    const initial = initialFormValue(stored, null, null, KYIV, now);
    const moved = { ...initial, startTime: '10:00', endTime: '11:00' };

    const patch = buildSlotPatch(moved, stored);

    expect(patch.startsAt).toBe('2026-03-06T09:00:00.000Z');
    expect(patch.endsAt).toBe('2026-03-06T10:00:00.000Z');
    // A save that carried the status would quietly re-open a cancelled slot.
    expect(patch.status).toBeUndefined();
  });

  it('sends only the end when only the end moves', () => {
    const stored = slot();
    const initial = initialFormValue(stored, null, null, KYIV, now);

    const patch = buildSlotPatch({ ...initial, endTime: '11:00' }, stored);

    expect(patch.startsAt).toBeUndefined();
    expect(patch.endsAt).toBe('2026-03-06T10:00:00.000Z');
  });

  it('sends the zone only when its spelling changed', () => {
    const stored = slot({ timeZone: KYIV });
    const initial = initialFormValue(stored, null, null, MADRID, now);

    expect(buildSlotPatch({ ...initial, timeZone: 'Europe/Kiev' }, stored).timeZone).toBe(
      'Europe/Kiev',
    );
    expect(buildSlotPatch(initial, stored).timeZone).toBeUndefined();
  });

  it('clears a note that was stored, and omits one that never existed', () => {
    const withNote = slot({ note: { en: 'Beginners' } });
    const cleared = { ...initialFormValue(withNote, null, null, KYIV, now), note: {} };
    expect(buildSlotPatch(cleared, withNote).note).toEqual({});

    const bare = slot();
    expect(
      buildSlotPatch(initialFormValue(bare, null, null, KYIV, now), bare).note,
    ).toBeUndefined();
    expect(
      buildSlotPatch({ ...initialFormValue(bare, null, null, KYIV, now), note: { en: 'Hi' } }, bare)
        .note,
    ).toEqual({ en: 'Hi' });
  });
});

describe('buildSlotCreate', () => {
  it('always sends the interval and the zone, and no note nobody typed', () => {
    expect(buildSlotCreate(value())).toEqual({
      startsAt: '2026-03-09T08:00:00.000Z',
      endsAt: '2026-03-09T09:00:00.000Z',
      timeZone: MADRID,
    });
  });

  it('sends a recurrence only when the slot repeats, with the days sorted', () => {
    const created = buildSlotCreate(
      value({ repeats: true, daysOfWeek: [3, 1], until: '2026-04-30' }),
    );

    expect(created?.recurrence).toEqual({
      frequency: 'weekly',
      daysOfWeek: [1, 3],
      until: '2026-04-30T21:59:59.000Z',
    });
  });

  it('drops the recurrence for a one-off slot however the days were left', () => {
    // `getRawValue()` answers for disabled controls too, so keying on the days
    // rather than on `repeats` would ship a series nobody asked for.
    expect(
      buildSlotCreate(value({ repeats: false, daysOfWeek: [1, 3] }))?.recurrence,
    ).toBeUndefined();
  });

  it('is null when the fields describe no interval', () => {
    expect(buildSlotCreate(value({ endTime: '09:00' }))).toBeNull();
  });
});

describe('conflictSlotId', () => {
  // Copied verbatim from `ScheduleService.fail`, which is the whole point of the
  // extraction being tolerant.
  const OVERLAP =
    'A slot starting at 2026-03-09T08:00:00.000Z overlaps the existing slot `abc123_-X` for this owner';
  const SELF_OVERLAP =
    'This recurrence overlaps itself at 2026-03-09T08:00:00.000Z — two occurrences would share the same time';

  it('names the slot the API refused to collide with', () => {
    expect(conflictSlotId(OVERLAP)).toBe('abc123_-X');
  });

  it('names nothing when the message quotes no id', () => {
    expect(conflictSlotId(SELF_OVERLAP)).toBeNull();
    expect(conflictSlotId(undefined)).toBeNull();
    expect(conflictSlotId('')).toBeNull();
  });

  it('refuses a quoted value that is not a document id', () => {
    // A link built from this would be a path traversal in a router segment.
    expect(conflictSlotId('overlaps the existing slot `../etc` for this owner')).toBeNull();
    expect(conflictSlotId('overlaps the existing slot `a b` for this owner')).toBeNull();
  });
});

describe('timeZoneOptions', () => {
  it('adds a stored spelling the runtime’s own list does not carry', () => {
    // The list is canonical names only: it holds `Europe/Kiev` and not
    // `Europe/Kyiv`, so a select built from it opens this product's own zone
    // blank and the next save re-zones the slot.
    const options = timeZoneOptions(['Europe/Kiev', 'Europe/Madrid'], KYIV);

    expect(options).toContain(KYIV);
    expect(options).toContain('Europe/Kiev');
    expect(options).toEqual([...options].sort());
  });

  it('adds nothing when the list already carries the zone, whatever the case', () => {
    // ADR-014 folds case rather than comparing with `===`, so one zone spelled
    // two ways must not become two options.
    expect(timeZoneOptions(['Europe/Kiev'], 'Europe/Kiev')).toEqual(['Europe/Kiev']);
    expect(timeZoneOptions(['Europe/Kiev'], 'europe/kiev')).toEqual(['Europe/Kiev']);
  });
});
