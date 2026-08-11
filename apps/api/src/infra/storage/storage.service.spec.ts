import { Readable } from 'node:stream';
import { ConfigService } from '@nestjs/config';
import type { Bucket, GetFilesOptions, GetFilesResponse, Storage } from '@google-cloud/storage';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../config/configuration.js';
import { MAX_STORAGE_LIST_RESULTS, StorageService } from './storage.service.js';

const BUCKET = 'speakukrainian-media';

interface FakeObject {
  name: string;
  size?: number;
  timeCreated?: string;
}

interface FakePage {
  objects: FakeObject[];
  prefixes?: string[];
}

/** The slice of the SDK's request options the service is allowed to change. */
interface FakeRequestOptions {
  uri: string;
  maxRetries?: number;
}

interface FakeInterceptor {
  request: (options: FakeRequestOptions) => FakeRequestOptions;
}

/** The request options a file's interceptors leave behind them. */
function decorate(interceptors: FakeInterceptor[], path: string): FakeRequestOptions {
  return interceptors.reduce<FakeRequestOptions>(
    (decorated, interceptor) => interceptor.request(decorated),
    { uri: path },
  );
}

interface FakeBucket {
  /** Every `getFiles` query the service issued, in order. */
  queries: GetFilesOptions[];
  deleted: string[];
  saved: {
    path: string;
    body: unknown;
    options: Record<string, unknown>;
    /** The request options this write would have gone out with. */
    request: FakeRequestOptions;
  }[];
}

/**
 * A `Storage` client that serves a fixed sequence of pages, one per `getFiles`
 * call, linking them with page tokens the way the real client does. It never
 * concatenates for the caller, so a service that fails to follow `nextQuery`
 * sees only the first page — which is the bug these tests exist to catch.
 */
function fakeStorage(pages: FakePage[]): { storage: Storage; state: FakeBucket } {
  const state: FakeBucket = { queries: [], deleted: [], saved: [] };

  const file = (path: string) => {
    const interceptors: FakeInterceptor[] = [];

    return {
      interceptors,
      delete: (): Promise<unknown[]> => {
        state.deleted.push(path);
        return Promise.resolve([]);
      },
      save: (body: unknown, options: Record<string, unknown>): Promise<void> => {
        state.saved.push({ path, body, options, request: decorate(interceptors, path) });
        return Promise.resolve();
      },
      exists: (): Promise<[boolean]> =>
        Promise.resolve([
          pages.some((page) => page.objects.some((object) => object.name === path)),
        ]),
      getMetadata: (): Promise<[FakeObject]> => {
        const found = pages
          .flatMap((page) => page.objects)
          .find((object) => object.name === path) ?? { name: path };
        return Promise.resolve([found]);
      },
      createReadStream: (options?: unknown): Readable =>
        Readable.from([
          JSON.stringify({
            path,
            options,
            // What the client would actually send, once this file's own
            // interceptors have decorated the request — which is where the
            // retry setting under test lives.
            request: decorate(interceptors, path),
          }),
        ]),
    };
  };

  const bucket = {
    file,
    getFiles: (query: GetFilesOptions): Promise<GetFilesResponse> => {
      state.queries.push(query);
      const index = query.pageToken ? Number(query.pageToken) : 0;
      const page = pages[index] ?? { objects: [] };
      const hasMore = index + 1 < pages.length;

      return Promise.resolve([
        page.objects.map((object) => ({ name: object.name, metadata: object })),
        hasMore ? { ...query, pageToken: String(index + 1) } : null,
        { prefixes: page.prefixes ?? [] },
      ] as unknown as GetFilesResponse);
    },
  };

  return { storage: { bucket: () => bucket as unknown as Bucket } as unknown as Storage, state };
}

function createService(pages: FakePage[] = []): { service: StorageService; state: FakeBucket } {
  const { storage, state } = fakeStorage(pages);
  const config = {
    get: (key: keyof Env) => (key === 'STORAGE_BUCKET' ? BUCKET : undefined),
  } as unknown as ConfigService<Env, true>;

  return { service: new StorageService(storage, config), state };
}

