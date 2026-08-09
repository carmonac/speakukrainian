import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type { ListScheduleSlotsQuery, ScheduleSlot } from '@speakukrainian/shared';
import { ApiService } from '../../core/http/api.service';

/**
 * HTTP surface for `/api/schedule/slots`. Types only — a value import of the
 * shared barrel would pull Zod into the eager bundle, as `pages.api.ts`
 * explains.
 *
 * One method, because this screen only reads: `get`, `create`, `update`,
 * `remove` and `removeSeries` belong to the authoring issue, and an unused
 * method is dead code.
 */
@Injectable({ providedIn: 'root' })
export class ScheduleApi {
  private readonly api = inject(ApiService);

  /**
   * A **bare array**, deliberately, and not `Page<T>`: ADR-014 records why — a
   * calendar cannot render half a week plus a cursor. The API bounds the answer
   * instead, by requiring `from`/`to` and refusing a range that holds too many
   * documents. Do not "fix" this into a page.
   */
  list(query: ListScheduleSlotsQuery): Observable<ScheduleSlot[]> {
    return this.api.get<ScheduleSlot[]>('/schedule/slots', {
      from: query.from,
      to: query.to,
      status: query.status,
    });
  }
}
