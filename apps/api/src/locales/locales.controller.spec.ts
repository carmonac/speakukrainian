import 'reflect-metadata';
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { Locale, UpdateLocaleInput, UserRole } from '@speakukrainian/shared';
import { IS_PUBLIC_KEY } from '../auth/public.decorator.js';
import { ROLES_KEY } from '../auth/roles.decorator.js';
import { LocalesController } from './locales.controller.js';
import type { LocalesService } from './locales.service.js';

const uk: Locale = {
  id: 'uk',
  code: 'uk',
  name: 'Ukrainian',
  nativeName: 'Українська',
  direction: 'ltr',
  isDefault: false,
  enabled: true,
  sortOrder: 2,
  audit: {
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'seed',
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'seed',
  },
};

interface ServiceSpy {
  service: LocalesService;
  calls: { method: string; args: unknown[] }[];
}

function createServiceSpy(): ServiceSpy {
  const calls: { method: string; args: unknown[] }[] = [];
  const record = <T>(method: string, result: T) => {
    return (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(result);
    };
  };

  const service = {
    list: record('list', [uk]),
    create: record('create', uk),
    update: record('update', uk),
    setDefault: record('setDefault', { ...uk, isDefault: true }),
    remove: record('remove', undefined),
  } as unknown as LocalesService;

  return { service, calls };
}

describe('LocalesController', () => {
  const caller = { uid: 'admin-uid', email: 'ada@example.com', role: 'admin' as UserRole };

  it('passes the enabled filter through to the service', async () => {
    const { service, calls } = createServiceSpy();

    const result = await new LocalesController(service).list({ enabled: true });

    expect(result.map((l) => l.code)).toEqual(['uk']);
    expect(calls).toEqual([{ method: 'list', args: [{ enabled: true }] }]);
  });

  it('rejects a create with no verified caller attached', () => {
    const { service } = createServiceSpy();
    const controller = new LocalesController(service);

    expect(() =>
      controller.create({
        code: 'pl',
        name: 'Polish',
        nativeName: 'Polski',
        direction: 'ltr',
        enabled: true,
        sortOrder: 3,
      }),
    ).toThrow(UnauthorizedException);
  });

  it('passes the caller uid as the actor on create, update and setDefault', async () => {
    const { service, calls } = createServiceSpy();
    const controller = new LocalesController(service);
    const patch: UpdateLocaleInput = { name: 'Ukrainian' };

    await controller.create(
      {
        code: 'pl',
        name: 'Polish',
        nativeName: 'Polski',
        direction: 'ltr',
        enabled: true,
        sortOrder: 3,
      },
      caller,
    );
    await controller.update('uk', patch, caller);
    await controller.setDefault('uk', caller);

    expect(calls.map((call) => [call.method, call.args[call.args.length - 1]])).toEqual([
      ['create', 'admin-uid'],
      ['update', 'admin-uid'],
      ['setDefault', 'admin-uid'],
    ]);
  });

  it('delegates a delete by code', async () => {
    const { service, calls } = createServiceSpy();

    await new LocalesController(service).remove('pl');

    expect(calls).toEqual([{ method: 'remove', args: ['pl'] }]);
  });
});

describe('LocalesController route metadata', () => {
  // Rule 8: every mutating route carries a role guard, and `@Public()` is the
  // deliberate opt-out. Asserting the metadata keeps a dropped decorator from
  // silently opening or closing a route — it compiles either way.
  const roles = (handler: object): UserRole[] | undefined =>
    Reflect.getMetadata(ROLES_KEY, handler) as UserRole[] | undefined;
  const isPublic = (handler: object): boolean | undefined =>
    Reflect.getMetadata(IS_PUBLIC_KEY, handler) as boolean | undefined;

  const mutating = {
    create: LocalesController.prototype.create,
    update: LocalesController.prototype.update,
    setDefault: LocalesController.prototype.setDefault,
    remove: LocalesController.prototype.remove,
  };

  for (const [name, handler] of Object.entries(mutating)) {
    it(`restricts ${name} to admins`, () => {
      expect(roles(handler)).toEqual(['admin']);
    });

    it(`does not mark ${name} public`, () => {
      expect(isPublic(handler)).toBeUndefined();
    });
  }

  it('leaves the list route public and unrestricted', () => {
    expect(isPublic(LocalesController.prototype.list)).toBe(true);
    expect(roles(LocalesController.prototype.list)).toBeUndefined();
  });
});
