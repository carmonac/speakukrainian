import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { CreateScheduleSlotInput, ScheduleSlot } from '@speakukrainian/shared';
import {
  MAX_SERIES_DELETE_SLOTS,
  type ScheduleDeleteResult,
  type ScheduleListResult,
  type ScheduleSeriesDeleteResult,
  type ScheduleSlotsRepository,
  type ScheduleWriteResult,
  type SlotMeta,
} from './schedule-slots.repository.js';
import { MAX_RECURRENCE_SLOTS, MAX_SLOT_DURATION_HOURS, type SlotDraft } from './schedule.rules.js';
import { ScheduleService } from './schedule.service.js';

const audit = {
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'admin-uid',
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: 'admin-uid',
};

const stored: ScheduleSlot = {
  id: 'slot-id',
  ownerId: 'admin-uid',
  startsAt: '2026-09-07T07:00:00.000Z',
  endsAt: '2026-09-07T08:00:00.000Z',
  timeZone: 'Europe/Madrid',
  status: 'open',
  recurrenceId: null,
  bookedBy: null,
  bookedAt: null,
  audit,
};

const RECURRENCE_ID = 'generated-recurrence-id';

interface RecordedCall {
  method: string;
  args: unknown[];
}

/**
 * The recorder keeps one flat list, so an assertion on `calls[0]` would follow
 * whichever method happened to run first. Selecting by name and demanding
 * exactly one call keeps the assertion pinned to the call it is about.
 */
function onlyCallTo(calls: RecordedCall[], method: string): RecordedCall {
  const matching = calls.filter((call) => call.method === method);
  expect(matching).toHaveLength(1);
  return matching[0]!;
}

interface DoubleResults {
  write?: ScheduleWriteResult;
  remove?: ScheduleDeleteResult;
  list?: ScheduleListResult;
  series?: ScheduleSeriesDeleteResult;
}

function createService(results: DoubleResults = {}): {
  service: ScheduleService;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const record = <T>(method: string, result: T) => {
    return (...args: unknown[]): Promise<T> => {
      calls.push({ method, args });
      return Promise.resolve(result);
    };
  };

  const write: ScheduleWriteResult = results.write ?? { ok: true, slots: [stored] };
  const repository = {
    createMany: record('createMany', write),
    update: record('update', write),
    remove: record('remove', results.remove ?? { ok: true }),
    removeSeries: record('removeSeries', results.series ?? { ok: true, deleted: 3 }),
    list: record('list', results.list ?? { ok: true, slots: [stored] }),
    findByIdOrFail: record('findByIdOrFail', stored),
    newRecurrenceId: (): string => {
      calls.push({ method: 'newRecurrenceId', args: [] });
      return RECURRENCE_ID;
    },
  } as unknown as ScheduleSlotsRepository;

  return { service: new ScheduleService(repository), calls };
}

const singleSlot: CreateScheduleSlotInput = {
  startsAt: '2026-09-07T09:00:00+02:00',
  endsAt: '2026-09-07T10:00:00+02:00',
  timeZone: 'Europe/Madrid',
};

const draftsOf = (call: RecordedCall): SlotDraft[] => call.args[0] as SlotDraft[];
const metaOf = (call: RecordedCall): SlotMeta => call.args[1] as SlotMeta;

describe('ScheduleService create', () => {
  it('passes one normalised draft and no recurrence id for a single slot', async () => {
    const { service, calls } = createService();

    await service.create(singleSlot, 'admin-uid');

    const call = onlyCallTo(calls, 'createMany');
    expect(draftsOf(call)).toEqual([
      { startsAt: '2026-09-07T07:00:00.000Z', endsAt: '2026-09-07T08:00:00.000Z' },
    ]);
    expect(metaOf(call).recurrenceId).toBeNull();
    expect(call.args[2]).toBe('admin-uid');
  });

  it('never lets the request name the owner', async () => {
    const { service, calls } = createService();

    // Zod strips it before the service, but an in-process caller can still
    // hand one over; the actor argument is the only thing that reaches the
    // repository.
    await service.create(
      { ...singleSlot, ownerId: 'someone-else' } as CreateScheduleSlotInput,
      'admin-uid',
    );

    const call = onlyCallTo(calls, 'createMany');
    expect(call.args[2]).toBe('admin-uid');
    expect(metaOf(call)).not.toHaveProperty('ownerId');
  });

  it('gives every occurrence of a recurrence the one generated id', async () => {
    const { service, calls } = createService();

    await service.create(
      {
        ...singleSlot,
        recurrence: { frequency: 'weekly', daysOfWeek: [1, 3], until: '2026-09-17T23:59:59Z' },
      },
      'admin-uid',
    );

    const call = onlyCallTo(calls, 'createMany');
    expect(draftsOf(call)).toHaveLength(4);
    expect(metaOf(call).recurrenceId).toBe(RECURRENCE_ID);
  });

  it('carries a note through and omits the key when there is none', async () => {
    const { service, calls } = createService();

    await service.create({ ...singleSlot, note: 'Bring your workbook' }, 'admin-uid');
    expect(metaOf(onlyCallTo(calls, 'createMany')).note).toBe('Bring your workbook');

    const bare = createService();
    await bare.service.create(singleSlot, 'admin-uid');
    expect(metaOf(onlyCallTo(bare.calls, 'createMany')).note).toBeUndefined();
  });

  it('refuses a self-overlapping recurrence without writing anything', async () => {
    const { service, calls } = createService();

    await expect(
      service.create(
        {
          ...singleSlot,
          recurrence: { frequency: 'weekly', daysOfWeek: [1, 1], until: '2026-09-07T23:59:59Z' },
        },
        'admin-uid',
      ),
    ).rejects.toThrow(ConflictException);

    // The unit-level half of "refused before anything is written".
    expect(calls.filter((call) => call.method === 'createMany')).toHaveLength(0);
  });

  it('says the conflict is with the request itself, not a stored slot', async () => {
    const { service } = createService();

    await expect(
      service.create(
        {
          ...singleSlot,
          recurrence: { frequency: 'weekly', daysOfWeek: [1, 1], until: '2026-09-07T23:59:59Z' },
        },
        'admin-uid',
      ),
    ).rejects.toThrow(/overlaps itself/);
  });

  it('names the cap when a recurrence would generate too many slots', async () => {
    const { service, calls } = createService();

    await expect(
      service.create(
        {
          ...singleSlot,
          recurrence: { frequency: 'weekly', daysOfWeek: [1], until: '2046-09-07T00:00:00Z' },
        },
        'admin-uid',
      ),
    ).rejects.toThrow(new RegExp(String(MAX_RECURRENCE_SLOTS)));
    expect(calls.filter((call) => call.method === 'createMany')).toHaveLength(0);
  });

  it('refuses a recurrence that generates nothing', async () => {
    const { service } = createService();

    await expect(
      service.create(
        {
          ...singleSlot,
          recurrence: { frequency: 'weekly', daysOfWeek: [1], until: '2026-09-01T00:00:00Z' },
        },
        'admin-uid',
      ),
    ).rejects.toThrow(UnprocessableEntityException);
  });
});

