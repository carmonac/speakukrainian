import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { HttpException, HttpStatus } from '@nestjs/common';
import { H5pError } from '@lumieducation/h5p-server';
import type { H5PEditor, IContentMetadata, IUser } from '@lumieducation/h5p-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CreateH5pContentInput, H5pContent } from '@speakukrainian/shared';
import type { H5pContentRepository } from './h5p-content.repository.js';
import { H5pContentStorage } from './h5p-content.storage.js';
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
}

function createRepositorySpy(failWith?: Error): RepositorySpy {
  const created: { input: CreateH5pContentInput; actorId: string }[] = [];
  const repository = {
    create: (input: CreateH5pContentInput, actorId: string): Promise<H5pContent> => {
      if (failWith) {
        return Promise.reject(failWith);
      }
      created.push({ input, actorId });
      return Promise.resolve({ ...input, audit: {} } as unknown as H5pContent);
    },
  } as unknown as H5pContentRepository;

  return { repository, created };
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
    const { repository } = createRepositorySpy(failure);
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
