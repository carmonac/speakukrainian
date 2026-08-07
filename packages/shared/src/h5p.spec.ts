import { describe, expect, it } from 'vitest';
import {
  H5P_PACKAGE_EXTENSION,
  MAX_H5P_UPLOAD_BYTES,
  createH5pContentSchema,
  formatMaxH5pUploadSize,
  h5pContentSchema,
  h5pUploadTooLargeMessage,
  isH5pPackageFilename,
  notAnH5pPackageMessage,
} from './h5p.js';

const validInput = {
  id: 'ff6c4a3a-4d1f-4f0f-9a4b-9d3b2f5a1c77',
  title: 'Present perfect drill',
  mainLibrary: 'H5P.MultiChoice 1.16',
  storagePath: 'h5p/content/ff6c4a3a-4d1f-4f0f-9a4b-9d3b2f5a1c77',
  sizeBytes: 4096,
  pageId: null,
};

describe('createH5pContentSchema', () => {
  it('accepts the index input the upload route builds', () => {
    expect(createH5pContentSchema.parse(validInput)).toEqual(validInput);
  });

  it('rejects an input with no storagePath', () => {
    // Without it nothing can ever find, stream or delete the content's files.
    const { storagePath: _storagePath, ...withoutPath } = validInput;

    expect(createH5pContentSchema.safeParse(withoutPath).success).toBe(false);
  });

  it('rejects an empty storagePath as firmly as a missing one', () => {
    expect(createH5pContentSchema.safeParse({ ...validInput, storagePath: '' }).success).toBe(
      false,
    );
  });

  it('leaves audit to the repository rather than accepting one from a caller', () => {
    expect(Object.keys(createH5pContentSchema.shape)).not.toContain('audit');
    expect(Object.keys(h5pContentSchema.shape)).toContain('audit');
  });
});

describe('H5P upload messages', () => {
  it('derives the size wording from the byte limit rather than restating it', () => {
    expect(MAX_H5P_UPLOAD_BYTES).toBe(100 * 1024 * 1024);
    expect(formatMaxH5pUploadSize()).toBe('100 MB');
    expect(h5pUploadTooLargeMessage()).toBe('H5P packages must be under 100 MB.');
  });

  it('names the offending file and the extension the API wants', () => {
    expect(notAnH5pPackageMessage('lesson.zip')).toBe(
      'lesson.zip is not an H5P package. Upload a file with the .h5p extension.',
    );
  });
});

describe('isH5pPackageFilename', () => {
  it('accepts the extension in any case', () => {
    expect(isH5pPackageFilename('drill.h5p')).toBe(true);
    expect(isH5pPackageFilename('DRILL.H5P')).toBe(true);
    expect(isH5pPackageFilename('a.b.c.h5p')).toBe(true);
  });

  it('rejects anything else, including a lookalike', () => {
    expect(isH5pPackageFilename('drill.zip')).toBe(false);
    expect(isH5pPackageFilename('drill.h5p.zip')).toBe(false);
    expect(isH5pPackageFilename('h5p')).toBe(false);
    expect(isH5pPackageFilename('')).toBe(false);
  });

  it('pins the extension constant the message and the filter share', () => {
    expect(H5P_PACKAGE_EXTENSION).toBe('.h5p');
  });
});
