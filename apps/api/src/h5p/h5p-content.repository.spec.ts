import { Timestamp, type Firestore } from '@google-cloud/firestore';
import { describe, expect, it } from 'vitest';
import { COLLECTIONS, type CreateH5pContentInput } from '@speakukrainian/shared';
import { H5pContentRepository, toDocumentData } from './h5p-content.repository.js';

const INPUT: CreateH5pContentInput = {
  id: 'ff6c4a3a-4d1f-4f0f-9a4b-9d3b2f5a1c77',
  title: 'Present perfect drill',
  mainLibrary: 'H5P.MultiChoice 1.16',
  storagePath: 'h5p/content/ff6c4a3a-4d1f-4f0f-9a4b-9d3b2f5a1c77',
  sizeBytes: 4096,
  pageId: null,
};

interface Snapshot {
  id: string;
  exists: boolean;
  data: () => Record<string, unknown> | undefined;
}

interface Double {
  firestore: Firestore;
  docs: Map<string, Record<string, unknown>>;
  /** One entry per query that ran, holding what the repository asked for. */
  queries: { orderBy: [string, string][]; limit: number | null }[];
}

/**
 * In-memory stand-in for the document reads, writes and queries this repository
 * makes. `create` rejects with gRPC code 6 for an id that is already taken,
 * which is the behaviour that makes an id collision loud instead of
 * destructive.
 *
 * The query half records what it was asked for, so "the list is bounded" and
 * "the list is ordered newest first" are observations rather than assumptions:
 * a `limit` the repository never set is `null` here, not a passing test.
 */
function createFirestoreDouble(): Double {
  const docs = new Map<string, Record<string, unknown>>();
  const queries: { orderBy: [string, string][]; limit: number | null }[] = [];

  const snapshotsOf = (collection: string): Snapshot[] =>
    [...docs.entries()]
      .filter(([key]) => key.startsWith(`${collection}/`))
      .map(([key, data]) => ({
        id: key.slice(collection.length + 1),
        exists: true,
        data: () => data,
      }));

  const docRef = (collection: string, id: string) => ({
    id,
    get: (): Promise<Snapshot> =>
      Promise.resolve({
        id,
        exists: docs.has(`${collection}/${id}`),
        data: () => docs.get(`${collection}/${id}`),
      }),
    create: (data: Record<string, unknown>) => {
      if (docs.has(`${collection}/${id}`)) {
        return Promise.reject(Object.assign(new Error('already exists'), { code: 6 }));
      }
      docs.set(`${collection}/${id}`, data);
      return Promise.resolve();
    },
  });

  const query = (
    collection: string,
    state: { orderBy: [string, string][]; limit: number | null; after: string | null },
  ) => ({
    orderBy: (field: string, direction = 'asc') =>
      query(collection, { ...state, orderBy: [...state.orderBy, [field, direction]] }),
    limit: (count: number) => query(collection, { ...state, limit: count }),
    startAfter: (snapshot: Snapshot) => query(collection, { ...state, after: snapshot.id }),
    get: () => {
      queries.push({ orderBy: state.orderBy, limit: state.limit });

      let rows = snapshotsOf(collection);
      for (const [field, direction] of [...state.orderBy].reverse()) {
        rows = [...rows].sort((a, b) => compare(valueAt(a, field), valueAt(b, field)));
        if (direction === 'desc') {
          rows.reverse();
        }
      }
      if (state.after) {
        const index = rows.findIndex((row) => row.id === state.after);
        rows = index === -1 ? rows : rows.slice(index + 1);
      }
      return Promise.resolve({
        docs: state.limit === null ? rows : rows.slice(0, state.limit),
      });
    },
  });

  const firestore = {
    collection: (name: string) => ({
      id: name,
      doc: (id: string) => docRef(name, id),
      ...query(name, { orderBy: [], limit: null, after: null }),
    }),
  } as unknown as Firestore;

  return { firestore, docs, queries };
}

/** `audit.createdAt` is a dotted field path, which Firestore resolves for us. */
function valueAt(snapshot: Snapshot, field: string): unknown {
  return field.split('.').reduce<unknown>((value, key) => {
    return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
  }, snapshot.data());
}

