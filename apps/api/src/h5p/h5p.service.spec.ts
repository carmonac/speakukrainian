import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ConflictException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { H5pError } from '@lumieducation/h5p-server';
import type { H5PEditor, IContentMetadata, IUser } from '@lumieducation/h5p-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  h5pContentSchema,
  type CreateH5pContentInput,
  type H5pContent,
  type ListH5pContentQuery,
  type Page,
} from '@speakukrainian/shared';
import type { H5pContentRepository, SetPageIdResult } from './h5p-content.repository.js';
import { H5pContentStorage } from './h5p-content.storage.js';
import { CONTENT_MISSING_MESSAGE, PAGE_MISSING_MESSAGE } from './h5p.errors.js';
import { buildRawZip, type RawZipEntry } from './h5p.raw-zip.js';
import { H5pService } from './h5p.service.js';
import { InMemoryStorage } from './h5p.storage-fake.js';

const MAIN = { machineName: 'SpeakTest.Main', majorVersion: 1, minorVersion: 2 };

const HARMLESS_ENTRIES: RawZipEntry[] = [
  { name: 'h5p.json', content: '{"title":"drill"}' },
  { name: 'content/content.json', content: '{}' },
];

function metadata(overrides: Partial<IContentMetadata> = {}): IContentMetadata {
  return {
    title: 'Present perfect drill',
    language: 'en',
    mainLibrary: MAIN.machineName,
    embedTypes: ['iframe'],
    preloadedDependencies: [MAIN],
    ...overrides,
  } as IContentMetadata;
}

interface RepositorySpy {
  repository: H5pContentRepository;
  created: { input: CreateH5pContentInput; actorId: string }[];
  /** The index, keyed by content id — what `findById`, `list` and `delete` see. */
  stored: Map<string, H5pContent>;
  /**
   * Ids whose stored document does not satisfy `h5pContentSchema`: they exist,
   * but the repository's parse-on-read throws instead of answering with them.
   */
  corrupt: Set<string>;
  /** Ids `delete` actually removed, so a no-op is not mistaken for a delete. */
  deleted: string[];
  /** Which page ids exist, for the read `setPageId` makes before it attaches. */
  pages: Set<string>;
}

interface RepositoryFailures {
  /** Rejects `create`, which is how the import rollback is provoked. */
  onCreate?: Error;
  onDelete?: Error;
}

function createRepositorySpy(failures: RepositoryFailures = {}): RepositorySpy {
  const created: { input: CreateH5pContentInput; actorId: string }[] = [];
  const stored = new Map<string, H5pContent>();
  const corrupt = new Set<string>();
  const deleted: string[] = [];
  const pages = new Set<string>();

  const repository = {
    create: (input: CreateH5pContentInput, actorId: string): Promise<H5pContent> => {
      if (failures.onCreate) {
        return Promise.reject(failures.onCreate);
      }
      created.push({ input, actorId });
      const content = { ...input, audit: {} } as unknown as H5pContent;
      stored.set(input.id, content);
      return Promise.resolve(content);
    },
    findById: (id: string): Promise<H5pContent | null> => {
      if (corrupt.has(id)) {
        // The real `fromDocument` parses, so a wrong-shaped document throws
        // here rather than answering `null`.
        return Promise.resolve().then(() =>
          h5pContentSchema.parse({ ...indexed(id), sizeBytes: 'not-a-number' }),
        );
      }
      return Promise.resolve(stored.get(id) ?? null);
    },
    exists: (id: string): Promise<boolean> => Promise.resolve(stored.has(id) || corrupt.has(id)),
    delete: (id: string): Promise<void> => {
      if (failures.onDelete) {
        return Promise.reject(failures.onDelete);
      }
      stored.delete(id);
      corrupt.delete(id);
      deleted.push(id);
      return Promise.resolve();
    },
    list: (query: ListH5pContentQuery): Promise<Page<H5pContent>> =>
      Promise.resolve({ items: [...stored.values()].slice(0, query.limit), nextCursor: null }),
    /**
     * An in-memory stand-in for the write, not a script: the service under test
     * is the mapping from this union onto HTTP, and it can only be checked
     * against a repository that really refuses and really writes. The rules
     * themselves are pinned in `h5p-content.repository.spec.ts`, against the
     * Firestore double.
     */
    setPageId: (id: string, pageId: string | null, actorId: string): Promise<SetPageIdResult> => {
      const existing = stored.get(id);
      if (!existing) {
        return Promise.resolve({ ok: false, reason: 'content-not-found' });
      }
      if (existing.pageId === pageId) {
        return Promise.resolve({ ok: true, content: existing });
      }
      if (pageId !== null) {
        if (!pages.has(pageId)) {
          return Promise.resolve({ ok: false, reason: 'page-not-found' });
        }
        if (existing.pageId !== null) {
          return Promise.resolve({
            ok: false,
            reason: 'attached-elsewhere',
            pageId: existing.pageId,
          });
        }
      }
      const updated: H5pContent = {
        ...existing,
        pageId,
        audit: { ...existing.audit, updatedAt: '2026-06-01T00:00:00.000Z', updatedBy: actorId },
      };
      stored.set(id, updated);
      return Promise.resolve({ ok: true, content: updated });
    },
  } as unknown as H5pContentRepository;

  return { repository, created, stored, corrupt, deleted, pages };
}

