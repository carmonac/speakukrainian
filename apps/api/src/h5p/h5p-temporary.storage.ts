import type { ReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import { H5PConfig, H5pError, utils } from '@lumieducation/h5p-server';
import type {
  IFileStats,
  ITemporaryFile,
  ITemporaryFileStorage,
  IUser,
} from '@lumieducation/h5p-server';
import { StorageService } from '../infra/storage/storage.service.js';
import {
  TEMP_ROOT_PREFIX,
  assertSafeOwnerId,
  parseTempObjectPath,
  tempObjectPath,
  tempPrefix,
} from './h5p.paths.js';
import { H5P_CONFIG } from './h5p.tokens.js';

/**
 * The editor's scratch storage in Cloud Storage: `h5p/temp/<ownerId>/<filename>`.
 *
 * **The owner is a path prefix rather than an attribute**, which is what
 * `DirectoryTemporaryFileStorage` does on disk and what the interface forces.
 * Every access names its owner — `fileExists(filename, user)`,
 * `getFileStats(filename, user)`, `getFileStream(filename, user, …)`,
 * `deleteFile(filename, ownerId)` — and a filename is unique only *within* an
 * owner: `FilenameGenerator` produces `images/image-aB34xQz9.png` and checks
 * uniqueness through `fileExists(f, user)`. So the owner has to be part of the
 * key, and being part of the key is what makes one editor unable to read
 * another's upload.
 *
 * **Expiry is derived, not stored:** `expiresAt = createdAt + temporaryFileLifetime`.
 * `TemporaryFileManager.addFile` is the only caller of `saveFile` in the
 * library and it always passes `new Date(Date.now() + config.temporaryFileLifetime)`,
 * so the expiry is a pure function of the write time and one config constant.
 * Storing it as well would put a derived value in a second place that can
 * disagree with the first, and `StorageService.list` already returns
 * `createdAt` from the listing itself — so `listFiles` costs one listing and no
 * extra round trips.
 *
 * The named cost: changing `temporaryFileLifetime` re-dates every temp object
 * already in the bucket. For objects whose whole life is two hours that is not
 * a defect.
 */
@Injectable()
export class H5pTemporaryStorage implements ITemporaryFileStorage {
  constructor(
    private readonly storage: StorageService,
    @Inject(H5P_CONFIG) private readonly config: H5PConfig,
  ) {}

  /**
   * No content type is set, for the same reason `H5pContentStorage.addFile`
   * sets none: these bytes are never served from the bucket. `temp-files`
   * streams them and sets its own headers.
   *
   * The `expirationTime` it was handed is returned unchanged, because that is
   * the truth about *this* call even though `listFiles` derives the same value
   * from the object's creation time afterwards.
   */
  async saveFile(
    filename: string,
    dataStream: ReadStream,
    user: IUser,
    expirationTime: Date,
  ): Promise<ITemporaryFile> {
    await this.storage.put(tempObjectPath(user.id, filename), dataStream);

    return { expiresAt: expirationTime, filename, ownedByUserId: user.id };
  }

  async fileExists(filename: string, user: IUser): Promise<boolean> {
    return this.storage.exists(tempObjectPath(user.id, filename));
  }

  async getFileStats(filename: string, user: IUser): Promise<IFileStats> {
    const stats = await this.storage.stat(tempObjectPath(user.id, filename));
    if (!stats) {
      throw notFound(filename, user);
    }

    return { birthtime: stats.createdAt, size: stats.sizeBytes };
  }

  async getFileStream(
    filename: string,
    user: IUser,
    rangeStart?: number,
    rangeEnd?: number,
  ): Promise<Readable> {
    const path = tempObjectPath(user.id, filename);
    if (!(await this.storage.exists(path))) {
      throw notFound(filename, user);
    }

    return this.storage.createReadStream(
      path,
      rangeStart === undefined && rangeEnd === undefined
        ? undefined
        : { start: rangeStart, end: rangeEnd },
    );
  }

  /**
   * `StorageService.delete` ignores a missing object, which is what the
   * interface asks for — "deletes the file (e.g. because it has expired)" has
   * to be a no-op when the sweep races a save that already removed it.
   */
  async deleteFile(filename: string, ownerId: string): Promise<void> {
    assertSafeOwnerId(ownerId);
    await this.storage.delete(tempObjectPath(ownerId, filename));
  }

  /**
   * Every temporary file, or only one user's.
   *
   * `TemporaryFileManager.cleanUp` is the only caller that passes no user, and
   * it deletes everything whose `expiresAt` is in the past — so the derivation
   * below is what stands between a live editing session and its uploads
   * disappearing underneath it. `StorageService.list` maps a missing
   * `timeCreated` to the epoch, which would make every object look expired;
   * `h5p-temporary.storage.spec.ts` drives two controlled creation times so
   * that a live file surviving is asserted and not assumed.
   *
   * An object that does not parse into an owner and a filename is skipped
   * rather than thrown on: a stray object under `h5p/temp/` must not be able to
   * stop the sweep for everybody.
   */
  async listFiles(user?: IUser): Promise<ITemporaryFile[]> {
    const objects = await this.storage.list(user ? tempPrefix(user.id) : TEMP_ROOT_PREFIX);
    const files: ITemporaryFile[] = [];

    for (const object of objects) {
      const parsed = parseTempObjectPath(object.path);
      if (!parsed) {
        continue;
      }

      files.push({
        filename: parsed.filename,
        ownedByUserId: parsed.ownerId,
        expiresAt: new Date(object.createdAt.getTime() + this.config.temporaryFileLifetime),
      });
    }

    return files;
  }

  /**
   * Identical to `H5pContentStorage`'s, and for the same reason: a Cloud
   * Storage object name is a flat string, so there is no `path.join` to
   * normalise away whatever this leaves behind.
   */
  sanitizeFilename = (filename: string): string =>
    utils.generalizedSanitizeFilename(filename, /[^A-Za-z0-9\-._!()/]/g, 240);
}

/** The id `DirectoryTemporaryFileStorage` raises, so both implementations answer alike. */
function notFound(filename: string, user: IUser): H5pError {
  return new H5pError(
    'storage-file-implementations:temporary-file-not-found',
    { filename, userId: user.id },
    404,
  );
}
