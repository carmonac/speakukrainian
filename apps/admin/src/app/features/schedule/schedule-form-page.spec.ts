import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { MatDialog } from '@angular/material/dialog';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { Subject, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CreateScheduleSlotInput,
  ListScheduleSlotsQuery,
  LocaleCode,
  ScheduleSlot,
  UpdateScheduleSlotInput,
} from '@speakukrainian/shared';
import { LocalesStore } from '../../core/locales/locales.store';
import { UNSAVED_CHANGES_DIALOG } from '../../core/router/unsaved-changes.guard';
import { NotificationService } from '../../core/notifications/notification.service';
import { BROWSER_TIME_ZONE } from '../../core/time/browser-time-zone';
import { SUPPORTED_TIME_ZONES } from '../../core/time/supported-time-zones';
import type { ConfirmDialogData } from '../../shared/dialogs/confirm-dialog';
import {
  BOOKED_READ_ONLY,
  CANCEL_SLOT_DIALOG,
  DELETE_SERIES_DIALOG,
  DELETE_SLOT_DIALOG,
  EDITING_ONE_OCCURRENCE,
  NO_OCCURRENCES_REMOVED,
  SLOT_CANCELLED,
  SLOT_DELETED,
  SLOT_REOPENED,
} from './schedule-messages';
import { ScheduleApi } from './schedule.api';
import { routes } from './schedule.routes';

const MADRID = 'Europe/Madrid';
const KYIV = 'Europe/Kyiv';
const KIEV = 'Europe/Kiev';
const NEW_YORK = 'America/New_York';
const PHOENIX = 'America/Phoenix';
const DENVER = 'America/Denver';

/**
 * The zone list a runtime hands over, cut to four entries and pinned here.
 * `Intl.supportedValuesOf` answers differently on every runtime — 418 canonical
 * names on this project's Node, a different set in Chromium — so asserting
 * against the real one would assert ICU's version rather than this code. Note
 * that it carries `Europe/Kiev` and **not** `Europe/Kyiv`, exactly as the real
 * list does.
 */
const SUPPORTED = [KIEV, MADRID, NEW_YORK, 'UTC'];

/** Any other admin screen, so the form can be left for somewhere. */
@Component({ selector: 'app-elsewhere-stub', template: 'elsewhere' })
class Elsewhere {}

/** Wednesday 4 March 2026, so "today" is a fixed day in both zones used here. */
const NOW = new Date('2026-03-04T12:00:00Z');

const audit = {
  createdAt: '2026-01-01T00:00:00Z',
  createdBy: 'admin',
  updatedAt: '2026-01-01T00:00:00Z',
  updatedBy: 'admin',
};