/**
 * Stands in for `H5PEditor.packageImporter`, writing what a real import writes:
 * the two JSON documents plus one content file, through the same content
 * storage the service is given.
 */
function createEditor(
  contentStorage: H5pContentStorage,
  behaviour: {
    contentId?: string;
    metadata?: IContentMetadata;
    throws?: unknown;
    /** Runs after the scan and before the index write, like the real importer. */
    onImport?: (path: string) => Promise<void>;
  } = {},
): H5PEditor {
  return {
    packageImporter: {
      addPackageLibrariesAndContent: async (path: string, user: IUser) => {
        await behaviour.onImport?.(path);
        if (behaviour.throws) {
          throw behaviour.throws;
        }
        const contentMetadata = behaviour.metadata ?? metadata();
        const id = await contentStorage.addContent(
          contentMetadata,
          { question: 'a' },
          user,
          behaviour.contentId ?? 'installed-content',
        );
        await contentStorage.addFile(id, 'media/clip.txt', Readable.from(['0123456789']));
        return { id, metadata: contentMetadata, parameters: {}, installedLibraries: [] };
      },
    },
  } as unknown as H5PEditor;
}

describe('H5pService.importPackage', () => {
  let storage: InMemoryStorage;
  let contentStorage: H5pContentStorage;
  let uploadDir: string;
  let uploaded: Express.Multer.File;

  beforeEach(async () => {
    storage = new InMemoryStorage();
    contentStorage = new H5pContentStorage(storage.asStorageService());
    uploadDir = await mkdtemp(join(tmpdir(), 'h5p-service-spec-'));

    const path = join(uploadDir, randomUUID());
    // A real archive, because the service scans the entry names before it hands
    // the file to the importer.
    await writeFile(path, buildRawZip(HARMLESS_ENTRIES));
    uploaded = { path, originalname: 'drill.h5p' } as Express.Multer.File;
  });

  afterEach(async () => {
    await rm(uploadDir, { recursive: true, force: true });
  });

  it('returns the content id, title and the main library as an ubername with a space', async () => {
    const { repository } = createRepositorySpy();
    const service = new H5pService(
      createEditor(contentStorage),
      contentStorage,
      repository,
      storage.asStorageService(),
    );

    const result = await service.importPackage(uploaded, 'editor-1');

    expect(result).toEqual({
      contentId: 'installed-content',
      title: 'Present perfect drill',
      // `h5pContentSchema` documents this form, not the hyphenated directory one.
      mainLibrary: 'SpeakTest.Main 1.2',
    });
  });

  it('indexes the content with its storage path and the size of everything stored', async () => {
    const { repository, created } = createRepositorySpy();
    const service = new H5pService(
      createEditor(contentStorage),
      contentStorage,
      repository,
      storage.asStorageService(),
    );

    await service.importPackage(uploaded, 'editor-1');

    const total = [...storage.objects.values()].reduce(
      (sum, object) => sum + object.body.length,
      0,
    );
    expect(created).toEqual([
      {
        actorId: 'editor-1',
        input: {
          id: 'installed-content',
          title: 'Present perfect drill',
          mainLibrary: 'SpeakTest.Main 1.2',
          storagePath: 'h5p/content/installed-content',
          sizeBytes: total,
          pageId: null,
        },
      },
    ]);
    expect(total).toBeGreaterThan(0);
  });

  it('falls back to the machine name when the package omits its own main library', async () => {
    const { repository } = createRepositorySpy();
    const service = new H5pService(
      createEditor(contentStorage, { metadata: metadata({ preloadedDependencies: [] }) }),
      contentStorage,
      repository,
      storage.asStorageService(),
    );

    await expect(service.importPackage(uploaded, 'editor-1')).resolves.toMatchObject({
      mainLibrary: 'SpeakTest.Main',
    });
  });

  it('deletes the uploaded file once the import succeeds', async () => {
    const { repository } = createRepositorySpy();
    const service = new H5pService(
      createEditor(contentStorage),
      contentStorage,
      repository,
      storage.asStorageService(),
    );

    await service.importPackage(uploaded, 'editor-1');

    // Multer does not clean up after a successful request.
    await expect(access(uploaded.path)).rejects.toThrow();
  });

  it('still returns the saved content when the uploaded file cannot be deleted', async () => {
    // Cleanup is best effort. An import that succeeded and wrote its index
    // document must not be reported as a 500 because an unlink failed: the
    // caller would then treat a real, indexed content as failed, and until #32
    // there is no route that could find or remove it.
    //
    // The failure is produced by replacing the uploaded file with a directory
    // once the importer has read it, which is an `ERR_FS_EISDIR` that
    // `force: true` does not swallow.
    const { repository, created } = createRepositorySpy();
    const service = new H5pService(
      createEditor(contentStorage, {
        onImport: async (path) => {
          await rm(path);
          await mkdir(path);
        },
      }),
      contentStorage,
      repository,
      storage.asStorageService(),
    );

    await expect(service.importPackage(uploaded, 'editor-1')).resolves.toMatchObject({
      contentId: 'installed-content',
    });
    expect(created).toHaveLength(1);
  });

  it('deletes the uploaded file when the import fails too', async () => {
    const { repository } = createRepositorySpy();
    const service = new H5pService(
      createEditor(contentStorage, { throws: new H5pError('unable-to-unzip', {}, 400) }),
      contentStorage,
      repository,
      storage.asStorageService(),
    );

    await expect(service.importPackage(uploaded, 'editor-1')).rejects.toThrow();
    await expect(access(uploaded.path)).rejects.toThrow();
  });

  it('maps an H5pError onto its HTTP status rather than letting it escape as a 500', async () => {
    const { repository } = createRepositorySpy();
    const service = new H5pService(
      createEditor(contentStorage, { throws: new H5pError('unable-to-unzip', {}, 400) }),
      contentStorage,
      repository,
      storage.asStorageService(),
    );

    const error = await service.importPackage(uploaded, 'editor-1').catch((thrown) => thrown);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
  });

  it('rethrows a failure that is not an H5pError untouched', async () => {
    // A storage outage is a 500, not "your file is corrupt".
    const outage = new Error('ECONNRESET');
    const { repository } = createRepositorySpy();
    const service = new H5pService(
      createEditor(contentStorage, { throws: outage }),
      contentStorage,
      repository,
      storage.asStorageService(),
    );

    await expect(service.importPackage(uploaded, 'editor-1')).rejects.toBe(outage);
  });

  it('refuses a package with a traversal entry name before the importer sees it', async () => {
    // The guard has to be *here*, ahead of `addPackageLibrariesAndContent`:
    // `PackageImporter.extractPackage` joins each entry name onto its temp
    // directory and writes it, so a check any later is a check after the write.
    const { repository, created } = createRepositorySpy();
    let imported = false;
    const editor = {
      packageImporter: {
        addPackageLibrariesAndContent: () => {
          imported = true;
          return Promise.resolve({});
        },
      },
    } as unknown as H5PEditor;
    const service = new H5pService(editor, contentStorage, repository, storage.asStorageService());
    await writeFile(
      uploaded.path,
      buildRawZip([...HARMLESS_ENTRIES, { name: '../pwned.txt', content: 'x' }]),
    );

    const error = await service.importPackage(uploaded, 'editor-1').catch((thrown) => thrown);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(imported).toBe(false);
    expect(storage.paths()).toEqual([]);
    expect(created).toEqual([]);
  });

  it('removes the installed content when the index write fails', async () => {
    // Without the rollback the bucket keeps files nothing references and no
    // route can ever delete.
    const failure = new Error('firestore unavailable');
    const { repository } = createRepositorySpy({ onCreate: failure });
    const service = new H5pService(
      createEditor(contentStorage),
      contentStorage,
      repository,
      storage.asStorageService(),
    );

    await expect(service.importPackage(uploaded, 'editor-1')).rejects.toBe(failure);
    expect(storage.paths()).toEqual([]);
  });
});

