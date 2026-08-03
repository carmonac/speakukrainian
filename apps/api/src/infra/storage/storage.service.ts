import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Storage } from '@google-cloud/storage';
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
    const file = this.storage.bucket(this.bucketName).file(options.path);

    await file.save(body as Buffer, {
      contentType: options.contentType,
      metadata: { cacheControl: options.cacheControl ?? 'public, max-age=31536000, immutable' },
      resumable: false,
    });

    const [metadata] = await file.getMetadata();
    this.logger.log(`Uploaded ${options.path} (${metadata.size ?? 0} bytes)`);

    return {
      path: options.path,
      url: this.publicUrl(options.path),
      contentType: options.contentType,
      sizeBytes: Number(metadata.size ?? 0),
    };
  }

  async delete(path: string): Promise<void> {
    await this.storage.bucket(this.bucketName).file(path).delete({ ignoreNotFound: true });
  }

  async exists(path: string): Promise<boolean> {
    const [exists] = await this.storage.bucket(this.bucketName).file(path).exists();
    return exists;
  }

  createReadStream(path: string): NodeJS.ReadableStream {
    return this.storage.bucket(this.bucketName).file(path).createReadStream();
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
}
