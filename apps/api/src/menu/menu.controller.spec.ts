import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { MenuEntry, UserRole } from '@speakukrainian/shared';
import { IS_PUBLIC_KEY } from '../auth/public.decorator.js';
import { ROLES_KEY } from '../auth/roles.decorator.js';
import { MenuController } from './menu.controller.js';
import type { MenuService } from './menu.service.js';

const entry: MenuEntry = {
  id: 'grammar',
  label: 'Grammar',
  href: '/grammar-points',
  openInNewTab: false,
  children: [],
};

describe('MenuController', () => {
  it('passes the locale query through to the service', async () => {
    const calls: unknown[] = [];
    const service = {
      menu: (query: unknown) => {
        calls.push(query);
        return Promise.resolve([entry]);
      },
    } as unknown as MenuService;

    const menu = await new MenuController(service).list({ locale: 'uk' });

    expect(menu).toEqual([entry]);
    expect(calls).toEqual([{ locale: 'uk' }]);
  });
});

describe('MenuController route metadata', () => {
  // Rule 8: `@Public()` is a deliberate opt-out, and dropping it compiles.
  // Asserting the metadata is what keeps the site's navigation reachable
  // anonymously, and keeps a role guard from being the thing that is missing.
  it('leaves the list route public and unrestricted', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, MenuController.prototype.list)).toBe(true);
    expect(
      Reflect.getMetadata(ROLES_KEY, MenuController.prototype.list) as UserRole[] | undefined,
    ).toBeUndefined();
  });

  it('has no route other than the read', () => {
    // A mutating route added here would inherit the controller's shape, where
    // `@Public()` is the norm rather than the exception.
    const handlers = Object.getOwnPropertyNames(MenuController.prototype).filter(
      (name) => name !== 'constructor',
    );

    expect(handlers).toEqual(['list']);
  });
});
