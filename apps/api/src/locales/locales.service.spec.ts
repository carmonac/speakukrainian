import { ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  MAX_LOCALES,
  type CreateLocaleInput,
  type Locale,
  type UpdateLocaleInput,
} from '@speakukrainian/shared';
import { LocalesRepository } from './locales.repository.js';
import { LocalesService } from './locales.service.js';

interface RepositoryFake {
  repository: LocalesRepository;
  docs: Map<string, Locale>;
}

/**
 * Backed by a real map so seed idempotency is a property of the stored data
 * rather than of a mock's call count.
 */
function createRepositoryFake(seeded: Locale[] = []): RepositoryFake {
  const docs = new Map(seeded.map((locale) => [locale.code, locale]));
  const audit = (actorId: string) => ({
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: actorId,
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: actorId,
  });

  const repository = {
    list: () =>
      Promise.resolve(
        [...docs.values()].sort(
          (a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code),
        ),
      ),
    findById: (code: string) => Promise.resolve(docs.get(code) ?? null),
    create: (input: CreateLocaleInput, actorId: string, isDefault = false) => {
      if (docs.has(input.code)) {
        return Promise.resolve(null);
      }
      const created: Locale = { ...input, id: input.code, isDefault, audit: audit(actorId) };
      docs.set(input.code, created);
      return Promise.resolve(created);
    },
    update: (code: string, input: UpdateLocaleInput, actorId: string) => {
      const existing = docs.get(code);
      if (!existing) {
        return Promise.resolve(null);
      }
      const next: Locale = { ...existing, ...input, audit: audit(actorId) };
      docs.set(code, next);
      return Promise.resolve(next);
    },
    setDefault: (code: string, actorId: string) => {
      const target = docs.get(code);
      if (!target) {
        return Promise.resolve(null);
      }
      for (const [key, locale] of docs) {
        docs.set(key, { ...locale, isDefault: key === code });
      }
      const next: Locale = { ...target, isDefault: true, audit: audit(actorId) };
      docs.set(code, next);
      return Promise.resolve(next);
    },
    delete: (code: string) => {
      docs.delete(code);
      return Promise.resolve();
    },
  } as unknown as LocalesRepository;

  return { repository, docs };
}

function locale(code: string, overrides: Partial<Locale> = {}): Locale {
  return {
    id: code,
    code,
    name: code.toUpperCase(),
    nativeName: code.toUpperCase(),
    direction: 'ltr',
    isDefault: false,
    enabled: true,
    sortOrder: 0,
    audit: {
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'seed',
      updatedAt: '2026-01-01T00:00:00.000Z',
      updatedBy: 'seed',
    },
    ...overrides,
  };
}

describe('LocalesService.seed', () => {
  it('writes en, es and uk with en as the only default', async () => {
    const { repository, docs } = createRepositoryFake();
    const service = new LocalesService(repository);

    expect(await service.seed()).toBe(3);
    expect([...docs.keys()].sort()).toEqual(['en', 'es', 'uk']);
    expect([...docs.values()].filter((l) => l.isDefault).map((l) => l.code)).toEqual(['en']);
  });

  it('writes nothing on a second boot and leaves the documents identical', async () => {
    const { repository, docs } = createRepositoryFake();
    const service = new LocalesService(repository);
    await service.seed();
    const before = structuredClone([...docs.values()]);

    expect(await service.seed()).toBe(0);
    expect([...docs.values()]).toEqual(before);
  });

  it('does not resurrect en as the default after the admin moved it', async () => {
    const { repository, docs } = createRepositoryFake();
    const service = new LocalesService(repository);
    await service.seed();
    await service.setDefault('uk', 'admin-uid');

    await service.seed();

    expect(docs.get('en')?.isDefault).toBe(false);
    expect(docs.get('uk')?.isDefault).toBe(true);
  });

  it('does not resurrect a deleted seed locale as a second default', async () => {
    const { repository, docs } = createRepositoryFake();
    const service = new LocalesService(repository);
    await service.seed();
    await service.setDefault('uk', 'admin-uid');
    await service.remove('en');

    // A deploy after the admin moved the default and dropped the old one.
    expect(await service.seed()).toBe(1);

    expect(docs.get('en')?.isDefault).toBe(false);
    expect([...docs.values()].filter((l) => l.isDefault).map((l) => l.code)).toEqual(['uk']);
  });

  it('claims the default only on an empty collection', async () => {
    const { repository, docs } = createRepositoryFake([locale('pl', { isDefault: true })]);
    const service = new LocalesService(repository);

    await service.seed();

    expect(docs.get('en')?.isDefault).toBe(false);
    expect([...docs.values()].filter((l) => l.isDefault).map((l) => l.code)).toEqual(['pl']);
  });

  it('stops at the cap the list query reads to', async () => {
    // Seeding past the cap would hide the extra document from the admin, the
    // residual half of the same hole `create` closes.
    const full = Array.from({ length: MAX_LOCALES }, (_, index) =>
      locale(`x${index}`, { sortOrder: index, isDefault: index === 0 }),
    );
    const { repository, docs } = createRepositoryFake(full);

    expect(await new LocalesService(repository).seed()).toBe(0);
    expect(docs.size).toBe(MAX_LOCALES);
  });

  it('seeds only as far as the cap allows', async () => {
    const nearlyFull = Array.from({ length: MAX_LOCALES - 1 }, (_, index) =>
      locale(`x${index}`, { sortOrder: index, isDefault: index === 0 }),
    );
    const { repository, docs } = createRepositoryFake(nearlyFull);

    expect(await new LocalesService(repository).seed()).toBe(1);
    expect(docs.size).toBe(MAX_LOCALES);
    expect(docs.has('en')).toBe(true);
    expect(docs.has('es')).toBe(false);
  });

  it('does not throw out of onModuleInit when the repository fails', async () => {
    const failing = {
      list: () => Promise.reject(new Error('firestore unavailable')),
      create: () => Promise.reject(new Error('firestore unavailable')),
    } as unknown as LocalesRepository;

    await expect(new LocalesService(failing).onModuleInit()).resolves.toBeUndefined();
  });
});

