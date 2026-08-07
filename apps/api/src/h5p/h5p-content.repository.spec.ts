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

interface Double {
  firestore: Firestore;
  docs: Map<string, Record<string, unknown>>;
}

/**
 * In-memory stand-in for the document reads and writes this repository makes.
 * `create` rejects with gRPC code 6 for an id that is already taken, which is
 * the behaviour that makes an id collision loud instead of destructive.
 */
function createFirestoreDouble(): Double {
  const docs = new Map<string, Record<string, unknown>>();
  const collections = new Map<string, string>();

  const docRef = (collection: string, id: string) => ({
    id,
    get: () =>
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

  const firestore = {
    collection: (name: string) => {
      collections.set(name, name);
      return { id: name, doc: (id: string) => docRef(name, id) };
    },
  } as unknown as Firestore;

  return { firestore, docs };
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
