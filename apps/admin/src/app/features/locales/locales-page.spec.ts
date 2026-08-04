import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { MatDialog } from '@angular/material/dialog';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Locale } from '@speakukrainian/shared';
import { LocalesStore } from '../../core/locales/locales.store';
import { LocalesPage } from './locales-page';

function locale(code: string, overrides: Partial<Locale> = {}): Locale {
  return {
    id: code,
    code,
    name: `${code.toUpperCase()} language`,
    nativeName: `${code}-native`,
    direction: 'ltr',
    isDefault: false,
    enabled: true,
    sortOrder: 0,
    audit: {
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'seed',
      updatedAt: '2026-01-01T00:00:00.000Z',
      updatedBy: 'seed',
    },
    ...overrides,
  };
}

interface StoreSpy {
  locales: WritableSignal<readonly Locale[]>;
  calls: { method: string; args: unknown[] }[];
}

function setup(seeded: Locale[]): StoreSpy {
  const locales = signal<readonly Locale[]>(seeded);
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve();
    };

  const store = {
    locales: locales.asReadonly(),
    setDefault: record('setDefault'),
    update: record('update'),
    reorder: record('reorder'),
    remove: record('remove'),
  } as unknown as LocalesStore;

  TestBed.configureTestingModule({
    providers: [
      provideNoopAnimations(),
      provideRouter([{ path: 'locales', component: LocalesPage }]),
      { provide: LocalesStore, useValue: store },
      {
        provide: MatDialog,
        useValue: { open: () => ({ afterClosed: () => of(true) }) } as unknown as MatDialog,
      },
    ],
  });

  return { locales, calls };
}

function root(harness: RouterTestingHarness): HTMLElement {
  const element = harness.routeNativeElement;
  if (!(element instanceof HTMLElement)) {
    throw new Error('Expected the locales page to be the activated route');
  }
  return element;
}

function rows(harness: RouterTestingHarness): HTMLElement[] {
  return Array.from(root(harness).querySelectorAll<HTMLElement>('tr[mat-row]'));
}

function requireIn<T extends Element>(element: ParentNode, selector: string): T {
  const found = element.querySelector<T>(selector);
  if (!found) {
    throw new Error(`Expected the row to render "${selector}"`);
  }
  return found;
}

const seeded = [
  locale('en', { isDefault: true, sortOrder: 0 }),
  locale('es', { sortOrder: 1 }),
  locale('uk', { sortOrder: 2 }),
];

describe('LocalesPage', () => {
  beforeEach(() => {
    history.replaceState({}, '');
  });

  it('renders one row per locale with its code, name and native name', async () => {
    setup(seeded);
    const harness = await RouterTestingHarness.create('/locales');

    const cells = rows(harness).map((row) =>
      Array.from(row.querySelectorAll('td'))
        .slice(0, 3)
        .map((cell) => cell.textContent?.trim()),
    );

    expect(cells).toEqual([
      ['en', 'EN language', 'en-native'],
      ['es', 'ES language', 'es-native'],
      ['uk', 'UK language', 'uk-native'],
    ]);
  });

  it('offers "Make default" only on the locales that are not already default', async () => {
    const { calls } = setup(seeded);
    const harness = await RouterTestingHarness.create('/locales');

    const [first, second] = rows(harness);
    expect(first?.querySelector('.locales__make-default')).toBeNull();

    requireIn<HTMLButtonElement>(second!, '.locales__make-default').click();
    await harness.fixture.whenStable();

    expect(calls).toEqual([{ method: 'setDefault', args: ['es'] }]);
  });

  it('does not let the default locale be disabled or deleted from the list', async () => {
    setup(seeded);
    const harness = await RouterTestingHarness.create('/locales');

    const [first, second] = rows(harness);
    expect(requireIn(first!, 'mat-slide-toggle button').getAttribute('disabled')).not.toBeNull();
    expect(first?.querySelector('.locales__delete')).toBeNull();
    expect(requireIn(second!, 'mat-slide-toggle button').getAttribute('disabled')).toBeNull();
    expect(second?.querySelector('.locales__delete')).not.toBeNull();
  });

  it('toggles a non-default locale off through the store', async () => {
    const { calls } = setup(seeded);
    const harness = await RouterTestingHarness.create('/locales');

    requireIn<HTMLButtonElement>(rows(harness)[1]!, 'mat-slide-toggle button').click();
    await harness.fixture.whenStable();

    expect(calls).toEqual([{ method: 'update', args: ['es', { enabled: false }] }]);
  });

  it('moves a row up by reordering the codes around it', async () => {
    const { calls } = setup(seeded);
    const harness = await RouterTestingHarness.create('/locales');

    requireIn<HTMLButtonElement>(rows(harness)[1]!, '.locales__move-up').click();
    await harness.fixture.whenStable();

    expect(calls).toEqual([{ method: 'reorder', args: [['es', 'en', 'uk']] }]);
  });

  it('disables the arrows at the ends of the list', async () => {
    setup(seeded);
    const harness = await RouterTestingHarness.create('/locales');

    const listed = rows(harness);
    expect(requireIn(listed[0]!, '.locales__move-up').getAttribute('disabled')).not.toBeNull();
    expect(requireIn(listed[0]!, '.locales__move-down').getAttribute('disabled')).toBeNull();
    expect(requireIn(listed[2]!, '.locales__move-down').getAttribute('disabled')).not.toBeNull();
  });

  it('deletes a locale once the confirmation is accepted', async () => {
    const { calls } = setup(seeded);
    const harness = await RouterTestingHarness.create('/locales');

    requireIn<HTMLButtonElement>(rows(harness)[1]!, '.locales__delete').click();
    await harness.fixture.whenStable();

    expect(calls).toEqual([{ method: 'remove', args: ['es'] }]);
  });

  it('marks the row carried in the navigation state after a save', async () => {
    setup(seeded);
    const harness = await RouterTestingHarness.create();

    await TestBed.inject(Router).navigate(['/locales'], { state: { savedCode: 'uk' } });
    harness.detectChanges();

    expect(rows(harness).map((row) => row.classList.contains('is-saved'))).toEqual([
      false,
      false,
      true,
    ]);
  });

  it('keeps the marked row across a refresh, where only history.state survives', async () => {
    setup(seeded);
    history.replaceState({ savedCode: 'uk' }, '');

    const harness = await RouterTestingHarness.create('/locales');

    expect(rows(harness).map((row) => row.classList.contains('is-saved'))).toEqual([
      false,
      false,
      true,
    ]);
  });
});
