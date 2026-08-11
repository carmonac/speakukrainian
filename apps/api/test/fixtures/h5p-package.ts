import { ZipFile } from 'yazl';
import { buildRawZip, type RawZipEntry } from '../../src/h5p/h5p.raw-zip.js';

/**
 * Builds `.h5p` packages for the e2e suite.
 *
 * Generated rather than committed on purpose: the suite needs a variant per
 * case (valid, patched, downgraded, corrupt, missing `h5p.json`, and one per
 * hostile entry name), and a committed binary per variant would be a dozen
 * opaque blobs whose contents no reviewer can read. Everything below is
 * checked against the library's own
 * `h5p-schema.json` and `library-schema.json`, whose patterns are stricter than
 * they look — `mainLibrary`, `machineName` and `language` all carry regexes.
 *
 * Two libraries rather than one, so the install loop, the "is every dependency
 * present" check and the sorted install ordering are all exercised. A
 * single-library package could not tell a broken `getInstalledLibraryNames`
 * from a working one.
 *
 * File extensions matter: content files must be on `contentWhitelist` (`txt`
 * is) and library files on `libraryWhitelist` (`js css svg`).
 */

export const MAIN_LIBRARY = {
  machineName: 'SpeakTest.Main',
  majorVersion: 1,
  minorVersion: 0,
} as const;

export const DEP_LIBRARY = {
  machineName: 'SpeakTest.Dep',
  majorVersion: 1,
  minorVersion: 0,
} as const;

export const MAIN_LIBRARY_DIR = 'SpeakTest.Main-1.0';
export const DEP_LIBRARY_DIR = 'SpeakTest.Dep-1.0';

/** The one content file in the package, exercising `addFile` and `listFiles`. */
export const CONTENT_FILE = 'media/clip.txt';

/** Where `PackageOptions.mediaBytes` lands, once the `content/` prefix is stripped. */
export const MEDIA_FILE = 'media/tone.mp3';

export interface PackageOptions {
  /** Patch version written into both libraries' `library.json`. */
  patchVersion?: number;
  title?: string;
  /** Builds a zip with no `h5p.json`, which the validator must reject. */
  omitH5pJson?: boolean;
  /**
   * Adds `content/media/tone.mp3` with these bytes.
   *
   * The existing content file is 35 bytes, which a range test cannot say
   * anything with: a server that buffered the whole object and sliced it
   * afterwards would answer identically. `mp3` is on
   * `H5PConfig.contentWhitelist`, so the package still validates.
   */
  mediaBytes?: Buffer;
}

function packageEntries(options: PackageOptions = {}): RawZipEntry[] {
  const { patchVersion = 1, title = 'Speak Ukrainian e2e drill', omitH5pJson = false } = options;

  const entries: RawZipEntry[] = [];

  if (!omitH5pJson) {
    entries.push({
      name: 'h5p.json',
      content: json({
        title,
        language: 'en',
        mainLibrary: MAIN_LIBRARY.machineName,
        embedTypes: ['iframe'],
        preloadedDependencies: [MAIN_LIBRARY, DEP_LIBRARY],
      }),
    });
  }

  entries.push(
    { name: 'content/content.json', content: json({ question: 'Have you ever been to Kyiv?' }) },
    { name: `content/${CONTENT_FILE}`, content: 'a pronunciation clip would go here\n' },
    {
      name: `${MAIN_LIBRARY_DIR}/library.json`,
      content: json({
        title: 'Speak Test Main',
        machineName: MAIN_LIBRARY.machineName,
        majorVersion: MAIN_LIBRARY.majorVersion,
        minorVersion: MAIN_LIBRARY.minorVersion,
        patchVersion,
        runnable: 1,
        // The validator checks that every declared file is actually in the
        // package, so `main.js` below is not optional.
        preloadedJs: [{ path: 'main.js' }],
        preloadedDependencies: [DEP_LIBRARY],
      }),
    },
    { name: `${MAIN_LIBRARY_DIR}/main.js`, content: 'window.SpeakTestMain = {};\n' },
    {
      // Every runnable H5P library has one, and the editor's
      // `GET /ajax?action=libraries` reads it: without it that route answers
      // 404 for a library that is installed and fine. `json` is on
      // `contentWhitelist`, which `libraryExtensionWhitelist` concatenates, so
      // the package still validates.
      name: `${MAIN_LIBRARY_DIR}/semantics.json`,
      content: json([
        { name: 'question', type: 'text', label: 'Question', widget: 'html' },
        { name: 'clip', type: 'file', label: 'Pronunciation clip', optional: true },
      ]),
    },
    {
      name: `${DEP_LIBRARY_DIR}/library.json`,
      content: json({
        title: 'Speak Test Dep',
        machineName: DEP_LIBRARY.machineName,
        majorVersion: DEP_LIBRARY.majorVersion,
        minorVersion: DEP_LIBRARY.minorVersion,
        patchVersion,
        runnable: 0,
        preloadedJs: [{ path: 'dep.js' }],
      }),
    },
    { name: `${DEP_LIBRARY_DIR}/dep.js`, content: 'window.SpeakTestDep = {};\n' },
  );

  if (options.mediaBytes) {
    entries.push({ name: `content/${MEDIA_FILE}`, content: options.mediaBytes });
  }

  return entries;
}

