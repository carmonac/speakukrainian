import { randomUUID } from 'node:crypto';
import type { Readable, Stream } from 'node:stream';
import { Injectable } from '@nestjs/common';
import { H5pError, streamToString, utils } from '@lumieducation/h5p-server';
import type {
  ContentId,
  ContentParameters,
  IContentMetadata,
  IContentStorage,
  IFileStats,
  ILibraryName,
  IUser,
} from '@lumieducation/h5p-server';
import { StorageService } from '../infra/storage/storage.service.js';
import { hasDependencyOn } from './h5p.dependencies.js';
import {
  CONTENT_ROOT_PREFIX,
  assertSafeContentId,
  contentObjectPath,
  contentPrefix,
} from './h5p.paths.js';

/** Written by `addContent`; excluded from `listFiles`, as the FS version does. */
const METADATA_FILE = 'h5p.json';
const PARAMETERS_FILE = 'content.json';

/**
 * H5P content files in Cloud Storage, laid out exactly as `FileContentStorage`
 * lays them out on disk so the library's own path assumptions hold:
 * `h5p/content/<id>/h5p.json`, `content.json` and the package's content files
 * with their `content/` prefix stripped.
 *
 * Nothing here is atomic across objects. A crash midway through `addContent`
 * can leave a half-written piece of content; the library's own callers roll
 * back by deleting the content, which is the only mitigation object storage
 * allows.
 */
@Injectable()
export class H5pContentStorage implements IContentStorage {
  constructor(private readonly storage: StorageService) {}

  async addContent(
    metadata: IContentMetadata,
    content: ContentParameters,
    _user: IUser,
    contentId?: ContentId,
  ): Promise<ContentId> {
    let id: string;
    if (contentId === undefined || contentId === null) {
      id = randomUUID();
    } else {
      id = String(contentId);
      assertSafeContentId(id);
    }

    try {
      await this.storage.put(contentObjectPath(id, METADATA_FILE), toJsonBuffer(metadata), {
        contentType: 'application/json',
      });
      await this.storage.put(contentObjectPath(id, PARAMETERS_FILE), toJsonBuffer(content), {
        contentType: 'application/json',
      });
    } catch (error) {
      // The cleanup must not mask why the write failed, which is the only
      // thing that tells a caller whether to retry.
      await this.storage.deleteByPrefix(contentPrefix(id)).catch(() => undefined);
      throw new H5pError(
        'storage-file-implementations:error-creating-content',
        {},
        500,
        messageOf(error),
      );
    }

    return id;
  }

  /**
   * No content type is set: these objects are never served from the bucket.
   * The API streams them and sets its own headers.
   */
  async addFile(
    contentId: ContentId,
    filename: string,
    readStream: Stream,
    _user?: IUser,
  ): Promise<void> {
    const path = contentObjectPath(contentId, filename);

    if (!(await this.contentExists(contentId))) {
      throw new H5pError(
        'storage-file-implementations:add-file-content-not-found',
        { filename, id: String(contentId) },
        404,
      );
    }

    // The interface declares the base `Stream`; every caller inside the library
    // passes a `Readable`, which is what the storage client needs.
    await this.storage.put(path, readStream as Readable);
  }

  async contentExists(contentId: ContentId): Promise<boolean> {
    return this.storage.exists(contentObjectPath(contentId, METADATA_FILE));
  }

  async deleteContent(contentId: ContentId, _user?: IUser): Promise<void> {
    if (!(await this.contentExists(contentId))) {
      throw new H5pError('storage-file-implementations:delete-content-not-found', {}, 404);
    }
    await this.storage.deleteByPrefix(contentPrefix(contentId));
  }

  async deleteFile(contentId: ContentId, filename: string, _user?: IUser): Promise<void> {
    const path = contentObjectPath(contentId, filename);

    if (!(await this.storage.exists(path))) {
      throw new H5pError(
        'storage-file-implementations:delete-content-file-not-found',
        { filename },
        404,
      );
    }
    await this.storage.delete(path);
  }

