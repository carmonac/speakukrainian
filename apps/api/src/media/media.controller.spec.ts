import 'reflect-metadata';
import { Readable } from 'node:stream';
import { BadRequestException } from '@nestjs/common';
import { INTERCEPTORS_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it } from 'vitest';
import { MEDIA_UPLOAD_RULES } from '@speakukrainian/shared';
import type { AssetRef, MediaKind, UserRole } from '@speakukrainian/shared';
import { IS_PUBLIC_KEY } from '../auth/public.decorator.js';
import { ROLES_KEY } from '../auth/roles.decorator.js';
import { MediaController } from './media.controller.js';
import type { MediaService } from './media.service.js';
import { UploadLimitInterceptor } from './media.upload-limit.interceptor.js';

const storedAsset: AssetRef = {
  path: 'images/2026/03/2f7d1f1c-0b3a-4b2e-9d31-8b5f0a1c2d3e.png',
  url: 'http://localhost:4443/storage/v1/b/bucket/o/images%2Fdiagram.png?alt=media',
  contentType: 'image/png',
  sizeBytes: 11,
};

interface ServiceSpy {
  service: MediaService;
  calls: { kind: MediaKind; file: Express.Multer.File }[];
}

function createServiceSpy(result: AssetRef = storedAsset): ServiceSpy {
  const calls: { kind: MediaKind; file: Express.Multer.File }[] = [];
  const service = {
    upload: (kind: MediaKind, file: Express.Multer.File): Promise<AssetRef> => {
      calls.push({ kind, file });
      return Promise.resolve(result);
    },
  } as unknown as MediaService;

  return { service, calls };
}

function fakeFile(mimetype = 'image/png'): Express.Multer.File {
  const buffer = Buffer.from('png-bytes-1');
  return {
    fieldname: 'file',
    originalname: 'diagram.png',
    encoding: '7bit',
    mimetype,
    size: buffer.length,
    destination: '',
    filename: '',
    path: '',
    buffer,
    stream: Readable.from([]),
  };
}

describe('MediaController', () => {
  it('uploads an image as the image kind and answers with the asset', async () => {
    const { service, calls } = createServiceSpy();
    const file = fakeFile();

    const asset = await new MediaController(service).uploadImage(file);

    expect(calls).toEqual([{ kind: 'image', file }]);
    expect(asset).toEqual(storedAsset);
  });

  it('uploads audio as the audio kind', async () => {
    const { service, calls } = createServiceSpy({
      ...storedAsset,
      path: 'audio/2026/03/2f7d1f1c-0b3a-4b2e-9d31-8b5f0a1c2d3e.mp3',
      contentType: 'audio/mpeg',
    });
    const file = fakeFile('audio/mpeg');

    const asset = await new MediaController(service).uploadAudio(file);

    expect(calls.map((call) => call.kind)).toEqual(['audio']);
    expect(asset.contentType).toBe('audio/mpeg');
  });

  it('rejects a request with no file part and never reaches the service', async () => {
    const { service, calls } = createServiceSpy();

    await expect(new MediaController(service).uploadImage()).rejects.toThrow(BadRequestException);
    await expect(new MediaController(service).uploadAudio()).rejects.toThrow(BadRequestException);
    expect(calls).toEqual([]);
  });

  it('refuses to answer with an asset that does not satisfy assetRefSchema', async () => {
    // The parse at the boundary is the only thing standing between a storage
    // regression and a broken `src` rendered into published content.
    const { service } = createServiceSpy({ ...storedAsset, url: 'not-a-url' });

    await expect(new MediaController(service).uploadImage(fakeFile())).rejects.toThrow();
  });
});

interface MulterInstance {
  limits?: { fileSize?: number; files?: number };
  fileFilter?: (
    request: unknown,
    file: { mimetype: string },
    callback: (error: Error | null, acceptFile: boolean) => void,
  ) => void;
}

