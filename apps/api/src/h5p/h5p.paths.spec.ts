import { H5pError } from '@lumieducation/h5p-server';
import { describe, expect, it } from 'vitest';
import {
  CONTENT_ROOT_PREFIX,
  LIBRARY_ROOT_PREFIX,
  assertSafeContentId,
  assertSafeEntryName,
  assertSafeRelativePath,
  assertSafeRequestPath,
  contentObjectPath,
  contentPrefix,
  contentStoragePath,
  joinContentFilePath,
  libraryObjectPath,
  libraryPrefix,
} from './h5p.paths.js';

const LIBRARY = { machineName: 'H5P.MultiChoice', majorVersion: 1, minorVersion: 16 };

/** The `H5pError` a call threw, or a failure saying it threw something else. */
function thrownBy(call: () => unknown): H5pError {
  try {
    call();
  } catch (error) {
    if (error instanceof H5pError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the call to throw an H5pError.');
}

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

describe('assertSafeRequestPath', () => {
  it('applies the same rule as the storage assert', () => {
    expect(() => assertSafeRequestPath('media/clip.mp3')).not.toThrow();
    expect(() => assertSafeRequestPath('media/../../h5p.json')).toThrow(H5pError);
  });

  it('refuses with an id worded for a caller who uploaded nothing', () => {
    // The `storage-file-implementations:*` ids all mean "the package contains a
    // file with an unusable path", which is a statement about something a
    // reader never sent. Same rule, same status, different sentence.
    const error = thrownBy(() => assertSafeRequestPath('../../etc/passwd'));

    expect(error.errorId).toBe('h5p-request:unusable-path');
    expect(error.httpStatusCode).toBe(400);
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

  it('refuses as a request, since an id only reaches this from a URL', () => {
    // `GET /api/h5p/play/<bad-id>` is the reachable way to fail this; on the
    // import path the id is generated. Package wording there names a file the
    // caller never sent.
    expect(thrownBy(() => assertSafeContentId('../x')).errorId).toBe('h5p-request:unusable-path');
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

  it.each([['../evil'], ['a/../..'], ['/etc'], ['a\\b'], ['..'], ['']])(
    'refuses to build a prefix from the library name %j',
    (machineName) => {
      // `H5pError` rather than a bare `Error`, which is what says this module's
      // own rule ran: `LibraryName.toUberName` would refuse these too, but with
      // a plain `Error` that the mapper turns into a 500 rather than the 400
      // this is.
      const build = (): string => libraryPrefix({ machineName, majorVersion: 1, minorVersion: 0 });

      expect(build).toThrow(H5pError);
      expect(thrownBy(build).httpStatusCode).toBe(400);
      // `GET /api/h5p/libraries/..-1.0/library.json` is what reaches this, so
      // the refusal may not be worded as a package that was never uploaded.
      expect(thrownBy(build).errorId).toBe('h5p-request:unusable-path');
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