describe('ScheduleService failures', () => {
  it('maps an overlap with a stored slot to 409 naming the slot it collided with', async () => {
    const { service } = createService({
      write: {
        ok: false,
        reason: 'overlap',
        startsAt: '2026-09-07T07:00:00.000Z',
        conflictId: 'other-slot',
      },
    });

    const failure = await service.create(singleSlot, 'admin-uid').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ConflictException);
    // Without the id the message says only that *something* is in the way, and
    // the admin has to find it themselves.
    expect((failure as ConflictException).message).toContain('other-slot');
    expect((failure as ConflictException).message).toContain('2026-09-07T07:00:00.000Z');
  });

  it('names the duration cap', async () => {
    const { service } = createService({
      write: { ok: false, reason: 'duration-too-long', limitHours: MAX_SLOT_DURATION_HOURS },
    });

    await expect(service.create(singleSlot, 'admin-uid')).rejects.toThrow(
      new RegExp(String(MAX_SLOT_DURATION_HOURS)),
    );
  });

  it('reports a backwards range as a validation failure pathed to endsAt', async () => {
    const { service } = createService({
      write: {
        ok: false,
        reason: 'invalid',
        issues: [
          {
            code: 'custom',
            path: ['endsAt'],
            message: '`endsAt` must be after `startsAt`',
            input: undefined,
          },
        ],
      },
    });

    const failure = await service.create(singleSlot, 'admin-uid').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UnprocessableEntityException);
    const body = (failure as UnprocessableEntityException).getResponse() as {
      errors: { path: string }[];
    };
    expect(body.errors[0]?.path).toBe('endsAt');
  });

  it('maps a missing slot to 404', async () => {
    const { service } = createService({ remove: { ok: false, reason: 'not-found' } });

    await expect(service.remove('slot-id')).rejects.toThrow(NotFoundException);
  });

  it('describes a series too large to delete as a series, not as a window', async () => {
    const { service } = createService({
      series: { ok: false, reason: 'series-too-large', limit: MAX_SERIES_DELETE_SLOTS },
    });

    const failure = await service.removeSeries('series-id').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UnprocessableEntityException);
    const { message } = failure as UnprocessableEntityException;
    expect(message).toContain('series');
    expect(message).toContain(String(MAX_SERIES_DELETE_SLOTS));
    // Neither a window nor an owner is involved in deleting a series, and an
    // admin told otherwise looks in the wrong place.
    expect(message).not.toMatch(/window|owner/);
  });

  it('asks the caller to narrow a range that holds too many slots', async () => {
    const { service } = createService({ list: { ok: false, overflow: true } });

    await expect(
      service.list({ from: '2026-01-01T00:00:00Z', to: '2026-12-01T00:00:00Z' }),
    ).rejects.toThrow(/narrow the range/);
  });
});

describe('ScheduleService reads and deletes', () => {
  it('returns the slots the repository found', async () => {
    const { service } = createService();

    await expect(
      service.list({ from: '2026-09-01T00:00:00Z', to: '2026-09-30T00:00:00Z' }),
    ).resolves.toEqual([stored]);
  });

  it('unwraps a patch to the single updated slot', async () => {
    const { service, calls } = createService();

    await expect(service.update('slot-id', { status: 'cancelled' }, 'admin-uid')).resolves.toEqual(
      stored,
    );
    expect(onlyCallTo(calls, 'update').args).toEqual([
      'slot-id',
      { status: 'cancelled' },
      'admin-uid',
    ]);
  });

  it('cuts a series off at now, not at a cutoff the caller chose', async () => {
    const { service, calls } = createService();

    await expect(service.removeSeries('series-id')).resolves.toEqual({ deleted: 3 });

    const call = onlyCallTo(calls, 'removeSeries');
    expect(call.args[0]).toBe('series-id');
    const cutoff = Date.parse(call.args[1] as string);
    expect(Math.abs(cutoff - Date.now())).toBeLessThan(5_000);
  });
});