/** A multer-backed `FileInterceptor` mixin, which holds its options on `multer`. */
interface FileInterceptorMixin {
  multer: MulterInstance;
}

/**
 * Instantiating the mixin is the only way to see which options `FileInterceptor`
 * was given: they are captured in its closure and reachable only through the
 * multer instance the constructor builds.
 */
function multerOf(entry: unknown): MulterInstance {
  if (typeof entry !== 'function') {
    throw new Error('expected a FileInterceptor mixin class, got ' + typeof entry);
  }
  const Mixin = entry as new () => FileInterceptorMixin;
  return new Mixin().multer;
}

/** Runs the route's own `fileFilter` over a declared content type. */
function accepts(instance: MulterInstance, mimetype: string): boolean {
  const filter = instance.fileFilter;
  if (!filter) {
    throw new Error('the route was given multer options with no fileFilter');
  }

  let outcome: boolean | undefined;
  filter(null, { mimetype }, (error, acceptFile) => {
    outcome = error === null && acceptFile;
  });
  if (outcome === undefined) {
    throw new Error(`fileFilter never called back for ${mimetype}`);
  }
  return outcome;
}

describe('MediaController route metadata', () => {
  // Rule 8: both routes mutate storage, so both carry a role guard and neither
  // is public. A dropped decorator compiles either way.
  const roles = (handler: object): UserRole[] | undefined =>
    Reflect.getMetadata(ROLES_KEY, handler) as UserRole[] | undefined;
  const isPublic = (handler: object): boolean | undefined =>
    Reflect.getMetadata(IS_PUBLIC_KEY, handler) as boolean | undefined;
  const interceptors = (handler: object): unknown[] =>
    (Reflect.getMetadata(INTERCEPTORS_METADATA, handler) as unknown[] | undefined) ?? [];

  const routes: { name: string; handler: object; kind: MediaKind }[] = [
    { name: 'uploadImage', handler: MediaController.prototype.uploadImage, kind: 'image' },
    { name: 'uploadAudio', handler: MediaController.prototype.uploadAudio, kind: 'audio' },
  ];

  for (const { name, handler, kind } of routes) {
    it(`restricts ${name} to editors and above`, () => {
      expect(roles(handler)).toEqual(['editor']);
    });

    it(`does not mark ${name} public`, () => {
      expect(isPublic(handler)).toBeUndefined();
    });

    it(`puts the ${kind} limit interceptor ahead of multer on ${name}`, () => {
      // Nothing at runtime would complain if these two were swapped or if one
      // route were given the other's kind: the upload would still work and only
      // the 413 message would be wrong, which no other test on the audio route
      // reaches. Composing them in `MediaUpload` makes that impossible; this
      // asserts the composition actually arrived on the route.
      const [limit, upload, ...rest] = interceptors(handler);

      expect(limit).toBeInstanceOf(UploadLimitInterceptor);
      expect((limit as UploadLimitInterceptor).kind).toBe(kind);
      expect(multerOf(upload).limits).toEqual({
        fileSize: MEDIA_UPLOAD_RULES[kind].maxBytes,
        files: 1,
      });
      expect(rest).toEqual([]);
    });

    it(`filters ${name} by the ${kind} allow-list, not the other kind's`, () => {
      // The limits above tell the two kinds apart only because the byte limits
      // happen to differ; the allow-list is what decides a 415, and it tells
      // them apart by construction.
      const other: MediaKind = kind === 'image' ? 'audio' : 'image';
      const multer = multerOf(interceptors(handler)[1]);
      const candidates = [
        ...MEDIA_UPLOAD_RULES[kind].contentTypes,
        ...MEDIA_UPLOAD_RULES[other].contentTypes,
      ];

      expect(candidates.filter((contentType) => accepts(multer, contentType))).toEqual([
        ...MEDIA_UPLOAD_RULES[kind].contentTypes,
      ]);
    });
  }
});
