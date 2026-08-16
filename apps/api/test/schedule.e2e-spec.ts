import type { INestApplication } from '@nestjs/common';
import type { Firestore } from '@google-cloud/firestore';
import type { Auth } from 'firebase-admin/auth';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COLLECTIONS,
  MAX_LOCALES,
  MAX_SCHEDULE_RANGE_DAYS,
  MAX_SLOT_NOTE_LENGTH,
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

/**
 * The locale the tag is written under, and the one the purge queries.
 *
 * `note` is a `Record<LocaleCode, string>`, and Firestore indexes a map one key
 * at a time — `note.en` and `note.uk` are separate index entries. A fixture
 * written under any locale but this one would be invisible to the purge, so the
 * write and the query take the constant rather than each spelling it.
 */
const TAG_LOCALE = 'en';

/** The one shape of a fixture tag, so no `post` body can spell it differently. */
const tag = (label: string): Record<string, string> => ({ [TAG_LOCALE]: `${PREFIX}/${label}` });

/** The field path the purge ranges over: the tag locale's entry in the map. */
const TAG_PATH = `note.${TAG_LOCALE}`;

/**
 * Refuses to send a body the purge could not find afterwards.
 *
 * The purge ranges over `note.<TAG_LOCALE>` for values under `PREFIX`, and
 * Firestore indexes a map one key at a time — a fixture tagged under another
 * locale, tagged with some other string, or not tagged at all, survives
 * teardown and sits in a site-wide collection for every later run's range
 * assertions to trip over. That is the leak #14 was filed against. Every
 * successful write goes through `tag()` today; this makes that a property of
 * the suite rather than of each new call site remembering.
 *
 * The trade: a slot with *no* note can no longer be created over HTTP from
 * here, so that round trip is covered at the schema and service level instead
 * (`accepts a slot with no note at all`, `omits the key when there is none`).
 */
const assertTagged = (body: object): void => {
  const note: unknown = (body as { note?: unknown }).note;
  const tagged =
    typeof note === 'object' && note !== null
      ? (note as Record<string, unknown>)[TAG_LOCALE]
      : undefined;
  if (typeof tagged !== 'string' || !tagged.startsWith(PREFIX)) {
    throw new Error(
      `This suite may only post slots carrying ${TAG_PATH} under "${PREFIX}" — use tag(). Got ${JSON.stringify(note)}`,
    );
  }
};

/** Bounds each purge read the way the repository bounds every other read. */
const PURGE_LIMIT = 1000;

/** Enough pages to clear any run this suite could have left behind, and a bound. */
const MAX_PURGE_PASSES = 20;

/** 20 characters, the shape of a Firestore auto-id, and not one that exists. */
const UNKNOWN_ID = 'zzzz0000zzzz0000zzzz';

/** Firestore's reserved id form, which no auto-id can ever be. */
const RESERVED_ID = '__name__';

/**
 * Untagged documents the purge has to see past — more than `PURGE_LIMIT`, so a
 * single bounded read cannot hold both them and the fixture.
 */
const BALLAST_COUNT = 1100;

/** Under Firestore's 500-write limit for one batch. */
const BALLAST_BATCH = 400;

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/**
 * Distinct codes `localeCodeSchema` accepts (`zaa`, `zab`, …), three letters so
 * none of them can collide with `TAG_LOCALE` and overwrite the tag.
 */
