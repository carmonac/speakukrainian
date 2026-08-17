import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  CreateScheduleSlotInput,
  ListScheduleSlotsQuery,
  ScheduleSlot,
  UpdateScheduleSlotInput,
} from '@speakukrainian/shared';
import { ApiService } from '../../core/http/api.service';

/**
 * HTTP surface for `/api/schedule/slots`. Types only — a value import of the
 * shared barrel would pull Zod into the eager bundle, as `pages.api.ts`
 * explains.
 *
 * `remove` and `removeSeries` are deliberately absent: deleting and cancelling a
 * slot are #56, and an unused method is dead code.
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

  get(id: string): Observable<ScheduleSlot> {
    return this.api.get<ScheduleSlot>(`/schedule/slots/${id}`);
  }

  /**
   * **A list even for a single slot.** That is the create route's shape for both
   * one slot and a whole series (`ScheduleController.create`), and unwrapping it
   * here would make the caller unable to tell how many occurrences it just
   * authored.
   */
  create(input: CreateScheduleSlotInput): Observable<ScheduleSlot[]> {
    return this.api.post<ScheduleSlot[]>('/schedule/slots', input);
  }

  update(id: string, input: UpdateScheduleSlotInput): Observable<ScheduleSlot> {
    return this.api.patch<ScheduleSlot>(`/schedule/slots/${id}`, input);
  }
}
