import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SaveH5pContentInput } from '@speakukrainian/shared';
import { environment } from '../../../environments/environment';
import { H5pApi } from './h5p.api';

/**
 * The one thing on this screen whose correctness is a **URL**, and the one the
 * page spec cannot see: it stubs `H5pApi` wholesale, so the id-or-no-id branch
 * that decides 201-vs-200 — the whole of AC2 against AC3 — would survive any
 * mutation of it. The API answers 404 for `GET /h5p/editor/undefined` and 201
 * for a `POST /h5p/editor` that was meant to update, so both mistakes are
 * silent on this side and loud on the other.
 */
const BODY: SaveH5pContentInput = {
  library: 'H5P.MultiChoice 1.16',
  params: { params: { question: 'Котра година?' }, metadata: { title: 'Telling the time' } },
};

const SAVED = {
  contentId: 'c1',
  title: 'Telling the time',
  mainLibrary: 'H5P.MultiChoice 1.16',
};

describe('H5pApi', () => {
  let api: H5pApi;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [H5pApi, provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(H5pApi);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('asks for the id-less editor model when there is no exercise yet', () => {
    // `GET /api/h5p/editor` is a route of its own — `documentIdSchema.optional()`
    // is what keeps it from being a 400 — and it is what a new exercise boots
    // from.
    api.editorModel().subscribe();

    const request = httpMock.expectOne(`${environment.apiBaseUrl}/h5p/editor`);
    expect(request.request.method).toBe('GET');
    request.flush({ integration: {}, scripts: [], styles: [] });
  });

  it('asks for the editor model of an exercise that exists', () => {
    api.editorModel('c1').subscribe();

    httpMock.expectOne(`${environment.apiBaseUrl}/h5p/editor/c1`).flush({
      integration: {},
      scripts: [],
      styles: [],
    });
  });

  it('reads stored parameters from the params route, not the editor one', () => {
    api.contentParameters('c1').subscribe();

    httpMock
      .expectOne(`${environment.apiBaseUrl}/h5p/params/c1`)
      .flush({ library: 'H5P.MultiChoice 1.16', params: { metadata: {}, params: {} } });
  });

  it('posts a new exercise to the route that lets the library assign the id', () => {
    api.save(undefined, BODY).subscribe();

    const request = httpMock.expectOne(`${environment.apiBaseUrl}/h5p/editor`);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual(BODY);
    request.flush(SAVED, { status: 201, statusText: 'Created' });
  });

  it('posts an existing exercise under its own id, which is what keeps it', () => {
    api.save('c1', BODY).subscribe();

    const request = httpMock.expectOne(`${environment.apiBaseUrl}/h5p/editor/c1`);
    expect(request.request.method).toBe('POST');
    request.flush(SAVED);
  });

  it('answers with the save result the page body records', async () => {
    const result = api.save('c1', BODY);
    const awaited = new Promise((resolve) => result.subscribe(resolve));
    httpMock.expectOne(`${environment.apiBaseUrl}/h5p/editor/c1`).flush(SAVED);

    // `mainLibrary` is an ubername, and it is the value the page form stores as
    // `h5pLibrary`.
    await expect(awaited).resolves.toEqual(SAVED);
  });
});