function slot(id: string, overrides: Partial<ScheduleSlot> = {}): ScheduleSlot {
  return {
    id,
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

interface Options {
  slots?: ScheduleSlot[];
  /** What `create` answers with. Defaults to one slot echoing the request. */
  created?: ScheduleSlot[];
  createFails?: unknown;
  updateFails?: unknown;
  removeFails?: unknown;
  removeSeriesFails?: unknown;
  /**
   * What `removeSeries` answers with, for the tests about the count rather than
   * about which occurrences go. Left out, the fake applies its own cutoff.
   */
  removeSeriesResult?: number;
  /**
   * Holds `remove` open, so a test can look at the screen mid-delete. Completed
   * by hand with `next()`; a bare `complete()` would reject `firstValueFrom`.
   */
  deferRemove?: Subject<void>;
  /** What every confirmation answers, including the unsaved-changes guard's. */
  confirm?: boolean;
  /**
   * Closes every confirmation the way Escape and a backdrop click do — with
   * `undefined`, which is not a `boolean` and is what the component has to read
   * as a no.
   */
  dismissed?: boolean;
  viewZone?: string;
  supported?: string[];
}

interface Recorded {
  created: CreateScheduleSlotInput[];
  updated: { id: string; input: UpdateScheduleSlotInput }[];
  removed: string[];
  removedSeries: string[];
  read: string[];
  successes: string[];
  dialogs: number;
  /** What each confirmation was opened with, in order. */
  dialogData: ConfirmDialogData[];
}

function setup(options: Options = {}): Recorded {
  const stored = new Map((options.slots ?? []).map((entry) => [entry.id, entry]));
  const recorded: Recorded = {
    created: [],
    updated: [],
    removed: [],
    removedSeries: [],
    read: [],
    successes: [],
    dialogs: 0,
    dialogData: [],
  };

  const api = {
    /**
     * Honours the range, the way `ScheduleSlotsRepository.list` does: the slots
     * that *intersect* `[from, to)`. Not tidiness — `buildWeek` drops a slot
     * with no matching column into `columns[0]` rather than dropping it, so an
     * unfiltered fake paints an out-of-week slot in Monday's column and "the
     * deleted chip is gone" would pass or fail for the wrong reason.
     */
    list: (query: ListScheduleSlotsQuery) => {
      const from = Date.parse(query.from);
      const to = Date.parse(query.to);
      return of<ScheduleSlot[]>(
        [...stored.values()].filter(
          (entry) => Date.parse(entry.startsAt) < to && Date.parse(entry.endsAt) > from,
        ),
      );
    },
    get: (id: string) => {
      recorded.read.push(id);
      const found = stored.get(id);
      return found === undefined
        ? throwError(() => new HttpErrorResponse({ status: 404, statusText: 'Not Found' }))
        : of(found);
    },
    create: (input: CreateScheduleSlotInput) => {
      recorded.created.push(input);
      if (options.createFails !== undefined) {
        return throwError(() => options.createFails);
      }
      return of<ScheduleSlot[]>(
        options.created ?? [
          slot('created-1', {
            startsAt: input.startsAt,
            endsAt: input.endsAt,
            timeZone: input.timeZone,
          }),
        ],
      );
    },
    update: (id: string, input: UpdateScheduleSlotInput) => {
      recorded.updated.push({ id, input });
      if (options.updateFails !== undefined) {
        return throwError(() => options.updateFails);
      }
      // Written back, or a cancelled slot re-reads as open on the week the
      // screen navigates to.
      const next: ScheduleSlot = { ...slot(id), ...stored.get(id), ...input };
      stored.set(id, next);
      return of<ScheduleSlot>(next);
    },
    remove: (id: string) => {
      recorded.removed.push(id);
      if (options.removeFails !== undefined) {
        return throwError(() => options.removeFails);
      }
      stored.delete(id);
      // `of(undefined)` and never `EMPTY`: an observable that completes without
      // emitting rejects `firstValueFrom` with an `EmptyError`, which would
      // reach the component as a failed delete.
      return options.deferRemove ?? of(undefined);
    },
    removeSeries: (recurrenceId: string) => {
      recorded.removedSeries.push(recurrenceId);
      if (options.removeSeriesFails !== undefined) {
        return throwError(() => options.removeSeriesFails);
      }
      if (options.removeSeriesResult !== undefined) {
        return of({ deleted: options.removeSeriesResult });
      }
      // The cutoff is the API's, not the caller's: `ScheduleService.removeSeries`
      // passes `new Date()` and `ScheduleSlotsRepository.removeSeries` keeps
      // everything before it. A fake that dropped the whole series would leave
      // "the occurrences that have already started stay" untestable while
      // looking green.
      const now = Date.now();
      let deleted = 0;
      for (const entry of [...stored.values()]) {
        if (entry.recurrenceId === recurrenceId && Date.parse(entry.startsAt) >= now) {
          stored.delete(entry.id);
          deleted += 1;
        }
      }
      return of({ deleted });
    },
  } as unknown as ScheduleApi;

  TestBed.configureTestingModule({
    providers: [
      provideNoopAnimations(),
      // The shipped table, mounted the way `app.routes.ts` mounts it — never a
      // copy of it. `ScheduleFormPage` is deliberately not imported by this
      // spec, so `path`, `loadComponent`, `resolve`, `title` and `canDeactivate`
      // are all the shipped ones: declaring `:id` before `new`, or dropping the
      // guard, fails here rather than only in a browser.
      provideRouter(
        [
          { path: 'schedule', loadChildren: () => routes },
          { path: 'sections', component: Elsewhere },
        ],
        withComponentInputBinding(),
      ),
      { provide: ScheduleApi, useValue: api },
      // Never the machine's own zone, and never its real zone list: a leaked one
      // fails as a time in the wrong field, or an option that is not there, on
      // somebody else's laptop.
      { provide: BROWSER_TIME_ZONE, useValue: options.viewZone ?? KYIV },
      { provide: SUPPORTED_TIME_ZONES, useValue: options.supported ?? SUPPORTED },
      {
        provide: LocalesStore,
        useValue: {
          codes: signal<LocaleCode[]>(['en', 'uk']).asReadonly(),
          defaultCode: signal<LocaleCode | null>('en').asReadonly(),
        } as unknown as LocalesStore,
      },
      {
        provide: NotificationService,
        useValue: {
          success: (message: string) => recorded.successes.push(message),
          info: () => {},
          error: () => {},
        } as unknown as NotificationService,
      },
      {
        provide: MatDialog,
        useValue: {
          open: (_component: unknown, config?: { data?: ConfirmDialogData }) => {
            recorded.dialogs += 1;
            if (config?.data !== undefined) {
              recorded.dialogData.push(config.data);
            }
            return {
              afterClosed: () =>
                of<boolean | undefined>(
                  options.dismissed === true ? undefined : (options.confirm ?? true),
                ),
            };
          },
        } as unknown as MatDialog,
      },
    ],
  });

  return recorded;
}

async function open(url: string): Promise<RouterTestingHarness> {
  const harness = await RouterTestingHarness.create(url);
  await harness.fixture.whenStable();
  harness.detectChanges();
  return harness;
}

function root(harness: RouterTestingHarness): HTMLElement {
  const element = harness.routeNativeElement;
  if (!(element instanceof HTMLElement)) {
    throw new Error('Expected a schedule route to be activated');
  }
  return element;
}

function field(harness: RouterTestingHarness, selector: string): HTMLInputElement {
  const input = root(harness).querySelector<HTMLInputElement>(selector);
  if (input === null) {
    throw new Error(`Expected the form to render ${selector}`);
  }
  return input;
}

function fill(harness: RouterTestingHarness, selector: string, value: string): void {
  const input = field(harness, selector);
  input.value = value;
  input.dispatchEvent(new Event('input'));
  harness.detectChanges();
}

function text(element: Element | null): string {
  return element?.textContent?.trim().replaceAll(/\s+/g, ' ') ?? '';
}

function find(harness: RouterTestingHarness, selector: string): string {
  return text(root(harness).querySelector(selector));
}

async function click(harness: RouterTestingHarness, selector: string): Promise<void> {
  const element = root(harness).querySelector<HTMLElement>(selector);
  if (element === null) {
    throw new Error(`No ${selector} to click`);
  }
  element.click();
  await harness.fixture.whenStable();
  harness.detectChanges();
}

/** The native input Material hides inside a checkbox, which is what takes a click. */
async function tick(harness: RouterTestingHarness, selector: string): Promise<void> {
  await click(harness, `${selector} input[type="checkbox"]`);
}

function zoneText(harness: RouterTestingHarness): string {
  return find(harness, '.slot-form__zone .mat-mdc-select-value');
}

/** The options only exist while the panel is open, and they live in the overlay. */
async function openZones(harness: RouterTestingHarness): Promise<HTMLElement[]> {
  await click(harness, '.slot-form__zone .mat-mdc-select-trigger');
  return Array.from(document.querySelectorAll<HTMLElement>('mat-option'));
}

async function pickZone(harness: RouterTestingHarness, zone: string): Promise<void> {
  const option = (await openZones(harness)).find((entry) => text(entry) === zone);
  if (option === undefined) {
    throw new Error(`No ${zone} option to pick`);
  }
  option.click();
  await harness.fixture.whenStable();
  harness.detectChanges();
}

function saveDisabled(harness: RouterTestingHarness): boolean | undefined {
  return disabled(harness, '.slot-form__save');
}

function disabled(harness: RouterTestingHarness, selector: string): boolean | undefined {
  return root(harness).querySelector<HTMLButtonElement>(selector)?.disabled;
}

/**
 * Lets a promise chain that is already running finish. `whenStable` awaits the
 * application, not the handler, so a delete resolved by hand still has its
 * toast and its navigation queued behind this boundary. Only `Date` is faked
 * here, so `setTimeout` is the real one.
 */
function settled(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

/** A create form whose first save came back as the API's real overlap 409. */
async function refusedAsOverlapping(): Promise<{
  harness: RouterTestingHarness;
  recorded: Recorded;
}> {
  const recorded = setup({
    createFails: new HttpErrorResponse({
      status: 409,
      error: { message: 'overlaps the existing slot `taken-1` for this owner' },
    }),
  });
  const harness = await open('/schedule/new?date=2026-03-09&time=09:00');
  await click(harness, '.slot-form__save');
  return { harness, recorded };
}

describe('ScheduleFormPage', () => {
  beforeEach(() => {
    history.replaceState({}, '');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens a new slot on the date and time the week view asked for', async () => {
    const recorded = setup();
    const harness = await open('/schedule/new?date=2026-03-09&time=14:30');

    expect(field(harness, '.slot-form__date').value).toBe('2026-03-09');
    expect(field(harness, '.slot-form__start').value).toBe('14:30');
    expect(field(harness, '.slot-form__end').value).toBe('15:30');
    expect(zoneText(harness)).toBe(KYIV);
    // `new` is declared before `:id`, so this is the create form and not a
    // fetch of a slot called "new".
    expect(recorded.read).toEqual([]);
  });

  it('falls back to today rather than redirecting when the query params are unusable', async () => {
    setup();
    // Canonicalising here is what made the week view hang twice; there is
    // nothing to correct, so nothing navigates.
    const harness = await open('/schedule/new?date=2026-02-31&time=nonsense');

    expect(TestBed.inject(Router).url).toBe('/schedule/new?date=2026-02-31&time=nonsense');
    expect(field(harness, '.slot-form__date').value).toBe('2026-03-04');
    expect(field(harness, '.slot-form__start').value).toBe('09:00');
  });

  it('creates a one-off slot and returns to the week that holds it', async () => {
    const recorded = setup();
    const harness = await open('/schedule/new?date=2026-03-09&time=09:00');

    await click(harness, '.slot-form__save');

    // 09:00 in Kyiv on 9 March is 07:00Z — the wall clock read as UTC would be
    // 09:00Z, and the browser's zone is not the machine's here.
    expect(recorded.created).toEqual([
      {
        startsAt: '2026-03-09T07:00:00.000Z',
        endsAt: '2026-03-09T08:00:00.000Z',
        timeZone: KYIV,
      },
    ]);
    expect(recorded.successes).toEqual(['Slot created.']);

    const router = TestBed.inject(Router);
    expect(router.url).toBe('/schedule?from=2026-03-09');
    expect(router.lastSuccessfulNavigation()?.extras.state).toEqual({ savedId: 'created-1' });
  });

  it('sends a note only when one was typed', async () => {
    const recorded = setup();
    const harness = await open('/schedule/new?date=2026-03-09&time=09:00');

    await click(harness, '.slot-form__save');

    // An omitted key means "leave it alone"; sending `{}` would write an empty
    // note onto every slot.
    expect(recorded.created[0]).not.toHaveProperty('note');
  });

  it('creates a weekly series on the days ticked, until the end of the day chosen', async () => {
    const recorded = setup({
      created: [
        slot('occ-1', { startsAt: '2026-03-09T07:00:00.000Z', endsAt: '2026-03-09T08:00:00.000Z' }),
        slot('occ-2', { startsAt: '2026-03-11T07:00:00.000Z', endsAt: '2026-03-11T08:00:00.000Z' }),
        slot('occ-3', { startsAt: '2026-03-16T07:00:00.000Z', endsAt: '2026-03-16T08:00:00.000Z' }),
      ],
    });
    const harness = await open('/schedule/new?date=2026-03-09&time=09:00');

    await tick(harness, '.slot-form__repeats');
    // Monday is ticked by default because the slot starts on one; Wednesday is
    // the added day.
    await tick(harness, '.slot-form__day-3');
    fill(harness, '.slot-form__until', '2026-04-30');
    await click(harness, '.slot-form__save');

    expect(recorded.created[0]?.recurrence).toEqual({
      frequency: 'weekly',
      daysOfWeek: [1, 3],
      // The end of 30 April in Kyiv, which is what makes `until` inclusive of
      // the day the admin picked.
      until: '2026-04-30T20:59:59.000Z',
    });
    expect(recorded.successes).toEqual(['Created 3 slots.']);
    // The week the first occurrence landed in, not the anchor's.
    expect(TestBed.inject(Router).url).toBe('/schedule?from=2026-03-09');
  });

  it('refuses a repeat with no day ticked rather than sending one', async () => {
    setup();
    const harness = await open('/schedule/new?date=2026-03-09&time=09:00');

    await tick(harness, '.slot-form__repeats');
    await tick(harness, '.slot-form__day-1');

    // The group is enabled while it is on screen, so its rule reaches
    // `form.invalid` and Save says why rather than being dead for no reason.
    expect(find(harness, '.slot-form__days-error')).not.toBe('');
    expect(root(harness).querySelector<HTMLButtonElement>('.slot-form__save')?.disabled).toBe(true);
  });

  it('opens a stored slot on its own clock and draws the browser’s reading beside it', async () => {
    setup({ slots: [slot('madrid-1')] });
    const harness = await open('/schedule/madrid-1');

    // 08:00Z is 09:00 in Madrid and 10:00 in Kyiv. Reading the fields in the
    // browser's zone is the silent shift this screen exists to avoid.
    expect(field(harness, '.slot-form__date').value).toBe('2026-03-06');
    expect(field(harness, '.slot-form__start').value).toBe('09:00');
    expect(field(harness, '.slot-form__end').value).toBe('10:00');
    expect(zoneText(harness)).toBe(MADRID);
    expect(find(harness, '.slot-form__interval-own')).toBe('09:00–10:00');
    expect(find(harness, '.slot-form__interval-zone')).toBe(MADRID);
    expect(find(harness, '.slot-form__browser-interval')).toContain('10:00–11:00');
  });

  it('draws no second line when it would say what the first one says', async () => {
    setup({ slots: [slot('kyiv-1', { timeZone: KYIV }), slot('kiev-1', { timeZone: KIEV })] });

    const harness = await open('/schedule/kyiv-1');
    expect(root(harness).querySelector('.slot-form__browser-interval')).toBeNull();

    // Chromium answers `Europe/Kiev` for a machine set to `Europe/Kyiv`, so
    // comparing zone names alone draws the identical line twice for this
    // product's primary audience. The zone assertion is what says the form
    // really repainted onto the second slot — without it this half asserted
    // `kyiv-1` a second time and passed however the rule was written.
    await harness.navigateByUrl('/schedule/kiev-1');
    harness.detectChanges();
    expect(zoneText(harness)).toBe(KIEV);
    expect(find(harness, '.slot-form__interval-own')).toBe('10:00–11:00');
    expect(root(harness).querySelector('.slot-form__browser-interval')).toBeNull();
  });

  it('decides the second line on what it would say, not on the two zone names', async () => {
    // Phoenix and Denver are two unrelated names on one offset in winter and on
    // two in summer, so the pair separates "the names differ" from "the line
    // would differ" without leaning on the Kyiv/Kiev spelling at all.
    setup({
      slots: [
        slot('phoenix-jan', {
          timeZone: PHOENIX,
          startsAt: '2026-01-15T17:00:00Z',
          endsAt: '2026-01-15T18:00:00Z',
        }),
        slot('phoenix-jul', {
          timeZone: PHOENIX,
          startsAt: '2026-07-15T17:00:00Z',
          endsAt: '2026-07-15T18:00:00Z',
        }),
      ],
      viewZone: DENVER,
    });

    const harness = await open('/schedule/phoenix-jan');
    expect(find(harness, '.slot-form__interval-own')).toBe('10:00–11:00');
    expect(root(harness).querySelector('.slot-form__browser-interval')).toBeNull();

    await harness.navigateByUrl('/schedule/phoenix-jul');
    harness.detectChanges();
    expect(find(harness, '.slot-form__interval-own')).toBe('10:00–11:00');
    expect(find(harness, '.slot-form__browser-interval')).toContain('11:00–12:00');
  });

  it('marks a slot that runs past midnight rather than refusing it', async () => {
    setup();
    const harness = await open('/schedule/new?date=2026-03-06&time=23:30');
    fill(harness, '.slot-form__end', '00:30');

    expect(find(harness, '.slot-form__crosses-midnight')).not.toBe('');
    expect(root(harness).querySelector('.slot-form__zero-length')).toBeNull();
  });

  it('refuses a slot that starts and ends at the same time', async () => {
    setup();
    const harness = await open('/schedule/new?date=2026-03-09&time=09:00');
    fill(harness, '.slot-form__end', '09:00');

    expect(find(harness, '.slot-form__zero-length')).not.toBe('');
    expect(root(harness).querySelector<HTMLButtonElement>('.slot-form__save')?.disabled).toBe(true);
  });

  it('offers a stored zone the runtime’s own list does not carry', async () => {
    setup({ slots: [slot('kyiv-1', { timeZone: KYIV })], viewZone: MADRID });
    const harness = await open('/schedule/kyiv-1');

    expect(zoneText(harness)).toBe(KYIV);
    const options = (await openZones(harness)).map((option) => text(option));
    // `SUPPORTED` carries `Europe/Kiev` and not `Europe/Kyiv`; without the extra
    // option the select opens blank and the save below re-zones the slot.
    expect(options).toContain(KYIV);
    expect(options).toContain(KIEV);
  });

  it('selects the list’s own spelling for a zone stored in another case', async () => {
    // ADR-014 stores a zone as the admin spelled it, and `mat-select` compares
    // option values with `===`. `timeZoneOptions` folds `europe/madrid` into the
    // list's `Europe/Madrid` rather than adding a second entry, so without
    // `[compareWith]` the select opens **blank** on a slot that has a zone, and
    // the next pick re-zones a slot nobody touched. Both halves are asserted
    // here: the fold (no duplicate option) and the match (not blank).
    const recorded = setup({ slots: [slot('lower-1', { timeZone: 'europe/madrid' })] });
    const harness = await open('/schedule/lower-1');

    expect(zoneText(harness)).toBe(MADRID);
    expect(await openZones(harness)).toHaveLength(SUPPORTED.length);

    await click(harness, '.slot-form__save');

    // The control still holds the stored spelling, so an untouched save leaves
    // `timeZone` out of the patch entirely.
    expect(recorded.updated).toEqual([{ id: 'lower-1', input: {} }]);
  });

  it('saves an untouched slot without moving it', async () => {
    const recorded = setup({ slots: [slot('kyiv-1', { timeZone: KYIV })], viewZone: MADRID });
    const harness = await open('/schedule/kyiv-1');

    await click(harness, '.slot-form__save');

    // Not "the round trip happened to be exact": the fields are simply left out
    // of the patch when they did not change.
    expect(recorded.updated).toEqual([{ id: 'kyiv-1', input: {} }]);
    expect(recorded.successes).toEqual(['Slot saved.']);
    expect(TestBed.inject(Router).url).toBe('/schedule?from=2026-03-02');
  });

  it('changes one occurrence of a series and offers no repeat controls', async () => {
    const recorded = setup({ slots: [slot('occ-2', { recurrenceId: 'series-1' })] });
    const harness = await open('/schedule/occ-2');

    // `updateScheduleSlotSchema` omits `recurrence` and there is no
    // series-update route, so the controls are absent rather than disabled.
    expect(root(harness).querySelector('.slot-form__repeat')).toBeNull();
    expect(find(harness, '.slot-form__series-note')).toBe(EDITING_ONE_OCCURRENCE);

    fill(harness, '.slot-form__start', '10:00');
    fill(harness, '.slot-form__end', '11:00');
    await click(harness, '.slot-form__save');

    expect(recorded.updated).toEqual([
      {
        id: 'occ-2',
        input: { startsAt: '2026-03-06T09:00:00.000Z', endsAt: '2026-03-06T10:00:00.000Z' },
      },
    ]);
  });

  it('shows no series note on a slot that is not part of one', async () => {
    setup({ slots: [slot('one-off')] });
    const harness = await open('/schedule/one-off');

    expect(root(harness).querySelector('.slot-form__series-note')).toBeNull();
    expect(root(harness).querySelector('.slot-form__repeat')).toBeNull();
  });

  it('binds an overlap refusal to the time fields and links to the slot it names', async () => {
    const recorded = setup({
      createFails: new HttpErrorResponse({
        status: 409,
        error: {
          message:
            'A slot starting at 2026-03-09T07:00:00.000Z overlaps the existing slot `taken-1` for this owner',
        },
      }),
    });
    const harness = await open('/schedule/new?date=2026-03-09&time=09:00');

    await click(harness, '.slot-form__save');

    expect(find(harness, '.slot-form__overlap')).toContain('`taken-1`');
    expect(root(harness).querySelector('.slot-form__conflict-link')?.getAttribute('href')).toBe(
      '/schedule/taken-1',
    );
    // Nothing was added to the view, and the admin is still on their form.
    expect(TestBed.inject(Router).url).toBe('/schedule/new?date=2026-03-09&time=09:00');
    expect(recorded.created).toHaveLength(1);
  });

  it('shows a 409 that names no slot without offering a link', async () => {
    setup({
      createFails: new HttpErrorResponse({
        status: 409,
        error: {
          message:
            'This recurrence overlaps itself at 2026-03-09T07:00:00.000Z — two occurrences would share the same time',
        },
      }),
    });
    const harness = await open('/schedule/new?date=2026-03-09&time=09:00');

    await click(harness, '.slot-form__save');

    expect(find(harness, '.slot-form__overlap')).toContain('overlaps itself');
    expect(root(harness).querySelector('.slot-form__conflict-link')).toBeNull();
  });

  it('offers no link for a 422 that happens to quote something in backticks', async () => {
    setup({
      createFails: new HttpErrorResponse({
        status: 422,
        error: {
          message:
            'A recurrence cannot generate more than 200 slots — bring `until` closer or split the series',
        },
      }),
    });
    const harness = await open('/schedule/new?date=2026-03-09&time=09:00');

    await click(harness, '.slot-form__save');

    // `documentIdSchema` accepts `until` happily, so the status gate is the only
    // thing between that sentence and a link to a slot that does not exist.
    expect(root(harness).querySelector('.slot-form__conflict-link')).toBeNull();
    expect(root(harness).querySelector('.slot-form__overlap')).toBeNull();
  });

  it('clears a bound conflict as soon as the start time is edited', async () => {
    const { harness } = await refusedAsOverlapping();

    fill(harness, '.slot-form__start', '11:00');

    expect(root(harness).querySelector('.slot-form__overlap')).toBeNull();
    expect(root(harness).querySelector('.slot-form__conflict-link')).toBeNull();
    expect(saveDisabled(harness)).toBe(false);
  });

  it('clears a bound conflict when the slot is moved to another date instead', async () => {
    // Moving the slot to a free day is the most natural fix for an overlap, and
    // it is not the field the refusal was bound to: `setErrors` is only replaced
    // when the control's *own* validators re-run, so this left Save dead behind
    // "Give the slot a start time." over a field holding 09:00.
    const { harness, recorded } = await refusedAsOverlapping();

    fill(harness, '.slot-form__date', '2026-03-19');

    expect(root(harness).querySelector('.slot-form__overlap')).toBeNull();
    expect(root(harness).querySelector('.slot-form__start-error')).toBeNull();
    expect(field(harness, '.slot-form__start').value).toBe('09:00');
    expect(saveDisabled(harness)).toBe(false);

    // Enabled and live: the second attempt really is sent.
    await click(harness, '.slot-form__save');
    expect(recorded.created).toHaveLength(2);
    expect(recorded.created[1]?.startsAt).toBe('2026-03-19T07:00:00.000Z');
  });

  it('clears a bound conflict when the end time is edited instead', async () => {
    const { harness } = await refusedAsOverlapping();

    fill(harness, '.slot-form__end', '09:30');

    expect(root(harness).querySelector('.slot-form__overlap')).toBeNull();
    expect(root(harness).querySelector('.slot-form__start-error')).toBeNull();
    expect(saveDisabled(harness)).toBe(false);
  });

  it('clears a bound conflict when the zone is changed instead', async () => {
    // A different zone is a different instant, so it is a fix for an overlap
    // even though neither clock face moved.
    const { harness } = await refusedAsOverlapping();

    await pickZone(harness, MADRID);

    expect(root(harness).querySelector('.slot-form__overlap')).toBeNull();
    expect(root(harness).querySelector('.slot-form__start-error')).toBeNull();
    expect(saveDisabled(harness)).toBe(false);
  });

  it('refuses to edit a booked slot at all', async () => {
    setup({ slots: [slot('taken', { status: 'booked', bookedBy: 'learner' })] });
    const harness = await open('/schedule/taken');

    expect(find(harness, '.slot-form__booked')).toBe(BOOKED_READ_ONLY);
    expect(field(harness, '.slot-form__date').disabled).toBe(true);
    expect(field(harness, '.slot-form__start').disabled).toBe(true);
    expect(root(harness).querySelector('.slot-form__save')).toBeNull();
    // Read-only is not a dead end: the way back is a link, not the browser's
    // Back button.
    expect(root(harness).querySelector('.slot-form__back')).not.toBeNull();
  });

  it('asks before leaving a form with unsaved edits', async () => {
    const recorded = setup({ slots: [slot('one-off')] });
    const harness = await open('/schedule/one-off');
    fill(harness, '.slot-form__start', '11:00');

    await harness.navigateByUrl('/sections');

    expect(recorded.dialogs).toBe(1);
    expect(TestBed.inject(Router).url).toBe('/sections');
  });

  it('asks before abandoning a new slot that was started', async () => {
    // The create route carries the same guard as the edit one, and only its own
    // test says so: an unsaved series is as easy to lose as an unsaved edit.
    const recorded = setup();
    const harness = await open('/schedule/new?date=2026-03-09&time=09:00');
    fill(harness, '.slot-form__start', '11:00');

    await harness.navigateByUrl('/sections');

    expect(recorded.dialogs).toBe(1);
  });

  it('does not ask on the way out of a form that was just saved', async () => {
    const recorded = setup({ slots: [slot('one-off')] });
    const harness = await open('/schedule/one-off');
    fill(harness, '.slot-form__start', '11:00');
    fill(harness, '.slot-form__end', '12:00');

    await click(harness, '.slot-form__save');

    expect(recorded.updated).toHaveLength(1);
    expect(recorded.dialogs).toBe(0);
    expect(TestBed.inject(Router).url).toBe('/schedule?from=2026-03-02');
  });

  it('sends a cold deep link to a slot that is gone back to the week', async () => {
    setup();
    await open('/schedule/missing');

    expect(TestBed.inject(Router).url).toBe('/schedule?from=2026-03-02');
  });

  it('repaints onto the slot it was sent to rather than keeping the last one’s values', async () => {
    // `/schedule/:id` → `/schedule/:id` reuses the component, and "Open the
    // conflicting slot" is exactly that navigation. Populating once meant the
    // slot arrived at wore the slot left behind, and the next Save wrote those
    // values onto it.
    const recorded = setup({
      slots: [
        slot('a', { note: { en: 'Slot A' } }),
        slot('b', {
          timeZone: NEW_YORK,
          startsAt: '2026-03-09T14:00:00Z',
          endsAt: '2026-03-09T15:30:00Z',
          note: { en: 'Slot B' },
        }),
      ],
    });
    const harness = await open('/schedule/a');
    fill(harness, '.slot-form__start', '14:30');
    fill(harness, '.slot-form__end', '15:30');

    await harness.navigateByUrl('/schedule/b');
    harness.detectChanges();

    expect(field(harness, '.slot-form__date').value).toBe('2026-03-09');
    expect(field(harness, '.slot-form__start').value).toBe('10:00');
    expect(field(harness, '.slot-form__end').value).toBe('11:30');
    expect(zoneText(harness)).toBe(NEW_YORK);

    await click(harness, '.slot-form__save');

    // Nothing was edited on B, so the only thing on the wire is its own note,
    // which `buildSlotPatch` always resends for a slot that has one. Carrying
    // A's form turned B into a 23.5-hour Madrid slot with A's note.
    expect(recorded.updated).toEqual([{ id: 'b', input: { note: { en: 'Slot B' } } }]);
  });

  it('arrives at another slot with no unsaved changes of its own', async () => {
    const recorded = setup({ slots: [slot('a'), slot('b')] });
    const harness = await open('/schedule/a');
    fill(harness, '.slot-form__start', '14:30');

    await harness.navigateByUrl('/schedule/b');
    harness.detectChanges();
    await harness.navigateByUrl('/sections');

    // One dialog for leaving A dirty, and none for leaving B, which was never
    // edited: a form that stayed dirty across the move would prompt about edits
    // belonging to a slot that is no longer on screen.
    expect(recorded.dialogs).toBe(1);
    expect(TestBed.inject(Router).url).toBe('/sections');
  });

  it('locks the controls when the slot it was sent to is booked', async () => {
    setup({ slots: [slot('open-1'), slot('taken', { status: 'booked', bookedBy: 'learner' })] });
    const harness = await open('/schedule/open-1');
    fill(harness, '.slot-form__start', '14:30');

    await harness.navigateByUrl('/schedule/taken');
    harness.detectChanges();

    // The banner rendered from the first pass; the disabling did not, so the
    // read-only screen sat over fully editable controls holding another slot's
    // values.
    expect(find(harness, '.slot-form__booked')).toBe(BOOKED_READ_ONLY);
    expect(field(harness, '.slot-form__date').disabled).toBe(true);
    expect(field(harness, '.slot-form__start').disabled).toBe(true);
    expect(field(harness, '.slot-form__end').disabled).toBe(true);
    expect(root(harness).querySelector('.slot-form__save')).toBeNull();
  });

  it('unlocks them again on the way out of a booked slot', async () => {
    const recorded = setup({
      slots: [slot('taken', { status: 'booked', bookedBy: 'learner' }), slot('open-1')],
    });
    const harness = await open('/schedule/taken');

    await harness.navigateByUrl('/schedule/open-1');
    harness.detectChanges();

    expect(root(harness).querySelector('.slot-form__booked')).toBeNull();
    expect(field(harness, '.slot-form__date').disabled).toBe(false);
    expect(field(harness, '.slot-form__start').disabled).toBe(false);

    fill(harness, '.slot-form__start', '09:30');
    await click(harness, '.slot-form__save');

    expect(recorded.updated).toEqual([
      { id: 'open-1', input: { startsAt: '2026-03-06T08:30:00.000Z' } },
    ]);
  });

  it('closes the repeat group again after unlocking, so a later date leaves Save live', async () => {
    // `form.enable()` reaches its children in declaration order with
    // `onlySelf: true`, so `repeats.valueChanges` fires while `repeat` is still
    // disabled and its subscription no-ops; the loop enables the group a moment
    // later. Only the `syncRepeatGroup` in `populate` re-closes it. Left open,
    // `until` holds the slot's own start date, and moving the slot *later* fails
    // `untilNotBeforeValidator` inside a fieldset the edit route never draws —
    // Save dead with no field on screen to explain it.
    const recorded = setup({
      slots: [
        slot('taken', { status: 'booked', bookedBy: 'learner' }),
        slot('open-1', { startsAt: '2026-03-20T08:00:00Z', endsAt: '2026-03-20T09:00:00Z' }),
      ],
    });
    const harness = await open('/schedule/taken');

    await harness.navigateByUrl('/schedule/open-1');
    harness.detectChanges();

    fill(harness, '.slot-form__date', '2026-03-25');

    expect(root(harness).querySelector('.slot-form__repeat')).toBeNull();
    expect(saveDisabled(harness)).toBe(false);

    await click(harness, '.slot-form__save');

    expect(recorded.updated).toEqual([
      {
        id: 'open-1',
        input: { startsAt: '2026-03-25T08:00:00.000Z', endsAt: '2026-03-25T09:00:00.000Z' },
      },
    ]);
  });

  it('cancels a slot rather than removing it, and lands on the week that holds it', async () => {
    const recorded = setup({ slots: [slot('one-off')] });
    const harness = await open('/schedule/one-off');

    await click(harness, '.slot-form__cancel-slot');

    expect(recorded.dialogData).toEqual([CANCEL_SLOT_DIALOG]);
    // Exactly the status: a patch carrying the times too would move a slot
    // nobody edited.
    expect(recorded.updated).toEqual([{ id: 'one-off', input: { status: 'cancelled' } }]);
    expect(recorded.removed).toEqual([]);
    expect(recorded.successes).toEqual([SLOT_CANCELLED]);
    expect(TestBed.inject(Router).url).toBe('/schedule?from=2026-03-02');
  });

  it('leaves the cancelled slot on the week, drawn as cancelled and in its own column', async () => {
    setup({ slots: [slot('one-off')] });
    const harness = await open('/schedule/one-off');

    await click(harness, '.slot-form__cancel-slot');

    const chip = root(harness).querySelector('[data-slot-id="one-off"]');
    expect(chip?.getAttribute('data-status')).toBe('cancelled');
    expect(chip?.classList.contains('slot--cancelled')).toBe(true);
    // 08:00Z on 6 March is 10:00 in Kyiv, so Friday's column and not Monday's —
    // which is where `buildWeek` puts anything it cannot place.
    expect(chip?.closest('.schedule__day')?.getAttribute('data-date')).toBe('2026-03-06');
  });

  it('does not cancel a slot when the confirmation is declined', async () => {
    const recorded = setup({ slots: [slot('one-off')], confirm: false });
    const harness = await open('/schedule/one-off');

    await click(harness, '.slot-form__cancel-slot');

    expect(recorded.dialogData).toEqual([CANCEL_SLOT_DIALOG]);
    expect(recorded.updated).toEqual([]);
    expect(recorded.successes).toEqual([]);
    expect(TestBed.inject(Router).url).toBe('/schedule/one-off');
  });

  it('still asks about unsaved edits when the slot survives the write', async () => {
    const recorded = setup({ slots: [slot('one-off')] });
    const harness = await open('/schedule/one-off');
    fill(harness, '.slot-form__start', '11:00');

    await click(harness, '.slot-form__cancel-slot');

    // Cancelling decides about the slot, not about the draft: the note and the
    // times typed into the form are still edits to a slot that exists, so they
    // are not thrown away without a word. The guard's dialog is the second
    // entry, after the action's own.
    expect(recorded.dialogData).toEqual([CANCEL_SLOT_DIALOG, UNSAVED_CHANGES_DIALOG]);
    expect(recorded.updated).toEqual([{ id: 'one-off', input: { status: 'cancelled' } }]);
    expect(TestBed.inject(Router).url).toBe('/schedule?from=2026-03-02');
  });

  it('offers Cancel on an open slot and Reopen on a cancelled one, never both', async () => {
    setup({ slots: [slot('open-1'), slot('off-1', { status: 'cancelled' })] });

    const harness = await open('/schedule/open-1');
    expect(root(harness).querySelector('.slot-form__cancel-slot')).not.toBeNull();
    expect(root(harness).querySelector('.slot-form__reopen-slot')).toBeNull();

    await harness.navigateByUrl('/schedule/off-1');
    harness.detectChanges();
    expect(root(harness).querySelector('.slot-form__cancel-slot')).toBeNull();
    expect(root(harness).querySelector('.slot-form__reopen-slot')).not.toBeNull();
  });

  it('reopens a cancelled slot without asking first', async () => {
    const recorded = setup({ slots: [slot('off-1', { status: 'cancelled' })] });
    const harness = await open('/schedule/off-1');

    await click(harness, '.slot-form__reopen-slot');

    // Reopening destroys nothing and cancelling again undoes it, so it is the
    // one action on this row with no confirmation.
    expect(recorded.dialogs).toBe(0);
    expect(recorded.updated).toEqual([{ id: 'off-1', input: { status: 'open' } }]);
    expect(recorded.successes).toEqual([SLOT_REOPENED]);
  });

  it('still asks about unsaved edits when a reopened slot survives the write', async () => {
    const recorded = setup({ slots: [slot('off-1', { status: 'cancelled' })] });
    const harness = await open('/schedule/off-1');
    fill(harness, '.slot-form__start', '11:00');

    await click(harness, '.slot-form__reopen-slot');

    // Reopen has no confirmation of its own, so the guard's dialog is the only
    // one here — and it is the only thing between typing a note into a cancelled
    // slot, pressing Reopen, and losing it without a word.
    expect(recorded.dialogData).toEqual([UNSAVED_CHANGES_DIALOG]);
    expect(recorded.updated).toEqual([{ id: 'off-1', input: { status: 'open' } }]);
    expect(TestBed.inject(Router).url).toBe('/schedule?from=2026-03-02');
  });

  it('offers neither Cancel nor Reopen on a completed slot, but still offers Delete', async () => {
    // A completed slot is a record that an hour happened, so cancelling it
    // retroactively says nothing true. Cleaning one up is still allowed.
    setup({ slots: [slot('done-1', { status: 'completed' })] });
    const harness = await open('/schedule/done-1');

    expect(root(harness).querySelector('.slot-form__cancel-slot')).toBeNull();
    expect(root(harness).querySelector('.slot-form__reopen-slot')).toBeNull();
    expect(root(harness).querySelector('.slot-form__delete')).not.toBeNull();
  });

  it('deletes a slot and comes back to a week that no longer draws it', async () => {
    const recorded = setup({
      slots: [
        slot('one-off'),
        slot('keeper', { startsAt: '2026-03-03T08:00:00Z', endsAt: '2026-03-03T09:00:00Z' }),
        slot('next-week', { startsAt: '2026-03-10T08:00:00Z', endsAt: '2026-03-10T09:00:00Z' }),
      ],
    });
    const harness = await open('/schedule/one-off');

    await click(harness, '.slot-form__delete');

    expect(recorded.dialogData).toEqual([DELETE_SLOT_DIALOG]);
    expect(recorded.removed).toEqual(['one-off']);
    expect(recorded.successes).toEqual([SLOT_DELETED]);
    expect(TestBed.inject(Router).url).toBe('/schedule?from=2026-03-02');
    // The week was really re-read rather than merely failing to draw: its other
    // slot is still there.
    expect(root(harness).querySelector('[data-slot-id="one-off"]')).toBeNull();
    expect(root(harness).querySelector('[data-slot-id="keeper"]')).not.toBeNull();
    // And the week really is one week: a slot outside the requested range is not
    // drawn. `buildWeek` would put it in Monday's column, which is how "the
    // deleted chip is gone" passes for the wrong reason.
    expect(root(harness).querySelector('[data-slot-id="next-week"]')).toBeNull();
  });

  it('deletes without submitting the form it sits inside', async () => {
    const recorded = setup({ slots: [slot('one-off')] });
    const harness = await open('/schedule/one-off');

    await click(harness, '.slot-form__delete');

    // A `<button>` with no `type` submits the form around it, which on this
    // route is a save of the slot being deleted.
    expect(recorded.created).toEqual([]);
    expect(recorded.updated).toEqual([]);
  });

  it('does not delete a slot when the confirmation is declined', async () => {
    const recorded = setup({ slots: [slot('one-off')], confirm: false });
    const harness = await open('/schedule/one-off');

    await click(harness, '.slot-form__delete');

    // The dialog is the only thing standing between a click and an irreversible
    // delete: an answer that is opened and then discarded is a cosmetic
    // confirmation, and it looks identical from every other test.
    expect(recorded.dialogData).toEqual([DELETE_SLOT_DIALOG]);
    expect(recorded.removed).toEqual([]);
    expect(recorded.successes).toEqual([]);
    expect(TestBed.inject(Router).url).toBe('/schedule/one-off');
  });

  it('treats a dismissed confirmation as a no rather than a yes', async () => {
    // Escape and a backdrop click close a Material dialog with `undefined`, so a
    // handler reading anything looser than `=== true` deletes the slot on the
    // way out of a dialog the admin never answered.
    const recorded = setup({ slots: [slot('one-off')], dismissed: true });
    const harness = await open('/schedule/one-off');

    await click(harness, '.slot-form__delete');

    expect(recorded.dialogs).toBe(1);
    expect(recorded.removed).toEqual([]);
    expect(TestBed.inject(Router).url).toBe('/schedule/one-off');
  });

  it('reports no deletion when the slot is already gone', async () => {
    // The realistic single-delete failure: another admin removed it first, so
    // the API answers 404. Staying put is the point — the interceptor has
    // toasted, and navigating to the week would read as a successful delete.
    const recorded = setup({
      slots: [slot('one-off')],
      removeFails: new HttpErrorResponse({ status: 404, statusText: 'Not Found' }),
    });
    const harness = await open('/schedule/one-off');

    await click(harness, '.slot-form__delete');

    expect(recorded.removed).toEqual(['one-off']);
    expect(recorded.successes).toEqual([]);
    expect(TestBed.inject(Router).url).toBe('/schedule/one-off');
    // The form is live again rather than stuck behind the in-flight flag.
    expect(disabled(harness, '.slot-form__delete')).toBe(false);
  });

  it('asks only about the delete when the form was edited, and uses the stored week', async () => {
    const recorded = setup({ slots: [slot('one-off')] });
    const harness = await open('/schedule/one-off');
    fill(harness, '.slot-form__date', '2026-03-19');

    await click(harness, '.slot-form__delete');

    // With `markAsPristine()` after the navigation instead of before it, the
    // unsaved-changes guard prompts about a slot that is already gone — and its
    // dialog would be the second entry here.
    expect(recorded.dialogData).toEqual([DELETE_SLOT_DIALOG]);
    // The week the slot was stored in, not the one the abandoned edit named.
    expect(TestBed.inject(Router).url).toBe('/schedule?from=2026-03-02');
  });

  it('offers "Delete the whole series" only for a slot that belongs to one', async () => {
    setup({ slots: [slot('one-off'), slot('occ-2', { recurrenceId: 'series-1' })] });

    const harness = await open('/schedule/one-off');
    expect(root(harness).querySelector('.slot-form__delete-series')).toBeNull();

    await harness.navigateByUrl('/schedule/occ-2');
    harness.detectChanges();
    expect(root(harness).querySelector('.slot-form__delete-series')).not.toBeNull();
  });

  it('states both halves of the series cutoff before deleting one', async () => {
    const recorded = setup({ slots: [slot('occ-2', { recurrenceId: 'series-1' })] });
    const harness = await open('/schedule/occ-2');

    await click(harness, '.slot-form__delete-series');

    expect(recorded.dialogData).toEqual([DELETE_SERIES_DIALOG]);
    // Both halves, on the constant itself: softened to "future occurrences" this
    // reads as "only what is on screen", which is wrong in both directions.
    expect(DELETE_SERIES_DIALOG.message).toContain('has not started yet');
    expect(DELETE_SERIES_DIALOG.message).toContain('weeks you are not looking at');
    expect(DELETE_SERIES_DIALOG.message).toContain('already started');
  });

  it('does not delete the series when the confirmation is declined', async () => {
    const recorded = setup({
      slots: [slot('occ-2', { recurrenceId: 'series-1' })],
      confirm: false,
    });
    const harness = await open('/schedule/occ-2');

    await click(harness, '.slot-form__delete-series');

    // The widest-reaching action on the screen — it removes occurrences in weeks
    // nobody is looking at — so a confirmation that does not gate it is the
    // worst of the three to get wrong.
    expect(recorded.dialogData).toEqual([DELETE_SERIES_DIALOG]);
    expect(recorded.removedSeries).toEqual([]);
    expect(recorded.successes).toEqual([]);
    expect(TestBed.inject(Router).url).toBe('/schedule/occ-2');
  });

  it('still asks about unsaved edits after a series delete, which may spare this occurrence', async () => {
    const recorded = setup({
      slots: [
        slot('occ-past', {
          recurrenceId: 'series-1',
          startsAt: '2026-03-02T08:00:00Z',
          endsAt: '2026-03-02T09:00:00Z',
        }),
      ],
    });
    const harness = await open('/schedule/occ-past');
    fill(harness, '.slot-form__start', '11:00');

    await click(harness, '.slot-form__delete-series');

    // This occurrence started before "now", so the series delete leaves it —
    // `Removed 0 occurrences.` is `NO_OCCURRENCES_REMOVED` here — and the edits
    // on screen still belong to a slot that exists. Only the single delete can
    // claim the document is gone.
    expect(recorded.successes).toEqual([NO_OCCURRENCES_REMOVED]);
    expect(recorded.dialogData).toEqual([DELETE_SERIES_DIALOG, UNSAVED_CHANGES_DIALOG]);
  });

  it('removes the occurrences that have not started and leaves the earlier ones', async () => {
    // "Now" is Wednesday 4 March, so the week landed on holds one survivor and
    // one casualty — which makes both halves of the cutoff the same assertion.
    const recorded = setup({
      slots: [
        slot('occ-past', {
          recurrenceId: 'series-1',
          startsAt: '2026-03-02T08:00:00Z',
          endsAt: '2026-03-02T09:00:00Z',
        }),
        slot('occ-next', {
          recurrenceId: 'series-1',
          startsAt: '2026-03-05T08:00:00Z',
          endsAt: '2026-03-05T09:00:00Z',
        }),
        slot('occ-later', {
          recurrenceId: 'series-1',
          startsAt: '2026-03-12T08:00:00Z',
          endsAt: '2026-03-12T09:00:00Z',
        }),
      ],
    });
    const harness = await open('/schedule/occ-next');

    await click(harness, '.slot-form__delete-series');

    expect(recorded.removedSeries).toEqual(['series-1']);
    // The API's answer and not the number of occurrences on screen.
    expect(recorded.successes).toEqual(['Removed 2 occurrences.']);
    expect(TestBed.inject(Router).url).toBe('/schedule?from=2026-03-02');
    expect(root(harness).querySelector('[data-slot-id="occ-past"]')).not.toBeNull();
    expect(root(harness).querySelector('[data-slot-id="occ-next"]')).toBeNull();
  });

  it('says "occurrence" when exactly one was removed', async () => {
    const recorded = setup({
      slots: [slot('occ-2', { recurrenceId: 'series-1' })],
      removeSeriesResult: 1,
    });
    const harness = await open('/schedule/occ-2');

    await click(harness, '.slot-form__delete-series');

    expect(recorded.successes).toEqual(['Removed 1 occurrence.']);
  });

  it('says nothing was left to remove rather than "Removed 0 occurrences."', async () => {
    const recorded = setup({
      slots: [slot('occ-2', { recurrenceId: 'series-1' })],
      removeSeriesResult: 0,
    });
    const harness = await open('/schedule/occ-2');

    await click(harness, '.slot-form__delete-series');

    expect(recorded.successes).toEqual([NO_OCCURRENCES_REMOVED]);
    // Still success: the API answers 200 for a series with nothing left in the
    // future, so there is nothing to stay on this form for.
    expect(TestBed.inject(Router).url).toBe('/schedule?from=2026-03-02');
  });

  it('reports no removal when the series delete is refused', async () => {
    // #47 made a malformed `recurrenceId` a 400, and that is reachable from
    // here: `scheduleSlotSchema.recurrenceId` is any non-empty string, while the
    // DELETE route validates it with `documentIdSchema`.
    const recorded = setup({
      slots: [slot('occ-2', { recurrenceId: 'series 1' })],
      removeSeriesFails: new HttpErrorResponse({
        status: 400,
        error: { message: 'recurrenceId: must contain only letters, numbers, hyphens' },
      }),
    });
    const harness = await open('/schedule/occ-2');

    await click(harness, '.slot-form__delete-series');

    expect(recorded.removedSeries).toEqual(['series 1']);
    expect(recorded.successes).toEqual([]);
    // Left where the admin can act; the interceptor has already toasted.
    expect(TestBed.inject(Router).url).toBe('/schedule/occ-2');
  });

  it('offers no destructive action at all on a booked slot', async () => {
    setup({
      slots: [slot('taken', { status: 'booked', bookedBy: 'learner', recurrenceId: 'series-1' })],
    });
    const harness = await open('/schedule/taken');

    // Nothing in `ScheduleSlotsRepository.remove` refuses a booked slot, so this
    // template guard is the whole of the refusal.
    expect(root(harness).querySelector('.slot-form__cancel-slot')).toBeNull();
    expect(root(harness).querySelector('.slot-form__reopen-slot')).toBeNull();
    expect(root(harness).querySelector('.slot-form__delete')).toBeNull();
    expect(root(harness).querySelector('.slot-form__delete-series')).toBeNull();
    expect(find(harness, '.slot-form__booked')).toBe(BOOKED_READ_ONLY);
  });

  it('disables the whole row while a delete is in flight', async () => {
    const deferRemove = new Subject<void>();
    const recorded = setup({
      slots: [slot('occ-2', { recurrenceId: 'series-1' })],
      deferRemove,
    });
    const harness = await open('/schedule/occ-2');

    await click(harness, '.slot-form__delete');

    expect(root(harness).querySelector('mat-progress-bar')).not.toBeNull();
    expect(disabled(harness, '.slot-form__cancel-slot')).toBe(true);
    expect(disabled(harness, '.slot-form__delete')).toBe(true);
    expect(disabled(harness, '.slot-form__delete-series')).toBe(true);
    expect(saveDisabled(harness)).toBe(true);

    // A disabled form control swallows `click()`, so this issues no second
    // delete — which is what the flag is for.
    await click(harness, '.slot-form__delete');
    expect(recorded.removed).toEqual(['occ-2']);

    deferRemove.next();
    deferRemove.complete();
    await settled();
    harness.detectChanges();

    expect(recorded.successes).toEqual([SLOT_DELETED]);
  });

  it('points "Back to the week" at the stored week even after the date is retyped', async () => {
    setup({ slots: [slot('one-off')] });
    const harness = await open('/schedule/one-off');

    fill(harness, '.slot-form__date', '2026-03-19');

    // Anchored on the live interval, this sent an admin who abandoned an edit to
    // a week the slot was never in — and would send a delete there too.
    expect(root(harness).querySelector('.slot-form__back')?.getAttribute('href')).toBe(
      '/schedule?from=2026-03-02',
    );
  });
});
