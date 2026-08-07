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

export interface PackageOptions {
  /** Patch version written into both libraries' `library.json`. */
  patchVersion?: number;
  title?: string;
  /** Builds a zip with no `h5p.json`, which the validator must reject. */
  omitH5pJson?: boolean;
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
 * A valid package carrying one extra entry whose name is not safe to unpack.
 *
 * `yazl` refuses to write such a name — correctly, and unhelpfully: without an
 * archive that carries one, nothing can show what the API answers for it.
 */
export function buildHostileH5pPackage(entryName: string, marker: string): Buffer {
  return buildRawZip([...packageEntries(), { name: entryName, content: marker }]);
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
