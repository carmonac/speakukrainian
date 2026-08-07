import { H5pError } from '@lumieducation/h5p-server';
import { describe, expect, it } from 'vitest';
import {
  CONTENT_ROOT_PREFIX,
  LIBRARY_ROOT_PREFIX,
  assertSafeContentId,
  assertSafeRelativePath,
  contentObjectPath,
  contentPrefix,
  contentStoragePath,
  libraryObjectPath,
  libraryPrefix,
} from './h5p.paths.js';

const LIBRARY = { machineName: 'H5P.MultiChoice', majorVersion: 1, minorVersion: 16 };

describe('assertSafeRelativePath', () => {
  it.each([
    ['content.json'],
    ['images/a-1.png'],
    ['dist/h5p-multi-choice.js'],
    ['language/uk.json'],
    ['a.b.c/d_e-f.txt'],
  ])('accepts %s', (filename) => {
    expect(() => assertSafeRelativePath(filename)).not.toThrow();
  });

  it.each([
    ['..'],
    ['../x'],
    ['a/../b'],
    // A regex anchored only at the start lets this through, and it is a
    // traversal two levels out of the content's own prefix.
    ['a/../../b'],
    ['a/b/..'],
    ['/abs/path'],
    ['a\\b'],
    ['..\\..\\x'],
    ['a<b'],
    ['a>b'],
    ['a:b'],
    ['a"b'],
    ['a|b'],
    ['a?b'],
    ['a*b'],
    [''],
    ['a//b'],
    ['.'],
    ['a/./b'],
    ['a/'],
  ])('rejects %s', (filename) => {
    expect(() => assertSafeRelativePath(filename)).toThrow(H5pError);
  });

  it('rejects with a 400 the error mapper can turn into a client error', () => {
    try {
      assertSafeRelativePath('../../etc/passwd');
      throw new Error('the traversal was accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(H5pError);
      expect((error as H5pError).httpStatusCode).toBe(400);
      expect((error as H5pError).errorId).toBe(
        'storage-file-implementations:illegal-relative-filename',
      );
    }
  });
});

describe('assertSafeContentId', () => {
  it.each([['a'], ['ff6c4a3a-4d1f-4f0f-9a4b-9d3b2f5a1c77'], ['A_b-1'], ['0'.repeat(64)]])(
    'accepts %s',
    (id) => {
      expect(() => assertSafeContentId(id)).not.toThrow();
    },
  );

  it.each([[''], ['../x'], ['a/b'], ['a.b'], ['a b'], ['0'.repeat(65)]])('rejects %s', (id) => {
    expect(() => assertSafeContentId(id)).toThrow(H5pError);
  });
});

describe('content paths', () => {
  it('keeps the trailing slash on a prefix and drops it on the stored path', () => {
    expect(contentPrefix('abc')).toBe('h5p/content/abc/');
    expect(contentStoragePath('abc')).toBe('h5p/content/abc');
  });

  it('joins a relative filename under the content prefix', () => {
    expect(contentObjectPath('abc', 'media/clip.txt')).toBe('h5p/content/abc/media/clip.txt');
  });

  it('refuses to build a path out of an unsafe filename', () => {
    expect(() => contentObjectPath('abc', '../../secret')).toThrow(H5pError);
  });

  it('refuses to build a path out of an unsafe content id', () => {
    expect(() => contentPrefix('../other')).toThrow(H5pError);
  });

  it('roots content listings at the shared storage prefix', () => {
    expect(CONTENT_ROOT_PREFIX).toBe('h5p/content/');
  });
});

describe('library paths', () => {
  it('uses the hyphenated ubername as the directory name', () => {
    expect(libraryPrefix(LIBRARY)).toBe('h5p/libraries/H5P.MultiChoice-1.16/');
    expect(libraryObjectPath(LIBRARY, 'library.json')).toBe(
      'h5p/libraries/H5P.MultiChoice-1.16/library.json',
    );
  });

  it('refuses to build a path out of an unsafe filename', () => {
    expect(() => libraryObjectPath(LIBRARY, '../../../x')).toThrow(H5pError);
  });

  it('roots library listings at the shared storage prefix', () => {
    expect(LIBRARY_ROOT_PREFIX).toBe('h5p/libraries/');
  });
});