describe('StorageService.list', () => {
  it('concatenates objects across every page', async () => {
    const { service } = createService([
      { objects: [{ name: 'h5p/content/a/h5p.json', size: 10 }] },
      { objects: [{ name: 'h5p/content/a/content.json', size: 20 }] },
      { objects: [{ name: 'h5p/content/a/media/clip.txt', size: 30 }] },
    ]);

    const objects = await service.list('h5p/content/a/');

    expect(objects.map((object) => object.path)).toEqual([
      'h5p/content/a/h5p.json',
      'h5p/content/a/content.json',
      'h5p/content/a/media/clip.txt',
    ]);
    expect(objects.reduce((total, object) => total + object.sizeBytes, 0)).toBe(60);
  });

  it('never asks the client to auto-paginate, which would drop page prefixes', async () => {
    const { service, state } = createService([{ objects: [{ name: 'a/x' }] }]);

    await service.list('a/');

    expect(state.queries).toHaveLength(1);
    expect(state.queries[0]?.autoPaginate).toBe(false);
  });

  it('reports the object size and creation time out of the listing', async () => {
    const { service } = createService([
      { objects: [{ name: 'a/x', size: 42, timeCreated: '2026-03-04T05:06:07.000Z' }] },
    ]);

    const [object] = await service.list('a/');

    expect(object?.sizeBytes).toBe(42);
    expect(object?.createdAt.toISOString()).toBe('2026-03-04T05:06:07.000Z');
  });

  it('throws past the limit instead of returning a truncated listing', async () => {
    const { service } = createService([
      { objects: [{ name: 'a/1' }, { name: 'a/2' }] },
      { objects: [{ name: 'a/3' }] },
    ]);

    await expect(service.list('a/', 2)).rejects.toThrow(/more than 2 objects/);
  });

  it('defaults the limit to the shared ceiling', async () => {
    expect(MAX_STORAGE_LIST_RESULTS).toBe(10_000);
  });
});

describe('StorageService.listUpTo', () => {
  it('returns the first objects and stops asking for pages', async () => {
    // The reason it exists: a caller that only acts on objects must not have to
    // materialise a prefix wider than the ceiling to touch any of it, and must
    // not pay for the pages it will never look at.
    const { service, state } = createService([
      { objects: [{ name: 'a/1' }, { name: 'a/2' }] },
      { objects: [{ name: 'a/3' }] },
    ]);

    const objects = await service.listUpTo('a/', 2);

    expect(objects.map((object) => object.path)).toEqual(['a/1', 'a/2']);
    expect(state.queries).toHaveLength(1);
  });

  it('truncates inside a page rather than overshooting it', async () => {
    const { service } = createService([{ objects: [{ name: 'a/1' }, { name: 'a/2' }] }]);

    await expect(service.listUpTo('a/', 1)).resolves.toHaveLength(1);
  });

  it('returns everything under a prefix narrower than the batch', async () => {
    const { service } = createService([
      { objects: [{ name: 'a/1' }] },
      { objects: [{ name: 'a/2' }] },
    ]);

    await expect(service.listUpTo('a/', 10)).resolves.toHaveLength(2);
  });

  it('does not throw where list would, which is the whole point of it', async () => {
    const objects = (from: number, count: number): FakeObject[] =>
      Array.from({ length: count }, (_unused, offset) => ({ name: `wide/${from + offset}` }));
    const { service } = createService([
      { objects: objects(0, MAX_STORAGE_LIST_RESULTS) },
      { objects: objects(MAX_STORAGE_LIST_RESULTS, 5) },
    ]);

    await expect(service.list('wide/')).rejects.toThrow(/more than 10000 objects/);
    await expect(service.listUpTo('wide/', 1_000)).resolves.toHaveLength(1_000);
  });

  it('reports the size and creation time the sweep derives an expiry from', async () => {
    const { service } = createService([
      { objects: [{ name: 'a/x', size: 42, timeCreated: '2026-03-04T05:06:07.000Z' }] },
    ]);

    const [object] = await service.listUpTo('a/', 10);

    expect(object?.sizeBytes).toBe(42);
    expect(object?.createdAt.toISOString()).toBe('2026-03-04T05:06:07.000Z');
  });
});

