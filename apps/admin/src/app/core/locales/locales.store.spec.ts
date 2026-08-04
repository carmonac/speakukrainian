import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PublicLocale } from '@speakukrainian/shared';
import { environment } from '../../../environments/environment';
import { LocalesStore } from './locales.store';

function locale(code: string, overrides: Partial<PublicLocale> = {}): PublicLocale {
  return {
    id: code,
    code,
    name: code.toUpperCase(),
    nativeName: code.toUpperCase(),
    direction: 'ltr',
    isDefault: false,
    enabled: true,
    sortOrder: 0,
    ...overrides,
  };
}

const seeded = [
  locale('en', { isDefault: true, sortOrder: 0 }),
  locale('es', { enabled: false, sortOrder: 1 }),
  locale('uk', { sortOrder: 2 }),
];

describe('LocalesStore', () => {
  let store: LocalesStore;
  let httpMock: HttpTestingController;

  const listUrl = `${environment.apiBaseUrl}/locales`;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    store = TestBed.inject(LocalesStore);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  async function loadSeeded(): Promise<void> {
    const loaded = store.load();
    httpMock.expectOne(listUrl).flush(seeded);
    await loaded;
  }

  /**
   * The store chains its requests through `await`, so the next one is only
   * issued a microtask or two after the previous is flushed.
   */
  async function nextRequest(url: string, method: string): Promise<TestRequest> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const [match] = httpMock.match({ url, method });
      if (match) {
        return match;
      }
      await Promise.resolve();
    }
    throw new Error(`The store never issued ${method} ${url}`);
  }

  it('issues one request for concurrent loads and none once it has settled', async () => {
    const first = store.load();
    const second = store.load();
    httpMock.expectOne(listUrl).flush(seeded);
    await Promise.all([first, second]);

    await store.load();

    httpMock.verify();
    expect(store.locales().map((l) => l.code)).toEqual(['en', 'es', 'uk']);
  });

  it('re-fetches and replaces the list on refresh', async () => {
    await loadSeeded();

    const refreshed = store.refresh();
    httpMock.expectOne(listUrl).flush([locale('pl', { sortOrder: 0 })]);
    await refreshed;

    expect(store.locales().map((l) => l.code)).toEqual(['pl']);
  });

  it('retries after a failed load instead of caching the rejection', async () => {
    const failed = store.load();
    httpMock.expectOne(listUrl).flush('nope', { status: 500, statusText: 'Server Error' });
    await expect(failed).rejects.toBeDefined();

    const retried = store.load();
    httpMock.expectOne(listUrl).flush(seeded);
    await retried;

    expect(store.locales().map((l) => l.code)).toEqual(['en', 'es', 'uk']);
  });

  it('exposes only enabled locales and their codes in list order', async () => {
    await loadSeeded();

    expect(store.enabled().map((l) => l.code)).toEqual(['en', 'uk']);
    expect(store.codes()).toEqual(['en', 'uk']);
  });

  it('reports the flagged default, and null when nothing is loaded', async () => {
    expect(store.defaultCode()).toBeNull();

    await loadSeeded();

    expect(store.defaultCode()).toBe('en');
  });

  it('moves the default through the dedicated route and re-reads the list', async () => {
    await loadSeeded();

    const switching = store.setDefault('uk');
    (await nextRequest(`${listUrl}/uk/default`, 'PUT')).flush(
      locale('uk', { isDefault: true, sortOrder: 2 }),
    );
    (await nextRequest(listUrl, 'GET')).flush([
      locale('en', { sortOrder: 0 }),
      locale('es', { enabled: false, sortOrder: 1 }),
      locale('uk', { isDefault: true, sortOrder: 2 }),
    ]);
    await switching;

    expect(store.defaultCode()).toBe('uk');
  });

  it('patches only the entries whose position changed on reorder', async () => {
    await loadSeeded();

    const reordering = store.reorder(['es', 'en', 'uk']);

    const first = await nextRequest(`${listUrl}/es`, 'PATCH');
    expect(first.request.body).toEqual({ sortOrder: 0 });
    first.flush(locale('es', { enabled: false, sortOrder: 0 }));

    const second = await nextRequest(`${listUrl}/en`, 'PATCH');
    expect(second.request.body).toEqual({ sortOrder: 1 });
    second.flush(locale('en', { isDefault: true, sortOrder: 1 }));

    // `uk` is already at index 2, so it is never written.
    (await nextRequest(listUrl, 'GET')).flush(seeded);
    await reordering;
    expect(httpMock.match({ url: `${listUrl}/uk`, method: 'PATCH' })).toEqual([]);
  });

  it('creates through POST and re-reads the list', async () => {
    await loadSeeded();

    const creating = store.create({
      code: 'pl',
      name: 'Polish',
      nativeName: 'Polski',
      direction: 'ltr',
      enabled: true,
      sortOrder: 3,
    });
    (await nextRequest(listUrl, 'POST')).flush(locale('pl', { name: 'Polish', sortOrder: 3 }));
    (await nextRequest(listUrl, 'GET')).flush([
      ...seeded,
      locale('pl', { name: 'Polish', sortOrder: 3 }),
    ]);
    await creating;

    expect(store.codes()).toEqual(['en', 'uk', 'pl']);
  });

  it('deletes through DELETE and re-reads the list', async () => {
    await loadSeeded();

    const removing = store.remove('es');
    (await nextRequest(`${listUrl}/es`, 'DELETE')).flush(null);
    (await nextRequest(listUrl, 'GET')).flush(seeded.filter((l) => l.code !== 'es'));
    await removing;

    expect(store.locales().map((l) => l.code)).toEqual(['en', 'uk']);
  });
});
