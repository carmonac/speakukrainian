import type { INestApplication } from '@nestjs/common';
import type { Firestore } from '@google-cloud/firestore';
import type { Auth } from 'firebase-admin/auth';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COLLECTIONS,
  MAX_SCHEDULE_RANGE_DAYS,
  scheduleSlotSchema,
  type ScheduleSlot,
} from '@speakukrainian/shared';
import { FIRESTORE } from '../src/infra/firestore/firestore.tokens.js';
import { MAX_RECURRENCE_SLOTS } from '../src/schedule/schedule.rules.js';
import { authOf, createTestApp, signInAs, type TestUser } from './emulator.js';

/**
 * Slots have no slug to namespace by and Firestore hands out the ids, so this
 * suite tags every slot it creates through `note` and the purge deletes exactly
 * those. The tag doubles as the filter list assertions use: `GET
 * /api/schedule/slots` is site-wide, so a slot left behind by a killed run
 * would otherwise turn up inside a range another case asserts on.
 */
const PREFIX = 'e2e-schedule';

/** Bounds each purge read the way the repository bounds every other read. */
const PURGE_LIMIT = 1000;

/** Enough pages to clear any run this suite could have left behind, and a bound. */
const MAX_PURGE_PASSES = 20;

/** 20 characters, the shape of a Firestore auto-id, and not one that exists. */
const UNKNOWN_ID = 'zzzz0000zzzz0000zzzz';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

interface ErrorBody {
  statusCode: number;
  message: string;
}

/** What both `ZodValidationPipe` and `ScheduleService.fail` put on the body. */
interface IssueBody {
  message: string;
  errors?: { path: string; message: string }[];
}

/** The local wall clock an instant reads as, for the daylight-saving criterion. */
const localTimeIn = (instant: string, timeZone: string): string =>
  new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(instant));

