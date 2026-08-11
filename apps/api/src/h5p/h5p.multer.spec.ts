import { Readable } from 'node:stream';
import { HttpStatus, UnsupportedMediaTypeException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { MAX_H5P_UPLOAD_BYTES } from '@speakukrainian/shared';
import { h5pEditorUploadOptions, h5pUploadOptions } from './h5p.multer.js';

function fakeFile(
  originalname: string,
  mimetype = 'application/octet-stream',
): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname,
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

function runFilter(originalname: string, mimetype?: string): FilterResult {
  const results: FilterResult[] = [];
  h5pUploadOptions().fileFilter({}, fakeFile(originalname, mimetype), (error, accepted) => {
    results.push({ error, accepted });
  });

  const [result] = results;
  if (!result) {
    throw new Error('fileFilter did not call its callback: the request would hang');
  }
  return result;
}

describe('h5pUploadOptions fileFilter', () => {
  it('accepts the extension in any case', () => {
    expect(runFilter('drill.h5p')).toEqual({ error: null, accepted: true });
    expect(runFilter('DRILL.H5P')).toEqual({ error: null, accepted: true });
  });

  it('accepts a package whatever content type the browser guessed', () => {
    // The three values below are what Chrome, Firefox and Safari have each been
    // seen to declare for the same `.h5p` file, which is why the extension and
    // not the content type is the gate.
    for (const mimetype of ['application/zip', 'application/octet-stream', '']) {
      expect(runFilter('drill.h5p', mimetype).accepted).toBe(true);
    }
  });

  it('rejects another extension as a 415 naming the file and the extension wanted', () => {
    const { error, accepted } = runFilter('drill.zip', 'application/zip');

    expect(error).toBeInstanceOf(UnsupportedMediaTypeException);
    // The status is what makes the rejection survive Nest's
    // `transformException` as a 415 instead of becoming a 500.
    expect((error as UnsupportedMediaTypeException).getStatus()).toBe(
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    );
    expect((error as UnsupportedMediaTypeException).message).toBe(
      'drill.zip is not an H5P package. Upload a file with the .h5p extension.',
    );
    expect(accepted).toBe(false);
  });

  it('is not fooled by a package name that only contains the extension', () => {
    expect(runFilter('drill.h5p.zip').accepted).toBe(false);
    expect(runFilter('h5p').accepted).toBe(false);
  });
});

describe('h5pUploadOptions limits', () => {
  it('caps the route at the shared byte limit and one file', () => {
    expect(h5pUploadOptions().limits).toEqual({ fileSize: MAX_H5P_UPLOAD_BYTES, files: 1 });
  });

  it('sets no storage engine, leaving the module to supply the disk destination', () => {
    // Memory storage would hold 100 MB per concurrent upload, and the importer
    // wants a file path anyway.
    expect(h5pUploadOptions()).not.toHaveProperty('storage');
  });
});

describe('h5pEditorUploadOptions', () => {
  it('caps the ajax route at the same byte limit and one file', () => {
    expect(h5pEditorUploadOptions().limits).toEqual({
      fileSize: MAX_H5P_UPLOAD_BYTES,
      files: 1,
    });
  });

  it('installs no fileFilter, because the gate here is per action and the library owns it', () => {
    // `action=files` is gated by `config.contentWhitelist` and
    // `action=library-upload` by the `.h5p` extension. A filter here could only
    // be one of the two, and would refuse what the other action accepts.
    expect(h5pEditorUploadOptions()).not.toHaveProperty('fileFilter');
  });

  it('sets no storage engine, leaving the module to supply the disk destination', () => {
    expect(h5pEditorUploadOptions()).not.toHaveProperty('storage');
  });
});
