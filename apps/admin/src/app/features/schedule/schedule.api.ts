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

  /** 204, and nothing to read back. */
  remove(id: string): Observable<void> {
    return this.api.delete<void>(`/schedule/slots/${id}`);
  }

  /**
   * Removes the occurrences of a series that have not started yet.
   *
   * **The caller does not choose the cutoff and cannot see it.** It is
   * `new Date()` inside `ScheduleService.removeSeries`, and
   * `ScheduleSlotsRepository.removeSeries` keeps everything before it — so this
   * reaches every future occurrence, including ones in weeks nobody is looking
   * at, and leaves the ones that have already started.
   *
   * `{ deleted: 0 }` is a 200 and not a 404: `ScheduleController.removeSeries`
   * answers "DELETE is idempotent, and 'nothing to remove' is success".
   *
   * The shape is written out rather than imported because
   * `ScheduleController.removeSeries` declares it inline too — there is nothing
   * in `packages/shared` to import.
   */
  removeSeries(recurrenceId: string): Observable<{ deleted: number }> {
    return this.api.delete<{ deleted: number }>('/schedule/slots', { recurrenceId });
  }
}
