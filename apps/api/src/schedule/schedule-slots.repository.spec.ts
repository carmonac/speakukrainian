import { describe, expect, it } from 'vitest';
import type { Firestore } from '@google-cloud/firestore';
import { MAX_SERIES_DELETE_SLOTS, ScheduleSlotsRepository } from './schedule-slots.repository.js';

/**
 * Firestore commits at most this many writes in one batch. The emulator does
 * not enforce it, so `test:e2e` would happily commit a 520-delete batch that
 * production refuses — which is the whole reason this suite exists.
 */
const FIRESTORE_BATCH_WRITE_LIMIT = 500;

const SERIES_ID = 'series-under-test';

type Document = Record<string, unknown>;

interface Filter {
  field: string;
  op: string;
  value: string;
}

interface Double {
  firestore: Firestore;
  documents: Map<string, Document>;
  commits: () => number;
}

const matches = (data: Document, filter: Filter): boolean => {
  const stored = String(data[filter.field] ?? '');
  switch (filter.op) {
    case '==':
      return stored === filter.value;
    case '>=':
      return stored >= filter.value;
    case '<':
      return stored < filter.value;
    default:
      throw new Error(`The double does not implement the "${filter.op}" operator`);
  }
};

/**
 * In-memory stand-in for the slice of Firestore `removeSeries` touches: a
 * filtered, ordered, limited collection query and a write batch — one that
 * enforces the 500-write limit the real server enforces and the emulator does
 * not.
 */
function createFirestoreDouble(documents: Map<string, Document>): Double {
  let commits = 0;

  const snapshotOf = (id: string, data: Document) => ({
    id,
    data: () => data,
    ref: { id },
  });

  const buildQuery = (filters: Filter[], orderBy: string | null, max: number) => ({
    where: (field: string, op: string, value: string) =>
      buildQuery([...filters, { field, op, value }], orderBy, max),
    orderBy: (field: string) => buildQuery(filters, field, max),
    limit: (limit: number) => buildQuery(filters, orderBy, limit),
    get: () => {
      const matching = [...documents.entries()]
        .filter(([, data]) => filters.every((filter) => matches(data, filter)))
        .sort(([, left], [, right]) =>
          orderBy ? String(left[orderBy]).localeCompare(String(right[orderBy])) : 0,
        )
        .slice(0, max);

      return Promise.resolve({
        size: matching.length,
        docs: matching.map(([id, data]) => snapshotOf(id, data)),
      });
    },
  });

  const firestore = {
    collection: () => ({ ...buildQuery([], null, Number.MAX_SAFE_INTEGER), id: 'scheduleSlots' }),
    batch: () => {
      const staged: string[] = [];
      return {
        delete: (ref: { id: string }) => staged.push(ref.id),
        commit: () => {
          if (staged.length > FIRESTORE_BATCH_WRITE_LIMIT) {
            return Promise.reject(
              new Error(
                `INVALID_ARGUMENT: maximum ${FIRESTORE_BATCH_WRITE_LIMIT} writes allowed per request`,
              ),
            );
          }
          commits += 1;
          for (const id of staged) {
            documents.delete(id);
          }
          return Promise.resolve([]);
        },
      };
    },
  } as unknown as Firestore;

  return { firestore, documents, commits: () => commits };
}

/** `count` hourly occurrences of one series, all after the cutoff the test uses. */
function seedSeries(count: number): Map<string, Document> {
  const documents = new Map<string, Document>();
  const first = Date.parse('2030-01-01T00:00:00.000Z');
  for (let index = 0; index < count; index += 1) {
    const startsAt = new Date(first + index * 3_600_000).toISOString();
    documents.set(`slot-${String(index).padStart(4, '0')}`, {
      ownerId: 'admin-uid',
      startsAt,
      endsAt: new Date(Date.parse(startsAt) + 1_800_000).toISOString(),
      timeZone: 'Europe/Madrid',
      status: 'open',
      recurrenceId: SERIES_ID,
      bookedBy: null,
      bookedAt: null,
      audit: {
        createdAt: '2026-01-01T00:00:00.000Z',
        createdBy: 'admin-uid',
        updatedAt: '2026-01-01T00:00:00.000Z',
        updatedBy: 'admin-uid',
      },
    });
  }
  return documents;
}

const CUTOFF = '2029-12-31T00:00:00.000Z';

describe('ScheduleSlotsRepository removeSeries', () => {
  it('removes a whole series of exactly the batch limit in one commit', async () => {
    const double = createFirestoreDouble(seedSeries(MAX_SERIES_DELETE_SLOTS));
    const repository = new ScheduleSlotsRepository(double.firestore);

    await expect(repository.removeSeries(SERIES_ID, CUTOFF)).resolves.toEqual({
      ok: true,
      deleted: MAX_SERIES_DELETE_SLOTS,
    });
    expect(double.commits()).toBe(1);
    expect(double.documents.size).toBe(0);
  });

  it('refuses a series too large for one commit instead of assembling one', async () => {
    // A series can only get here through hand-written documents — the API's own
    // cap is 200 — but the answer has to be a refusal, not a batch the server
    // rejects halfway through a delete.
    const double = createFirestoreDouble(seedSeries(MAX_SERIES_DELETE_SLOTS + 1));
    const repository = new ScheduleSlotsRepository(double.firestore);

    await expect(repository.removeSeries(SERIES_ID, CUTOFF)).resolves.toEqual({
      ok: false,
      reason: 'series-too-large',
      limit: MAX_SERIES_DELETE_SLOTS,
    });
    expect(double.commits()).toBe(0);
    expect(double.documents.size).toBe(MAX_SERIES_DELETE_SLOTS + 1);
  });

  it('leaves the occurrences that already happened alone', async () => {
    const documents = seedSeries(4);
    const double = createFirestoreDouble(documents);
    const repository = new ScheduleSlotsRepository(double.firestore);

    // Two occurrences in, so the first two are behind the cutoff.
    const result = await repository.removeSeries(SERIES_ID, '2030-01-01T02:00:00.000Z');

    expect(result).toEqual({ ok: true, deleted: 2 });
    expect([...double.documents.keys()]).toEqual(['slot-0000', 'slot-0001']);
  });
});
