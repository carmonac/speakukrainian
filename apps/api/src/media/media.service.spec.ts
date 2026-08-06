import { Readable } from 'node:stream';
import { PayloadTooLargeException, UnsupportedMediaTypeException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  MAX_AUDIO_UPLOAD_BYTES,
  MAX_IMAGE_UPLOAD_BYTES,
  type AssetRef,
} from '@speakukrainian/shared';
import type { StorageService, UploadOptions } from '../infra/storage/storage.service.js';
import { MediaService } from './media.service.js';

interface UploadCall {
  body: Buffer | NodeJS.ReadableStream;
  options: UploadOptions;
}

interface StorageDouble {
  storage: StorageService;
  calls: UploadCall[];
}

function createStorageDouble(): StorageDouble {
  const calls: UploadCall[] = [];
  const storage = {
    upload: (body: Buffer | NodeJS.ReadableStream, options: UploadOptions): Promise<AssetRef> => {
      calls.push({ body, options });
      return Promise.resolve({
        path: options.path,
        url: `http://localhost:4443/storage/v1/b/bucket/o/${encodeURIComponent(options.path)}?alt=media`,
        contentType: options.contentType,
        sizeBytes: 11,
      });
    },
  } as unknown as StorageService;

  return { storage, calls };
}

function fakeFile(overrides: Partial<Express.Multer.File> = {}): Express.Multer.File {
  const buffer = overrides.buffer ?? Buffer.from('png-bytes-1');
  return {
    fieldname: 'file',
    originalname: 'diagram.png',
    encoding: '7bit',
    mimetype: 'image/png',
    size: buffer.length,
    destination: '',
    filename: '',
    path: '',
    buffer,
    stream: Readable.from([]),
    ...overrides,
  };
}

describe('MediaService', () => {
  it('stores the uploaded bytes under a generated path and returns what storage returned', async () => {
    const { storage, calls } = createStorageDouble();
    const buffer = Buffer.from('png-bytes-1');

    const asset = await new MediaService(storage).upload('image', fakeFile({ buffer }));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toBe(buffer);
    expect(calls[0]?.options.contentType).toBe('image/png');
    expect(calls[0]?.options.path).toMatch(/^images\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/);
    expect(asset).toEqual({
      path: calls[0]?.options.path,
      url: expect.stringContaining('alt=media'),
      contentType: 'image/png',
      sizeBytes: 11,
    });
  });

  it('never uses the uploaded filename as a path segment', async () => {
    const { storage, calls } = createStorageDouble();

    await new MediaService(storage).upload(
      'audio',
      fakeFile({ mimetype: 'audio/mpeg', originalname: '../../etc/passwd.mp3' }),
    );

    expect(calls[0]?.options.path).not.toContain('passwd');
    expect(calls[0]?.options.path).not.toContain('..');
  });

  it('refuses a content type outside the allow-list without touching storage', async () => {
    const { storage, calls } = createStorageDouble();
    const service = new MediaService(storage);

    await expect(service.upload('audio', fakeFile({ mimetype: 'text/plain' }))).rejects.toThrow(
      UnsupportedMediaTypeException,
    );
    await expect(service.upload('audio', fakeFile({ mimetype: 'image/png' }))).rejects.toThrow(
      UnsupportedMediaTypeException,
    );
    expect(calls).toEqual([]);
  });

  it('refuses a file one byte over the limit without touching storage', async () => {
    const { storage, calls } = createStorageDouble();
    const service = new MediaService(storage);

    await expect(
      service.upload('image', fakeFile({ size: MAX_IMAGE_UPLOAD_BYTES + 1 })),
    ).rejects.toThrow(PayloadTooLargeException);
    await expect(
      service.upload(
        'audio',
        fakeFile({ mimetype: 'audio/mpeg', size: MAX_AUDIO_UPLOAD_BYTES + 1 }),
      ),
    ).rejects.toThrow(PayloadTooLargeException);
    expect(calls).toEqual([]);
  });

  it('accepts a file exactly at the limit', async () => {
    const { storage, calls } = createStorageDouble();

    await new MediaService(storage).upload('image', fakeFile({ size: MAX_IMAGE_UPLOAD_BYTES }));

    expect(calls).toHaveLength(1);
  });

  it('gives two uploads of the same filename two distinct paths', async () => {
    const { storage } = createStorageDouble();
    const service = new MediaService(storage);
    const file = () => fakeFile({ mimetype: 'audio/mpeg', originalname: 'intro.mp3' });

    const first = await service.upload('audio', file());
    const second = await service.upload('audio', file());

    expect(first.path).not.toBe(second.path);
  });
});
