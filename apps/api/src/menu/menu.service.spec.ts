import { UnprocessableEntityException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, type Locale, type Section } from '@speakukrainian/shared';
import type { LocalesService } from '../locales/locales.service.js';
import type { SectionsService } from '../sections/sections.service.js';
import { MenuService } from './menu.service.js';

const audit = {
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'editor',
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: 'editor',
};

const grammar: Section = {
  id: 'grammar',
  parentId: null,
  ancestorIds: [],
  depth: 0,
  kind: 'content',
  slug: 'grammar-points',
  path: '/grammar-points',
  title: { en: 'Grammar points', uk: 'Граматика' },
  menuLabel: { uk: 'Грам' },
  showInMenu: true,
  sortOrder: 0,
  status: 'published',
  audit,
};

function locale(code: string, isDefault: boolean): Locale {
  return {
    id: code,
    code,
    name: code,
    nativeName: code,
    direction: 'ltr',
    isDefault,
    enabled: true,
    sortOrder: 0,
    audit,
  };
}

function createService(options: { locales?: Locale[]; overflows?: boolean } = {}): MenuService {
  const sections = {
    menuSections: () =>
      options.overflows === true
        ? Promise.reject(
            new UnprocessableEntityException('The section tree is limited to 1000 sections'),
          )
        : Promise.resolve([grammar]),
  } as unknown as SectionsService;

  const locales = {
    list: () => Promise.resolve(options.locales ?? [locale('en', true), locale('uk', false)]),
  } as unknown as LocalesService;

  return new MenuService(sections, locales);
}

describe('MenuService', () => {
  it("uses the site's default locale when the query carries none", async () => {
    // `uk` is the default here, so the `uk` menu label proves which locale the
    // labels were resolved against.
    const service = createService({ locales: [locale('en', false), locale('uk', true)] });

    const menu = await service.menu({});

    expect(menu.map((entry) => entry.label)).toEqual(['Грам']);
  });

  it('resolves against the requested locale', async () => {
    const service = createService();

    const menu = await service.menu({ locale: 'uk' });

    expect(menu[0]?.label).toBe('Грам');
  });

  it('falls back to the default locale for a locale the section has nothing in', async () => {
    const service = createService();

    const menu = await service.menu({ locale: 'es' });

    expect(menu[0]?.label).toBe('Grammar points');
  });

  it('falls back to DEFAULT_LOCALE when no locale is flagged default', async () => {
    // A collection with no default is a data problem, and it must not turn every
    // anonymous read of the navigation into a 500.
    const service = createService({
      locales: [locale('uk', false), locale(DEFAULT_LOCALE, false)],
    });

    const menu = await service.menu({});

    expect(menu[0]?.label).toBe('Grammar points');
  });

  it('lets the overflow refusal through instead of answering a truncated menu', async () => {
    const service = createService({ overflows: true });

    await expect(service.menu({})).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});
