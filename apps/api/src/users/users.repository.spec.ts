import { describe, expect, it } from 'vitest';
import type { Firestore } from '@google-cloud/firestore';
import { UsersRepository, toDocumentData } from './users.repository.js';

/**
 * Minimal in-memory stand-in for the parts of Firestore this repository uses.
 * Documents are kept as plain objects so a test can inspect exactly what was
 * written, including whether `id` leaked into the body.
 */
function createFirestoreDouble(): { firestore: Firestore; docs: Map<string, unknown> } {
  const docs = new Map<string, unknown>();

  const firestore = {
    collection: (name: string) => ({
      id: name,
      doc: (id: string) => ({
        id,
        get: () =>
          Promise.resolve({
            id,
            exists: docs.has(id),
            data: () => docs.get(id),
          }),
        set: (data: unknown) => {
          docs.set(id, data);
          return Promise.resolve();
        },
        delete: () => {
          docs.delete(id);
          return Promise.resolve();
        },
      }),
    }),
  } as unknown as Firestore;

  return { firestore, docs };
}

describe('UsersRepository', () => {
  it('round-trips a created profile through findById', async () => {
    const { firestore } = createFirestoreDouble();
    const repository = new UsersRepository(firestore);

    await repository.create(
      { id: 'uid-1', email: 'ada@example.com', displayName: 'Ada', role: 'editor' },
      'seed',
    );

    const found = await repository.findById('uid-1');
    expect(found).toMatchObject({
      id: 'uid-1',
      email: 'ada@example.com',
      displayName: 'Ada',
      role: 'editor',
      disabled: false,
    });
    expect(found?.audit.createdBy).toBe('seed');
    expect(found?.audit.updatedBy).toBe('seed');
  });

  it('stores the document without an id field and puts it back on read', async () => {
    const { firestore, docs } = createFirestoreDouble();
    const repository = new UsersRepository(firestore);

    await repository.create({ id: 'uid-1', email: 'ada@example.com', role: 'student' }, 'seed');

    expect(docs.get('uid-1')).not.toHaveProperty('id');
    expect((await repository.findById('uid-1'))?.id).toBe('uid-1');
  });

  it('keeps the creation audit and moves the update audit to the actor on setRole', async () => {
    const { firestore } = createFirestoreDouble();
    const repository = new UsersRepository(firestore);

    const created = await repository.create(
      { id: 'uid-1', email: 'ada@example.com', role: 'student' },
      'seed',
    );

    const updated = await repository.setRole('uid-1', 'editor', 'admin-uid');

    expect(updated?.role).toBe('editor');
    expect(updated?.audit.createdAt).toBe(created.audit.createdAt);
    expect(updated?.audit.createdBy).toBe('seed');
    expect(updated?.audit.updatedBy).toBe('admin-uid');
    expect((await repository.findById('uid-1'))?.role).toBe('editor');
  });

  it('returns null from setRole when no profile document exists', async () => {
    const { firestore } = createFirestoreDouble();
    const repository = new UsersRepository(firestore);

    expect(await repository.setRole('unknown', 'editor', 'admin-uid')).toBeNull();
  });

  it('throws when a stored document does not match the profile schema', async () => {
    const { firestore, docs } = createFirestoreDouble();
    const repository = new UsersRepository(firestore);

    docs.set('uid-1', { role: 'admin', disabled: false });

    await expect(repository.findById('uid-1')).rejects.toThrow();
  });
});

describe('toDocumentData', () => {
  it('drops the id and preserves every other field', () => {
    const data = toDocumentData({
      id: 'uid-1',
      email: 'ada@example.com',
      role: 'admin',
      disabled: false,
      audit: {
        createdAt: '2026-01-01T00:00:00.000Z',
        createdBy: 'seed',
        updatedAt: '2026-01-01T00:00:00.000Z',
        updatedBy: 'seed',
      },
    });

    expect(data).toEqual({
      email: 'ada@example.com',
      role: 'admin',
      disabled: false,
      audit: {
        createdAt: '2026-01-01T00:00:00.000Z',
        createdBy: 'seed',
        updatedAt: '2026-01-01T00:00:00.000Z',
        updatedBy: 'seed',
      },
    });
  });
});
