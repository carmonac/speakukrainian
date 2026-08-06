import { Readable } from 'node:stream';
import { HttpStatus, UnsupportedMediaTypeException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { MAX_AUDIO_UPLOAD_BYTES, MAX_IMAGE_UPLOAD_BYTES } from '@speakukrainian/shared';
import { mediaUploadOptions } from './media.multer.js';

function fakeFile(mimetype: string): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: 'clip.mp3',
    encoding: '7bit',
    mimetype,
    size: 1024,
    destination: '',
    filename: '',
    path: '',
    buffer: Buffer.from('bytes'),
    stream: Readable.from([]),
  };
}

interface FilterResult {
  error: Error | null;
  accepted: boolean;
}

function runFilter(kind: 'image' | 'audio', mimetype: string): FilterResult {
  const results: FilterResult[] = [];
  mediaUploadOptions(kind).fileFilter({}, fakeFile(mimetype), (error, accepted) => {
    results.push({ error, accepted });
  });

  const [result] = results;
  if (!result) {
    throw new Error('fileFilter did not call its callback: the request would hang');
  }
  return result;
}

describe('mediaUploadOptions fileFilter', () => {
  it('accepts a content type on its own allow-list', () => {
    expect(runFilter('audio', 'audio/mpeg')).toEqual({ error: null, accepted: true });
    expect(runFilter('image', 'image/png')).toEqual({ error: null, accepted: true });
  });

  it('rejects a disallowed type as a 415 naming the type', () => {
    const { error, accepted } = runFilter('audio', 'text/plain');

    expect(error).toBeInstanceOf(UnsupportedMediaTypeException);
    // The status is what makes the rejection survive Nest's
    // `transformException` as a 415 instead of becoming a 500.
    expect((error as UnsupportedMediaTypeException).getStatus()).toBe(
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    );
    expect((error as UnsupportedMediaTypeException).message).toContain('text/plain');
    expect(accepted).toBe(false);
  });

  it('does not let one kind accept the other kind', () => {
    expect(runFilter('audio', 'image/png').error).toBeInstanceOf(UnsupportedMediaTypeException);
    expect(runFilter('image', 'audio/mpeg').error).toBeInstanceOf(UnsupportedMediaTypeException);
  });
});

describe('mediaUploadOptions limits', () => {
  it('caps each route at its shared byte limit and one file', () => {
    expect(mediaUploadOptions('image').limits).toEqual({
      fileSize: MAX_IMAGE_UPLOAD_BYTES,
      files: 1,
    });
    expect(mediaUploadOptions('audio').limits).toEqual({
      fileSize: MAX_AUDIO_UPLOAD_BYTES,
      files: 1,
    });
  });
});
