import 'reflect-metadata';
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { CreateScheduleSlotInput, ScheduleSlot, UserRole } from '@speakukrainian/shared';
import { IS_PUBLIC_KEY } from '../auth/public.decorator.js';
import { ROLES_KEY } from '../auth/roles.decorator.js';
import { ScheduleController } from './schedule.controller.js';
import type { ScheduleService } from './schedule.service.js';

const slot: ScheduleSlot = {
  id: 'slot-id',
  ownerId: 'admin-uid',
  startsAt: '2026-09-07T07:00:00.000Z',
  endsAt: '2026-09-07T08:00:00.000Z',
  timeZone: 'Europe/Madrid',
  status: 'open',
  recurrenceId: null,
  bookedBy: null,
  bookedAt: null,
  audit: {
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'admin-uid',
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'admin-uid',
  },
};

interface ServiceSpy {
  service: ScheduleService;
  calls: { method: string; args: unknown[] }[];
}

function createServiceSpy(): ServiceSpy {
  const calls: { method: string; args: unknown[] }[] = [];
  const record = <T>(method: string, result: T) => {
    return (...args: unknown[]): Promise<T> => {
      calls.push({ method, args });
      return Promise.resolve(result);
    };
  };

  const service = {
    list: record('list', [slot]),
    findById: record('findById', slot),
    create: record('create', [slot]),
    update: record('update', slot),
    remove: record('remove', undefined),
    removeSeries: record('removeSeries', { deleted: 4 }),
  } as unknown as ScheduleService;

  return { service, calls };
}

const caller = { uid: 'admin-uid', email: 'admin@example.com', role: 'admin' as UserRole };

const newSlot: CreateScheduleSlotInput = {
  startsAt: '2026-09-07T09:00:00+02:00',
  endsAt: '2026-09-07T10:00:00+02:00',
  timeZone: 'Europe/Madrid',
};

const range = { from: '2026-09-01T00:00:00Z', to: '2026-09-30T00:00:00Z' };

describe('ScheduleController', () => {
  it('passes the parsed range through and answers with the slots', async () => {
    const { service, calls } = createServiceSpy();

    await expect(new ScheduleController(service).list(range)).resolves.toEqual([slot]);
    expect(calls).toEqual([{ method: 'list', args: [range] }]);
  });

  it('reads one slot by id', async () => {
    const { service, calls } = createServiceSpy();

    await new ScheduleController(service).findOne('slot-id');

    expect(calls).toEqual([{ method: 'findById', args: ['slot-id'] }]);
  });

  it('answers a create with a list, even for one slot', async () => {
    const { service, calls } = createServiceSpy();

    await expect(new ScheduleController(service).create(newSlot, caller)).resolves.toEqual([slot]);
    expect(calls).toEqual([{ method: 'create', args: [newSlot, 'admin-uid'] }]);
  });

  it('passes the caller uid as the actor on update', async () => {
    const { service, calls } = createServiceSpy();

    await new ScheduleController(service).update('slot-id', { status: 'cancelled' }, caller);

    expect(calls).toEqual([
      { method: 'update', args: ['slot-id', { status: 'cancelled' }, 'admin-uid'] },
    ]);
  });

  it('delegates a delete by id', async () => {
    const { service, calls } = createServiceSpy();

    await new ScheduleController(service).remove('slot-id');

    expect(calls).toEqual([{ method: 'remove', args: ['slot-id'] }]);
  });

  it('reports how many occurrences a series delete removed', async () => {
    const { service, calls } = createServiceSpy();

    await expect(new ScheduleController(service).removeSeries('series-id')).resolves.toEqual({
      deleted: 4,
    });
    expect(calls).toEqual([{ method: 'removeSeries', args: ['series-id'] }]);
  });

  it.each([
    ['create', (controller: ScheduleController) => controller.create(newSlot)],
    ['update', (controller: ScheduleController) => controller.update('slot-id', {})],
  ])('rejects %s with no verified caller attached', (_name, invoke) => {
    const { service } = createServiceSpy();

    expect(() => invoke(new ScheduleController(service))).toThrow(UnauthorizedException);
  });
});

describe('ScheduleController route metadata', () => {
  // Rule 8: every mutating route carries a role guard, and `@Public()` is the
  // deliberate opt-out. Asserting the metadata keeps a dropped decorator from
  // silently opening or closing a route — it compiles either way.
  const roles = (handler: object): UserRole[] | undefined =>
    Reflect.getMetadata(ROLES_KEY, handler) as UserRole[] | undefined;
  const isPublic = (handler: object): boolean | undefined =>
    Reflect.getMetadata(IS_PUBLIC_KEY, handler) as boolean | undefined;

  const handlers = {
    list: ScheduleController.prototype.list,
    findOne: ScheduleController.prototype.findOne,
    create: ScheduleController.prototype.create,
    update: ScheduleController.prototype.update,
    remove: ScheduleController.prototype.remove,
    removeSeries: ScheduleController.prototype.removeSeries,
  };

  it.each([
    ['create', handlers.create],
    ['update', handlers.update],
    ['remove', handlers.remove],
    ['removeSeries', handlers.removeSeries],
  ])('restricts %s to admins', (_name, handler) => {
    // A slot is an offer of one person's time; an editor reads the calendar
    // but does not publish time on someone else's behalf.
    expect(roles(handler)).toEqual(['admin']);
  });

  it.each([
    ['list', handlers.list],
    ['findOne', handlers.findOne],
  ])('lets an editor read %s', (_name, handler) => {
    expect(roles(handler)).toEqual(['editor']);
  });

  for (const [name, handler] of Object.entries(handlers)) {
    it(`does not mark ${name} public`, () => {
      // Booking is Phase 2 and gets its own projected read route; nothing here
      // is anonymous.
      expect(isPublic(handler)).toBeUndefined();
    });
  }
});
