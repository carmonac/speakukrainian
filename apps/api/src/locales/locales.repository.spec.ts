import { describe, expect, it } from 'vitest';
import type { Firestore } from '@google-cloud/firestore';
import type { CreateLocaleInput } from '@speakukrainian/shared';
import { LocalesRepository, toDocumentData } from './locales.repository.js';

interface StoredDoc {
  id: string;
  data: Record<string, unknown>;
}

/**
 * In-memory stand-in for the parts of Firestore this repository uses: document
 * reads and writes, an ordered+limited collection query, and a transaction that
 * reads and writes the same map. Documents are plain objects so a test can
 * inspect exactly what was written, including whether `id` leaked into the body.
 *
 * `create` rejects with gRPC code 6 for an existing id, which is the contract
 * the idempotent seed depends on.
 */
function createFirestoreDouble(): { firestore: Firestore; docs: Map<string, StoredDoc['data']> } {
  const docs = new Map<string, StoredDoc['data']>();

  const snapshot = (id: string) => ({
    id,
    exists: docs.has(id),
    data: () => docs.get(id),
    ref: docRef(id),
  });

  const docRef = (id: string) => ({
    id,
    get: () => Promise.resolve(snapshot(id)),
    set: (data: Record<string, unknown>) => {
      docs.set(id, data);
      return Promise.resolve();
    },
    create: (data: Record<string, unknown>) => {
      if (docs.has(id)) {
        return Promise.reject(Object.assign(new Error('ALREADY_EXISTS'), { code: 6 }));
      }
      docs.set(id, data);
      return Promise.resolve();
    },
    delete: () => {
      docs.delete(id);
      return Promise.resolve();
    },
  });

  const runQuery = (field: string, limit: number) => {
    const ordered = [...docs.entries()].sort(([, a], [, b]) => {
      const left = a[field];
      const right = b[field];
      return typeof left === 'number' && typeof right === 'number' ? left - right : 0;
    });
    return {
      docs: ordered.slice(0, limit).map(([id]) => snapshot(id)),
    };
  };

  const query = (field: string) => ({
    limit: (max: number) => ({
      field,
      max,
      get: () => Promise.resolve(runQuery(field, max)),
    }),
  });

  const firestore = {
    collection: (name: string) => ({
      id: name,
      doc: docRef,
      orderBy: query,
    }),
    runTransaction: <T>(
      work: (tx: {
        get: (target: unknown) => Promise<unknown>;
        set: (ref: { id: string }, data: Record<string, unknown>) => void;
      }) => Promise<T>,
    ): Promise<T> =>
      work({
        get: (target: unknown) => {
          const candidate = target as { get: () => Promise<unknown> };
          return candidate.get();
        },
        set: (ref, data) => {
          docs.set(ref.id, data);
        },
      }),
  } as unknown as Firestore;

  return { firestore, docs };
}

function input(code: string, sortOrder: number): CreateLocaleInput {
  return {
    code,
    name: code.toUpperCase(),
    nativeName: code.toUpperCase(),
    direction: 'ltr',
    enabled: true,
    sortOrder,
  };
}

function defaultCodes(docs: Map<string, Record<string, unknown>>): string[] {
  return [...docs.entries()].filter(([, data]) => data['isDefault'] === true).map(([id]) => id);
}

