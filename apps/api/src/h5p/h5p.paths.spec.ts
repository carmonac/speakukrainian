import { H5pError } from '@lumieducation/h5p-server';
import { describe, expect, it } from 'vitest';
import {
  CONTENT_ROOT_PREFIX,
  LIBRARY_ROOT_PREFIX,
  assertSafeContentId,
  assertSafeEntryName,
  assertSafeRelativePath,
  contentObjectPath,
  contentPrefix,
  contentStoragePath,
  joinContentFilePath,
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
    // A NUL truncates the path in the syscall; Node answers with a `TypeError`
    // from somewhere much deeper, which is a 500 for a file problem.
    ['a\u0000b'],
    ['a\u001fb'],
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

describe('assertSafeEntryName', () => {
  it.each([['content/'], ['SpeakTest.Main-1.0/'], ['content/media/clip.txt']])(
    'accepts %s',
    (name) => {
      // A zip may name a directory, which a stored object never can.
      expect(() => assertSafeEntryName(name)).not.toThrow();
    },
  );

  it.each([['content/../'], ['../'], ['/'], ['content/..'], ['//']])('rejects %s', (name) => {
    expect(() => assertSafeEntryName(name)).toThrow(H5pError);
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

  it.each([['../evil'], ['a/../..'], ['/etc'], ['a\\b']])(
    'never builds a prefix from the library name %j',
    (machineName) => {
      // The contract, not the mechanism. Today it is `LibraryName.toUberName`'s
      // own pattern that refuses these first — `libraryPrefix`'s assert is the
      // module's uniform rule sitting behind it, and it is genuinely unreachable
      // while that pattern holds. Asserting the outcome rather than which of the
      // two threw is what keeps this true if either changes; asserting the
      // assert's own `H5pError` would only pin the current order.
      expect(() => libraryPrefix({ machineName, majorVersion: 1, minorVersion: 0 })).toThrow();
    },
  );

  it('roots library listings at the shared storage prefix', () => {
    expect(LIBRARY_ROOT_PREFIX).toBe('h5p/libraries/');
  });
});

describe('joinContentFilePath', () => {
  it('joins the decoded segments Express hands back', () => {
    expect(joinContentFilePath(['media', 'clip.mp3'])).toBe('media/clip.mp3');
  });

  it('keeps a space, which Express has already decoded from %20', () => {
    expect(joinContentFilePath(['media', 'tone one.mp3'])).toBe('media/tone one.mp3');
  });

  it('accepts a single string, which is what a one-segment wildcard can be', () => {
    expect(joinContentFilePath('h5p.json')).toBe('h5p.json');
  });

  it('refuses a traversal that arrives inside one decoded segment', () => {
    // The whole reason the assert runs after the join. `media/..%2f..%2fx`
    // reaches Express 5 as `['media', '../../x']`, so a per-segment check sees
    // two ordinary names and only the joined string sees the traversal.
    expect(() => joinContentFilePath(['media', '../../x'])).toThrow(H5pError);
  });

  it('refuses a traversal spread across two segments', () => {
    expect(() => joinContentFilePath(['media', '..', '..', 'x'])).toThrow(H5pError);
  });

  it.each([[[]], [['']], ['']])('refuses the empty path %j', (segments) => {
    expect(() => joinContentFilePath(segments)).toThrow(H5pError);
  });
});