describe('schedule slots (e2e)', () => {
  let app: INestApplication;
  let auth: Auth;
  let firestore: Firestore;
  let admin: TestUser;
  let otherAdmin: TestUser;
  let editor: TestUser;
  let student: TestUser;

  const server = (): ReturnType<INestApplication['getHttpServer']> => app.getHttpServer();
  const bearer = (user: TestUser): string => `Bearer ${user.idToken}`;

  const post = (body: object, user: () => TestUser = () => admin): request.Test =>
    request(server()).post('/api/schedule/slots').set('Authorization', bearer(user())).send(body);

  /** Every fixture carries the suite's tag unless the case overrides `note`. */
  const create = async (
    label: string,
    body: Record<string, unknown>,
    user: () => TestUser = () => admin,
  ): Promise<ScheduleSlot[]> => {
    const response = await post({ note: `${PREFIX}/${label}`, ...body }, user).expect(201);
    return (response.body as unknown[]).map((slot) => scheduleSlotSchema.parse(slot));
  };

  const createOne = async (
    label: string,
    body: Record<string, unknown>,
    user: () => TestUser = () => admin,
  ): Promise<ScheduleSlot> => {
    const [slot] = await create(label, body, user);
    return slot!;
  };

  const listRange = (from: string, to: string, extra = '', user: () => TestUser = () => admin) =>
    request(server())
      .get(
        `/api/schedule/slots?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${extra}`,
      )
      .set('Authorization', bearer(user()));

  /** The slots of one case, so a neighbouring fixture cannot change the answer. */
  const listLabelled = async (
    label: string,
    from: string,
    to: string,
    extra = '',
  ): Promise<ScheduleSlot[]> => {
    const response = await listRange(from, to, extra).expect(200);
    return (response.body as unknown[])
      .map((slot) => scheduleSlotSchema.parse(slot))
      .filter((slot) => slot.note === `${PREFIX}/${label}`);
  };

  const read = (id: string): request.Test =>
    request(server()).get(`/api/schedule/slots/${id}`).set('Authorization', bearer(admin));

  const patch = (id: string, body: object): request.Test =>
    request(server())
      .patch(`/api/schedule/slots/${id}`)
      .set('Authorization', bearer(admin))
      .send(body);

  const remove = (id: string, user: () => TestUser = () => admin): request.Test =>
    request(server()).delete(`/api/schedule/slots/${id}`).set('Authorization', bearer(user()));

  const removeSeries = (recurrenceId: string, user: () => TestUser = () => admin): request.Test =>
    request(server())
      .delete(`/api/schedule/slots?recurrenceId=${recurrenceId}`)
      .set('Authorization', bearer(user()));

  /**
   * Runs at setup as well as teardown: a run killed before its teardown would
   * otherwise leave slots that the site-wide list query keeps returning.
   *
   * The tag filter is in the *query*, not in memory: a bounded read of the
   * whole collection filtered afterwards silently purges nothing once the
   * collection holds more than a page of other documents, and the suite then
   * fails on fixtures it cannot see. A prefix range over `note` is exact, and
   * needs no composite index — Firestore indexes single fields on its own, and
   * a document with no `note` is simply not in that index.
   *
   * It pages, because one bounded read cannot assume it is the last.
   */
  const purge = async (): Promise<void> => {
    for (let pass = 0; pass < MAX_PURGE_PASSES; pass += 1) {
      const snapshot = await firestore
        .collection(COLLECTIONS.scheduleSlots)
        .where('note', '>=', PREFIX)
        .where('note', '<', `${PREFIX}\uffff`)
        .limit(PURGE_LIMIT)
        .get();
      if (snapshot.empty) {
        return;
      }
      await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
    }
    throw new Error(
      `Purge gave up after ${MAX_PURGE_PASSES} passes — more than ${MAX_PURGE_PASSES * PURGE_LIMIT} slots are tagged "${PREFIX}"`,
    );
  };

  beforeAll(async () => {
    app = await createTestApp();
    auth = authOf(app);
    firestore = app.get<Firestore>(FIRESTORE);
    await purge();
    [admin, otherAdmin, editor, student] = await Promise.all([
      signInAs(auth, 'admin'),
      signInAs(auth, 'admin'),
      signInAs(auth, 'editor'),
      signInAs(auth, 'student'),
    ]);
  });

  // Guarded on what setup actually reached: when `beforeAll` fails, an
  // unguarded teardown throws over the top of it and hides why.
  afterAll(async () => {
    if (app && firestore) {
      await purge();
    }
    const created = [admin, otherAdmin, editor, student].filter((user) => user !== undefined);
    await Promise.all(created.map((user) => auth.deleteUser(user.uid)));
    if (app) {
      await app.close();
    }
  });

  it('stores a single slot owned by the caller, open and outside any series', async () => {
    const slots = await create('single', {
      startsAt: '2026-05-04T09:00:00Z',
      endsAt: '2026-05-04T10:00:00Z',
      timeZone: 'Europe/Madrid',
    });

    expect(slots).toHaveLength(1);
    const slot = slots[0]!;
    expect(slot.ownerId).toBe(admin.uid);
    expect(slot.status).toBe('open');
    expect(slot.recurrenceId).toBeNull();
    expect(slot.bookedBy).toBeNull();
    expect(slot.bookedAt).toBeNull();

    // Read it back rather than trusting the response: the criterion is about
    // what Firestore holds.
    const reread = scheduleSlotSchema.parse((await read(slot.id).expect(200)).body);
    expect(reread.ownerId).toBe(admin.uid);
  });

  it('ignores an ownerId supplied in the request body', async () => {
    const slot = await createOne('owner-spoof', {
      startsAt: '2026-05-05T09:00:00Z',
      endsAt: '2026-05-05T10:00:00Z',
      timeZone: 'Europe/Madrid',
      ownerId: otherAdmin.uid,
    });

    expect(slot.ownerId).toBe(admin.uid);
  });

  it('expands a Monday and Wednesday recurrence into one series', async () => {
    const slots = await create('weekly', {
      startsAt: '2026-09-07T07:00:00Z',
      endsAt: '2026-09-07T08:00:00Z',
      timeZone: 'Europe/Madrid',
      recurrence: { frequency: 'weekly', daysOfWeek: [1, 3], until: '2026-10-18T23:59:59Z' },
    });

    expect(slots).toHaveLength(12);
    const series = new Set(slots.map((slot) => slot.recurrenceId));
    expect(series.size).toBe(1);
    expect([...series][0]).toBeTruthy();

    const listed = await listLabelled('weekly', '2026-09-01T00:00:00Z', '2026-10-31T00:00:00Z');
    expect(listed.map((slot) => slot.id).sort()).toEqual(slots.map((slot) => slot.id).sort());
  });

  it('keeps a 09:00 Madrid recurrence at 09:00 local across the March change', async () => {
    const slots = await create('dst', {
      startsAt: '2026-03-25T08:00:00Z',
      endsAt: '2026-03-25T09:00:00Z',
      timeZone: 'Europe/Madrid',
      recurrence: { frequency: 'weekly', daysOfWeek: [3], until: '2026-04-08T23:59:59Z' },
    });

    // Read back what was stored, not what the response said.
    const stored = await listLabelled('dst', '2026-03-01T00:00:00Z', '2026-04-30T00:00:00Z');
    expect(stored).toHaveLength(3);
    expect(stored.map((slot) => slot.startsAt)).toEqual([
      '2026-03-25T08:00:00.000Z',
      '2026-04-01T07:00:00.000Z',
      '2026-04-08T07:00:00.000Z',
    ]);
    for (const slot of stored) {
      expect(localTimeIn(slot.startsAt, 'Europe/Madrid')).toBe('09:00');
      expect(localTimeIn(slot.endsAt, 'Europe/Madrid')).toBe('10:00');
    }
    expect(slots.map((slot) => slot.startsAt)).toEqual(stored.map((slot) => slot.startsAt));
  });

  it.each([
    ['equal to', '2026-05-06T09:00:00Z'],
    ['before', '2026-05-06T08:00:00Z'],
  ])('refuses a slot whose endsAt is %s its startsAt', async (_name, endsAt) => {
    const response = await post({
      note: `${PREFIX}/backwards`,
      startsAt: '2026-05-06T09:00:00Z',
      endsAt,
      timeZone: 'Europe/Madrid',
    }).expect(422);

    const body = response.body as IssueBody;
    expect(body.errors?.[0]?.path).toBe('endsAt');
  });

  it.each([
    ['a zone that does not exist', 'Mars/Olympus'],
    ['a zone-shaped string', 'Not/AZone'],
    ['a blank zone', ' '],
  ])('refuses %s on a single slot and stores nothing', async (_name, timeZone) => {
    const response = await post({
      note: `${PREFIX}/bad-zone`,
      startsAt: '2026-05-18T09:00:00Z',
      endsAt: '2026-05-18T10:00:00Z',
      timeZone,
    }).expect(400);

    expect((response.body as IssueBody).errors?.[0]?.path).toBe('timeZone');
    expect(await listLabelled('bad-zone', '2026-05-18T00:00:00Z', '2026-05-19T00:00:00Z')).toEqual(
      [],
    );
  });

  it('refuses a recurrence in an unknown zone instead of failing on it', async () => {
    // The expansion hands `timeZone` to `Intl.DateTimeFormat`, which answers an
    // unknown zone with a RangeError — a 500 on a route that validated its body.
    const response = await post({
      note: `${PREFIX}/bad-zone-series`,
      startsAt: '2026-05-19T09:00:00Z',
      endsAt: '2026-05-19T10:00:00Z',
      timeZone: 'Mars/Olympus',
      recurrence: { frequency: 'weekly', daysOfWeek: [2], until: '2026-06-09T23:59:59Z' },
    }).expect(400);

    expect((response.body as IssueBody).errors?.[0]?.path).toBe('timeZone');
    expect(
      await listLabelled('bad-zone-series', '2026-05-19T00:00:00Z', '2026-06-10T00:00:00Z'),
    ).toEqual([]);
  });

  it('refuses to patch a slot into an unknown zone', async () => {
    const slot = await createOne('patch-zone', {
      startsAt: '2026-05-20T09:00:00Z',
      endsAt: '2026-05-20T10:00:00Z',
      timeZone: 'Europe/Madrid',
    });

    const response = await patch(slot.id, { timeZone: 'Not/AZone' }).expect(400);
    expect((response.body as IssueBody).errors?.[0]?.path).toBe('timeZone');

    // The refusal really refused: the stored zone is untouched.
    expect(scheduleSlotSchema.parse((await read(slot.id).expect(200)).body).timeZone).toBe(
      'Europe/Madrid',
    );
  });

  it('refuses to book a slot through the generic patch', async () => {
    // Booking is Phase 2. Accepting it here would store a slot that reads as
    // booked with no learner attached, blocking its window for nobody.
    const slot = await createOne('patch-booked', {
      startsAt: '2026-05-21T09:00:00Z',
      endsAt: '2026-05-21T10:00:00Z',
      timeZone: 'Europe/Madrid',
    });

    const response = await patch(slot.id, { status: 'booked' }).expect(400);
    expect((response.body as IssueBody).errors?.[0]?.path).toBe('status');

    const reread = scheduleSlotSchema.parse((await read(slot.id).expect(200)).body);
    expect(reread.status).toBe('open');
    expect(reread.bookedBy).toBeNull();
  });

  it('refuses a slot overlapping an open slot of the same owner', async () => {
    await createOne('overlap', {
      startsAt: '2026-05-07T09:00:00Z',
      endsAt: '2026-05-07T10:00:00Z',
      timeZone: 'Europe/Madrid',
    });

    await post({
      note: `${PREFIX}/overlap`,
      startsAt: '2026-05-07T09:30:00Z',
      endsAt: '2026-05-07T10:30:00Z',
      timeZone: 'Europe/Madrid',
    }).expect(409);
  });

  it('lets a slot touch the end of another and reuse a cancelled slot`s window', async () => {
    const first = await createOne('boundary', {
      startsAt: '2026-05-08T09:00:00Z',
      endsAt: '2026-05-08T10:00:00Z',
      timeZone: 'Europe/Madrid',
    });

    // Half-open intervals: starting exactly when another ends is not an overlap.
    await create('boundary', {
      startsAt: '2026-05-08T10:00:00Z',
      endsAt: '2026-05-08T11:00:00Z',
      timeZone: 'Europe/Madrid',
    });

    await patch(first.id, { status: 'cancelled' }).expect(200);
    const replacement = await createOne('boundary', {
      startsAt: '2026-05-08T09:00:00Z',
      endsAt: '2026-05-08T10:00:00Z',
      timeZone: 'Europe/Madrid',
    });
    expect(replacement.status).toBe('open');
  });

  it('scopes overlap to one owner', async () => {
    await createOne('two-owners', {
      startsAt: '2026-05-11T09:00:00Z',
      endsAt: '2026-05-11T10:00:00Z',
      timeZone: 'Europe/Madrid',
    });

    // Two teachers may legitimately offer the same hour.
    const other = await createOne(
      'two-owners',
      {
        startsAt: '2026-05-11T09:00:00Z',
        endsAt: '2026-05-11T10:00:00Z',
        timeZone: 'Europe/Madrid',
      },
      () => otherAdmin,
    );
    expect(other.ownerId).toBe(otherAdmin.uid);
  });

  it('writes nothing when one occurrence of a recurrence collides', async () => {
    const existing = await createOne('series-collision', {
      startsAt: '2026-11-24T10:00:00Z',
      endsAt: '2026-11-24T11:00:00Z',
      timeZone: 'Europe/Madrid',
    });

    await post({
      note: `${PREFIX}/series-collision`,
      startsAt: '2026-11-03T10:00:00Z',
      endsAt: '2026-11-03T11:00:00Z',
      timeZone: 'Europe/Madrid',
      recurrence: { frequency: 'weekly', daysOfWeek: [2], until: '2026-11-24T23:59:59Z' },
    }).expect(409);

    // The first three occurrences were fine; none of them may have been written.
    const listed = await listLabelled(
      'series-collision',
      '2026-11-01T00:00:00Z',
      '2026-11-30T00:00:00Z',
    );
    expect(listed.map((slot) => slot.id)).toEqual([existing.id]);
  });

  it('refuses a recurrence that collides with itself and writes nothing', async () => {
    const response = await post({
      note: `${PREFIX}/self-overlap`,
      startsAt: '2026-06-01T09:00:00Z',
      endsAt: '2026-06-01T10:00:00Z',
      timeZone: 'Europe/Madrid',
      recurrence: { frequency: 'weekly', daysOfWeek: [1, 1], until: '2026-06-01T23:59:59Z' },
    }).expect(409);

    expect((response.body as ErrorBody).message).toContain('itself');
    expect(
      await listLabelled('self-overlap', '2026-06-01T00:00:00Z', '2026-06-02T00:00:00Z'),
    ).toEqual([]);
  });

  it('refuses a recurrence past the cap, naming the cap', async () => {
    const response = await post({
      note: `${PREFIX}/cap`,
      startsAt: '2026-06-02T09:00:00Z',
      endsAt: '2026-06-02T10:00:00Z',
      timeZone: 'Europe/Madrid',
      recurrence: { frequency: 'weekly', daysOfWeek: [2, 4], until: '2031-06-02T00:00:00Z' },
    }).expect(422);

    expect((response.body as ErrorBody).message).toContain(String(MAX_RECURRENCE_SLOTS));
    expect(await listLabelled('cap', '2026-06-01T00:00:00Z', '2026-06-30T00:00:00Z')).toEqual([]);
  });

  it.each([
    ['no range at all', ''],
    ['only a `from`', '?from=2026-07-01T00:00:00Z'],
    ['a range longer than the cap', `?from=2026-01-01T00:00:00Z&to=2027-06-01T00:00:00Z`],
    ['a `to` before its `from`', '?from=2026-07-02T00:00:00Z&to=2026-07-01T00:00:00Z'],
  ])('refuses a list with %s', async (_name, query) => {
    await request(server())
      .get(`/api/schedule/slots${query}`)
      .set('Authorization', bearer(admin))
      .expect(400);
  });

  it(`accepts a range of exactly ${MAX_SCHEDULE_RANGE_DAYS} days`, async () => {
    const from = Date.parse('2026-01-01T00:00:00Z');
    await listRange(
      new Date(from).toISOString(),
      new Date(from + MAX_SCHEDULE_RANGE_DAYS * DAY_MS).toISOString(),
    ).expect(200);
  });

  it('returns the slots that intersect the range, not just those starting in it', async () => {
    const inside = await createOne('intersect', {
      startsAt: '2026-07-13T09:00:00Z',
      endsAt: '2026-07-13T10:00:00Z',
      timeZone: 'Europe/Madrid',
    });
    const straddling = await createOne('intersect', {
      startsAt: '2026-07-12T23:00:00Z',
      endsAt: '2026-07-13T01:00:00Z',
      timeZone: 'Europe/Madrid',
    });
    const after = await createOne('intersect', {
      startsAt: '2026-07-15T09:00:00Z',
      endsAt: '2026-07-15T10:00:00Z',
      timeZone: 'Europe/Madrid',
    });

    const listed = await listLabelled('intersect', '2026-07-13T00:00:00Z', '2026-07-14T00:00:00Z');
    const ids = listed.map((slot) => slot.id);

    expect(ids).toContain(inside.id);
    expect(ids).toContain(straddling.id);
    expect(ids).not.toContain(after.id);
  });

  it('leaves out a slot that ends exactly when the range starts', async () => {
    await createOne('touching', {
      startsAt: '2026-07-19T22:00:00Z',
      endsAt: '2026-07-20T00:00:00Z',
      timeZone: 'Europe/Madrid',
    });

    expect(await listLabelled('touching', '2026-07-20T00:00:00Z', '2026-07-21T00:00:00Z')).toEqual(
      [],
    );
  });

  it('filters a range by status', async () => {
    const open = await createOne('status-filter', {
      startsAt: '2026-07-21T09:00:00Z',
      endsAt: '2026-07-21T10:00:00Z',
      timeZone: 'Europe/Madrid',
    });
    const cancelled = await createOne('status-filter', {
      startsAt: '2026-07-21T11:00:00Z',
      endsAt: '2026-07-21T12:00:00Z',
      timeZone: 'Europe/Madrid',
    });
    await patch(cancelled.id, { status: 'cancelled' }).expect(200);

    const listed = await listLabelled(
      'status-filter',
      '2026-07-21T00:00:00Z',
      '2026-07-22T00:00:00Z',
      '&status=cancelled',
    );

    expect(listed.map((slot) => slot.id)).toEqual([cancelled.id]);
    expect(listed.map((slot) => slot.id)).not.toContain(open.id);
  });

  it('finds a slot authored with an offset through a range expressed in UTC', async () => {
    // Firestore compares `startsAt` as a string, so an unnormalised `+02:00`
    // would sort outside this range and vanish from the calendar.
    const slot = await createOne('normalised', {
      startsAt: '2026-07-22T11:00:00+02:00',
      endsAt: '2026-07-22T12:00:00+02:00',
      timeZone: 'Europe/Madrid',
    });

    expect(slot.startsAt).toBe('2026-07-22T09:00:00.000Z');
    const listed = await listLabelled('normalised', '2026-07-22T00:00:00Z', '2026-07-23T00:00:00Z');
    expect(listed.map((slot) => slot.id)).toEqual([slot.id]);
  });

  it('moves a slot only into a free window', async () => {
    const morning = await createOne('patch-move', {
      startsAt: '2026-08-03T09:00:00Z',
      endsAt: '2026-08-03T10:00:00Z',
      timeZone: 'Europe/Madrid',
    });
    const afternoon = await createOne('patch-move', {
      startsAt: '2026-08-03T15:00:00Z',
      endsAt: '2026-08-03T16:00:00Z',
      timeZone: 'Europe/Madrid',
    });

    await patch(afternoon.id, {
      startsAt: '2026-08-03T09:30:00Z',
      endsAt: '2026-08-03T10:30:00Z',
    }).expect(409);

    const moved = scheduleSlotSchema.parse(
      (
        await patch(afternoon.id, {
          startsAt: '2026-08-03T17:00:00Z',
          endsAt: '2026-08-03T18:00:00Z',
        }).expect(200)
      ).body,
    );
    expect(moved.startsAt).toBe('2026-08-03T17:00:00.000Z');

    // The slot it collided with is untouched by the refusal.
    expect(scheduleSlotSchema.parse((await read(morning.id).expect(200)).body).startsAt).toBe(
      '2026-08-03T09:00:00.000Z',
    );
  });

  it('cancels and completes a slot without clobbering the fields the patch omits', async () => {
    const slot = await createOne('patch-status', {
      startsAt: '2026-08-04T09:00:00Z',
      endsAt: '2026-08-04T10:00:00Z',
      timeZone: 'Europe/Kyiv',
    });

    const cancelled = scheduleSlotSchema.parse(
      (await patch(slot.id, { status: 'cancelled' }).expect(200)).body,
    );
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.timeZone).toBe('Europe/Kyiv');
    expect(cancelled.note).toBe(`${PREFIX}/patch-status`);
    expect(cancelled.startsAt).toBe(slot.startsAt);
    expect(cancelled.endsAt).toBe(slot.endsAt);

    const completed = scheduleSlotSchema.parse(
      (await patch(slot.id, { status: 'completed' }).expect(200)).body,
    );
    expect(completed.status).toBe('completed');
  });

  it('refuses a patch that would leave endsAt at or before startsAt', async () => {
    const slot = await createOne('patch-backwards', {
      startsAt: '2026-08-05T09:00:00Z',
      endsAt: '2026-08-05T10:00:00Z',
      timeZone: 'Europe/Madrid',
    });

    const response = await patch(slot.id, { endsAt: '2026-08-05T08:00:00Z' }).expect(422);
    expect((response.body as IssueBody).errors?.[0]?.path).toBe('endsAt');
  });

  it('deletes one slot and answers 404 for an unknown one', async () => {
    const slot = await createOne('delete-one', {
      startsAt: '2026-08-06T09:00:00Z',
      endsAt: '2026-08-06T10:00:00Z',
      timeZone: 'Europe/Madrid',
    });

    await remove(slot.id).expect(204);
    await read(slot.id).expect(404);
    await remove(UNKNOWN_ID).expect(404);
  });

  it('drops the future occurrences of a series and keeps the past ones', async () => {
    // This case has to straddle "now", so its dates are the only ones in the
    // suite built from the clock. The hour is one no other fixture uses, so the
    // owner's other slots cannot collide with it whatever day it lands on.
    const now = Date.now();
    // 25 days rather than a whole number of weeks, so no occurrence lands on
    // today and the past/future split cannot race the server's `now`.
    const anchor = new Date(now - 25 * DAY_MS);
    anchor.setUTCHours(21, 15, 0, 0);
    const weekday = anchor.getUTCDay();

    const slots = await create('series-delete', {
      startsAt: anchor.toISOString(),
      endsAt: new Date(anchor.getTime() + HOUR_MS / 2).toISOString(),
      timeZone: 'Europe/Madrid',
      recurrence: {
        frequency: 'weekly',
        daysOfWeek: [weekday],
        until: new Date(anchor.getTime() + 49 * DAY_MS).toISOString(),
      },
    });

    const recurrenceId = slots[0]!.recurrenceId!;
    const past = slots.filter((slot) => Date.parse(slot.startsAt) < now);
    const future = slots.filter((slot) => Date.parse(slot.startsAt) >= now);
    expect(past.length).toBeGreaterThan(0);
    expect(future.length).toBeGreaterThan(0);

    const response = await removeSeries(recurrenceId).expect(200);
    expect(response.body).toEqual({ deleted: future.length });

    for (const slot of past) {
      await read(slot.id).expect(200);
    }
    for (const slot of future) {
      await read(slot.id).expect(404);
    }
  });

  it('answers a series delete for an unknown series with 200 and nothing removed', async () => {
    const response = await removeSeries(UNKNOWN_ID).expect(200);

    expect(response.body).toEqual({ deleted: 0 });
  });

  it('lets an editor read the calendar but not write to it', async () => {
    const slot = await createOne('roles', {
      startsAt: '2026-08-10T09:00:00Z',
      endsAt: '2026-08-10T10:00:00Z',
      timeZone: 'Europe/Madrid',
    });

    await listRange('2026-08-10T00:00:00Z', '2026-08-11T00:00:00Z', '', () => editor).expect(200);
    await request(server())
      .get(`/api/schedule/slots/${slot.id}`)
      .set('Authorization', bearer(editor))
      .expect(200);

    await post(
      {
        note: `${PREFIX}/roles`,
        startsAt: '2026-08-11T09:00:00Z',
        endsAt: '2026-08-11T10:00:00Z',
        timeZone: 'Europe/Madrid',
      },
      () => editor,
    ).expect(403);
    await request(server())
      .patch(`/api/schedule/slots/${slot.id}`)
      .set('Authorization', bearer(editor))
      .send({ status: 'cancelled' })
      .expect(403);
    await remove(slot.id, () => editor).expect(403);
    await removeSeries(UNKNOWN_ID, () => editor).expect(403);

    // The refusals really refused: the slot is still open.
    expect(scheduleSlotSchema.parse((await read(slot.id).expect(200)).body).status).toBe('open');
  });

  it('refuses a student even on the read routes', async () => {
    await listRange('2026-08-10T00:00:00Z', '2026-08-11T00:00:00Z', '', () => student).expect(403);
  });

  it('refuses an unauthenticated caller', async () => {
    await request(server())
      .get('/api/schedule/slots?from=2026-08-10T00:00:00Z&to=2026-08-11T00:00:00Z')
      .expect(401);
  });
});