describe('StorageService.listSubdirectories', () => {
  it('returns the prefixes from every page, not only the last one', async () => {
    // The trap this pins: with auto-pagination the SDK accumulates files across
    // pages but keeps only the final page's `apiResponse`, so an implementation
    // that reads prefixes off an auto-paginated call loses `H5P.Main-1.0` here
    // and reinstalls a library it already has.
    const { service } = createService([
      { objects: [], prefixes: ['h5p/libraries/H5P.Main-1.0/'] },
      { objects: [], prefixes: ['h5p/libraries/H5P.Dep-1.0/'] },
    ]);

    const directories = await service.listSubdirectories('h5p/libraries/');

    expect(directories.sort()).toEqual(['H5P.Dep-1.0', 'H5P.Main-1.0']);
  });

  it('asks for a delimited listing', async () => {
    const { service, state } = createService([{ objects: [], prefixes: [] }]);

    await service.listSubdirectories('h5p/libraries/');

    expect(state.queries[0]?.delimiter).toBe('/');
  });

  it('strips the queried prefix and the trailing slash', async () => {
    const { service } = createService([
      { objects: [], prefixes: ['h5p/content/abc-123/', 'h5p/content/def-456/'] },
    ]);

    await expect(service.listSubdirectories('h5p/content/')).resolves.toEqual([
      'abc-123',
      'def-456',
    ]);
  });

  it('de-duplicates a directory reported on two pages', async () => {
    const { service } = createService([
      { objects: [], prefixes: ['a/one/'] },
      { objects: [], prefixes: ['a/one/', 'a/two/'] },
    ]);

    await expect(service.listSubdirectories('a/')).resolves.toEqual(['one', 'two']);
  });

  it('throws past the limit', async () => {
    const { service } = createService([{ objects: [], prefixes: ['a/x/', 'a/y/', 'a/z/'] }]);

    await expect(service.listSubdirectories('a/', 2)).rejects.toThrow(/more than 2 directories/);
  });
});

describe('StorageService.deleteByPrefix', () => {
  it('refuses a prefix that does not end in a slash', async () => {
    const { service, state } = createService([{ objects: [{ name: 'h5p/content/abcdef/x' }] }]);

    // Without the slash this would delete the sibling content `abcdef`, which
    // is silent data loss nothing downstream would notice.
    await expect(service.deleteByPrefix('h5p/content/abc')).rejects.toThrow(/must end in "\/"/);
    expect(state.deleted).toEqual([]);
  });

  it('deletes exactly the objects the listing returned', async () => {
    const { service, state } = createService([
      { objects: [{ name: 'h5p/content/abc/h5p.json' }] },
      { objects: [{ name: 'h5p/content/abc/media/clip.txt' }] },
    ]);

    await service.deleteByPrefix('h5p/content/abc/');

    expect(state.deleted.sort()).toEqual([
      'h5p/content/abc/h5p.json',
      'h5p/content/abc/media/clip.txt',
    ]);
  });

  it('deletes past the listing ceiling, which a delete has no way to recover from', async () => {
    // `list()` refuses a prefix this wide rather than truncating, and that is
    // the right answer for a caller that wants the objects. A delete only wants
    // to act on them, so it pages instead — otherwise the one prefix nobody can
    // enumerate is also the one prefix nobody can clean up.
    const objects = (from: number, count: number): FakeObject[] =>
      Array.from({ length: count }, (_unused, offset) => ({ name: `wide/${from + offset}` }));
    const { service, state } = createService([
      { objects: objects(0, MAX_STORAGE_LIST_RESULTS) },
      { objects: objects(MAX_STORAGE_LIST_RESULTS, 5) },
    ]);

    await expect(service.list('wide/')).rejects.toThrow(/more than 10000 objects/);

    await service.deleteByPrefix('wide/');

    expect(state.deleted).toHaveLength(MAX_STORAGE_LIST_RESULTS + 5);
  });
});

