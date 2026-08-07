import 'reflect-metadata';
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { ContentPage, CreateContentPageInput, UserRole } from '@speakukrainian/shared';
import { IS_PUBLIC_KEY } from '../auth/public.decorator.js';
import { ROLES_KEY } from '../auth/roles.decorator.js';
import { PagesController } from './pages.controller.js';
import type { PagesService } from './pages.service.js';

const page: ContentPage = {
  id: 'page-id',
  sectionId: 'section-id',
  slug: 'intro',
  path: '/grammar-points/present-simple/intro',
  title: { en: 'Introduction' },
  body: { type: 'rich_text', content: { en: '<p>Hi</p>' }, audioAssets: [], imageAssets: [] },
  sortOrder: 0,
  status: 'draft',
  publishedAt: null,
  audit: {
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'editor',
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'editor',
  },
};

interface ServiceSpy {
  service: PagesService;
  calls: { method: string; args: unknown[] }[];
}

function createServiceSpy(): ServiceSpy {
  const calls: { method: string; args: unknown[] }[] = [];
  const record = <T>(method: string, result: T) => {
    return (...args: unknown[]): Promise<T> => {
      calls.push({ method, args });
      return Promise.resolve(result);
    };
  };

  const service = {
    list: record('list', { items: [page], nextCursor: null }),
    findById: record('findById', page),
    create: record('create', page),
    update: record('update', page),
    publish: record('publish', page),
    unpublish: record('unpublish', page),
    remove: record('remove', undefined),
  } as unknown as PagesService;

  return { service, calls };
}

const caller = { uid: 'editor-uid', email: 'ed@example.com', role: 'editor' as UserRole };

const newPage: CreateContentPageInput = {
  sectionId: 'section-id',
  slug: 'intro',
  title: { en: 'Introduction' },
  body: { type: 'rich_text', content: { en: '<p>Hi</p>' }, audioAssets: [], imageAssets: [] },
  status: 'draft',
};

describe('PagesController', () => {
  it('passes the parsed list query through', async () => {
    const { service, calls } = createServiceSpy();

    const result = await new PagesController(service).list({
      limit: 25,
      sectionId: 'section-id',
      type: 'rich_text',
    });

    expect(result.items.map((item) => item.id)).toEqual(['page-id']);
    expect(calls).toEqual([
      { method: 'list', args: [{ limit: 25, sectionId: 'section-id', type: 'rich_text' }] },
    ]);
  });

  it('reads one page by id', async () => {
    const { service, calls } = createServiceSpy();

    await new PagesController(service).findOne('page-id');

    expect(calls).toEqual([{ method: 'findById', args: ['page-id'] }]);
  });

  it('passes the caller uid as the actor on create, update, publish and unpublish', async () => {
    const { service, calls } = createServiceSpy();
    const controller = new PagesController(service);

    await controller.create(newPage, caller);
    await controller.update('page-id', { slug: 'intro-2' }, caller);
    await controller.publish('page-id', caller);
    await controller.unpublish('page-id', caller);

    expect(calls).toEqual([
      { method: 'create', args: [newPage, 'editor-uid'] },
      { method: 'update', args: ['page-id', { slug: 'intro-2' }, 'editor-uid'] },
      { method: 'publish', args: ['page-id', 'editor-uid'] },
      { method: 'unpublish', args: ['page-id', 'editor-uid'] },
    ]);
  });

  it('delegates a delete by id', async () => {
    const { service, calls } = createServiceSpy();

    await new PagesController(service).remove('page-id');

    expect(calls).toEqual([{ method: 'remove', args: ['page-id'] }]);
  });

  it.each([
    ['create', (c: PagesController) => c.create(newPage)],
    ['update', (c: PagesController) => c.update('page-id', {})],
    ['publish', (c: PagesController) => c.publish('page-id')],
    ['unpublish', (c: PagesController) => c.unpublish('page-id')],
  ])('rejects %s with no verified caller attached', (_name, invoke) => {
    const { service } = createServiceSpy();
    const controller = new PagesController(service);

    expect(() => invoke(controller)).toThrow(UnauthorizedException);
  });
});

describe('PagesController route metadata', () => {
  // Rule 8: every mutating route carries a role guard, and `@Public()` is the
  // deliberate opt-out. Asserting the metadata keeps a dropped decorator from
  // silently opening or closing a route — it compiles either way.
  const roles = (handler: object): UserRole[] | undefined =>
    Reflect.getMetadata(ROLES_KEY, handler) as UserRole[] | undefined;
  const isPublic = (handler: object): boolean | undefined =>
    Reflect.getMetadata(IS_PUBLIC_KEY, handler) as boolean | undefined;

  const handlers = {
    list: PagesController.prototype.list,
    findOne: PagesController.prototype.findOne,
    create: PagesController.prototype.create,
    update: PagesController.prototype.update,
    publish: PagesController.prototype.publish,
    unpublish: PagesController.prototype.unpublish,
    remove: PagesController.prototype.remove,
  };

  for (const [name, handler] of Object.entries(handlers)) {
    it(`restricts ${name} to editors`, () => {
      expect(roles(handler)).toEqual(['editor']);
    });

    it(`does not mark ${name} public`, () => {
      // The public site reads page content through its own projected endpoints,
      // which Phase 2 adds; nothing here is anonymous.
      expect(isPublic(handler)).toBeUndefined();
    });
  }
});
