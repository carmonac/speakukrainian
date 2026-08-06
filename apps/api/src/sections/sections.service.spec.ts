import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { CreateSectionInput, Section, UpdateSectionInput } from '@speakukrainian/shared';
import { RichTextSanitizer } from '../common/rich-text.sanitizer.js';
import {
  MAX_TREE_SECTIONS,
  type SectionDeleteResult,
  type SectionListResult,
  type SectionWriteFailure,
  type SectionWriteResult,
  type SectionsRepository,
} from './sections.repository.js';
import { SectionsService } from './sections.service.js';

const audit = {
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'editor',
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: 'editor',
};

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
  audit,
};

const child: Section = {
  ...root,
  id: 'child-id',
  parentId: 'root-id',
  ancestorIds: ['root-id'],
  depth: 1,
  slug: 'present-simple',
  path: '/grammar-points/present-simple',
  title: { en: 'Present simple' },
};

interface RecordedCall {
  method: string;
  args: unknown[];
}

interface RepositoryDouble {
  repository: SectionsRepository;
  calls: RecordedCall[];
}

/**
 * The recorder keeps one flat list, so an assertion on `calls[0]` would follow
 * whichever method happened to run first. Selecting by name and demanding
 * exactly one call keeps the assertion pinned to the call it is about.
 */
function onlyCallTo(calls: RecordedCall[], method: string): RecordedCall {
  const matching = calls.filter((call) => call.method === method);
  expect(matching).toHaveLength(1);
  return matching[0]!;
}

interface DoubleResults {
  write?: SectionWriteResult;
  remove?: SectionDeleteResult;
  tree?: SectionListResult;
  menu?: SectionListResult;
}

function createRepository(results: DoubleResults = {}): RepositoryDouble {
  const calls: RecordedCall[] = [];
  const record = <T>(method: string, result: T) => {
    return (...args: unknown[]): Promise<T> => {
      calls.push({ method, args });
      return Promise.resolve(result);
    };
  };

  const write: SectionWriteResult = results.write ?? { ok: true, section: root };
  const repository = {
    create: record('create', write),
    update: record('update', write),
    move: record('move', write),
    remove: record('remove', results.remove ?? { ok: true }),
    list: record('list', { items: [root], nextCursor: null }),
    findByIdOrFail: record('findByIdOrFail', root),
    listAllForTree: record('listAllForTree', results.tree ?? { ok: true, sections: [root, child] }),
    listForMenu: record('listForMenu', results.menu ?? { ok: true, sections: [root] }),
  } as unknown as SectionsRepository;

  return { repository, calls };
}

function createService(results: DoubleResults = {}): {
  service: SectionsService;
  calls: RecordedCall[];
} {
  const { repository, calls } = createRepository(results);
  // A real sanitizer: it is pure and fast, and a double would let the wiring rot.
  return { service: new SectionsService(repository, new RichTextSanitizer()), calls };
}

const newSection: CreateSectionInput = {
  parentId: null,
  kind: 'content',
  slug: 'grammar-points',
  title: { en: 'Grammar points' },
  showInMenu: false,
  status: 'draft',
};

describe('SectionsService rich text', () => {
  it('strips a script out of the description before the repository sees it', async () => {
    const { service, calls } = createService();

    await service.create(
      { ...newSection, description: { en: '<p>a</p><script>alert(1)</script>' } },
      'editor-uid',
    );

    const call = onlyCallTo(calls, 'create');
    expect((call.args[0] as CreateSectionInput).description).toEqual({ en: '<p>a</p>' });
  });

  it('strips a script out of a patched description too', async () => {
    const { service, calls } = createService();

    await service.update('root-id', { description: { uk: '<script>x</script><p>б</p>' } }, 'uid');

    const call = onlyCallTo(calls, 'update');
    expect(call.args[0]).toBe('root-id');
    expect((call.args[1] as UpdateSectionInput).description).toEqual({ uk: '<p>б</p>' });
  });

  it('leaves the fields a patch omits out of what the repository receives', async () => {
    // The repository merges the patch over the stored document, so a key the
    // request never carried must not arrive here: a `status` of `draft` added
    // on the way through would unpublish a live section on a title edit.
    const { service, calls } = createService();

    await service.update('root-id', { title: { en: 'Renamed' } }, 'uid');

    const patch = onlyCallTo(calls, 'update').args[1] as UpdateSectionInput;
    expect(patch.status).toBeUndefined();
    expect(patch.showInMenu).toBeUndefined();
    expect(patch.kind).toBeUndefined();
  });

  it('leaves an absent description absent rather than materialising an empty record', async () => {
    const { service, calls } = createService();

    await service.create(newSection, 'editor-uid');

    const call = onlyCallTo(calls, 'create');
    expect((call.args[0] as CreateSectionInput).description).toBeUndefined();
  });

  it('does not touch the plain-text title', async () => {
    // `title` is `localizedTextSchema`, not rich text: sanitizing it would
    // store "Tom &amp; Jerry" and render the escape literally.
    const { service, calls } = createService();

    await service.create({ ...newSection, title: { en: 'Tom & Jerry' } }, 'editor-uid');

    const call = onlyCallTo(calls, 'create');
    expect((call.args[0] as CreateSectionInput).title).toEqual({ en: 'Tom & Jerry' });
  });
});

