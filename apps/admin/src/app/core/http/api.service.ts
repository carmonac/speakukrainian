import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import type { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

export type QueryParams = Record<string, string | number | boolean | undefined | null>;

/**
 * Base HTTP client for the admin API. Feature services inject this rather than
 * `HttpClient` directly so the base URL and param handling stay in one place.
 *
 * ```ts
 * @Injectable({ providedIn: 'root' })
 * export class SectionsApi {
 *   private readonly api = inject(ApiService);
 *   list(parentId: string | null) {
 *     return this.api.get<Section[]>('/sections', { parentId });
 *   }
 * }
 * ```
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = environment.apiBaseUrl;

  get<T>(path: string, params?: QueryParams): Observable<T> {
    return this.http.get<T>(this.url(path), { params: toHttpParams(params) });
  }

  post<T>(path: string, body: unknown): Observable<T> {
    return this.http.post<T>(this.url(path), body);
  }

  patch<T>(path: string, body: unknown): Observable<T> {
    return this.http.patch<T>(this.url(path), body);
  }

  put<T>(path: string, body: unknown): Observable<T> {
    return this.http.put<T>(this.url(path), body);
  }

  /**
   * `params` is how a delete addresses a set rather than a document — deleting a
   * whole schedule series is `DELETE /schedule/slots?recurrenceId=`.
   *
   * Passing them is free for the callers that do not: `HttpRequest`'s
   * constructor assigns `urlWithParams = url` unchanged when `params.toString()`
   * is empty, so a path-only delete stays byte-identical to what it sent before
   * this parameter existed. `api.service.spec.ts` pins that with an exact-URL
   * assertion.
   */
  delete<T>(path: string, params?: QueryParams): Observable<T> {
    return this.http.delete<T>(this.url(path), { params: toHttpParams(params) });
  }

  /** Multipart upload used for images, audio and `.h5p` packages. */
  upload<T>(path: string, file: File, fields?: Record<string, string>): Observable<T> {
    const form = new FormData();
    form.append('file', file, file.name);
    for (const [key, value] of Object.entries(fields ?? {})) {
      form.append(key, value);
    }
    return this.http.post<T>(this.url(path), form);
  }

  private url(path: string): string {
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }
}

function toHttpParams(params?: QueryParams): HttpParams {
  let httpParams = new HttpParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null) {
      httpParams = httpParams.set(key, String(value));
    }
  }
  return httpParams;
}