export function buildH5pPackage(options: PackageOptions = {}): Promise<Buffer> {
  const zip = new ZipFile();
  for (const entry of packageEntries(options)) {
    zip.addBuffer(Buffer.from(entry.content), entry.name);
  }
  zip.end();

  return collect(zip);
}

/**
 * The same package written by the raw ZIP writer instead of `yazl`.
 *
 * It is the control for the hostile packages below: if a hostile upload is
 * refused, this one proves the refusal is about the entry name and not about
 * the writer, because the only difference between them is that name.
 */
export function buildRawH5pPackage(options: PackageOptions = {}): Buffer {
  return buildRawZip(packageEntries(options));
}

/**
 * A valid package carrying one extra entry with the given name.
 *
 * That entry is the only difference from `buildRawH5pPackage`, so whatever the
 * API answers is about the name and nothing else. It is built by hand because
 * `yazl` refuses to write most of the names worth asking about — correctly, and
 * unhelpfully: without an archive that carries one, nothing can show what the
 * API answers for it.
 */
export function buildH5pPackageWithEntry(entryName: string, content: string): Buffer {
  return buildRawZip([...packageEntries(), { name: entryName, content }]);
}

/** How one entry's data can be something the zip reader refuses to read. */
export type PackageDamage = Pick<RawZipEntry, 'compressionMethod' | 'encrypted' | 'corruptData'>;

const DEFLATE = 8;

/**
 * The same package with every entry deflated, which is how every archiver
 * writes a `.zip`.
 *
 * The control the damaged packages below need: it shows the import path reads
 * compressed entries, so a 400 for a package whose only difference is a flipped
 * bit or a compression method cannot mean the fixture was unreadable to begin
 * with.
 */
export function buildDeflatedH5pPackage(options: PackageOptions = {}): Buffer {
  return buildRawZip(
    packageEntries(options).map((entry) => ({ ...entry, compressionMethod: DEFLATE })),
  );
}

/**
 * The same package with `damage` applied to its last entry.
 *
 * One entry rather than all of them, and the last one, because the rule is per
 * entry: a scan that checked only the first would let this through. The rest of
 * the archive is byte-identical to `buildRawH5pPackage`, so whatever the API
 * answers is about the damage and nothing else.
 */
export function buildDamagedH5pPackage(damage: PackageDamage): Buffer {
  const entries = packageEntries();
  const last = entries.length - 1;

  return buildRawZip(
    entries.map((entry, index) => (index === last ? { ...entry, ...damage } : entry)),
  );
}

function json(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, 2), 'utf-8');
}

function collect(zip: ZipFile): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}