const spareLocaleCodes = (count: number): string[] =>
  Array.from(
    { length: count },
    (_unused, index) =>
      `z${LETTERS[Math.floor(index / LETTERS.length)]}${LETTERS[index % LETTERS.length]}`,
  );

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

  const post = (body: object, user: () => TestUser = () => admin): request.Test => {
    assertTagged(body);
    return request(server())
      .post('/api/schedule/slots')
      .set('Authorization', bearer(user()))
      .send(body);
  };

  /** Every fixture carries the suite's tag unless the case overrides `note`. */
  const create = async (
    label: string,
    body: Record<string, unknown>,
    user: () => TestUser = () => admin,
  ): Promise<ScheduleSlot[]> => {
    const response = await post({ note: tag(label), ...body }, user).expect(201);
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
      .filter((slot) => slot.note?.[TAG_LOCALE] === `${PREFIX}/${label}`);
  };

  const read = (id: string): request.Test =>
    request(server()).get(`/api/schedule/slots/${id}`).set('Authorization', bearer(admin));

  /** A patch rewriting `note` rewrites the tag, so it is guarded like a post. */
  const patch = (id: string, body: object): request.Test => {
    if ('note' in body) {
      assertTagged(body);
    }
    return request(server())
      .patch(`/api/schedule/slots/${id}`)
      .set('Authorization', bearer(admin))
      .send(body);
  };

  const remove = (id: string, user: () => TestUser = () => admin): request.Test =>
    request(server()).delete(`/api/schedule/slots/${id}`).set('Authorization', bearer(user()));

  const removeSeries = (recurrenceId: string, user: () => TestUser = () => admin): request.Test =>
    request(server())
      .delete(`/api/schedule/slots?recurrenceId=${recurrenceId}`)
      .set('Authorization', bearer(user()));

  /**
   * Deletes every slot whose tag starts with `prefix` — the whole suite's tag,
   * or one case's sub-namespace under it.
   *
   * The tag filter is in the *query*, not in memory: a bounded read of the
   * whole collection filtered afterwards silently purges nothing once the
   * collection holds more than a page of other documents, and the suite then
   * fails on fixtures it cannot see. A prefix range over `note.en` is exact and
   * needs no composite index — Firestore single-field-indexes each subfield of
   * a map on its own, and a document with no `note`, or a `note` carrying no
   * entry under this locale, is simply not in that index.
   *
   * It pages, because one bounded read cannot assume it is the last.
   */
  const purgeTagged = async (prefix: string): Promise<void> => {
    for (let pass = 0; pass < MAX_PURGE_PASSES; pass += 1) {
      const snapshot = await firestore
        .collection(COLLECTIONS.scheduleSlots)
        .where(TAG_PATH, '>=', prefix)
        .where(TAG_PATH, '<', `${prefix}\uffff`)
        .limit(PURGE_LIMIT)
        .get();
      if (snapshot.empty) {
        return;
      }
      await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
    }
    throw new Error(
      `Purge gave up after ${MAX_PURGE_PASSES} passes — more than ${MAX_PURGE_PASSES * PURGE_LIMIT} slots are tagged "${prefix}"`,
    );
  };

  /**
   * Runs at setup as well as teardown: a run killed before its teardown would
   * otherwise leave slots that the site-wide list query keeps returning.
   */
  const purge = (): Promise<void> => purgeTagged(PREFIX);

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
      note: tag('backwards'),
      startsAt: '2026-05-06T09:00:00Z',
      endsAt,
      timeZone: 'Europe/Madrid',
    }).expect(422);

    const body = response.body as IssueBody;
    expect(body.errors?.[0]?.path).toBe('endsAt');
  });

  it('refuses a note longer than the bound in one locale and stores nothing', async () => {
    // The bound is per locale, so the refusal has to name the locale that broke
    // it — an admin with four tabs open cannot act on `note` alone.
    const response = await post({
      note: { ...tag('long-note'), uk: 'я'.repeat(MAX_SLOT_NOTE_LENGTH + 1) },
      startsAt: '2026-05-25T09:00:00Z',
      endsAt: '2026-05-25T10:00:00Z',
      timeZone: 'Europe/Madrid',
    }).expect(400);

    expect((response.body as IssueBody).errors?.[0]?.path).toBe('note.uk');
    expect(await listLabelled('long-note', '2026-05-25T00:00:00Z', '2026-05-26T00:00:00Z')).toEqual(
      [],
    );
  });

  it('refuses a note carrying more locales than the site can hold', async () => {
    // Every value is one character, so this is refused for the number of
    // translations and nothing else. The per-locale bound on its own leaves the
    // note unbounded — 500 characters under each of a few hundred invented
    // codes, multiplied by a recurrence and again by a range read.
    const note: Record<string, string> = { ...tag('many-locales') };
    for (const code of spareLocaleCodes(MAX_LOCALES)) {
      note[code] = 'x';
    }

    const response = await post({
      note,
      startsAt: '2026-05-26T09:00:00Z',
      endsAt: '2026-05-26T10:00:00Z',
      timeZone: 'Europe/Madrid',
    }).expect(400);

    expect((response.body as IssueBody).errors?.[0]?.path).toBe('note');
    expect(
      await listLabelled('many-locales', '2026-05-26T00:00:00Z', '2026-05-27T00:00:00Z'),
    ).toEqual([]);
  });

  it.each([
    ['a zone that does not exist', 'Mars/Olympus'],
    ['a zone-shaped string', 'Not/AZone'],
    ['a blank zone', ' '],
    // `Intl` resolves these two; the field refuses them because an offset never
    // observes DST, so a series authored in one would drift half the year. The
    // second is spelled with U+2212 MINUS SIGN, which `Intl` reads as a sign
    // just like the ASCII one — it is written as an escape because rendered it
    // is indistinguishable, and it is here because a rule that named the ASCII
    // signs accepted it and stored it.
    ['a fixed offset', '+05:30'],
    ['a fixed offset signed with U+2212', '\u221205:30'],
  ])('refuses %s on a single slot and stores nothing', async (_name, timeZone) => {
    const response = await post({
      note: tag('bad-zone'),
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
      note: tag('bad-zone-series'),
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

  it('refuses to patch a slot into an unknown zone or a fixed offset', async () => {
    const slot = await createOne('patch-zone', {
      startsAt: '2026-05-20T09:00:00Z',
      endsAt: '2026-05-20T10:00:00Z',
      timeZone: 'Europe/Madrid',
    });

    const response = await patch(slot.id, { timeZone: 'Not/AZone' }).expect(400);
    expect((response.body as IssueBody).errors?.[0]?.path).toBe('timeZone');

    const offset = await patch(slot.id, { timeZone: '+05:30' }).expect(400);
    expect((offset.body as IssueBody).errors?.[0]?.path).toBe('timeZone');

    const unicodeOffset = await patch(slot.id, { timeZone: '\u221205:30' }).expect(400);
    expect((unicodeOffset.body as IssueBody).errors?.[0]?.path).toBe('timeZone');

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
      note: tag('overlap'),
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
      note: tag('series-collision'),
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
      note: tag('self-overlap'),
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
      note: tag('cap'),
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
    expect(cancelled.note).toEqual(tag('patch-status'));
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

  it('refuses a reserved Firestore id on a series delete and on a slot read', async () => {
    // The series delete used to answer 200 `{ deleted: 0 }` here, because
    // `recurrenceId` is only ever a `where` value and never reaches
    // `collection.doc()`. The documented idempotence covers a series that
    // exists in shape and has nothing left to remove; a value that is not an id
    // at all is a different case, and no generated series id can begin with
    // `__` — they are Firestore auto-ids.
    await removeSeries(RESERVED_ID).expect(400);

    // The slot id does reach `collection.doc()`, and the two refusals stay
    // distinguishable: 400 is "that is not an id", 404 is "no such slot".
    await read(RESERVED_ID).expect(400);
    await read(UNKNOWN_ID).expect(404);
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
        note: tag('roles'),
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

  it('refuses to write a fixture its own purge could not find', () => {
    // Each of these would leave a slot the teardown range over `note.en` never
    // sees, so it would stay in the site-wide collection and turn up inside a
    // later run's range assertions. Nothing is sent, and that is a property of
    // where the guard runs — before the request object exists — rather than an
    // outcome the collection could be queried for.
    const slotWindow = {
      startsAt: '2026-12-21T09:00:00Z',
      endsAt: '2026-12-21T10:00:00Z',
      timeZone: 'Europe/Madrid',
    };

    // Tagged, but under a locale the purge does not index.
    expect(() => post({ ...slotWindow, note: { uk: `${PREFIX}/untagged` } })).toThrow(TAG_PATH);
    // The tag locale, but outside the prefix range the purge sweeps.
    expect(() => post({ ...slotWindow, note: { [TAG_LOCALE]: 'unprefixed' } })).toThrow(PREFIX);
    // No note at all.
    expect(() => post(slotWindow)).toThrow(TAG_PATH);

    // A patch can untag a slot the same way a post can fail to tag one.
    expect(() => patch(UNKNOWN_ID, { note: { uk: `${PREFIX}/untagged` } })).toThrow(TAG_PATH);
    // But only a patch that touches `note`: every other one is left alone.
    expect(() => patch(UNKNOWN_ID, { status: 'cancelled' })).not.toThrow();
  });

  it('finds and deletes its own fixtures in a collection holding more than one purge page', async () => {
    // The condition the query-side filter was written for. An in-memory filter
    // over one bounded read purges nothing here, and the suite then fails on
    // fixtures it can neither see nor clean up.
    const tagged = await createOne('purge-scale', {
      startsAt: '2026-12-14T09:00:00Z',
      endsAt: '2026-12-14T10:00:00Z',
      timeZone: 'Europe/Madrid',
    });
    await read(tagged.id).expect(200);

    // Written straight to Firestore from the document the route just wrote, so
    // the shape is exactly what the repository reads back; the branch under
    // test is about how many *other* documents the collection holds, and 1100
    // round trips through the route would buy nothing but minutes.
    const collection = firestore.collection(COLLECTIONS.scheduleSlots);
    const { note: _note, ...untagged } = (await collection.doc(tagged.id).get()).data()!;
    const ballastIds = Array.from(
      { length: BALLAST_COUNT },
      // `!` (U+0021) sorts ahead of every character a Firestore auto-id can
      // hold, so a purge reading the collection unfiltered pages through
      // ballast alone and never reaches the fixture. The ids are deterministic
      // so a killed run leaves documents the next one overwrites and deletes.
      (_unused, index) => `!e2e-ballast-${String(index).padStart(4, '0')}`,
    );

    for (let from = 0; from < ballastIds.length; from += BALLAST_BATCH) {
      const batch = firestore.batch();
      for (const id of ballastIds.slice(from, from + BALLAST_BATCH)) {
        // No fixture shares this owner, so no overlap window reads them, and no
        // range this suite asserts on reaches 2099, so no list assertion does.
        batch.set(collection.doc(id), {
          ...untagged,
          ownerId: 'e2e-ballast-owner',
          startsAt: '2099-01-01T09:00:00.000Z',
          endsAt: '2099-01-01T10:00:00.000Z',
        });
      }
      await batch.commit();
    }

    try {
      await purgeTagged(`${PREFIX}/purge-scale`);

      await read(tagged.id).expect(404);
      // And only what it tagged: the ballast on both ends of the ordering is
      // still there.
      for (const id of [ballastIds[0]!, ballastIds.at(-1)!]) {
        expect((await collection.doc(id).get()).exists).toBe(true);
      }
    } finally {
      for (let from = 0; from < ballastIds.length; from += BALLAST_BATCH) {
        const cleanup = firestore.batch();
        for (const id of ballastIds.slice(from, from + BALLAST_BATCH)) {
          cleanup.delete(collection.doc(id));
        }
        await cleanup.commit();
      }
    }
  });
});
