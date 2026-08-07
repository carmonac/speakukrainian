import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Readable } from 'node:stream';
import type {
  Bucket,
  File,
  GetFilesOptions,
  GetFilesResponse,
  Storage,
} from '@google-cloud/storage';
import type { AssetRef } from '@speakukrainian/shared';
import type { Env } from '../../config/configuration.js';
import { CLOUD_STORAGE } from './storage.tokens.js';

export interface UploadOptions {
  /** Full object path inside the bucket, e.g. `audio/lesson-1/intro.mp3`. */
  path: string;
  contentType: string;
  /** Objects served to the public site are cached aggressively at the CDN. */
  cacheControl?: string;
}

export interface PutOptions {
  contentType?: string;
  cacheControl?: string;
}

export interface StoredObject {
  path: string;
  sizeBytes: number;
  createdAt: Date;
}

/**
 * Hard ceiling on one listing. A prefix wider than this is a caller bug — an
 * unbounded enumeration of the whole bucket — not a page to fetch.
 */
export const MAX_STORAGE_LIST_RESULTS = 10_000;

/** Objects per API call. GCS caps a page at 1000 whatever we ask for. */
const LIST_PAGE_SIZE = 1_000;

/** The listing response's `prefixes`, which the SDK types as `unknown`. */
interface ObjectListResponse {
  prefixes?: string[];
}

