import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiService } from './api.service';
import { environment } from '../../../environments/environment';

describe('ApiService', () => {
  let api: ApiService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [ApiService, provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(ApiService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('prefixes the configured API base URL', () => {
    api.get('/sections').subscribe();
    httpMock.expectOne(`${environment.apiBaseUrl}/sections`).flush([]);
  });

  it('tolerates a path given without a leading slash', () => {
    api.get('sections').subscribe();
    httpMock.expectOne(`${environment.apiBaseUrl}/sections`).flush([]);
  });

  it('omits null and undefined query params', () => {
    // A section list filtered by "no parent" must not send `parentId=null`,
    // which the API would read as the literal string.
    api.get('/sections', { parentId: undefined, status: 'draft', page: 2 }).subscribe();

    const req = httpMock.expectOne((r) => r.url === `${environment.apiBaseUrl}/sections`);
    expect(req.request.params.has('parentId')).toBe(false);
    expect(req.request.params.get('status')).toBe('draft');
    expect(req.request.params.get('page')).toBe('2');
    req.flush([]);
  });

  it('carries query params on a delete', () => {
    // Deleting a whole schedule series addresses a set rather than a document:
    // `DELETE /schedule/slots?recurrenceId=`.
    api.delete('/schedule/slots', { recurrenceId: 'abc' }).subscribe();

    const req = httpMock.expectOne((r) => r.url === `${environment.apiBaseUrl}/schedule/slots`);
    expect(req.request.method).toBe('DELETE');
    expect(req.request.params.get('recurrenceId')).toBe('abc');
    req.flush({ deleted: 2 });
  });

  it('sends a delete with no params to the bare path', () => {
    // The regression test for the callers that pass none — `LocalesApi.remove`
    // and `SectionsApi.remove`. `expectOne` matches on `urlWithParams`, so this
    // is what fails if an empty `HttpParams` ever starts appending a `?`.
    api.delete('/locales/en').subscribe();
    httpMock.expectOne(`${environment.apiBaseUrl}/locales/en`).flush(null);
  });

  it('posts a file as multipart form data', () => {
    const file = new File(['abc'], 'clip.mp3', { type: 'audio/mpeg' });
    api.upload('/media/audio', file, { sectionId: 'sec-1' }).subscribe();

    const req = httpMock.expectOne(`${environment.apiBaseUrl}/media/audio`);
    const body = req.request.body as FormData;
    expect(body.get('file')).toBeInstanceOf(File);
    expect(body.get('sectionId')).toBe('sec-1');
    req.flush({});
  });
});