describe('LocalesService.list', () => {
  const seeded = [
    locale('en', { isDefault: true, sortOrder: 0 }),
    locale('es', { enabled: false, sortOrder: 1 }),
    locale('uk', { sortOrder: 2 }),
  ];

  it('returns everything when no filter is asked for', async () => {
    const { repository } = createRepositoryFake(seeded);
    const result = await new LocalesService(repository).list({});
    expect(result.map((l) => l.code)).toEqual(['en', 'es', 'uk']);
  });

  it('drops disabled locales for enabled=true', async () => {
    const { repository } = createRepositoryFake(seeded);
    const result = await new LocalesService(repository).list({ enabled: true });
    expect(result.map((l) => l.code)).toEqual(['en', 'uk']);
  });

  it('treats enabled=false as no filter', async () => {
    const { repository } = createRepositoryFake(seeded);
    const result = await new LocalesService(repository).list({ enabled: false });
    expect(result.map((l) => l.code)).toEqual(['en', 'es', 'uk']);
  });
});

describe('LocalesService mutations', () => {
  const seeded = () => [
    locale('en', { isDefault: true, sortOrder: 0 }),
    locale('es', { sortOrder: 1 }),
    locale('uk', { enabled: false, sortOrder: 2 }),
  ];

  it('refuses a duplicate code with a conflict', async () => {
    const { repository } = createRepositoryFake(seeded());
    const service = new LocalesService(repository);

    await expect(
      service.create(
        {
          code: 'es',
          name: 'Spanish',
          nativeName: 'Español',
          direction: 'ltr',
          enabled: true,
          sortOrder: 3,
        },
        'admin-uid',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('creates a new code', async () => {
    const { repository, docs } = createRepositoryFake(seeded());
    const service = new LocalesService(repository);

    const created = await service.create(
      {
        code: 'pl',
        name: 'Polish',
        nativeName: 'Polski',
        direction: 'ltr',
        enabled: true,
        sortOrder: 3,
      },
      'admin-uid',
    );

    expect(created.code).toBe('pl');
    expect(created.isDefault).toBe(false);
    expect(docs.get('pl')?.audit.createdBy).toBe('admin-uid');
  });

  it('refuses to create past the cap the list query reads to', async () => {
    // Past the cap the list truncates: the extra locales would be invisible to
    // the admin and a default outside the window would never be cleared.
    const full = Array.from({ length: MAX_LOCALES }, (_, index) =>
      locale(`x${index}`, { sortOrder: index, isDefault: index === 0 }),
    );
    const { repository, docs } = createRepositoryFake(full);
    const service = new LocalesService(repository);

    await expect(
      service.create(
        {
          code: 'pl',
          name: 'Polish',
          nativeName: 'Polski',
          direction: 'ltr',
          enabled: true,
          sortOrder: 3,
        },
        'admin-uid',
      ),
    ).rejects.toThrow(/limited to 100 locales/i);
    expect(docs.size).toBe(MAX_LOCALES);
  });

  it('refuses to disable the default locale and says why', async () => {
    const { repository, docs } = createRepositoryFake(seeded());
    const service = new LocalesService(repository);

    await expect(service.update('en', { enabled: false }, 'admin-uid')).rejects.toThrow(
      /default locale cannot be disabled/i,
    );
    expect(docs.get('en')?.enabled).toBe(true);
  });

  it('disables a non-default locale', async () => {
    const { repository, docs } = createRepositoryFake(seeded());
    const service = new LocalesService(repository);

    const updated = await service.update('es', { enabled: false }, 'admin-uid');

    expect(updated.enabled).toBe(false);
    expect(docs.get('es')?.enabled).toBe(false);
  });

  it('refuses to make a disabled locale the default', async () => {
    const { repository, docs } = createRepositoryFake(seeded());
    const service = new LocalesService(repository);

    await expect(service.setDefault('uk', 'admin-uid')).rejects.toThrow(/Enable it first/i);
    expect(docs.get('en')?.isDefault).toBe(true);
  });

  it('moves the default to an enabled locale', async () => {
    const { repository, docs } = createRepositoryFake(seeded());
    const service = new LocalesService(repository);

    const updated = await service.setDefault('es', 'admin-uid');

    expect(updated.isDefault).toBe(true);
    expect([...docs.values()].filter((l) => l.isDefault).map((l) => l.code)).toEqual(['es']);
  });

  it('refuses to delete the default locale with a readable message', async () => {
    const { repository, docs } = createRepositoryFake(seeded());
    const service = new LocalesService(repository);

    await expect(service.remove('en')).rejects.toThrow(
      'Locale "en" is the default and cannot be deleted. Make another locale the default first.',
    );
    expect(docs.has('en')).toBe(true);
  });

  it('deletes a non-default locale', async () => {
    const { repository, docs } = createRepositoryFake(seeded());
    const service = new LocalesService(repository);

    await service.remove('es');

    expect(docs.has('es')).toBe(false);
  });

  it('reports an unknown code as not found', async () => {
    const { repository } = createRepositoryFake(seeded());
    const service = new LocalesService(repository);

    await expect(service.update('zz', { name: 'Nope' }, 'admin-uid')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.setDefault('zz', 'admin-uid')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.remove('zz')).rejects.toBeInstanceOf(NotFoundException);
  });
});
