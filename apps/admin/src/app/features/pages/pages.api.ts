import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  ContentPage,
  CreateContentPageInput,
  ListPagesQuery,
  Page,
  UpdateContentPageInput,
} from '@speakukrainian/shared';
import { ApiService } from '../../core/http/api.service';

/**
 * The create body as a *request* carries it.
 *
 * `CreateContentPageInput` is the schema's output type, where
 * `status`'s `.default('draft')` has already been applied — so it demands a
 * field a client is entitled to leave out, and which this admin deliberately
 * does leave out so that a save can never publish. Derived from the shared type
 * rather than restated, so it cannot drift from it (rule 1).
 */
export type CreatePageBody = Omit<CreateContentPageInput, 'status'> &
  Partial<Pick<CreateContentPageInput, 'status'>>;

/**
 * HTTP surface for `/api/pages`. Types only — a value import of the shared
 * barrel would pull Zod into the eager bundle, as `auth.service.ts` explains.
 *
 * There is no `remove`: nothing in this feature deletes a page yet, and an
 * unused method is dead code.
 */
@Injectable({ providedIn: 'root' })
export class PagesApi {
  private readonly api = inject(ApiService);

  list(query: ListPagesQuery): Observable<Page<ContentPage>> {
    return this.api.get<Page<ContentPage>>('/pages', {
      sectionId: query.sectionId,
      status: query.status,
      type: query.type,
      limit: query.limit,
      cursor: query.cursor,
    });
  }

  get(id: string): Observable<ContentPage> {
    return this.api.get<ContentPage>(`/pages/${id}`);
  }

  create(input: CreatePageBody): Observable<ContentPage> {
    return this.api.post<ContentPage>('/pages', input);
  }

  update(id: string, input: UpdateContentPageInput): Observable<ContentPage> {
    return this.api.patch<ContentPage>(`/pages/${id}`, input);
  }

  /**
   * Both routes answer with the whole updated page, which is what carries the
   * `publishedAt` the form shows. They are `POST` with an empty body: the
   * status is the route, not a field a client picks.
   */
  publish(id: string): Observable<ContentPage> {
    return this.api.post<ContentPage>(`/pages/${id}/publish`, {});
  }

  unpublish(id: string): Observable<ContentPage> {
    return this.api.post<ContentPage>(`/pages/${id}/unpublish`, {});
  }
}
