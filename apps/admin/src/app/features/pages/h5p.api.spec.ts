import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { H5pContent, SaveH5pContentInput } from '@speakukrainian/shared';
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

const CONTENT: H5pContent = {
  id: 'c1',
  title: 'Telling the time',
  mainLibrary: 'H5P.MultiChoice 1.16',
  pageId: 'page-1',
  storagePath: 'h5p/content/c1',
  sizeBytes: 4096,
  audit: {
    createdAt: '2026-01-01T00:00:00Z',
    createdBy: 'admin',
    updatedAt: '2026-01-01T00:00:00Z',
    updatedBy: 'admin',
  },
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

  it('installs an uploaded package through the package route, not the editor one', () => {
    // `POST /h5p/content` unpacks a `.h5p` and registers its libraries;
    // `POST /h5p/editor` saves parameters the widget produced. Both answer an
    // `H5pSaveResult`, so nothing on this side would notice the mix-up.
    const file = new File(['PK'], 'telling-the-time.h5p');
    api.uploadPackage(file).subscribe();

    const request = httpMock.expectOne(`${environment.apiBaseUrl}/h5p/content`);
    expect(request.request.method).toBe('POST');
    // Multipart under the field name the route's `@UploadedFile()` reads. The
    // entry is a copy, not the same object — `append` with a filename rebuilds
    // it — so it is identified by what the API sees.
    const entry = (request.request.body as FormData).get('file');
    expect(entry).toBeInstanceOf(File);
    expect((entry as File).name).toBe('telling-the-time.h5p');
    request.flush(SAVED, { status: 201, statusText: 'Created' });
  });

  it('reads one index row for the attached exercise’s title', () => {
    api.content('c1').subscribe();

    const request = httpMock.expectOne(`${environment.apiBaseUrl}/h5p/content/c1`);
    expect(request.request.method).toBe('GET');
    request.flush(CONTENT);
  });

  it('attaches an exercise by naming the page in the body', () => {
    // `attachH5pContentSchema` is a `strictObject`, so any other key is a 400.
    api.attach('c1', 'page-1').subscribe();

    const request = httpMock.expectOne(`${environment.apiBaseUrl}/h5p/content/c1/attach`);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ pageId: 'page-1' });
    request.flush(CONTENT);
  });

  it('detaches through its own route, with no page id to get wrong', () => {
    // A detach that posted `{ pageId: null }` to the attach route would be a
    // 400: the schema is non-nullable, deliberately.
    api.detach('c1').subscribe();

    const request = httpMock.expectOne(`${environment.apiBaseUrl}/h5p/content/c1/detach`);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toBeNull();
    request.flush({ ...CONTENT, pageId: null });
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