  async fileExists(contentId: ContentId, filename: string): Promise<boolean> {
    return this.storage.exists(contentObjectPath(contentId, filename));
  }

  async getFileStats(contentId: ContentId, file: string, _user: IUser): Promise<IFileStats> {
    const stats = await this.storage.stat(contentObjectPath(contentId, file));
    if (!stats) {
      throw new H5pError(
        'content-file-missing',
        { filename: file, contentId: String(contentId) },
        404,
      );
    }
    return { birthtime: stats.createdAt, size: stats.sizeBytes };
  }

  async getFileStream(
    contentId: ContentId,
    file: string,
    _user: IUser,
    rangeStart?: number,
    rangeEnd?: number,
  ): Promise<Readable> {
    const path = contentObjectPath(contentId, file);
    if (!(await this.storage.exists(path))) {
      throw new H5pError(
        'content-file-missing',
        { filename: file, contentId: String(contentId) },
        404,
      );
    }

    return this.storage.createReadStream(
      path,
      rangeStart === undefined && rangeEnd === undefined
        ? undefined
        : { start: rangeStart, end: rangeEnd },
    );
  }

  async getMetadata(contentId: ContentId, user?: IUser): Promise<IContentMetadata> {
    return this.readJson(contentId, METADATA_FILE, user);
  }

  async getParameters(contentId: ContentId, user?: IUser): Promise<ContentParameters> {
    return this.readJson(contentId, PARAMETERS_FILE, user);
  }

  /**
   * One HTTP round trip per piece of content. That is affordable only because
   * the sole caller is `LibraryAdministration`, which no route wires up in
   * Phase 1; a library-administration screen would need this cached.
   *
   * Sequential rather than `Promise.all` for the reason the FS implementation
   * gives: a bucket-wide fan-out would hold every metadata document in memory
   * at once.
   */
  async getUsage(library: ILibraryName): Promise<{ asDependency: number; asMainLibrary: number }> {
    let asDependency = 0;
    let asMainLibrary = 0;

    for (const contentId of await this.listContent()) {
      const metadata = await this.getMetadata(contentId);
      if (!hasDependencyOn(metadata, library)) {
        continue;
      }
      if (metadata.mainLibrary === library.machineName) {
        asMainLibrary += 1;
      } else {
        asDependency += 1;
      }
    }

    return { asDependency, asMainLibrary };
  }

  /**
   * Unlike the FS implementation this does not confirm each directory holds an
   * `h5p.json`: that would be one HEAD request per piece of content on every
   * listing. Nothing but `addContent` ever creates a directory here, and it
   * writes `h5p.json` first.
   */
  async listContent(_user?: IUser): Promise<ContentId[]> {
    return this.storage.listSubdirectories(CONTENT_ROOT_PREFIX);
  }

  async listFiles(contentId: ContentId, _user: IUser): Promise<string[]> {
    const prefix = contentPrefix(contentId);

    return (await this.storage.list(prefix))
      .map((object) => object.path.slice(prefix.length))
      .filter((name) => name !== METADATA_FILE && name !== PARAMETERS_FILE);
  }

  /**
   * Never reached on the package-import path — `ContentStorer` writes package
   * files straight through `addFile` — but it is what protects the editor's own
   * uploads in #12, and `assertSafeRelativePath` is what protects this one.
   */
  sanitizeFilename = (filename: string): string =>
    utils.generalizedSanitizeFilename(filename, /[^A-Za-z0-9\-._!()/]/g, 240);

  private async readJson<T>(contentId: ContentId, file: string, user?: IUser): Promise<T> {
    const stream = await this.getFileStream(contentId, file, user as IUser);
    return JSON.parse(await streamToString(stream)) as T;
  }
}

function toJsonBuffer(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf-8');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
