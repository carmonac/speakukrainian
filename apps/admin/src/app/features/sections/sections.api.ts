import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  CreateSectionInput,
  MoveSectionInput,
  Section,
  SectionTreeNode,
  UpdateSectionInput,
} from '@speakukrainian/shared';
import { ApiService } from '../../core/http/api.service';

/**
 * HTTP surface for `/api/sections`. Types only — a value import of the shared
 * barrel would pull Zod into the eager bundle, as `auth.service.ts` explains.
 *
 * The tree screen answers from `/sections/tree` whole, so there is no `list()`.
 */
@Injectable({ providedIn: 'root' })
export class SectionsApi {
  private readonly api = inject(ApiService);

  tree(): Observable<SectionTreeNode[]> {
    return this.api.get<SectionTreeNode[]>('/sections/tree');
  }

  get(id: string): Observable<Section> {
    return this.api.get<Section>(`/sections/${id}`);
  }

  create(input: CreateSectionInput): Observable<Section> {
    return this.api.post<Section>('/sections', input);
  }

  update(id: string, input: UpdateSectionInput): Observable<Section> {
    return this.api.patch<Section>(`/sections/${id}`, input);
  }

  /**
   * `sortOrder` is a position among the destination's children, not a number to
   * store: the API renumbers that list contiguously, so a caller says "second"
   * and never has to know what its neighbours hold.
   */
  move(id: string, input: MoveSectionInput): Observable<Section> {
    return this.api.patch<Section>(`/sections/${id}/move`, input);
  }

  remove(id: string): Observable<void> {
    return this.api.delete<void>(`/sections/${id}`);
  }
}
