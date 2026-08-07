import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type {
  ContentPage,
  CreateContentPageInput,
  RichTextPageBody,
  SubsectionListPageBody,
  H5pExercisePageBody,
  UpdateContentPageInput,
} from '@speakukrainian/shared';
import { RichTextSanitizer } from '../common/rich-text.sanitizer.js';
import type {
  PageDeleteResult,
  PageWriteFailure,
  PageWriteResult,
  PagesRepository,
} from './pages.repository.js';
import { PagesService } from './pages.service.js';

const audit = {
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'editor',
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: 'editor',
};

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
  audit,
};

interface RecordedCall {
  method: string;
  args: unknown[];
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
  write?: PageWriteResult;
  remove?: PageDeleteResult;
}

function createService(results: DoubleResults = {}): {
  service: PagesService;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const record = <T>(method: string, result: T) => {
    return (...args: unknown[]): Promise<T> => {
      calls.push({ method, args });
      return Promise.resolve(result);
    };
  };

  const write: PageWriteResult = results.write ?? { ok: true, page };
  const repository = {
    create: record('create', write),
    update: record('update', write),
    remove: record('remove', results.remove ?? { ok: true }),
    list: record('list', { items: [page], nextCursor: null }),
    findByIdOrFail: record('findByIdOrFail', page),
  } as unknown as PagesRepository;

  // A real sanitizer: it is pure and fast, and a double would let the wiring rot.
  return { service: new PagesService(repository, new RichTextSanitizer()), calls };
}

const newPage: CreateContentPageInput = {
  sectionId: 'section-id',
  slug: 'intro',
  title: { en: 'Introduction' },
  body: { type: 'rich_text', content: { en: '<p>Hi</p>' }, audioAssets: [], imageAssets: [] },
  status: 'draft',
};

const AUDIO =
  '<audio controls preload="metadata" src="https://cdn.test/a.mp3" data-asset-path="audio/2026/01/a.mp3"></audio>';

function expectAudioSurvived(html: string): void {
  expect(html).not.toContain('<script');
  expect(html).not.toContain('alert(1)');
  expect(html).toContain('src="https://cdn.test/a.mp3"');
  expect(html).toContain('data-asset-path="audio/2026/01/a.mp3"');
  expect(html).toContain('controls');
  expect(html).toContain('preload="metadata"');
}

describe('PagesService rich text', () => {
  it('strips a script out of a rich text body before the repository sees it', async () => {
    const { service, calls } = createService();

    await service.create(
      {
        ...newPage,
        body: {
          type: 'rich_text',
          content: { en: `<p>ok</p><script>alert(1)</script>${AUDIO}` },
          audioAssets: [],
          imageAssets: [],
        },
      },
      'editor-uid',
    );

    const body = (onlyCallTo(calls, 'create').args[0] as CreateContentPageInput)
      .body as RichTextPageBody;
    expectAudioSurvived(body.content['en'] ?? '');
  });

  it('strips a script out of a patched subsection list intro', async () => {
    const { service, calls } = createService();

    await service.update(
      'page-id',
      {
        body: {
          type: 'subsection_list',
          intro: { uk: `<script>alert(1)</script><p>б</p>${AUDIO}` },
          layout: 'grid',
          showImages: true,
          showDescriptions: true,
        },
      },
      'uid',
    );

    const call = onlyCallTo(calls, 'update');
    expect(call.args[0]).toBe('page-id');
    const body = (call.args[1] as UpdateContentPageInput).body as SubsectionListPageBody;
    expect(body.intro?.['uk']).toContain('<p>б</p>');
    expectAudioSurvived(body.intro?.['uk'] ?? '');
  });

  it('strips a script out of an H5P explanation', async () => {
    const { service, calls } = createService();

    await service.create(
      {
        ...newPage,
        body: {
          type: 'h5p_exercise',
          h5pContentId: 'h5p-1',
          explanation: { en: `<p>ok</p><script>alert(1)</script>${AUDIO}` },
          explanationPosition: 'above',
          trackResults: false,
        },
      },
      'editor-uid',
    );

    const body = (onlyCallTo(calls, 'create').args[0] as CreateContentPageInput)
      .body as H5pExercisePageBody;
    expectAudioSurvived(body.explanation?.['en'] ?? '');
  });

  it('does not touch the plain-text title or the seo text', async () => {
    // Both are `localizedTextSchema`, not rich text: sanitizing them would
    // store "Tom &amp; Jerry" and render the escape literally.
    const { service, calls } = createService();

    await service.create(
      {
        ...newPage,
        title: { en: 'Tom & Jerry' },
        seo: {
          metaTitle: { en: 'Tom & Jerry' },
          metaDescription: { en: 'A & B' },
          noIndex: false,
        },
      },
      'editor-uid',
    );

    const input = onlyCallTo(calls, 'create').args[0] as CreateContentPageInput;
    expect(input.title).toEqual({ en: 'Tom & Jerry' });
    expect(input.seo?.metaTitle).toEqual({ en: 'Tom & Jerry' });
    expect(input.seo?.metaDescription).toEqual({ en: 'A & B' });
  });

  it('leaves an absent explanation absent rather than materialising an empty record', async () => {
    const { service, calls } = createService();

    await service.create(
      {
        ...newPage,
        body: {
          type: 'h5p_exercise',
          h5pContentId: null,
          explanationPosition: 'above',
          trackResults: false,
        },
      },
      'editor-uid',
    );

    const body = (onlyCallTo(calls, 'create').args[0] as CreateContentPageInput)
      .body as H5pExercisePageBody;
    expect(body.explanation).toBeUndefined();
  });

  it('leaves a patch that carries no body without a body key', async () => {
    // A `body: undefined` spread into the patch would clobber the stored body:
    // the repository merges the patch over the document it read.
    const { service, calls } = createService();

    await service.update('page-id', { title: { en: 'Renamed' } }, 'uid');

    const patch = onlyCallTo(calls, 'update').args[1] as UpdateContentPageInput;
    expect(patch.body).toBeUndefined();
    expect(Object.keys(patch)).toEqual(['title']);
  });
});

