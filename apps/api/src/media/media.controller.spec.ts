import 'reflect-metadata';
import { Readable } from 'node:stream';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { AssetRef, MediaKind, UserRole } from '@speakukrainian/shared';
import { IS_PUBLIC_KEY } from '../auth/public.decorator.js';
import { ROLES_KEY } from '../auth/roles.decorator.js';
import { MediaController } from './media.controller.js';
import type { MediaService } from './media.service.js';

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

describe('MediaController route metadata', () => {
  // Rule 8: both routes mutate storage, so both carry a role guard and neither
  // is public. A dropped decorator compiles either way.
  const roles = (handler: object): UserRole[] | undefined =>
    Reflect.getMetadata(ROLES_KEY, handler) as UserRole[] | undefined;
  const isPublic = (handler: object): boolean | undefined =>
    Reflect.getMetadata(IS_PUBLIC_KEY, handler) as boolean | undefined;

  const routes = {
    uploadImage: MediaController.prototype.uploadImage,
    uploadAudio: MediaController.prototype.uploadAudio,
  };

  for (const [name, handler] of Object.entries(routes)) {
    it(`restricts ${name} to editors and above`, () => {
      expect(roles(handler)).toEqual(['editor']);
    });

    it(`does not mark ${name} public`, () => {
      expect(isPublic(handler)).toBeUndefined();
    });
  }
});
