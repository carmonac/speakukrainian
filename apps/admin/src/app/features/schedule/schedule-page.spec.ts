import { PlatformNavigation } from '@angular/common';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListScheduleSlotsQuery, LocaleCode, ScheduleSlot } from '@speakukrainian/shared';
import { LocalesStore } from '../../core/locales/locales.store';
import { BROWSER_TIME_ZONE } from '../../core/time/browser-time-zone';
import { NO_SLOTS_THIS_WEEK, SLOTS_LOAD_FAILED } from './schedule-messages';
import { ScheduleApi } from './schedule.api';
import { routes } from './schedule.routes';

const MADRID = 'Europe/Madrid';
const KYIV = 'Europe/Kyiv';

/** Any other admin screen, so the schedule can be arrived at from somewhere. */
@Component({ selector: 'app-elsewhere-stub', template: 'elsewhere' })
class Elsewhere {}

/**
 * Wednesday 4 March 2026, so "today's week" is the week of Monday 2 March in
 * both zones these specs use. Fixed rather than real: the redirect for a
 * missing `?from=` is otherwise asserted against whatever day the suite runs
 * on. Only `Date` is faked — the router and the zoneless scheduler need their
 * timers.
 */
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
    startsAt: '2026-03-04T08:00:00Z',
    endsAt: '2026-03-04T09:00:00Z',
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
  /** Answered per requested `from`, for the tests that page between weeks. */
  byWeek?: Record<string, ScheduleSlot[]>;
  viewZone?: string;
  fails?: boolean;
}

interface Recorded {
  queries: ListScheduleSlotsQuery[];
}