describe('PagesService publishing', () => {
  it('publishes through the same write path a PATCH uses', async () => {
    // One write path is what keeps `publishedAt` and the H5P refinement from
    // disagreeing between `POST /publish` and `PATCH { status }`.
    const { service, calls } = createService();

    await service.publish('page-id', 'editor-uid');

    expect(onlyCallTo(calls, 'update').args).toEqual([
      'page-id',
      { status: 'published' },
      'editor-uid',
    ]);
  });

  it('unpublishes back to draft and carries nothing else', async () => {
    const { service, calls } = createService();

    await service.unpublish('page-id', 'editor-uid');

    expect(onlyCallTo(calls, 'update').args).toEqual([
      'page-id',
      { status: 'draft' },
      'editor-uid',
    ]);
  });
});

describe('PagesService failure mapping', () => {
  const cases: [PageWriteFailure, new (...args: never[]) => Error, number][] = [
    [{ reason: 'not-found' }, NotFoundException, 404],
    [{ reason: 'section-not-found', sectionId: 'gone' }, NotFoundException, 404],
    [{ reason: 'section-is-link' }, UnprocessableEntityException, 422],
    [{ reason: 'slug-taken', slug: 'duplicate' }, ConflictException, 409],
    [{ reason: 'invalid', issues: [] }, UnprocessableEntityException, 422],
  ];

  for (const [failure, exception, status] of cases) {
    it(`answers ${status} for ${failure.reason}`, async () => {
      const { service } = createService({ write: { ok: false, ...failure } });

      const thrown = await service.create(newPage, 'uid').catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(exception);
      expect((thrown as UnprocessableEntityException).getStatus()).toBe(status);
    });
  }

  it('names the missing section in the 404', async () => {
    const { service } = createService({
      write: { ok: false, reason: 'section-not-found', sectionId: 'gone-id' },
    });

    await expect(service.create(newPage, 'uid')).rejects.toThrow(/gone-id/);
  });

  it('names the conflicting slug in the 409', async () => {
    const { service } = createService({
      write: { ok: false, reason: 'slug-taken', slug: 'taken' },
    });

    await expect(service.create(newPage, 'uid')).rejects.toThrow(/taken/);
  });

  it('reports a delete failure rather than swallowing it', async () => {
    const { service } = createService({ remove: { ok: false, reason: 'not-found' } });

    await expect(service.remove('page-id')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('passes the H5P refinement through on the errors key', async () => {
    const { service } = createService({
      write: {
        ok: false,
        reason: 'invalid',
        issues: [
          {
            code: 'custom',
            path: ['body', 'h5pContentId'],
            message: 'An H5P page cannot be published before its H5P content is uploaded',
          },
        ],
      },
    });

    const thrown = (await service
      .publish('page-id', 'uid')
      .catch((error: unknown) => error)) as UnprocessableEntityException;

    expect(thrown.getResponse()).toMatchObject({
      errors: [
        {
          path: 'body.h5pContentId',
          message: 'An H5P page cannot be published before its H5P content is uploaded',
          code: 'custom',
        },
      ],
    });
  });
});

describe('PagesService delegation', () => {
  it('passes the list query straight through', async () => {
    const { service, calls } = createService();

    const result = await service.list({ limit: 10, sectionId: 'section-id', status: 'draft' });

    expect(result.items.map((item) => item.id)).toEqual(['page-id']);
    expect(calls).toEqual([
      { method: 'list', args: [{ limit: 10, sectionId: 'section-id', status: 'draft' }] },
    ]);
  });

  it('reads one page by id', async () => {
    const { service, calls } = createService();

    await expect(service.findById('page-id')).resolves.toEqual(page);
    expect(calls).toEqual([{ method: 'findByIdOrFail', args: ['page-id'] }]);
  });

  it('deletes by id', async () => {
    const { service, calls } = createService();

    await service.remove('page-id');

    expect(calls).toEqual([{ method: 'remove', args: ['page-id'] }]);
  });
});