function prefixesOf(apiResponse: unknown): string[] {
  const prefixes = (apiResponse as ObjectListResponse | null | undefined)?.prefixes;
  return Array.isArray(prefixes) ? prefixes : [];
}

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly bucketName: string;
  private readonly apiEndpoint: string | undefined;

  constructor(
    @Inject(CLOUD_STORAGE) private readonly storage: Storage,
    config: ConfigService<Env, true>,
  ) {
    this.bucketName = config.get('STORAGE_BUCKET', { infer: true });
    this.apiEndpoint = config.get('STORAGE_API_ENDPOINT', { infer: true });
  }

  async upload(body: Buffer | NodeJS.ReadableStream, options: UploadOptions): Promise<AssetRef> {
    // Media is served straight from the bucket, so the CDN may hold it for a
    // year. The default belongs here and not in `put`: H5P objects are streamed
    // through the API and are deleted with their exercise, and a CDN holding a
    // deleted exercise's files for a year is not what we want.
    await this.put(options.path, body, {
      contentType: options.contentType,
      cacheControl: options.cacheControl ?? 'public, max-age=31536000, immutable',
    });

    const [metadata] = await this.bucket.file(options.path).getMetadata();
    this.logger.log(`Uploaded ${options.path} (${metadata.size ?? 0} bytes)`);

    return {
      path: options.path,
      url: this.publicUrl(options.path),
      contentType: options.contentType,
      sizeBytes: Number(metadata.size ?? 0),
    };
  }

  /** Writes an object without `upload`'s metadata round trip. */
  async put(
    path: string,
    body: Buffer | NodeJS.ReadableStream,
    options: PutOptions = {},
  ): Promise<void> {
    await this.bucket.file(path).save(body as Buffer, {
      ...(options.contentType ? { contentType: options.contentType } : {}),
      ...(options.cacheControl ? { metadata: { cacheControl: options.cacheControl } } : {}),
      resumable: false,
    });
  }

  async delete(path: string): Promise<void> {
    await this.bucket.file(path).delete({ ignoreNotFound: true });
  }

  async exists(path: string): Promise<boolean> {
    const [exists] = await this.bucket.file(path).exists();
    return exists;
  }

  /** Size and creation time, or null if the object is absent. */
  async stat(path: string): Promise<{ sizeBytes: number; createdAt: Date } | null> {
    const file = this.bucket.file(path);
    const [exists] = await file.exists();
    if (!exists) {
      return null;
    }

    const [metadata] = await file.getMetadata();
    return { sizeBytes: Number(metadata.size ?? 0), createdAt: createdAtOf(metadata.timeCreated) };
  }

  /**
   * Every object under `prefix`, paged internally. Throws past `limit` rather
   * than truncating: a caller that silently gets half a listing deletes half a
   * piece of content, or reinstalls a library it already has.
   *
   * Sizes come back in the listing itself, so a caller that needs the total
   * size of a prefix does not need one `stat` per object.
   */
  async list(prefix: string, limit = MAX_STORAGE_LIST_RESULTS): Promise<StoredObject[]> {
    const objects: StoredObject[] = [];

    await this.eachPage({ prefix }, (files) => {
      for (const file of files) {
        objects.push({
          path: file.name,
          sizeBytes: Number(file.metadata.size ?? 0),
          createdAt: createdAtOf(file.metadata.timeCreated),
        });
      }
      if (objects.length > limit) {
        throw new Error(`Listing "${prefix}" returned more than ${limit} objects.`);
      }
    });

    return objects;
  }

  /**
   * Immediate pseudo-directories under `prefix`, without the trailing slash —
   * `h5p/libraries/` → `['H5P.Foo-1.0', 'H5P.Bar-1.2']`.
   */
  async listSubdirectories(prefix: string, limit = MAX_STORAGE_LIST_RESULTS): Promise<string[]> {
    const directories = new Set<string>();

    await this.eachPage({ prefix, delimiter: '/' }, (_files, apiResponse) => {
      for (const found of prefixesOf(apiResponse)) {
        const name = found.slice(prefix.length).replace(/\/$/, '');
        if (name !== '') {
          directories.add(name);
        }
      }
      if (directories.size > limit) {
        throw new Error(`Listing "${prefix}" returned more than ${limit} directories.`);
      }
    });

    return [...directories];
  }

  /**
   * Deletes every object under `prefix`, which must end in `/`.
   *
   * The trailing slash is asserted rather than appended, so a caller that built
   * the prefix by hand fails loudly: deleting `h5p/content/abc` without it
   * would also take out `h5p/content/abcdef/…`.
   */
  async deleteByPrefix(prefix: string): Promise<void> {
    if (!prefix.endsWith('/')) {
      throw new Error(`A delete prefix must end in "/", got "${prefix}".`);
    }

    const objects = await this.list(prefix);
    await Promise.all(objects.map((object) => this.delete(object.path)));
  }

  /**
   * The SDK types this as the wider `NodeJS.ReadableStream`, but it genuinely
   * returns a `Readable` and H5P's `IContentStorage.getFileStream` requires
   * one; narrowing here keeps the cast out of the adapters.
   */
  createReadStream(path: string, range?: { start?: number; end?: number }): Readable {
    return this.bucket.file(path).createReadStream(range ? { ...range } : undefined);
  }

  /**
   * Public URL for an object.
   *
   * fake-gcs-server does not serve the bucket-path form that
   * `storage.googleapis.com` does, so locally we hand out the JSON API media
   * URL, which it does serve. Both forms are plain GETs, so the browser and
   * the `<audio>`/`<img>` tags in rendered content treat them identically.
   */
  publicUrl(path: string): string {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    return this.apiEndpoint
      ? `${this.apiEndpoint}/storage/v1/b/${this.bucketName}/o/${encodeURIComponent(path)}?alt=media`
      : `https://storage.googleapis.com/${this.bucketName}/${encoded}`;
  }

  /**
   * Walks a listing one page at a time.
   *
   * Both public listings page by hand, for two reasons the SDK does not make
   * obvious. Passing `maxResults` silently switches auto-pagination *off* — so
   * `getFiles({ prefix, maxResults })` returns one page and no indication that
   * more exist, which is a truncated listing wearing a limit's clothing. And
   * with auto-pagination on, the SDK concatenates `File[]` across pages but
   * hands back only the *last* page's `apiResponse`, where the common prefixes
   * live, so every directory but the final page's is dropped. Driving
   * `nextQuery` ourselves is the only way to get both the whole listing and
   * every page's prefixes.
   */
  private async eachPage(
    query: GetFilesOptions,
    onPage: (files: File[], apiResponse: unknown) => void,
  ): Promise<void> {
    let next: GetFilesOptions | null = {
      ...query,
      autoPaginate: false,
      maxResults: LIST_PAGE_SIZE,
    };

    while (next) {
      const page: GetFilesResponse = await this.bucket.getFiles(next);
      const [files, nextQuery, apiResponse] = page;
      onPage(files, apiResponse);
      next = (nextQuery as GetFilesOptions | null) ?? null;
    }
  }

  private get bucket(): Bucket {
    return this.storage.bucket(this.bucketName);
  }
}

/** Epoch when the object predates the field, so callers never see `Invalid Date`. */
function createdAtOf(timeCreated: string | undefined): Date {
  return timeCreated ? new Date(timeCreated) : new Date(0);
}
