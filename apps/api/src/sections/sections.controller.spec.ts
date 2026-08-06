import 'reflect-metadata';
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type {
  CreateSectionInput,
  Section,
  SectionTreeNode,
  UserRole,
} from '@speakukrainian/shared';
import { IS_PUBLIC_KEY } from '../auth/public.decorator.js';
import { ROLES_KEY } from '../auth/roles.decorator.js';
import { SectionsController } from './sections.controller.js';
import type { SectionsService } from './sections.service.js';

const root: Section = {
  id: 'root-id',
  parentId: null,
  ancestorIds: [],
  depth: 0,
  kind: 'content',
  slug: 'grammar-points',
  path: '/grammar-points',
  title: { en: 'Grammar points' },
  showInMenu: false,
  sortOrder: 0,
  status: 'draft',
  audit: {
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'editor',
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'editor',
  },
};

const tree: SectionTreeNode[] = [{ ...root, children: [] }];

interface ServiceSpy {
  service: SectionsService;
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
    tree: record('tree', tree),
    list: record('list', { items: [root], nextCursor: null }),
    findById: record('findById', root),
    create: record('create', root),
    update: record('update', root),
    move: record('move', root),
    remove: record('remove', undefined),
  } as unknown as SectionsService;

  return { service, calls };
}

const caller = { uid: 'editor-uid', email: 'ed@example.com', role: 'editor' as UserRole };

const newSection: CreateSectionInput = {
  parentId: null,
  kind: 'content',
  slug: 'grammar-points',
  title: { en: 'Grammar points' },
  showInMenu: false,
  status: 'draft',
};

describe('SectionsController', () => {
  it('returns the nested tree', async () => {
    const { service, calls } = createServiceSpy();

    await expect(new SectionsController(service).tree()).resolves.toEqual(tree);
    expect(calls).toEqual([{ method: 'tree', args: [] }]);
  });

  it('passes the parsed list query through', async () => {
    const { service, calls } = createServiceSpy();

    const page = await new SectionsController(service).list({ limit: 25, parentId: 'root' });

    expect(page.items.map((section) => section.id)).toEqual(['root-id']);
    expect(calls).toEqual([{ method: 'list', args: [{ limit: 25, parentId: 'root' }] }]);
  });

  it('reads one section by id', async () => {
    const { service, calls } = createServiceSpy();

    await new SectionsController(service).findOne('root-id');

    expect(calls).toEqual([{ method: 'findById', args: ['root-id'] }]);
  });

  it('passes the caller uid as the actor on create, update and move', async () => {
    const { service, calls } = createServiceSpy();
    const controller = new SectionsController(service);

    await controller.create(newSection, caller);
    await controller.update('root-id', { slug: 'grammar' }, caller);
    await controller.move('root-id', { parentId: null, sortOrder: 2 }, caller);

    expect(calls).toEqual([
      { method: 'create', args: [newSection, 'editor-uid'] },
      { method: 'update', args: ['root-id', { slug: 'grammar' }, 'editor-uid'] },
      { method: 'move', args: ['root-id', { parentId: null, sortOrder: 2 }, 'editor-uid'] },
    ]);
  });

  it('delegates a delete by id', async () => {
    const { service, calls } = createServiceSpy();

    await new SectionsController(service).remove('root-id');

    expect(calls).toEqual([{ method: 'remove', args: ['root-id'] }]);
  });

  it.each([
    ['create', (c: SectionsController) => c.create(newSection)],
    ['update', (c: SectionsController) => c.update('root-id', {})],
    ['move', (c: SectionsController) => c.move('root-id', { parentId: null, sortOrder: 0 })],
  ])('rejects %s with no verified caller attached', (_name, invoke) => {
    const { service } = createServiceSpy();
    const controller = new SectionsController(service);

    expect(() => invoke(controller)).toThrow(UnauthorizedException);
  });
});

describe('SectionsController route metadata', () => {
  // Rule 8: every mutating route carries a role guard, and `@Public()` is the
  // deliberate opt-out. Asserting the metadata keeps a dropped decorator from
  // silently opening or closing a route — it compiles either way.
  const roles = (handler: object): UserRole[] | undefined =>
    Reflect.getMetadata(ROLES_KEY, handler) as UserRole[] | undefined;
  const isPublic = (handler: object): boolean | undefined =>
    Reflect.getMetadata(IS_PUBLIC_KEY, handler) as boolean | undefined;

  const handlers = {
    tree: SectionsController.prototype.tree,
    list: SectionsController.prototype.list,
    findOne: SectionsController.prototype.findOne,
    create: SectionsController.prototype.create,
    update: SectionsController.prototype.update,
    move: SectionsController.prototype.move,
    remove: SectionsController.prototype.remove,
  };

  for (const [name, handler] of Object.entries(handlers)) {
    it(`restricts ${name} to editors`, () => {
      expect(roles(handler)).toEqual(['editor']);
    });

    it(`does not mark ${name} public`, () => {
      // The public site reads sections through its own projected endpoints;
      // nothing here is anonymous.
      expect(isPublic(handler)).toBeUndefined();
    });
  }
});
