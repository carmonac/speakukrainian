import { describe, expect, it } from 'vitest';
import {
  createLocaleSchema,
  listLocalesQuerySchema,
  localeSchema,
  updateLocaleSchema,
} from './locale.js';

describe('createLocaleSchema', () => {
  it('applies the stored defaults for the fields a create body may omit', () => {
    expect(createLocaleSchema.parse({ code: 'pl', name: 'Polish', nativeName: 'Polski' })).toEqual({
      code: 'pl',
      name: 'Polish',
      nativeName: 'Polski',
      direction: 'ltr',
      enabled: true,
      sortOrder: 0,
    });
  });

  it('rejects a name longer than the cap', () => {
    expect(
      createLocaleSchema.safeParse({
        code: 'pl',
        name: 'P'.repeat(101),
        nativeName: 'Polski',
      }).success,
    ).toBe(false);
  });
});

describe('updateLocaleSchema', () => {
  it('returns only the fields the request carried', () => {
    const parsed = updateLocaleSchema.parse({ name: 'Hebrew (Israel)' });

    // The defaulted fields must not appear: a PATCH that reached the repository
    // with `direction`, `enabled` and `sortOrder` filled in would reset an RTL,
    // disabled, hand-ordered locale to ltr / enabled / 0.
    expect(parsed).toEqual({ name: 'Hebrew (Israel)' });
    expect(Object.keys(parsed)).toEqual(['name']);
  });

  it('leaves the other fields out of a sortOrder-only reorder patch', () => {
    expect(updateLocaleSchema.parse({ sortOrder: 3 })).toEqual({ sortOrder: 3 });
  });

  it('leaves the other fields out of an enabled-only toggle patch', () => {
    expect(updateLocaleSchema.parse({ enabled: false })).toEqual({ enabled: false });
  });

  it('accepts an empty patch without inventing any field', () => {
    expect(updateLocaleSchema.parse({})).toEqual({});
  });

  it('keeps the values a full patch does carry', () => {
    expect(
      updateLocaleSchema.parse({
        name: 'Hebrew',
        nativeName: 'עברית',
        direction: 'rtl',
        enabled: false,
        sortOrder: 42,
      }),
    ).toEqual({
      name: 'Hebrew',
      nativeName: 'עברית',
      direction: 'rtl',
      enabled: false,
      sortOrder: 42,
    });
  });

  it('strips a code, which is the document id and cannot move', () => {
    expect(updateLocaleSchema.parse({ code: 'zz', name: 'Zed' })).toEqual({ name: 'Zed' });
  });

  it('rejects an invalid value for a field it does carry', () => {
    expect(updateLocaleSchema.safeParse({ direction: 'sideways' }).success).toBe(false);
    expect(updateLocaleSchema.safeParse({ sortOrder: 1.5 }).success).toBe(false);
    expect(updateLocaleSchema.safeParse({ name: '' }).success).toBe(false);
    expect(updateLocaleSchema.safeParse({ nativeName: 'N'.repeat(101) }).success).toBe(false);
  });
});

describe('localeSchema', () => {
  const audit = {
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'seed',
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'seed',
  };

  it('defaults a stored document that predates the flags', () => {
    expect(localeSchema.parse({ id: 'uk', code: 'uk', name: 'U', nativeName: 'У', audit })).toEqual({
      id: 'uk',
      code: 'uk',
      name: 'U',
      nativeName: 'У',
      direction: 'ltr',
      isDefault: false,
      enabled: true,
      sortOrder: 0,
      audit,
    });
  });
});

describe('listLocalesQuerySchema', () => {
  it('reads the string "false" as false rather than as a truthy string', () => {
    expect(listLocalesQuerySchema.parse({ enabled: 'false' })).toEqual({ enabled: false });
    expect(listLocalesQuerySchema.parse({ enabled: 'true' })).toEqual({ enabled: true });
    expect(listLocalesQuerySchema.parse({})).toEqual({});
  });
});
