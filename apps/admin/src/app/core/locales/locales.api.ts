import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type { CreateLocaleInput, Locale, UpdateLocaleInput } from '@speakukrainian/shared';
import { ApiService } from '../http/api.service';

/**
 * HTTP surface for `/api/locales`. Types only — a value import of the shared
 * barrel would pull Zod into the eager bundle, as `auth.service.ts` explains.
 */
@Injectable({ providedIn: 'root' })
export class LocalesApi {
  private readonly api = inject(ApiService);

  list(): Observable<Locale[]> {
    return this.api.get<Locale[]>('/locales');
  }

  create(input: CreateLocaleInput): Observable<Locale> {
    return this.api.post<Locale>('/locales', input);
  }

  update(code: string, input: UpdateLocaleInput): Observable<Locale> {
    return this.api.patch<Locale>(`/locales/${code}`, input);
  }

  setDefault(code: string): Observable<Locale> {
    return this.api.put<Locale>(`/locales/${code}/default`, {});
  }

  remove(code: string): Observable<void> {
    return this.api.delete<void>(`/locales/${code}`);
  }
}
