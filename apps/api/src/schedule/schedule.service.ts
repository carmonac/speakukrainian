import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  CreateScheduleSlotInput,
  ListScheduleSlotsQuery,
  ScheduleSlot,
  UpdateScheduleSlotInput,
} from '@speakukrainian/shared';
import {
  ScheduleSlotsRepository,
  type ScheduleListResult,
  type ScheduleWriteFailure,
  type ScheduleWriteResult,
} from './schedule-slots.repository.js';
import {
  MAX_RECURRENCE_SLOTS,
  expandRecurrence,
  firstSelfOverlap,
  toInstant,
  type SlotDraft,
} from './schedule.rules.js';

@Injectable()
export class ScheduleService {
  constructor(private readonly repository: ScheduleSlotsRepository) {}

  /**
   * Always answers with a list, even for a single slot: one response shape for
   * one route beats "an object or an array depending on the body".
   *
   * A recurrence is expanded and checked against itself here, before the
   * repository is reached, so a series that contradicts itself costs no read
   * and writes nothing.
   */
  async create(input: CreateScheduleSlotInput, actorId: string): Promise<ScheduleSlot[]> {
    const anchor = {
      startsAt: toInstant(input.startsAt),
      endsAt: toInstant(input.endsAt),
      timeZone: input.timeZone,
    };

    let drafts: SlotDraft[] = [{ startsAt: anchor.startsAt, endsAt: anchor.endsAt }];
    let recurrenceId: string | null = null;

    if (input.recurrence) {
      const expanded = expandRecurrence(anchor, input.recurrence);
      if (!expanded.ok) {
        this.fail(
          expanded.reason === 'cap-exceeded'
            ? { reason: 'cap-exceeded', limit: MAX_RECURRENCE_SLOTS }
            : { reason: 'recurrence-empty' },
        );
      }

      const collision = firstSelfOverlap(expanded.drafts);
      if (collision) {
        this.fail({ reason: 'self-overlap', startsAt: collision[0].startsAt });
      }

      drafts = expanded.drafts;
      // Server-minted, never taken from the client: it is the handle the whole
      // series is deleted by.
      recurrenceId = this.repository.newRecurrenceId();
    }

    return this.unwrap(
      await this.repository.createMany(
        drafts,
        { timeZone: input.timeZone, note: input.note, recurrenceId },
        actorId,
      ),
    );
  }

  async list(query: ListScheduleSlotsQuery): Promise<ScheduleSlot[]> {
    return this.unwrapList(await this.repository.list(query));
  }

  findById(id: string): Promise<ScheduleSlot> {
    return this.repository.findByIdOrFail(id);
  }

  async update(id: string, input: UpdateScheduleSlotInput, actorId: string): Promise<ScheduleSlot> {
    const slots = this.unwrap(await this.repository.update(id, input, actorId));
    return slots[0]!;
  }

  async remove(id: string): Promise<void> {
    const result = await this.repository.remove(id);
    if (!result.ok) {
      this.fail(result);
    }
  }

  /** "Future" is decided here, in one place, so no caller can choose its own cutoff. */
  async removeSeries(recurrenceId: string): Promise<{ deleted: number }> {
    const result = await this.repository.removeSeries(recurrenceId, new Date().toISOString());
    if (!result.ok) {
      this.fail(result);
    }
    return { deleted: result.deleted };
  }

  private unwrap(result: ScheduleWriteResult): ScheduleSlot[] {
    if (!result.ok) {
      this.fail(result);
    }
    return result.slots;
  }

  private unwrapList(result: ScheduleListResult): ScheduleSlot[] {
    if (!result.ok) {
      throw new UnprocessableEntityException(
        'That range holds too many slots to return at once — narrow the range.',
      );
    }
    return result.slots;
  }

  /** The whole error table in one place, so two routes cannot disagree. */
  private fail(failure: ScheduleWriteFailure): never {
    switch (failure.reason) {
      case 'not-found':
        throw new NotFoundException('Schedule slot not found');
      case 'overlap':
        throw new ConflictException(
          `A slot starting at ${failure.startsAt} overlaps an existing slot for this owner`,
        );
      case 'self-overlap':
        // Naming the request rather than a stored slot matters: an admin told
        // "this overlaps an existing slot" would go looking for one that does
        // not exist.
        throw new ConflictException(
          `This recurrence overlaps itself at ${failure.startsAt} — two occurrences would share the same time`,
        );
      case 'duration-too-long':
        throw new UnprocessableEntityException(
          `A slot cannot be longer than ${failure.limitHours} hours`,
        );
      case 'cap-exceeded':
        throw new UnprocessableEntityException(
          `A recurrence cannot generate more than ${failure.limit} slots — bring \`until\` closer or split the series`,
        );
      case 'recurrence-empty':
        throw new UnprocessableEntityException(
          'That recurrence generates no slots — check `until` and `daysOfWeek`',
        );
      case 'window-too-dense':
        throw new UnprocessableEntityException(
          `That window already holds more than ${failure.limit} slots for this owner`,
        );
      case 'series-too-large':
        // Neither a window nor an owner is involved here, so it says neither:
        // an admin told "that window holds too many slots for this owner" goes
        // looking in the wrong place entirely.
        throw new UnprocessableEntityException(
          `That series still has more than ${failure.limit} occurrences to come, which is more than one delete can remove — remove some occurrences individually first`,
        );
      case 'invalid':
        // The `errors` key matches what `ZodValidationPipe` produces, so a
        // client renders both kinds of validation failure the same way.
        throw new UnprocessableEntityException({
          message: 'The schedule slot is not valid',
          errors: failure.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
            code: issue.code,
          })),
        });
    }
  }
}
