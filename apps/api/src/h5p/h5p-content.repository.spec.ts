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
    /** What a real `DocumentReference` calls it, and what the transaction writes by. */
    path: `${collection}/${id}`,
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
    /**
     * The two rules a transaction exists for, so a body that breaks either
     * fails here rather than passing quietly: a read after a write is refused,
     * and writes are buffered until the body has run to completion — which is
     * what makes "the missing-id branch writes nothing" observable in `docs`.
     */
    runTransaction: async <T>(
      work: (tx: {
        get: (target: unknown) => Promise<unknown>;
        set: (ref: { path: string }, data: Record<string, unknown>) => void;
      }) => Promise<T>,
    ): Promise<T> => {
      const buffered = new Map<string, Record<string, unknown>>();
      let wrote = false;

      const result = await work({
        get: (target: unknown) => {
          if (wrote) {
            return Promise.reject(
              new Error('Firestore transactions require all reads before all writes'),
            );
          }
          return (target as { get: () => Promise<unknown> }).get();
        },
        set: (ref, data) => {
          wrote = true;
          buffered.set(ref.path, data);
        },
      });

      for (const [path, data] of buffered) {
        docs.set(path, data);
      }
      return result;
    },
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

  it('reports a stored row whose shape is wrong as existing, without parsing it', async () => {
    // The delete path's check. A parse here would make a corrupt row removable
    // only with direct Firestore access, since no route could act on it.
    const { firestore, docs } = createFirestoreDouble();
    const repository = new H5pContentRepository(firestore);
    const at = '2026-04-05T06:07:08.000Z';
    docs.set(`h5pContent/${INPUT.id}`, {
      ...toDocumentData({
        ...INPUT,
        audit: { createdAt: at, createdBy: 'editor-1', updatedAt: at, updatedBy: 'editor-1' },
      }),
      sizeBytes: 'not-a-number',
    });

    await expect(repository.exists(INPUT.id)).resolves.toBe(true);
    await expect(repository.findById(INPUT.id)).rejects.toThrow();
  });

  it('reports an id nothing was stored under as not existing', async () => {
    const { firestore } = createFirestoreDouble();

    await expect(new H5pContentRepository(firestore).exists(INPUT.id)).resolves.toBe(false);
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

describe('H5pContentRepository.update', () => {
  const PAGE_ID = 'page-the-exercise-is-attached-to';

  /** A stored row with a **non-null** `pageId`, which is what makes the case below real. */
  function seed(docs: Map<string, Record<string, unknown>>): void {
    const at = '2026-04-05T06:07:08.000Z';
    docs.set(
      `h5pContent/${INPUT.id}`,
      toDocumentData({
        ...INPUT,
        pageId: PAGE_ID,
        audit: { createdAt: at, createdBy: 'editor-1', updatedAt: at, updatedBy: 'editor-1' },
      }),
    );
  }

  const PATCH = {
    title: 'Edited in the widget',
    mainLibrary: 'H5P.MultiChoice 1.16',
    sizeBytes: 8,
  };

  it('records who saved and when, and leaves who created it alone', async () => {
    const { firestore, docs } = createFirestoreDouble();
    seed(docs);

    const updated = await new H5pContentRepository(firestore).update(INPUT.id, PATCH, 'editor-2');

    expect(updated?.title).toBe('Edited in the widget');
    expect(updated?.audit.updatedBy).toBe('editor-2');
    expect(updated?.audit.createdBy).toBe('editor-1');
    expect(updated?.audit.createdAt).toBe('2026-04-05T06:07:08.000Z');
    expect(updated?.audit.updatedAt).not.toBe('2026-04-05T06:07:08.000Z');
  });

  it('keeps the page the exercise is attached to, and where its files live', async () => {
    // The destructive failure mode: `setPageId` is what attaches an exercise to
    // a page, and a row rewritten from the save's own fields would detach it
    // with nothing else going red.
    const { firestore, docs } = createFirestoreDouble();
    seed(docs);

    const updated = await new H5pContentRepository(firestore).update(INPUT.id, PATCH, 'editor-2');

    expect(updated?.pageId).toBe(PAGE_ID);
    expect(updated?.storagePath).toBe(INPUT.storagePath);
    expect(docs.get(`h5pContent/${INPUT.id}`)).toMatchObject({
      pageId: PAGE_ID,
      storagePath: INPUT.storagePath,
    });
  });

  it('recomputes the stored size, which a save that copied files in has changed', async () => {
    const { firestore, docs } = createFirestoreDouble();
    seed(docs);

    await new H5pContentRepository(firestore).update(INPUT.id, PATCH, 'editor-2');

    expect(docs.get(`h5pContent/${INPUT.id}`)).toMatchObject({ sizeBytes: 8 });
  });

  it('answers null for an id nothing was stored under, and writes nothing', async () => {
    // `null` and not a created document: `set` where `create` was meant would
    // mint an index row for content that does not exist.
    const { firestore, docs } = createFirestoreDouble();

    const updated = await new H5pContentRepository(firestore).update(INPUT.id, PATCH, 'editor-2');

    expect(updated).toBeNull();
    expect(docs.size).toBe(0);
  });

  it('keeps the id out of the document body', async () => {
    const { firestore, docs } = createFirestoreDouble();
    seed(docs);

    await new H5pContentRepository(firestore).update(INPUT.id, PATCH, 'editor-2');

    expect(docs.get(`h5pContent/${INPUT.id}`)).not.toHaveProperty('id');
  });
});

describe('H5pContentRepository.setPageId', () => {
  const PAGE = 'page-the-exercise-is-attached-to';
  const OTHER_PAGE = 'another-page-entirely';
  const SEEDED_AT = '2026-04-05T06:07:08.000Z';

  /** A stored row, attached or not, plus the page documents the double holds. */
  function seed(
    docs: Map<string, Record<string, unknown>>,
    options: { pageId?: string | null; pages?: string[] } = {},
  ): void {
    docs.set(
      `h5pContent/${INPUT.id}`,
      toDocumentData({
        ...INPUT,
        pageId: options.pageId ?? null,
        audit: {
          createdAt: SEEDED_AT,
          createdBy: 'editor-1',
          updatedAt: SEEDED_AT,
          updatedBy: 'editor-1',
        },
      }),
    );
    for (const pageId of options.pages ?? []) {
      docs.set(`pages/${pageId}`, { slug: 'a-page' });
    }
  }

  const rowOf = (docs: Map<string, Record<string, unknown>>): Record<string, unknown> =>
    docs.get(`h5pContent/${INPUT.id}`) ?? {};

  const auditOf = (docs: Map<string, Record<string, unknown>>): Record<string, unknown> =>
    (rowOf(docs).audit ?? {}) as Record<string, unknown>;

  it('attaches an exercise to a page and leaves every other field alone', async () => {
    const { firestore, docs } = createFirestoreDouble();
    seed(docs, { pages: [PAGE] });
    const before = structuredClone(rowOf(docs));

    const result = await new H5pContentRepository(firestore).setPageId(INPUT.id, PAGE, 'editor-2');

    expect(result).toMatchObject({ ok: true, content: { pageId: PAGE } });
    expect(rowOf(docs)).toMatchObject({
      pageId: PAGE,
      title: INPUT.title,
      mainLibrary: INPUT.mainLibrary,
      sizeBytes: INPUT.sizeBytes,
      storagePath: INPUT.storagePath,
    });
    // Who created it survives; who changed it moves.
    expect(auditOf(docs)).toMatchObject({
      createdAt: SEEDED_AT,
      createdBy: 'editor-1',
      updatedBy: 'editor-2',
    });
    expect(auditOf(docs).updatedAt).not.toBe(SEEDED_AT);
    // The write added no field the row did not already have.
    expect(Object.keys(rowOf(docs)).sort()).toEqual(Object.keys(before).sort());
  });

  it('detaches an exercise, leaving the row in place with everything else untouched', async () => {
    const { firestore, docs } = createFirestoreDouble();
    seed(docs, { pageId: PAGE, pages: [PAGE] });

    const result = await new H5pContentRepository(firestore).setPageId(INPUT.id, null, 'editor-2');

    expect(result).toMatchObject({ ok: true, content: { pageId: null } });
    expect(rowOf(docs)).toMatchObject({
      pageId: null,
      title: INPUT.title,
      mainLibrary: INPUT.mainLibrary,
      sizeBytes: INPUT.sizeBytes,
      storagePath: INPUT.storagePath,
    });
    expect(auditOf(docs)).toMatchObject({ createdAt: SEEDED_AT, createdBy: 'editor-1' });
  });

  it('detaches without any page document existing anywhere', async () => {
    // The outcome-shaped way of asserting that detach reads no page: there is
    // none to read, and the page an author is escaping from is usually the one
    // that was deleted.
    const { firestore, docs } = createFirestoreDouble();
    seed(docs, { pageId: PAGE });

    await expect(
      new H5pContentRepository(firestore).setPageId(INPUT.id, null, 'editor-2'),
    ).resolves.toMatchObject({ ok: true, content: { pageId: null } });
    expect(rowOf(docs)).toMatchObject({ pageId: null });
  });

  it('reports an id nothing was stored under, and writes nothing', async () => {
    const { firestore, docs } = createFirestoreDouble();
    docs.set(`pages/${PAGE}`, { slug: 'a-page' });

    const result = await new H5pContentRepository(firestore).setPageId(INPUT.id, PAGE, 'editor-2');

    expect(result).toEqual({ ok: false, reason: 'content-not-found' });
    expect(docs.has(`h5pContent/${INPUT.id}`)).toBe(false);
  });

  it('refuses a page nothing was stored under, and writes nothing', async () => {
    // A back-reference allowed to name nothing answers no question, and the
    // failure would be silent.
    const { firestore, docs } = createFirestoreDouble();
    seed(docs);
    const before = structuredClone(rowOf(docs));

    const result = await new H5pContentRepository(firestore).setPageId(INPUT.id, PAGE, 'editor-2');

    expect(result).toEqual({ ok: false, reason: 'page-not-found' });
    expect(rowOf(docs)).toEqual(before);
  });

  it('refuses to move an exercise that is already attached, naming the page it is on', async () => {
    const { firestore, docs } = createFirestoreDouble();
    seed(docs, { pageId: PAGE, pages: [PAGE, OTHER_PAGE] });
    const before = structuredClone(rowOf(docs));

    const result = await new H5pContentRepository(firestore).setPageId(
      INPUT.id,
      OTHER_PAGE,
      'editor-2',
    );

    expect(result).toEqual({ ok: false, reason: 'attached-elsewhere', pageId: PAGE });
    expect(rowOf(docs)).toEqual(before);
  });

  it('attaching to the page it already names writes nothing at all', async () => {
    // A retry after a dropped response must not read as a fresh edit: the
    // exercise was not changed, so `audit.updatedAt` must not move.
    const { firestore, docs } = createFirestoreDouble();
    seed(docs, { pageId: PAGE, pages: [PAGE] });
    const before = structuredClone(rowOf(docs));

    const result = await new H5pContentRepository(firestore).setPageId(INPUT.id, PAGE, 'editor-2');

    expect(result).toMatchObject({ ok: true, content: { pageId: PAGE } });
    expect(rowOf(docs)).toEqual(before);
    expect(rowOf(docs).audit).toMatchObject({ updatedAt: SEEDED_AT, updatedBy: 'editor-1' });
  });

  it('re-attaches to a page that has since been deleted, rather than refusing it', async () => {
    // Pins the ordering: the no-write short-circuit runs before the page read,
    // because nothing clears `pageId` when a page is deleted, so this row is a
    // normal state and a refusal here would be noise.
    const { firestore, docs } = createFirestoreDouble();
    seed(docs, { pageId: PAGE });
    const before = structuredClone(rowOf(docs));

    const result = await new H5pContentRepository(firestore).setPageId(INPUT.id, PAGE, 'editor-2');

    expect(result).toMatchObject({ ok: true, content: { pageId: PAGE } });
    expect(rowOf(docs)).toEqual(before);
  });

  it('detaching a row that is already detached writes nothing', async () => {
    const { firestore, docs } = createFirestoreDouble();
    seed(docs);
    const before = structuredClone(rowOf(docs));

    const result = await new H5pContentRepository(firestore).setPageId(INPUT.id, null, 'editor-2');

    expect(result).toMatchObject({ ok: true, content: { pageId: null } });
    expect(rowOf(docs)).toEqual(before);
  });

  it('keeps the id out of the document body', async () => {
    const { firestore, docs } = createFirestoreDouble();
    seed(docs, { pages: [PAGE] });

    await new H5pContentRepository(firestore).setPageId(INPUT.id, PAGE, 'editor-2');

    expect(rowOf(docs)).not.toHaveProperty('id');
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
