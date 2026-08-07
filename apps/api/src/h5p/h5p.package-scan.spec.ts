import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { H5pError } from '@lumieducation/h5p-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertSafePackageEntries } from './h5p.package-scan.js';
import { buildRawZip, type RawZipEntry } from './h5p.raw-zip.js';

/**
 * The shapes an attacker has to reach `path.join(tempDirectory, name)` with.
 * Each one is a name no zip writer will emit, which is why the archives here
 * are assembled byte by byte.
 */
const HOSTILE_NAMES = [
  'content/../../../../../../tmp/pwned.txt',
  '../pwned.txt',
  'content/a/../../anchor.txt',
  '/etc/pwned.txt',
  'C:\\pwned.txt',
  'content\\..\\..\\pwned.txt',
  'content/..',
  'content/./x/../../pwned.txt',
];

const ORDINARY_ENTRIES: RawZipEntry[] = [
  { name: 'h5p.json', content: '{"title":"drill"}' },
  // A directory entry, which is a legitimate name ending in `/`.
  { name: 'content/', content: '' },
  { name: 'content/content.json', content: '{}' },
  { name: 'content/media/clip.txt', content: 'a clip' },
  { name: 'SpeakTest.Main-1.0/library.json', content: '{}' },
];

describe('assertSafePackageEntries', () => {
  let directory: string;
  let index = 0;

  const write = async (bytes: Buffer): Promise<string> => {
    const path = join(directory, `package-${(index += 1)}.h5p`);
    await writeFile(path, bytes);
    return path;
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'h5p-scan-spec-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('accepts a package whose entry names are all ordinary', async () => {
    await expect(
      assertSafePackageEntries(await write(buildRawZip(ORDINARY_ENTRIES))),
    ).resolves.toBeUndefined();
  });

  it.each(HOSTILE_NAMES)('refuses a package carrying the entry %j', async (name) => {
    const path = await write(buildRawZip([...ORDINARY_ENTRIES, { name, content: 'pwned' }]));

    const error = await assertSafePackageEntries(path).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(H5pError);
    expect((error as H5pError).httpStatusCode).toBe(400);
    // The three ids `h5p.errors.ts` words as "an unusable path".
    expect((error as H5pError).errorId).toMatch(
      /^storage-file-implementations:illegal-(relative-filename|absolute-filename|character)$/,
    );
  });

  it('refuses a name carrying a NUL, which would truncate the path in the syscall', async () => {
    const path = await write(buildRawZip([{ name: 'content/clip\u0000.txt', content: 'x' }]));

    await expect(assertSafePackageEntries(path)).rejects.toBeInstanceOf(H5pError);
  });

  it('refuses the name the extractor would use, not the one the header advertises', async () => {
    // Yauzl prefers an Info-ZIP Unicode Path extra field over the header name,
    // so a scan that parsed the central directory itself would check `safe.txt`
    // while the importer wrote `../pwned.txt`. Reading the archive with the same
    // reader the importer uses is what closes that gap.
    const path = await write(
      buildRawZip([{ name: 'safe.txt', unicodeName: '../pwned.txt', content: 'x' }]),
    );

    await expect(assertSafePackageEntries(path)).rejects.toBeInstanceOf(H5pError);
  });

  it('reports a file that is not an archive as a 400, not as a server fault', async () => {
    const path = await write(Buffer.from('not a zip at all'));

    const error = await assertSafePackageEntries(path).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(H5pError);
    expect((error as H5pError).errorId).toBe('unable-to-unzip');
    expect((error as H5pError).httpStatusCode).toBe(400);
  });

  // The third class, and the one a "is it an archive at all?" case cannot
  // reach: an archive structured well enough for the reader to act on it, whose
  // contents then make *Node itself* throw. A zero-length entry name reaches
  // `Buffer.allocUnsafe(undefined)` in yauzl's reader and raises
  // `TypeError [ERR_INVALID_ARG_TYPE]`, which carries a string `code` like
  // every Node built-in error does — so a predicate that reads a `code` as
  // "the filesystem refused" hands it straight back and the route answers 500.
  it.each([
    ['while the central directory is located', [{ name: '', content: 'x' }]],
    ['while the entries are iterated', [...ORDINARY_ENTRIES, { name: '', content: 'x' }]],
  ])('reports an archive that makes Node throw %s as a 400', async (_where, entries) => {
    const path = await write(buildRawZip(entries));

    const error = await assertSafePackageEntries(path).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(H5pError);
    expect((error as H5pError).errorId).toBe('unable-to-unzip');
    expect((error as H5pError).httpStatusCode).toBe(400);
  });

  it('passes a filesystem failure through untouched, so it stays a 500', async () => {
    // An upload that is not there is this server's problem, not the caller's.
    const error = await assertSafePackageEntries(join(directory, 'absent.h5p')).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).not.toBeInstanceOf(H5pError);
    expect((error as NodeJS.ErrnoException).code).toBe('ENOENT');
  });

  describe('names too long to unpack', () => {
    it('refuses a path segment past the filesystem limit', async () => {
      // 256 bytes is the first length `mkdir` answers with `ENAMETOOLONG`,
      // which the importer raises halfway through extraction.
      const path = await write(
        buildRawZip([...ORDINARY_ENTRIES, { name: `${'a'.repeat(256)}/x.txt`, content: 'x' }]),
      );

      const error = await assertSafePackageEntries(path).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(H5pError);
      expect((error as H5pError).errorId).toBe('package-scan:filename-too-long');
      expect((error as H5pError).httpStatusCode).toBe(400);
    });

    it('measures a segment in bytes, not in characters', async () => {
      // 200 three-byte characters is 600 bytes, and it is the byte count the
      // filesystem counts.
      const path = await write(
        buildRawZip([
          ...ORDINARY_ENTRIES,
          { name: `content/${'ф'.repeat(200)}.txt`, content: 'x' },
        ]),
      );

      await expect(assertSafePackageEntries(path)).rejects.toBeInstanceOf(H5pError);
    });

    it('accepts a segment at the limit', async () => {
      const path = await write(
        buildRawZip([
          ...ORDINARY_ENTRIES,
          { name: `${'a'.repeat(255)}/library.json`, content: '{}' },
        ]),
      );

      await expect(assertSafePackageEntries(path)).resolves.toBeUndefined();
    });

    it('refuses a path too long to store, however short its segments are', async () => {
      const deep = `${'ab/'.repeat(400)}x.txt`;
      const path = await write(
        buildRawZip([...ORDINARY_ENTRIES, { name: `content/${deep}`, content: 'x' }]),
      );

      const error = await assertSafePackageEntries(path).catch((thrown: unknown) => thrown);

      expect((error as H5pError).errorId).toBe('package-scan:filename-too-long');
    });
  });

  describe('top-level folders', () => {
    it('refuses a folder that carries no library.json', async () => {
      // `PackageValidator` reads `<folder>/library.json` for every top-level
      // folder but `content`, and throws a plain `Error` when it is absent.
      const path = await write(
        buildRawZip([...ORDINARY_ENTRIES, { name: 'notes/scratch.txt', content: 'x' }]),
      );

      const error = await assertSafePackageEntries(path).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(H5pError);
      expect((error as H5pError).errorId).toBe('package-scan:not-a-library-folder');
      expect((error as H5pError).httpStatusCode).toBe(400);
    });

    it('refuses the folder a macOS archiver adds beside the real ones', async () => {
      const path = await write(
        buildRawZip([
          ...ORDINARY_ENTRIES,
          { name: '__MACOSX/SpeakTest.Main-1.0/library.json', content: '{}' },
        ]),
      );

      await expect(assertSafePackageEntries(path)).rejects.toBeInstanceOf(H5pError);
    });

    it('ignores a folder the extractor would never create', async () => {
      // Every entry under it is skipped by `extractPackage` — a directory entry
      // and a basename starting with `_` — so no such folder reaches the
      // validator and refusing the package would be refusing nothing.
      const path = await write(
        buildRawZip([
          ...ORDINARY_ENTRIES,
          { name: 'notes/', content: '' },
          { name: 'notes/_scratch.txt', content: 'x' },
          { name: 'notes/.hidden', content: 'x' },
        ]),
      );

      await expect(assertSafePackageEntries(path)).resolves.toBeUndefined();
    });

    it('matches library.json case-insensitively, as the validator does', async () => {
      const path = await write(
        buildRawZip([
          { name: 'h5p.json', content: '{"title":"drill"}' },
          { name: 'content/content.json', content: '{}' },
          { name: 'SpeakTest.Main-1.0/LIBRARY.JSON', content: '{}' },
        ]),
      );

      await expect(assertSafePackageEntries(path)).resolves.toBeUndefined();
    });
  });
});
