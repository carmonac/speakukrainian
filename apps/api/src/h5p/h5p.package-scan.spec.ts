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

  it('passes a filesystem failure through untouched, so it stays a 500', async () => {
    // An upload that is not there is this server's problem, not the caller's.
    const error = await assertSafePackageEntries(join(directory, 'absent.h5p')).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).not.toBeInstanceOf(H5pError);
    expect((error as NodeJS.ErrnoException).code).toBe('ENOENT');
  });
});
