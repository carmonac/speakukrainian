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
   * The ceiling is a cliff and not a slope — past it this raises a plain
   * `Error`, which no route maps, so the caller gets a 500 and no listing. That
   * is the right trade for a caller that wants the objects, because a partial
   * answer is worse than none; a caller that only wants to *act* on every
   * object should page for itself the way `deleteByPrefix` does, rather than
   * materialising the listing first.
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
   *
   * Deletes page by page rather than over `list()`, which keeps the listing
   * ceiling out of the delete path: a prefix too wide to enumerate in one go is
   * still a prefix that has to be removable, and a content that cannot be
   * deleted is a content nothing can clean up after.
   */
  async deleteByPrefix(prefix: string): Promise<void> {
    if (!prefix.endsWith('/')) {
      throw new Error(`A delete prefix must end in "/", got "${prefix}".`);
    }

    await this.eachPage({ prefix }, async (files) => {
      await Promise.all(files.map((file) => this.delete(file.name)));
    });
  }

  /**
   * The SDK types this as the wider `NodeJS.ReadableStream`, but it genuinely
   * returns a `Readable` and H5P's `IContentStorage.getFileStream` requires
   * one; narrowing here keeps the cast out of the adapters.
   *
   * **Retries are switched off for this one request, and that is deliberate.**
   * See `withoutStreamRetries`.
   */
  createReadStream(path: string, range?: { start?: number; end?: number }): Readable {
    const file = withoutStreamRetries(this.bucket.file(path));
    return file.createReadStream(range ? { ...range } : undefined);
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
    onPage: (files: File[], apiResponse: unknown) => void | Promise<void>,
  ): Promise<void> {
    let next: GetFilesOptions | null = {
      ...query,
      autoPaginate: false,
      maxResults: LIST_PAGE_SIZE,
    };

    while (next) {
      const page: GetFilesResponse = await this.bucket.getFiles(next);
      const [files, nextQuery, apiResponse] = page;
      await onPage(files, apiResponse);
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

/**
 * Turns off the SDK's retry loop for the requests made through this one `File`.
 *
 * **Not a tuning choice — the SDK's retry of a read *stream* kills the
 * process.** When the bucket answers a media GET with a retryable status (any
 * 5xx, or 429), `retry-request` destroys the in-flight request stream to start
 * the next attempt, and `teeny-request` then runs
 * `pipeline(responseStream, requestStream)` into that now-destroyed stream from
 * inside its own `response` listener. Node throws `ERR_STREAM_UNABLE_TO_PIPE`
 * there, inside a promise callback nothing awaits, so it surfaces as an
 * unhandled rejection and takes the API down — every route, not just this read.
 * A 403 or a reset connection is fine, because neither is retryable; a routine
 * transient 503 on one `<audio>` fetch is not.
 *
 * `maxRetries: 0` on the request options is what `nodejs-common`'s `makeRequest`
 * reads to size both `retries` and `noResponseRetries`, and an interceptor is
 * the only seam that reaches the options `File.createReadStream` builds for
 * itself. Scoped to this `File` — a fresh one per call — so uploads, metadata
 * reads, listings and deletes keep every retry the SDK gives them; only the
 * download loses one.
 *
 * **What that costs.** A read that would have been retried transparently now
 * surfaces as an error on the stream, which the H5P routes answer with a logged
 * 500. It is a narrow loss: `retry-request` can only retry a stream *before* the
 * response arrives, so nothing that had already delivered bytes was ever
 * recoverable, and the caller here is a browser fetching a subresource — it
 * re-requests on its own. A dead process recovers nothing.
 *
 * The end-to-end proof is `test/h5p-storage-faults.e2e-spec.ts`, which points
 * the client at a stub that answers 503; without this the suite does not fail,
 * it dies.
 */
function withoutStreamRetries(file: File): File {
  file.interceptors.push({
    request: (options: RetryableRequestOptions): RetryableRequestOptions => ({
      ...options,
      maxRetries: 0,
    }),
  });
  return file;
}

/**
 * The part of a request's options this interceptor is about.
 *
 * The SDK declares `Interceptor.request` over the `request` library's whole
 * option union and returns a narrower type of its own that the package does not
 * export, so neither end of the real signature can be named from here. Every
 * options object that reaches an interceptor has already been through
 * `Service.request_`, which sets `uri` before running them, so this describes
 * the value it is actually handed.
 */
interface RetryableRequestOptions {
  uri: string;
  /** What `nodejs-common`'s `makeRequest` reads for both of its retry counters. */
  maxRetries?: number;
}
