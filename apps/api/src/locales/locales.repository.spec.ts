import { describe, expect, it } from 'vitest';
import type { Firestore } from '@google-cloud/firestore';
import { updateLocaleSchema, type CreateLocaleInput } from '@speakukrainian/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { LocalesRepository, toDocumentData } from './locales.repository.js';

interface StoredDoc {
  id: string;
  data: Record<string, unknown>;
}

interface DoubleOptions {
  /**
   * How many times the transaction body is aborted and re-run before it commits,
   * which is what Firestore does under contention.
   */
  abortsBeforeCommit?: number;
}

interface Double {
  firestore: Firestore;
  docs: Map<string, StoredDoc['data']>;
  /** How many times the last transaction body ran. */
  transactionAttempts: () => number;
}

/**
 * In-memory stand-in for the parts of Firestore this repository uses: document
 * reads and writes, an ordered+limited collection query, and a transaction that
 * reads and writes the same map. Documents are plain objects so a test can
 * inspect exactly what was written, including whether `id` leaked into the body.
 *
 * `create` rejects with gRPC code 6 for an existing id, which is the contract
 * the idempotent seed depends on.
 *
 * The transaction reproduces the two rules a transaction exists for, so a body
 * that breaks either makes the test fail rather than pass quietly: a read after
 * a write is rejected, and writes are buffered until the body has run to
 * completion, so an aborted attempt leaves nothing behind and a retry re-reads
 * committed data.
 */
function createFirestoreDouble(options: DoubleOptions = {}): Double {
  const docs = new Map<string, StoredDoc['data']>();
  let attempts = 0;

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
    runTransaction: async <T>(
      work: (tx: {
        get: (target: unknown) => Promise<unknown>;
        set: (ref: { id: string }, data: Record<string, unknown>) => void;
      }) => Promise<T>,
    ): Promise<T> => {
      attempts = 0;
      for (;;) {
        const buffered = new Map<string, StoredDoc['data']>();
        let wrote = false;
        attempts += 1;

        const result = await work({
          get: (target: unknown) => {
            if (wrote) {
              return Promise.reject(
                new Error('Firestore transactions require all reads before all writes'),
              );
            }
            const candidate = target as { get: () => Promise<unknown> };
            return candidate.get();
          },
          set: (ref, data) => {
            wrote = true;
            buffered.set(ref.id, data);
          },
        });

        if (attempts <= (options.abortsBeforeCommit ?? 0)) {
          continue;
        }

        for (const [id, data] of buffered) {
          docs.set(id, data);
        }
        return result;
      }
    },
  } as unknown as Firestore;

  return { firestore, docs, transactionAttempts: () => attempts };
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

  it('changes only the fields a patch parsed by the validation pipe carries', async () => {
    const { firestore, docs } = createFirestoreDouble();
    const repository = new LocalesRepository(firestore);
    await repository.create(
      { ...input('he', 42), name: 'Hebrew', nativeName: 'עברית', direction: 'rtl', enabled: false },
      'admin-uid',
    );

    // The pipe is what the HTTP path actually applies to the body; going through
    // it is the difference between testing a shape a request can produce and one
    // it cannot.
    const body = new ZodValidationPipe(updateLocaleSchema).transform({ name: 'Hebrew (Israel)' });
    const updated = await repository.update('he', body, 'admin-uid');

    expect(updated).toMatchObject({
      name: 'Hebrew (Israel)',
      direction: 'rtl',
      enabled: false,
      sortOrder: 42,
    });
    expect(docs.get('he')).toMatchObject({ direction: 'rtl', enabled: false, sortOrder: 42 });
  });

  it('does not re-enable a disabled locale when the reorder patch goes through the pipe', async () => {
    const { firestore, docs } = createFirestoreDouble();
    const repository = new LocalesRepository(firestore);
    await repository.create({ ...input('es', 4), enabled: false }, 'admin-uid');

    const body = new ZodValidationPipe(updateLocaleSchema).transform({ sortOrder: 1 });
    await repository.update('es', body, 'admin-uid');

    expect(docs.get('es')).toMatchObject({ enabled: false, sortOrder: 1 });
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

  it('still leaves exactly one default when the transaction is retried', async () => {
    const { firestore, docs, transactionAttempts } = createFirestoreDouble({
      abortsBeforeCommit: 1,
    });
    const repository = new LocalesRepository(firestore);
    await repository.create(input('en', 0), 'seed', true);
    await repository.create(input('es', 1), 'seed');
    await repository.create(input('uk', 2), 'seed');

    const updated = await repository.setDefault('uk', 'admin-uid');

    expect(transactionAttempts()).toBe(2);
    expect(updated?.isDefault).toBe(true);
    expect(defaultCodes(docs)).toEqual(['uk']);
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

// The transaction tests above are only worth anything if the double can reject
// the mistakes Firestore rejects, so it is checked against both of them here.
describe('the Firestore transaction double', () => {
  it('rejects a read issued after a write', async () => {
    const { firestore, docs } = createFirestoreDouble();
    docs.set('en', { code: 'en' });

    await expect(
      firestore.runTransaction(async (tx) => {
        const ref = firestore.collection('locales').doc('en');
        tx.set(ref, { code: 'en', name: 'English' });
        await tx.get(ref);
      }),
    ).rejects.toThrow(/all reads before all writes/);
  });

  it('discards the writes of an aborted attempt', async () => {
    const { firestore, docs } = createFirestoreDouble({ abortsBeforeCommit: 1 });
    const seen: (string | undefined)[] = [];

    await firestore.runTransaction(async (tx) => {
      const ref = firestore.collection('locales').doc('en');
      const snapshot = await tx.get(ref);
      seen.push(snapshot.exists ? 'exists' : 'missing');
      tx.set(ref, { code: 'en' });
    });

    // The retry re-read committed data, not the aborted attempt's write.
    expect(seen).toEqual(['missing', 'missing']);
    expect(docs.get('en')).toEqual({ code: 'en' });
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