describe('SectionsService failure mapping', () => {
  const cases: [SectionWriteFailure, new (...args: never[]) => Error, number][] = [
    [{ reason: 'not-found' }, NotFoundException, 404],
    [{ reason: 'parent-not-found', parentId: 'gone' }, NotFoundException, 404],
    [{ reason: 'slug-taken', slug: 'duplicate' }, ConflictException, 409],
    [{ reason: 'has-children' }, ConflictException, 409],
    [{ reason: 'depth-exceeded', depth: 5 }, UnprocessableEntityException, 422],
    [{ reason: 'move-into-descendant' }, UnprocessableEntityException, 422],
    [{ reason: 'subtree-too-large', limit: 499 }, UnprocessableEntityException, 422],
    [{ reason: 'invalid', issues: [] }, UnprocessableEntityException, 422],
  ];

  for (const [failure, exception, status] of cases) {
    it(`answers ${status} for ${failure.reason}`, async () => {
      const { service } = createService({ write: { ok: false, ...failure } });

      const thrown = await service.create(newSection, 'uid').catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(exception);
      expect((thrown as UnprocessableEntityException).getStatus()).toBe(status);
    });
  }

  it('names the conflicting slug in the 409', async () => {
    const { service } = createService({
      write: { ok: false, reason: 'slug-taken', slug: 'taken' },
    });

    await expect(service.create(newSection, 'uid')).rejects.toThrow(/taken/);
  });

  it('reports a delete conflict rather than swallowing it', async () => {
    const { service } = createService({ remove: { ok: false, reason: 'has-children' } });

    await expect(service.remove('root-id')).rejects.toBeInstanceOf(ConflictException);
  });

  it('passes the zod issues through on the errors key', async () => {
    const { service } = createService({
      write: {
        ok: false,
        reason: 'invalid',
        issues: [{ code: 'custom', path: ['link'], message: 'A `link` section requires a target' }],
      },
    });

    const thrown = (await service
      .create(newSection, 'uid')
      .catch((error: unknown) => error)) as UnprocessableEntityException;

    expect(thrown.getResponse()).toMatchObject({
      errors: [{ path: 'link', message: 'A `link` section requires a target', code: 'custom' }],
    });
  });
});

describe('SectionsService tree', () => {
  it('nests the repository rows through buildTree', async () => {
    const { service } = createService();

    const tree = await service.tree();

    expect(tree.map((node) => node.id)).toEqual(['root-id']);
    expect(tree[0]?.children.map((node) => node.id)).toEqual(['child-id']);
  });

  it('refuses an overflowing collection instead of returning a truncated tree', async () => {
    const { service } = createService({ tree: { ok: false, overflow: true } });

    await expect(service.tree()).rejects.toThrow(String(MAX_TREE_SECTIONS));
  });
});

describe('SectionsService menu sections', () => {
  it('answers with the repository rows flat, for the menu builder to nest', async () => {
    const { service, calls } = createService({ menu: { ok: true, sections: [root, child] } });

    const sections = await service.menuSections();

    expect(sections.map((section) => section.id)).toEqual(['root-id', 'child-id']);
    expect(onlyCallTo(calls, 'listForMenu').args).toEqual([]);
  });

  it('refuses an overflowing menu query with the same message the tree uses', async () => {
    const { service } = createService({ menu: { ok: false, overflow: true } });

    const thrown = (await service
      .menuSections()
      .catch((error: unknown) => error)) as UnprocessableEntityException;

    expect(thrown).toBeInstanceOf(UnprocessableEntityException);
    expect(thrown.message).toContain(String(MAX_TREE_SECTIONS));
  });
});

describe('SectionsService delegation', () => {
  it('passes the list query straight through', async () => {
    const { service, calls } = createService();

    const page = await service.list({ limit: 10, parentId: 'root', status: 'draft' });

    expect(page.items.map((section) => section.id)).toEqual(['root-id']);
    expect(calls).toEqual([
      { method: 'list', args: [{ limit: 10, parentId: 'root', status: 'draft' }] },
    ]);
  });

  it('reads one section by id', async () => {
    const { service, calls } = createService();

    await expect(service.findById('root-id')).resolves.toEqual(root);
    expect(calls).toEqual([{ method: 'findByIdOrFail', args: ['root-id'] }]);
  });

  it('passes the actor and the move body to the repository', async () => {
    const { service, calls } = createService();

    await service.move('child-id', { parentId: null, sortOrder: 3 }, 'editor-uid');

    expect(calls).toEqual([
      { method: 'move', args: ['child-id', { parentId: null, sortOrder: 3 }, 'editor-uid'] },
    ]);
  });
});