function compare(a: unknown, b: unknown): number {
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

describe('H5pContentRepository', () => {
  it('writes to the shared collection name', () => {
    const { firestore } = createFirestoreDouble();
    const repository = new H5pContentRepository(firestore);

    expect(COLLECTIONS.h5pContent).toBe('h5pContent');
    expect(repository).toBeInstanceOf(H5pContentRepository);
  });

  it('stores the content under the H5P content id and stamps the audit', async () => {
    const { firestore, docs } = createFirestoreDouble();
    const repository = new H5pContentRepository(firestore);

    const created = await repository.create(INPUT, 'editor-1');

    expect(created.id).toBe(INPUT.id);
    expect(created.audit.createdBy).toBe('editor-1');
    expect(created.audit.updatedBy).toBe('editor-1');
    expect(docs.has(`h5pContent/${INPUT.id}`)).toBe(true);
  });

  it('keeps the id out of the document body, since it is the document id', async () => {
    const { firestore, docs } = createFirestoreDouble();

    await new H5pContentRepository(firestore).create(INPUT, 'editor-1');

    expect(docs.get(`h5pContent/${INPUT.id}`)).not.toHaveProperty('id');
    expect(docs.get(`h5pContent/${INPUT.id}`)).toMatchObject({
      storagePath: INPUT.storagePath,
      sizeBytes: 4096,
    });
  });

  it('fails loudly on a duplicate id instead of overwriting an existing exercise', async () => {
    // The document id is the H5P content id, so a collision means the generator
    // handed out a duplicate; a `set` here would silently detach the first
    // exercise from its files.
    const { firestore } = createFirestoreDouble();
    const repository = new H5pContentRepository(firestore);

    await repository.create(INPUT, 'editor-1');

    await expect(repository.create(INPUT, 'editor-1')).rejects.toMatchObject({ code: 6 });
  });

  it('refuses to store content that does not satisfy the schema', async () => {
    const { firestore, docs } = createFirestoreDouble();
    const repository = new H5pContentRepository(firestore);

    await expect(repository.create({ ...INPUT, storagePath: '' }, 'editor-1')).rejects.toThrow();
    expect(docs.size).toBe(0);
  });

  it('converts stored timestamps to ISO strings on read', async () => {
    const { firestore, docs } = createFirestoreDouble();
    const repository = new H5pContentRepository(firestore);
    const createdAt = Timestamp.fromDate(new Date('2026-04-05T06:07:08.000Z'));

    docs.set(`h5pContent/${INPUT.id}`, {
      ...toDocumentData({
        ...INPUT,
        audit: {
          createdAt: '',
          createdBy: 'editor-1',
          updatedAt: '',
          updatedBy: 'editor-1',
        },
      }),
      audit: {
        createdAt,
        createdBy: 'editor-1',
        updatedAt: createdAt,
        updatedBy: 'editor-1',
      },
    });

    const found = await repository.findById(INPUT.id);

    expect(found?.audit.createdAt).toBe('2026-04-05T06:07:08.000Z');
    expect(found?.title).toBe(INPUT.title);
  });
});

describe('H5pContentRepository.list', () => {
  /** Three contents, uploaded a minute apart, seeded in a shuffled order. */
  function seedThree(docs: Map<string, Record<string, unknown>>): void {
    for (const [id, minute] of [
      ['middle', '01'],
      ['newest', '02'],
      ['oldest', '00'],
    ] as const) {
      const at = `2026-04-05T06:${minute}:00.000Z`;
      docs.set(`h5pContent/${id}`, {
        ...toDocumentData({
          ...INPUT,
          id,
          audit: { createdAt: at, createdBy: 'e', updatedAt: at, updatedBy: 'e' },
        }),
      });
    }
  }

  it('answers newest first', async () => {
    const { firestore, docs, queries } = createFirestoreDouble();
    seedThree(docs);

    const page = await new H5pContentRepository(firestore).list({ limit: 25 });

    expect(page.items.map((content) => content.id)).toEqual(['newest', 'middle', 'oldest']);
    expect(queries[0]?.orderBy).toEqual([['audit.createdAt', 'desc']]);
  });

  it('never reads the collection unbounded, and asks for one more than it returns', async () => {
    const { firestore, docs, queries } = createFirestoreDouble();
    seedThree(docs);

    const page = await new H5pContentRepository(firestore).list({ limit: 2 });

    // The double records the limit it was handed, so "no limit at all" is
    // observable rather than assumed.
    expect(queries[0]?.limit).toBe(3);
    expect(page.items.map((content) => content.id)).toEqual(['newest', 'middle']);
    expect(page.nextCursor).toBe('middle');
  });

  it('reports no cursor once the last page is reached', async () => {
    const { firestore, docs } = createFirestoreDouble();
    seedThree(docs);

    const page = await new H5pContentRepository(firestore).list({ limit: 3 });

    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
  });

  it('starts the next page after the cursor without repeating it', async () => {
    const { firestore, docs } = createFirestoreDouble();
    seedThree(docs);
    const repository = new H5pContentRepository(firestore);

    const first = await repository.list({ limit: 2 });
    const second = await repository.list({ limit: 2, cursor: first.nextCursor ?? undefined });

    expect(second.items.map((content) => content.id)).toEqual(['oldest']);
    expect(second.nextCursor).toBeNull();
  });
});