function setup(options: Options = {}): Recorded {
  const recorded: Recorded = { queries: [] };

  const api = {
    list: (query: ListScheduleSlotsQuery) => {
      recorded.queries.push(query);
      if (options.fails === true) {
        return throwError(() => new Error('offline'));
      }
      const week = options.byWeek?.[query.from];
      return of<ScheduleSlot[]>(week ?? options.slots ?? []);
    },
  } as unknown as ScheduleApi;

  TestBed.configureTestingModule({
    providers: [
      provideNoopAnimations(),
      // The shipped table, mounted the way `app.routes.ts` mounts it — never a
      // copy of it. A spec that restates `resolve` and `runGuardsAndResolvers`
      // asserts its own literal: every routing expectation below would hold
      // while the real route had lost the line, which is exactly how a week
      // that never re-reads ships green.
      provideRouter(
        [
          { path: 'schedule', loadChildren: () => routes },
          // Somewhere to arrive from, so a canonicalising redirect has a
          // previous entry to leave in the history.
          { path: 'sections', component: Elsewhere },
        ],
        withComponentInputBinding(),
      ),
      { provide: ScheduleApi, useValue: api },
      // Never the machine's own zone: a leaked one fails as a slot in the wrong
      // day column, and only on a machine set to a different zone.
      { provide: BROWSER_TIME_ZONE, useValue: options.viewZone ?? KYIV },
      {
        provide: LocalesStore,
        useValue: {
          codes: signal<LocaleCode[]>(['en', 'uk']).asReadonly(),
          defaultCode: signal<LocaleCode | null>('en').asReadonly(),
        } as unknown as LocalesStore,
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
    throw new Error('Expected the week view to be the activated route');
  }
  return element;
}

function columnKeys(harness: RouterTestingHarness): string[] {
  return Array.from(
    root(harness).querySelectorAll('.schedule__day'),
    (day) => day.getAttribute('data-date') ?? '',
  );
}

/** The slot chips in one day column, addressed by the column's date. */
function chipsOn(harness: RouterTestingHarness, date: string): HTMLElement[] {
  return Array.from(root(harness).querySelectorAll<HTMLElement>(`[data-date="${date}"] .slot`));
}

function chip(harness: RouterTestingHarness, id: string): HTMLElement {
  const found = root(harness).querySelector<HTMLElement>(`[data-slot-id="${id}"]`);
  if (found === null) {
    throw new Error(`No chip for slot "${id}" anywhere in the week`);
  }
  return found;
}

function text(element: Element | null): string {
  return element?.textContent?.trim() ?? '';
}

async function click(harness: RouterTestingHarness, selector: string): Promise<void> {
  const link = root(harness).querySelector<HTMLElement>(selector);
  if (link === null) {
    throw new Error(`No ${selector} to click`);
  }
  link.click();
  await harness.fixture.whenStable();
  harness.detectChanges();
}

describe('SchedulePage', () => {
  beforeEach(() => {
    history.replaceState({}, '');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens the week in the URL on a cold load and asks for exactly that range', async () => {
    const { queries } = setup();
    const harness = await open('/schedule?from=2026-03-02');

    expect(TestBed.inject(Router).url).toBe('/schedule?from=2026-03-02');
    expect(queries).toHaveLength(1);
    // Midnight to midnight in the view zone — the visible week and nothing
    // else. Widening, padding or dropping the range fails here.
    expect(queries[0]).toEqual({
      from: '2026-03-01T22:00:00.000Z',
      to: '2026-03-08T22:00:00.000Z',
    });
    expect(columnKeys(harness)).toEqual([
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
      '2026-03-05',
      '2026-03-06',
      '2026-03-07',
      '2026-03-08',
    ]);
    // Today is Wednesday on the clock the grid is drawn on, and that is the
    // clock the highlight has to be read on too.
    expect(root(harness).querySelector('.is-today')?.getAttribute('data-date')).toBe('2026-03-04');
  });

  it('redirects a missing week to the Monday of today’s week', async () => {
    const { queries } = setup();
    await open('/schedule');

    expect(TestBed.inject(Router).url).toBe('/schedule?from=2026-03-02');
    expect(queries.at(-1)?.from).toBe('2026-03-01T22:00:00.000Z');
  });

  it('snaps a mid-week date back to its own Monday', async () => {
    setup();
    await open('/schedule?from=2026-03-04');

    expect(TestBed.inject(Router).url).toBe('/schedule?from=2026-03-02');
  });

  it('sends a malformed or impossible date to today’s week rather than to the API', async () => {
    const { queries } = setup();
    await open('/schedule?from=nonsense');
    expect(TestBed.inject(Router).url).toBe('/schedule?from=2026-03-02');

    await TestBed.inject(Router).navigateByUrl('/schedule?from=2026-02-31');
    expect(TestBed.inject(Router).url).toBe('/schedule?from=2026-03-02');

    // Every request is a real week: nothing unparseable reached the API, and
    // the redirect settled rather than looping.
    expect(queries.every((query) => query.from === '2026-03-01T22:00:00.000Z')).toBe(true);
  });

  it('canonicalises in place, without leaving the uncanonical URL in the history', async () => {
    setup();
    const nav = TestBed.inject(PlatformNavigation);
    const harness = await RouterTestingHarness.create('/sections');
    const before = nav.entries().length;

    await harness.navigateByUrl('/schedule?from=2026-03-04');

    expect(TestBed.inject(Router).url).toBe('/schedule?from=2026-03-02');
    // Replaced, not pushed. An uncanonical `?from=` is only reachable by hand,
    // so the entry the redirect replaces is the address the admin typed; pushed
    // instead, it would sit behind the corrected week and Back would land on it
    // and be redirected forward again, with no way off the screen.
    expect(nav.entries()).toHaveLength(before);
    expect(nav.currentEntry?.url).toContain('/schedule?from=2026-03-02');
  });

  it('keeps the rest of the query string when it canonicalises the week', async () => {
    setup();
    const router = TestBed.inject(Router);
    await open('/schedule?from=2026-03-04&status=open');

    // `from` is the only param this screen reads today, so the loss would only
    // show once another one exists — and only on the uncanonical path, which
    // no amount of clicking reaches.
    expect(router.parseUrl(router.url).queryParams).toEqual({
      from: '2026-03-02',
      status: 'open',
    });
  });

  it('moves a week forward and back through the URL, re-reading each time', async () => {
    const { queries } = setup({
      byWeek: {
        '2026-03-01T22:00:00.000Z': [slot('this-week')],
        '2026-03-08T22:00:00.000Z': [
          slot('next-week', { startsAt: '2026-03-11T08:00:00Z', endsAt: '2026-03-11T09:00:00Z' }),
        ],
      },
    });
    const harness = await open('/schedule?from=2026-03-02');

    await click(harness, '.schedule__next');

    expect(TestBed.inject(Router).url).toBe('/schedule?from=2026-03-09');
    expect(queries.at(-1)).toEqual({
      from: '2026-03-08T22:00:00.000Z',
      to: '2026-03-15T22:00:00.000Z',
    });
    expect(chip(harness, 'next-week')).toBeTruthy();

    await click(harness, '.schedule__previous');
    expect(TestBed.inject(Router).url).toBe('/schedule?from=2026-03-02');

    await click(harness, '.schedule__next');
    await click(harness, '.schedule__this-week');

    expect(TestBed.inject(Router).url).toBe('/schedule?from=2026-03-02');
    expect(chip(harness, 'this-week')).toBeTruthy();
    expect(queries).toHaveLength(5);
  });

  it('draws a slot in the view zone’s day and labels it in its own', async () => {
    setup({
      slots: [
        slot('madrid-morning', {
          startsAt: '2026-03-06T08:00:00Z',
          endsAt: '2026-03-06T09:00:00Z',
          timeZone: MADRID,
        }),
      ],
    });
    const harness = await open('/schedule?from=2026-03-02');

    expect(chipsOn(harness, '2026-03-06').map((element) => element.dataset['slotId'])).toEqual([
      'madrid-morning',
    ]);

    const element = chip(harness, 'madrid-morning');
    expect(text(element.querySelector('.slot__own-interval'))).toBe('09:00–10:00');
    expect(text(element.querySelector('.slot__own-zone'))).toBe(MADRID);
    // The same hour on the clock the grid is drawn on.
    expect(text(element.querySelector('.slot__view-interval'))).toBe('10:00–11:00');
  });

  it('draws a slot that crosses midnight in the next day’s column, saying which day it began', async () => {
    setup({
      slots: [
        slot('late-friday', {
          startsAt: '2026-03-06T22:30:00Z',
          endsAt: '2026-03-06T23:30:00Z',
          timeZone: MADRID,
        }),
      ],
    });
    const harness = await open('/schedule?from=2026-03-02');

    // 23:30 Friday in Madrid is 00:30 Saturday in Kyiv, so Saturday's column is
    // correct — and the `Fri` prefix is what stops it reading as a bug.
    expect(chipsOn(harness, '2026-03-06')).toEqual([]);
    expect(chipsOn(harness, '2026-03-07').map((element) => element.dataset['slotId'])).toEqual([
      'late-friday',
    ]);

    const element = chip(harness, 'late-friday');
    expect(text(element.querySelector('.slot__own-weekday'))).toBe('Fri');
    expect(text(element.querySelector('.slot__own-interval'))).toBe('23:30–00:30');
    expect(text(element.querySelector('.slot__view-interval'))).toBe('00:30–01:30');
  });

  it('draws one time line for a slot authored in the view zone', async () => {
    setup({
      viewZone: MADRID,
      slots: [
        slot('local', {
          startsAt: '2026-03-06T08:00:00Z',
          endsAt: '2026-03-06T09:00:00Z',
          timeZone: MADRID,
        }),
      ],
    });
    const harness = await open('/schedule?from=2026-03-02');

    const element = chip(harness, 'local');
    expect(text(element.querySelector('.slot__own-interval'))).toBe('09:00–10:00');
    expect(element.querySelector('.slot__view-interval')).toBeNull();
    expect(element.querySelector('.slot__own-weekday')).toBeNull();
  });

  it('keeps a cancelled slot on the grid and makes it look different', async () => {
    setup({
      slots: [
        slot('scrapped', {
          startsAt: '2026-03-04T08:00:00Z',
          endsAt: '2026-03-04T09:00:00Z',
          status: 'cancelled',
        }),
        slot('still-on', { startsAt: '2026-03-04T12:00:00Z', endsAt: '2026-03-04T13:00:00Z' }),
      ],
    });
    const harness = await open('/schedule?from=2026-03-02');

    const cancelled = chip(harness, 'scrapped');
    const open_ = chip(harness, 'still-on');

    // Filtering cancelled slots out is the tempting shortcut, and it hides an
    // hour the admin has already told someone about.
    expect(chipsOn(harness, '2026-03-04')).toHaveLength(2);
    expect(cancelled.dataset['status']).toBe('cancelled');
    expect(cancelled.classList.contains('slot--cancelled')).toBe(true);
    expect(text(cancelled.querySelector('.slot__status'))).toBe('Cancelled');

    expect(open_.dataset['status']).toBe('open');
    expect(open_.classList.contains('slot--cancelled')).toBe(false);
    expect(text(open_.querySelector('.slot__status'))).toBe('Open');
  });

  it('draws a slot that began before the week in the first column, flagged', async () => {
    setup({
      slots: [
        slot('overnight', {
          startsAt: '2026-03-01T21:00:00Z',
          endsAt: '2026-03-02T00:00:00Z',
          timeZone: KYIV,
        }),
      ],
    });
    const harness = await open('/schedule?from=2026-03-02');

    expect(chipsOn(harness, '2026-03-02').map((element) => element.dataset['slotId'])).toEqual([
      'overnight',
    ]);
    expect(text(chip(harness, 'overnight').querySelector('.slot__earlier'))).not.toBe('');
  });

  it('names the zone the grid is drawn on', async () => {
    setup();
    const harness = await open('/schedule?from=2026-03-02');

    expect(text(root(harness).querySelector('.schedule__view-zone'))).toBe(KYIV);
    expect(text(root(harness).querySelector('.schedule__week'))).toBe('Week of 2 Mar 2026');
  });

  it('renders a note as text, never as markup', async () => {
    setup({
      slots: [
        slot('noted', {
          note: { en: '<b>Beginners</b> only', uk: 'Тільки початківці' },
        }),
      ],
    });
    const harness = await open('/schedule?from=2026-03-02');

    const note = chip(harness, 'noted').querySelector('.slot__note');
    expect(text(note)).toBe('<b>Beginners</b> only');
    expect(note?.querySelector('b')).toBeFalsy();
  });

  it('says the week failed to load rather than that it is free', async () => {
    setup({ fails: true });
    const harness = await open('/schedule?from=2026-03-02');

    expect(text(root(harness).querySelector('.schedule__failed'))).toBe(SLOTS_LOAD_FAILED);
    expect(root(harness).querySelector('.schedule__empty')).toBeNull();
  });

  it('says a genuinely empty week is empty, and still draws seven columns', async () => {
    setup({ slots: [] });
    const harness = await open('/schedule?from=2026-03-02');

    expect(text(root(harness).querySelector('.schedule__empty'))).toBe(NO_SLOTS_THIS_WEEK);
    expect(root(harness).querySelector('.schedule__failed')).toBeNull();
    expect(columnKeys(harness)).toHaveLength(7);
  });
});
