import { describe, expect, it } from 'vitest';
import {
  H5P_PACKAGE_EXTENSION,
  MAX_H5P_UPLOAD_BYTES,
  createH5pContentSchema,
  formatMaxH5pUploadSize,
  h5pContentSchema,
  h5pEditorUploadTooLargeMessage,
  h5pUploadTooLargeMessage,
  isH5pPackageFilename,
  listH5pContentQuerySchema,
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

describe('listH5pContentQuerySchema', () => {
  it('pages the way every other list route pages', () => {
    // Reusing `paginationQuerySchema` rather than restating it is what keeps
    // this route from drifting into looser bounds than `GET /api/pages`.
    expect(listH5pContentQuerySchema.parse({})).toEqual({ limit: 25 });
    expect(listH5pContentQuerySchema.parse({ limit: '10' })).toEqual({ limit: 10 });
    expect(listH5pContentQuerySchema.parse({ cursor: 'abc' })).toEqual({
      limit: 25,
      cursor: 'abc',
    });
  });

  it('refuses a limit outside the shared bounds', () => {
    expect(listH5pContentQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(listH5pContentQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });
});

describe('H5P upload messages', () => {
  it('derives the size wording from the byte limit rather than restating it', () => {
    expect(MAX_H5P_UPLOAD_BYTES).toBe(100 * 1024 * 1024);
    expect(formatMaxH5pUploadSize()).toBe('100 MB');
    expect(h5pUploadTooLargeMessage()).toBe('H5P packages must be under 100 MB.');
  });

  it('does not call an editor upload a package, while quoting the same limit', () => {
    // The two routes share `MAX_H5P_UPLOAD_BYTES`, so the number may not be
    // restated; the sentence must differ, because the file an author uploads
    // from inside the editor is a clip or an image and not a package.
    expect(h5pEditorUploadTooLargeMessage()).toBe('Uploads must be under 100 MB.');
    expect(h5pEditorUploadTooLargeMessage()).toContain(formatMaxH5pUploadSize());
    expect(h5pEditorUploadTooLargeMessage()).not.toContain('H5P packages');
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