const INDEXED = 'e2f0b0b6-1f6c-4a3a-9a4b-9d3b2f5a1c77';
const SIBLING = 'a1b2c3d4-1f6c-4a3a-9a4b-9d3b2f5a1c77';
const PAGE = 'page-the-exercise-is-attached-to';
const OTHER_PAGE = 'another-page-entirely';
const LIBRARY_FILE = 'h5p/libraries/SpeakTest.Main-1.0/library.json';

function indexed(id: string): H5pContent {
  return {
    id,
    title: 'Present perfect drill',
    mainLibrary: 'SpeakTest.Main 1.0',
    storagePath: `h5p/content/${id}`,
    sizeBytes: 10,
    pageId: null,
    audit: {
      createdAt: '2026-05-01T00:00:00.000Z',
      createdBy: 'editor-1',
      updatedAt: '2026-05-01T00:00:00.000Z',
      updatedBy: 'editor-1',
    },
  };
}

/** An `InMemoryStorage` whose sweep always fails, standing in for an outage. */
class SweepFailingStorage extends InMemoryStorage {
  constructor(private readonly failure: Error) {
    super();
  }

  override deleteByPrefix(): Promise<void> {
    return Promise.reject(this.failure);
  }
}

describe('H5pService index routes', () => {
  let storage: InMemoryStorage;

  const serviceOver = (
    repository: H5pContentRepository,
    over: InMemoryStorage = storage,
  ): H5pService =>
    new H5pService(
      {} as unknown as H5PEditor,
      new H5pContentStorage(over.asStorageService()),
      repository,
      over.asStorageService(),
    );

  /** What an installed content and its neighbours look like in the bucket. */
  const seedObjects = async (over: InMemoryStorage = storage): Promise<void> => {
    await over.put(`h5p/content/${INDEXED}/h5p.json`, Buffer.from('{}'));
    await over.put(`h5p/content/${INDEXED}/content/content.json`, Buffer.from('{}'));
    await over.put(`h5p/content/${SIBLING}/h5p.json`, Buffer.from('{}'));
    await over.put(LIBRARY_FILE, Buffer.from('{}'));
  };

  beforeEach(() => {
    storage = new InMemoryStorage();
  });

  it('lists through the repository with the query it was given', async () => {
    const { repository, stored } = createRepositorySpy();
    stored.set(INDEXED, indexed(INDEXED));
    stored.set(SIBLING, indexed(SIBLING));

    await expect(serviceOver(repository).list({ limit: 1 })).resolves.toEqual({
      items: [indexed(INDEXED)],
      nextCursor: null,
    });
  });

  it('reads one indexed content', async () => {
    const { repository, stored } = createRepositorySpy();
    stored.set(INDEXED, indexed(INDEXED));

    await expect(serviceOver(repository).findById(INDEXED)).resolves.toEqual(indexed(INDEXED));
  });

  it('answers an unknown id with the same sentence the player uses', async () => {
    // `findByIdOrFail` would say `h5pContent/<id> not found`, which names an
    // internal collection and disagrees with the player about one fact.
    const { repository } = createRepositorySpy();

    const error = await serviceOver(repository)
      .findById(INDEXED)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).message).toBe(CONTENT_MISSING_MESSAGE);
  });

  it('removes every object under the content prefix and the index document', async () => {
    const { repository, stored } = createRepositorySpy();
    stored.set(INDEXED, indexed(INDEXED));
    await seedObjects();

    await serviceOver(repository).remove(INDEXED);

    expect(storage.paths().filter((path) => path.includes(INDEXED))).toEqual([]);
    expect(stored.has(INDEXED)).toBe(false);
  });

  it('leaves a sibling content and the installed libraries alone', async () => {
    // The trailing slash on the prefix is what makes this true; without it the
    // sweep would also take `h5p/content/<id>xyz/…`.
    const { repository, stored } = createRepositorySpy();
    stored.set(INDEXED, indexed(INDEXED));
    stored.set(SIBLING, indexed(SIBLING));
    await seedObjects();

    await serviceOver(repository).remove(INDEXED);

    expect(storage.paths()).toEqual([LIBRARY_FILE, `h5p/content/${SIBLING}/h5p.json`].sort());
    expect(stored.has(SIBLING)).toBe(true);
  });

  it('refuses an unknown id before it touches a single object', async () => {
    const { repository } = createRepositorySpy();
    await seedObjects();
    const before = storage.paths();

    await expect(serviceOver(repository).remove(INDEXED)).rejects.toThrow(NotFoundException);
    expect(storage.paths()).toEqual(before);
  });

  it('still finishes a delete whose objects an earlier attempt already swept', async () => {
    // The half-completed-delete case, and the whole reason the sweep is
    // `deleteByPrefix` rather than `H5pContentStorage.deleteContent`: that one
    // throws a 404 when `h5p.json` is gone, so a retry would strand the row for
    // good — and, because the sweep deletes concurrently, "h5p.json gone, other
    // files left" is a state a crash really can produce.
    const { repository, stored } = createRepositorySpy();
    stored.set(INDEXED, indexed(INDEXED));
    await storage.put(`h5p/content/${INDEXED}/content/content.json`, Buffer.from('{}'));

    await serviceOver(repository).remove(INDEXED);

    expect(storage.paths()).toEqual([]);
    expect(stored.has(INDEXED)).toBe(false);
  });

  it('removes a row whose stored document no longer satisfies the schema', async () => {
    // This route is the only way to repair such a row, so the existence check
    // must not parse: `findById` would throw here and answer 500, leaving the
    // row removable only with direct Firestore access.
    const { repository, corrupt, deleted } = createRepositorySpy();
    corrupt.add(INDEXED);
    await seedObjects();

    await serviceOver(repository).remove(INDEXED);

    expect(deleted).toEqual([INDEXED]);
    expect(storage.paths().filter((path) => path.includes(INDEXED))).toEqual([]);
  });

  it('leaves the index document behind when the document delete fails, never an object', async () => {
    const failure = new Error('firestore unavailable');
    const { repository, stored } = createRepositorySpy({ onDelete: failure });
    stored.set(INDEXED, indexed(INDEXED));
    await seedObjects();

    await expect(serviceOver(repository).remove(INDEXED)).rejects.toBe(failure);

    // The survivor is a row, which the index shows and a retry finishes off.
    expect(storage.paths().filter((path) => path.includes(INDEXED))).toEqual([]);
    expect(stored.has(INDEXED)).toBe(true);
  });

  it('attaches an exercise to a page and answers with the row that names it', async () => {
    const { repository, stored, pages } = createRepositorySpy();
    stored.set(INDEXED, indexed(INDEXED));
    pages.add(PAGE);

    const content = await serviceOver(repository).attachToPage(INDEXED, PAGE, 'editor-2');

    expect(content.pageId).toBe(PAGE);
    expect(stored.get(INDEXED)?.pageId).toBe(PAGE);
    expect(content.audit.updatedBy).toBe('editor-2');
  });

  it('detaches an exercise and answers with the row that names no page', async () => {
    const { repository, stored } = createRepositorySpy();
    stored.set(INDEXED, { ...indexed(INDEXED), pageId: PAGE });

    const content = await serviceOver(repository).detachFromPage(INDEXED, 'editor-2');

    expect(content.pageId).toBeNull();
    expect(stored.get(INDEXED)?.pageId).toBeNull();
    expect(content.audit.updatedBy).toBe('editor-2');
    // Detaching reads no page: none was ever registered on the fake.
    expect(content.title).toBe(indexed(INDEXED).title);
  });

  it.each([
    ['attach', (service: H5pService) => service.attachToPage(INDEXED, PAGE, 'editor-2')],
    ['detach', (service: H5pService) => service.detachFromPage(INDEXED, 'editor-2')],
  ])(
    'answers %s for an unindexed exercise with the sentence every other route uses',
    async (_name, call) => {
      const { repository, pages } = createRepositorySpy();
      pages.add(PAGE);

      const error = await call(serviceOver(repository)).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).message).toBe(CONTENT_MISSING_MESSAGE);
    },
  );

  it('refuses to attach to a page that does not exist, and changes nothing', async () => {
    const { repository, stored } = createRepositorySpy();
    stored.set(INDEXED, indexed(INDEXED));

    const error = await serviceOver(repository)
      .attachToPage(INDEXED, PAGE, 'editor-2')
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).message).toBe(PAGE_MISSING_MESSAGE);
    expect(stored.get(INDEXED)?.pageId).toBeNull();
  });

  it('refuses to move an exercise with a 409 that names the page it is on', async () => {
    // Moving is two explicit calls, and the message says which one comes first
    // because the page it names may itself be gone.
    const { repository, stored, pages } = createRepositorySpy();
    stored.set(INDEXED, { ...indexed(INDEXED), pageId: PAGE });
    pages.add(OTHER_PAGE);

    const error = await serviceOver(repository)
      .attachToPage(INDEXED, OTHER_PAGE, 'editor-2')
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getStatus()).toBe(HttpStatus.CONFLICT);
    expect((error as ConflictException).message).toContain(PAGE);
    expect((error as ConflictException).message).toContain('Detach it first.');
    expect(stored.get(INDEXED)?.pageId).toBe(PAGE);
  });

  it('keeps the index document when the sweep fails, so a retry can still find it', async () => {
    const failure = new Error('storage unavailable');
    const failing = new SweepFailingStorage(failure);
    const { repository, stored } = createRepositorySpy();
    stored.set(INDEXED, indexed(INDEXED));
    await seedObjects(failing);

    await expect(serviceOver(repository, failing).remove(INDEXED)).rejects.toBe(failure);

    expect(stored.has(INDEXED)).toBe(true);
  });
});
