import { Component, signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { describe, expect, it } from 'vitest';
import type { Locale } from '@speakukrainian/shared';
import { LocalesStore } from '../../core/locales/locales.store';
import { NotificationService } from '../../core/notifications/notification.service';
import { LocaleFormPage } from './locale-form-page';
import { DEFAULT_LOCALE_TOOLTIP } from './locale-messages';

@Component({ selector: 'app-locales-list-stub', template: 'list' })
class ListStub {}

function locale(code: string, overrides: Partial<Locale> = {}): Locale {
  return {
    id: code,
    code,
    name: 'Ukrainian',
    nativeName: 'Українська',
    direction: 'ltr',
    isDefault: false,
    enabled: true,
    sortOrder: 2,
    audit: {
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'seed',
      updatedAt: '2026-01-01T00:00:00.000Z',
      updatedBy: 'seed',
    },
    ...overrides,
  };
}

interface Harnessed {
  locales: WritableSignal<readonly Locale[]>;
  calls: { method: string; args: unknown[] }[];
  errors: string[];
}

function setup(seeded: Locale[]): Harnessed {
  const locales = signal<readonly Locale[]>(seeded);
  const calls: { method: string; args: unknown[] }[] = [];
  const errors: string[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(seeded[0]);
    };

  const store = {
    locales: locales.asReadonly(),
    create: record('create'),
    update: record('update'),
  } as unknown as LocalesStore;

  TestBed.configureTestingModule({
    providers: [
      provideNoopAnimations(),
      // The route param arrives as the `code` input, exactly as in `app.config.ts`.
      provideRouter(
        [
          { path: 'locales', component: ListStub },
          { path: 'locales/new', component: LocaleFormPage },
          { path: 'locales/:code', component: LocaleFormPage },
        ],
        withComponentInputBinding(),
      ),
      { provide: LocalesStore, useValue: store },
      {
        provide: NotificationService,
        useValue: {
          success: () => {},
          info: () => {},
          error: (message: string) => errors.push(message),
        } as unknown as NotificationService,
      },
    ],
  });

  return { locales, calls, errors };
}

function root(harness: RouterTestingHarness): HTMLElement {
  const element = harness.routeNativeElement;
  if (!(element instanceof HTMLElement)) {
    throw new Error('Expected the locale form to be the activated route');
  }
  return element;
}

function field(harness: RouterTestingHarness, name: string): HTMLInputElement {
  const input = root(harness).querySelector<HTMLInputElement>(`[formControlName="${name}"]`);
  if (!input) {
    throw new Error(`Expected the form to render a "${name}" field`);
  }
  return input;
}

function fill(harness: RouterTestingHarness, values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values)) {
    const input = field(harness, name);
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }
  harness.detectChanges();
}

async function submit(harness: RouterTestingHarness): Promise<void> {
  const form = root(harness).querySelector('form');
  form?.dispatchEvent(new Event('submit'));
  await harness.fixture.whenStable();
  harness.detectChanges();
}

describe('LocaleFormPage', () => {
  const seeded = [locale('uk')];

  it('creates a locale from /locales/new', async () => {
    const { calls } = setup(seeded);
    const harness = await RouterTestingHarness.create('/locales/new');

    expect(field(harness, 'code').disabled).toBe(false);
    fill(harness, { code: 'pl', name: 'Polish', nativeName: 'Polski', sortOrder: '3' });
    await submit(harness);

    expect(calls).toEqual([
      {
        method: 'create',
        args: [
          {
            code: 'pl',
            name: 'Polish',
            nativeName: 'Polski',
            direction: 'ltr',
            enabled: true,
            sortOrder: 3,
          },
        ],
      },
    ]);
    expect(TestBed.inject(Router).url).toBe('/locales');
  });

  it('patches the form from the store and locks the code when editing', async () => {
    const { calls } = setup(seeded);
    const harness = await RouterTestingHarness.create('/locales/uk');

    expect(field(harness, 'code').value).toBe('uk');
    expect(field(harness, 'code').disabled).toBe(true);
    expect(field(harness, 'name').value).toBe('Ukrainian');

    fill(harness, { name: 'Ukrainian (edited)' });
    await submit(harness);

    expect(calls).toEqual([
      {
        method: 'update',
        args: [
          'uk',
          {
            name: 'Ukrainian (edited)',
            nativeName: 'Українська',
            direction: 'ltr',
            enabled: true,
            sortOrder: 2,
          },
        ],
      },
    ]);
  });

  it('does not offer to disable the default locale, and says why', async () => {
    const { calls } = setup([locale('en', { isDefault: true })]);
    const harness = await RouterTestingHarness.create('/locales/en');

    expect(
      root(harness).querySelector<HTMLButtonElement>('mat-slide-toggle button')?.disabled,
    ).toBe(true);
    expect(root(harness).querySelector('.locale-form__note')?.textContent?.trim()).toBe(
      DEFAULT_LOCALE_TOOLTIP,
    );

    await submit(harness);

    // The disabled control still saves the stored value, so nothing else the
    // admin edited on this form is lost to it.
    expect(calls).toEqual([
      {
        method: 'update',
        args: [
          'en',
          {
            name: 'Ukrainian',
            nativeName: 'Українська',
            direction: 'ltr',
            enabled: true,
            sortOrder: 2,
          },
        ],
      },
    ]);
  });

  it('leaves the toggle live for a non-default locale', async () => {
    setup(seeded);
    const harness = await RouterTestingHarness.create('/locales/uk');

    expect(
      root(harness).querySelector<HTMLButtonElement>('mat-slide-toggle button')?.disabled,
    ).toBe(false);
    expect(root(harness).querySelector('.locale-form__note')).toBeNull();
  });

  it('sends a deep link to an unknown code back to the list with an explanation', async () => {
    const { errors } = setup(seeded);

    const harness = await RouterTestingHarness.create('/locales/zz');
    await harness.fixture.whenStable();

    expect(errors).toEqual(['Locale "zz" was not found.']);
    expect(TestBed.inject(Router).url).toBe('/locales');
  });

  it('refuses a code that is not a BCP-47 locale', async () => {
    const { calls } = setup(seeded);
    const harness = await RouterTestingHarness.create('/locales/new');

    // `localeCodeSchema` is the only judge of a valid code; the regex is never
    // restated in a `Validators.pattern` (rule 1).
    fill(harness, { code: 'English', name: 'English', nativeName: 'English' });
    field(harness, 'code').dispatchEvent(new Event('blur'));
    harness.detectChanges();
    await submit(harness);

    expect(root(harness).querySelector('mat-error')?.textContent?.trim()).toBe(
      'Enter a BCP-47 locale code.',
    );
    expect(root(harness).querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(
      true,
    );
    expect(calls).toEqual([]);
  });
});
