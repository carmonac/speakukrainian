import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  CreateSectionInput,
  Section,
  SectionTreeNode,
  UpdateSectionInput,
} from '@speakukrainian/shared';
import { ApiService } from '../../core/http/api.service';

/**
 * HTTP surface for `/api/sections`. Types only — a value import of the shared
 * barrel would pull Zod into the eager bundle, as `auth.service.ts` explains.
 *
 * The tree screen answers from `/sections/tree` whole, so there is no `list()`;
 * re-parenting and reordering land with the `move` route in a later issue.
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

  remove(id: string): Observable<void> {
    return this.api.delete<void>(`/sections/${id}`);
  }
}
