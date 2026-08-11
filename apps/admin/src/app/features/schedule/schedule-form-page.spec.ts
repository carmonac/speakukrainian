import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { MatDialog } from '@angular/material/dialog';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CreateScheduleSlotInput,
  LocaleCode,
  ScheduleSlot,
  UpdateScheduleSlotInput,
} from '@speakukrainian/shared';
import { LocalesStore } from '../../core/locales/locales.store';
import { NotificationService } from '../../core/notifications/notification.service';
import { BROWSER_TIME_ZONE } from '../../core/time/browser-time-zone';
import { SUPPORTED_TIME_ZONES } from '../../core/time/supported-time-zones';
import { BOOKED_READ_ONLY, EDITING_ONE_OCCURRENCE } from './schedule-messages';
import { ScheduleApi } from './schedule.api';
import { routes } from './schedule.routes';

const MADRID = 'Europe/Madrid';
const KYIV = 'Europe/Kyiv';
const KIEV = 'Europe/Kiev';

/**
 * The zone list a runtime hands over, cut to four entries and pinned here.
 * `Intl.supportedValuesOf` answers differently on every runtime — 418 canonical
 * names on this project's Node, a different set in Chromium — so asserting
 * against the real one would assert ICU's version rather than this code. Note
 * that it carries `Europe/Kiev` and **not** `Europe/Kyiv`, exactly as the real
 * list does.
 */
const SUPPORTED = [KIEV, MADRID, 'America/New_York', 'UTC'];

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
  viewZone?: string;
  supported?: string[];
}

interface Recorded {
  created: CreateScheduleSlotInput[];
  updated: { id: string; input: UpdateScheduleSlotInput }[];
  read: string[];
  successes: string[];
  dialogs: number;
}

function setup(options: Options = {}): Recorded {
  const stored = new Map((options.slots ?? []).map((entry) => [entry.id, entry]));
  const recorded: Recorded = { created: [], updated: [], read: [], successes: [], dialogs: 0 };

  const api = {
    list: () => of<ScheduleSlot[]>([]),
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
      return of<ScheduleSlot>({ ...slot(id), ...stored.get(id), ...input });
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
          open: () => {
            recorded.dialogs += 1;
            return { afterClosed: () => of(true) };
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
    // product's primary audience.
    await harness.navigateByUrl('/schedule/kiev-1');
    harness.detectChanges();
    expect(find(harness, '.slot-form__interval-own')).toBe('10:00–11:00');
    expect(root(harness).querySelector('.slot-form__browser-interval')).toBeNull();
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

  it('clears a bound conflict as soon as a field is edited', async () => {
    setup({
      createFails: new HttpErrorResponse({
        status: 409,
        error: { message: 'overlaps the existing slot `taken-1` for this owner' },
      }),
    });
    const harness = await open('/schedule/new?date=2026-03-09&time=09:00');
    await click(harness, '.slot-form__save');

    fill(harness, '.slot-form__start', '11:00');

    expect(root(harness).querySelector('.slot-form__overlap')).toBeNull();
    expect(root(harness).querySelector('.slot-form__conflict-link')).toBeNull();
    expect(root(harness).querySelector<HTMLButtonElement>('.slot-form__save')?.disabled).toBe(
      false,
    );
  });

  it('refuses to edit a booked slot at all', async () => {
    setup({ slots: [slot('taken', { status: 'booked', bookedBy: 'learner' })] });
    const harness = await open('/schedule/taken');

    expect(find(harness, '.slot-form__booked')).toBe(BOOKED_READ_ONLY);
    expect(field(harness, '.slot-form__date').disabled).toBe(true);
    expect(field(harness, '.slot-form__start').disabled).toBe(true);
    expect(root(harness).querySelector('.slot-form__save')).toBeNull();
    expect(root(harness).querySelector('.slot-form__back')).toBeNull();
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
});