describe('StorageService.stat', () => {
  it('returns null for an object that is not there', async () => {
    const { service } = createService([{ objects: [{ name: 'a/x' }] }]);

    await expect(service.stat('a/missing')).resolves.toBeNull();
  });

  it('reads the size and creation time off the object metadata', async () => {
    const { service } = createService([
      { objects: [{ name: 'a/x', size: 7, timeCreated: '2026-01-02T03:04:05.000Z' }] },
    ]);

    await expect(service.stat('a/x')).resolves.toEqual({
      sizeBytes: 7,
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
    });
  });
});

describe('StorageService.put', () => {
  it('writes without a cache header unless one is asked for', async () => {
    const { service, state } = createService();

    await service.put('h5p/content/a/h5p.json', Buffer.from('{}'), {
      contentType: 'application/json',
    });

    expect(state.saved).toHaveLength(1);
    expect(state.saved[0]?.path).toBe('h5p/content/a/h5p.json');
    expect(state.saved[0]?.options['contentType']).toBe('application/json');
    // H5P objects are deleted with their exercise; a year-long CDN cache on
    // them would outlive the content.
    expect(state.saved[0]?.options['metadata']).toBeUndefined();
  });

  it('keeps the immutable cache header on the media upload path', async () => {
    const { service, state } = createService();

    await service.upload(Buffer.from('png'), {
      path: 'images/2026/03/a.png',
      contentType: 'image/png',
    });

    expect(state.saved[0]?.options['metadata']).toEqual({
      cacheControl: 'public, max-age=31536000, immutable',
    });
  });
});

describe('StorageService.createReadStream', () => {
  interface RecordedRead {
    path: string;
    options?: { start?: number; end?: number };
    request: FakeRequestOptions;
  }

  const read = async (
    service: StorageService,
    range?: { start?: number; end?: number },
  ): Promise<RecordedRead> => {
    const chunks: string[] = [];
    for await (const chunk of service.createReadStream('a/x', range)) {
      chunks.push(String(chunk));
    }
    return JSON.parse(chunks.join('')) as RecordedRead;
  };

  it('passes a byte range through to the client', async () => {
    const { service } = createService();

    const recorded = await read(service, { start: 10, end: 20 });

    expect(recorded.path).toBe('a/x');
    expect(recorded.options).toEqual({ start: 10, end: 20 });
  });

  it('asks for the whole object when no range is given', async () => {
    const { service } = createService();

    const recorded = await read(service);

    expect(recorded.options).toBeUndefined();
  });

  it('tells the client not to retry the read', async () => {
    // Not a tuning choice. The SDK's retry of a read *stream* destroys the
    // in-flight request and then pipes into it, which throws where nothing can
    // catch it and takes the process down — so a read that asks for retries is
    // a read that can kill the API. `test/h5p-storage-faults.e2e-spec.ts`
    // drives the same property against a bucket that really answers 503.
    const { service } = createService();

    const recorded = await read(service);

    expect(recorded.request.maxRetries).toBe(0);
  });

  it('leaves the retries on every other operation alone', async () => {
    // The loss is scoped to the download. A `File` is built per call, so a
    // write — the operation whose retries actually matter, because it is the
    // one that has to survive a transient 5xx — keeps every one of them.
    const { service, state } = createService();

    await read(service);
    await service.put('a/y', Buffer.from('bytes'));

    expect(state.saved.map((write) => write.request.maxRetries)).toEqual([undefined]);
  });
});
