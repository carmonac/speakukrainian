import { Readable } from 'node:stream';
import { PayloadTooLargeException, UnsupportedMediaTypeException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  AUDIO_CONTENT_TYPES,
  FILE_EXTENSION_BY_CONTENT_TYPE,
  IMAGE_CONTENT_TYPES,
  MAX_AUDIO_UPLOAD_BYTES,
  MAX_IMAGE_UPLOAD_BYTES,
  type AssetRef,
  type MediaContentType,
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

/**
 * Real leading bytes for each allowed type. The service decides what a file is
 * from these, so a fixture that is not the format it claims is now a 415 rather
 * than a harmless placeholder.
 */
const HEADERS: Record<MediaContentType, Buffer> = {
  'image/png': Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
  'image/jpeg': Buffer.from('ffd8ffe000104a4649460001', 'hex'),
  'image/gif': Buffer.from('47494638396110001000', 'hex'),
  'image/webp': Buffer.from('524946462400000057454250565038', 'hex'),
  'audio/mpeg': Buffer.from('494433030000000000004142434445', 'hex'),
  'audio/mp4': Buffer.from('00000020667479704d34412000000000', 'hex'),
  'audio/ogg': Buffer.from('4f676753000200000000000000000000', 'hex'),
  'audio/wav': Buffer.from('524946462400000057415645666d7420', 'hex'),
  'audio/webm': Buffer.from('1a45dfa3010000000000001f', 'hex'),
};

const TEXT = Buffer.from('this is a text file, not a clip');
/** The same text saved as "Unicode": the BOM makes it open on `FF FE`. */
const UTF16_TEXT = Buffer.concat([
  Buffer.from([0xff, 0xfe]),
  Buffer.from('this is a text file, not a clip', 'utf16le'),
]);

function fakeFile(overrides: Partial<Express.Multer.File> = {}): Express.Multer.File {
  const mimetype = overrides.mimetype ?? 'image/png';
  const headerByType: Record<string, Buffer> = HEADERS;
  // A test about a rejected *declared* type never reaches the byte check, so
  // the fallback only has to be bytes, not the right ones.
  const buffer = overrides.buffer ?? headerByType[mimetype] ?? HEADERS['image/png'];
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
    ...overrides,
  };
}

describe('MediaService', () => {
  it('stores the uploaded bytes under a generated path and returns what storage returned', async () => {
    const { storage, calls } = createStorageDouble();
    const buffer = HEADERS['image/png'];

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

  it('refuses a text file declared as audio without touching storage', async () => {
    // The issue's own case: `cp notes.txt notes.mp3` makes a browser declare
    // `audio/mpeg`, and only the bytes can say otherwise.
    const { storage, calls } = createStorageDouble();

    await expect(
      new MediaService(storage).upload(
        'audio',
        fakeFile({ mimetype: 'audio/mpeg', originalname: 'notes.mp3', buffer: TEXT }),
      ),
    ).rejects.toThrow(UnsupportedMediaTypeException);
    expect(calls).toEqual([]);
  });

  it('refuses a UTF-16 text file, whose byte-order mark reads as a frame sync', async () => {
    // The same renamed `.txt`, saved with the encoding Notepad calls "Unicode".
    // Its first two bytes are `FF FE`, which satisfies an MP3 frame sync on its
    // own; only decoding the rest of the frame header rejects it.
    const { storage, calls } = createStorageDouble();

    await expect(
      new MediaService(storage).upload(
        'audio',
        fakeFile({ mimetype: 'audio/mpeg', originalname: 'notes.mp3', buffer: UTF16_TEXT }),
      ),
    ).rejects.toThrow(UnsupportedMediaTypeException);
    expect(calls).toEqual([]);
  });

  it('refuses bytes of one allowed type declared as another, in both directions', async () => {
    const { storage, calls } = createStorageDouble();
    const service = new MediaService(storage);

    await expect(
      service.upload('audio', fakeFile({ mimetype: 'audio/mpeg', buffer: HEADERS['image/png'] })),
    ).rejects.toThrow(UnsupportedMediaTypeException);
    await expect(
      service.upload('image', fakeFile({ mimetype: 'image/png', buffer: HEADERS['audio/mpeg'] })),
    ).rejects.toThrow(UnsupportedMediaTypeException);
    expect(calls).toEqual([]);
  });

  it('refuses an empty file', async () => {
    const { storage, calls } = createStorageDouble();

    await expect(
      new MediaService(storage).upload('image', fakeFile({ buffer: Buffer.alloc(0) })),
    ).rejects.toThrow(UnsupportedMediaTypeException);
    expect(calls).toEqual([]);
  });

  it('explains the rejection by naming the declared type', async () => {
    const { storage } = createStorageDouble();

    await expect(
      new MediaService(storage).upload('audio', fakeFile({ mimetype: 'audio/mpeg', buffer: TEXT })),
    ).rejects.toThrow(/audio\/mpeg/);
  });

  it('accepts every allowed type given its own header, and stores the declared type', async () => {
    // The false-rejection guard: a wrong table entry would otherwise stay
    // invisible until an author hit it with a real file.
    for (const kind of ['image', 'audio'] as const) {
      const contentTypes = kind === 'image' ? IMAGE_CONTENT_TYPES : AUDIO_CONTENT_TYPES;
      for (const contentType of contentTypes) {
        const { storage, calls } = createStorageDouble();

        await new MediaService(storage).upload(
          kind,
          fakeFile({ mimetype: contentType, buffer: HEADERS[contentType] }),
        );

        expect(calls).toHaveLength(1);
        expect(calls[0]?.options.contentType).toBe(contentType);
        expect(calls[0]?.options.path).toMatch(
          new RegExp(`\\.${FILE_EXTENSION_BY_CONTENT_TYPE[contentType]}$`),
        );
      }
    }
  });

  it('stores the declared content type rather than one derived from the bytes', async () => {
    // An ISO-BMFF header cannot distinguish `.m4a` from `.mp4`, so the
    // declaration decides — the byte check is what makes trusting it sound.
    const { storage, calls } = createStorageDouble();

    const asset = await new MediaService(storage).upload(
      'audio',
      fakeFile({ mimetype: 'audio/mp4', buffer: HEADERS['audio/mp4'] }),
    );

    expect(calls[0]?.options.contentType).toBe('audio/mp4');
    expect(asset.path).toMatch(/^audio\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.m4a$/);
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

  it('reports the format before the size when a file is both wrong and too big', async () => {
    // The admin's pre-check reports the format for this file, so the API has to
    // as well — otherwise the same upload gets two different reasons depending
    // on which end refuses it.
    const { storage, calls } = createStorageDouble();

    await expect(
      new MediaService(storage).upload(
        'audio',
        fakeFile({ mimetype: 'audio/mpeg', buffer: TEXT, size: MAX_AUDIO_UPLOAD_BYTES + 1 }),
      ),
    ).rejects.toThrow(UnsupportedMediaTypeException);
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