describe('LocalesRepository', () => {
  it('round-trips a created locale through findById without an id in the body', async () => {
    const { firestore, docs } = createFirestoreDouble();
    const repository = new LocalesRepository(firestore);

    await repository.create(input('uk', 2), 'admin-uid');

    expect(docs.get('uk')).not.toHaveProperty('id');
    const found = await repository.findById('uk');
    expect(found).toMatchObject({ id: 'uk', code: 'uk', sortOrder: 2, isDefault: false });
    expect(found?.audit.createdBy).toBe('admin-uid');
  });

  it('returns null for a taken code and leaves the stored document untouched', async () => {
    const { firestore, docs } = createFirestoreDouble();
    const repository = new LocalesRepository(firestore);

    await repository.create(input('en', 0), 'seed', true);
    const before = docs.get('en');

    const again = await repository.create(
      { ...input('en', 9), name: 'Overwritten' },
      'someone-else',
    );

    expect(again).toBeNull();
    expect(docs.get('en')).toBe(before);
    expect(docs.get('en')).toMatchObject({ name: 'EN', sortOrder: 0, isDefault: true });
  });

  it('stores isDefault only when it is asked for', async () => {
    const { firestore } = createFirestoreDouble();
    const repository = new LocalesRepository(firestore);

    const en = await repository.create(input('en', 0), 'seed', true);
    const es = await repository.create(input('es', 1), 'seed');

    expect(en?.isDefault).toBe(true);
    expect(es?.isDefault).toBe(false);
  });

  it('keeps the creation audit and moves the update audit to the actor', async () => {
    const { firestore } = createFirestoreDouble();
    const repository = new LocalesRepository(firestore);
    const created = await repository.create(input('uk', 2), 'seed');

    const updated = await repository.update('uk', { name: 'Ukrainian' }, 'admin-uid');

    expect(updated?.name).toBe('Ukrainian');
    expect(updated?.audit.createdAt).toBe(created?.audit.createdAt);
    expect(updated?.audit.createdBy).toBe('seed');
    expect(updated?.audit.updatedBy).toBe('admin-uid');
    expect((await repository.findById('uk'))?.name).toBe('Ukrainian');
  });

  it('leaves a field alone when the patch carries it as undefined', async () => {
    const { firestore } = createFirestoreDouble();
    const repository = new LocalesRepository(firestore);
    await repository.create(input('uk', 2), 'seed');

    const updated = await repository.update('uk', { name: undefined, enabled: false }, 'admin-uid');

    expect(updated?.name).toBe('UK');
    expect(updated?.enabled).toBe(false);
  });

  it('returns null when updating an unknown code', async () => {
    const { firestore } = createFirestoreDouble();
    const repository = new LocalesRepository(firestore);

    expect(await repository.update('zz', { name: 'Nope' }, 'admin-uid')).toBeNull();
  });

  it('orders the list by sortOrder and breaks ties by code', async () => {
    const { firestore } = createFirestoreDouble();
    const repository = new LocalesRepository(firestore);
    await repository.create(input('uk', 1), 'seed');
    await repository.create(input('es', 1), 'seed');
    await repository.create(input('en', 0), 'seed');

    expect((await repository.list()).map((locale) => locale.code)).toEqual(['en', 'es', 'uk']);
  });

  it('moves the default flag so exactly one locale holds it', async () => {
    const { firestore, docs } = createFirestoreDouble();
    const repository = new LocalesRepository(firestore);
    await repository.create(input('en', 0), 'seed', true);
    await repository.create(input('es', 1), 'seed');
    await repository.create(input('uk', 2), 'seed');

    const updated = await repository.setDefault('uk', 'admin-uid');

    expect(updated?.isDefault).toBe(true);
    expect(defaultCodes(docs)).toEqual(['uk']);
    expect(docs.get('en')).toMatchObject({ isDefault: false });
  });

  it('leaves exactly one default when the target is already the default', async () => {
    const { firestore, docs } = createFirestoreDouble();
    const repository = new LocalesRepository(firestore);
    await repository.create(input('en', 0), 'seed', true);
    await repository.create(input('es', 1), 'seed');

    const updated = await repository.setDefault('en', 'admin-uid');

    expect(updated?.code).toBe('en');
    expect(defaultCodes(docs)).toEqual(['en']);
  });

  it('returns null and writes nothing when the target code is unknown', async () => {
    const { firestore, docs } = createFirestoreDouble();
    const repository = new LocalesRepository(firestore);
    await repository.create(input('en', 0), 'seed', true);
    const before = docs.get('en');

    expect(await repository.setDefault('zz', 'admin-uid')).toBeNull();
    expect(docs.get('en')).toBe(before);
    expect(docs.has('zz')).toBe(false);
  });

  it('throws when a stored document does not match the locale schema', async () => {
    const { firestore, docs } = createFirestoreDouble();
    const repository = new LocalesRepository(firestore);

    docs.set('uk', { code: 'uk', name: 'Ukrainian' });

    await expect(repository.findById('uk')).rejects.toThrow();
  });
});

describe('toDocumentData', () => {
  it('drops the id and preserves every other field', () => {
    const audit = {
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'seed',
      updatedAt: '2026-01-01T00:00:00.000Z',
      updatedBy: 'seed',
    };

    expect(
      toDocumentData({
        id: 'uk',
        code: 'uk',
        name: 'Ukrainian',
        nativeName: 'Українська',
        direction: 'ltr',
        isDefault: false,
        enabled: true,
        sortOrder: 2,
        audit,
      }),
    ).toEqual({
      code: 'uk',
      name: 'Ukrainian',
      nativeName: 'Українська',
      direction: 'ltr',
      isDefault: false,
      enabled: true,
      sortOrder: 2,
      audit,
    });
  });
});
