import { ZipFile } from 'yazl';

/**
 * Builds `.h5p` packages for the e2e suite.
 *
 * Generated rather than committed on purpose: the suite needs five variants
 * (valid, patched, downgraded, corrupt, missing `h5p.json`), and a committed
 * binary per variant would be five opaque blobs whose contents no reviewer can
 * read. Everything below is checked against the library's own
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

export function buildH5pPackage(options: PackageOptions = {}): Promise<Buffer> {
  const { patchVersion = 1, title = 'Speak Ukrainian e2e drill', omitH5pJson = false } = options;

  const zip = new ZipFile();

  if (!omitH5pJson) {
    zip.addBuffer(
      json({
        title,
        language: 'en',
        mainLibrary: MAIN_LIBRARY.machineName,
        embedTypes: ['iframe'],
        preloadedDependencies: [MAIN_LIBRARY, DEP_LIBRARY],
      }),
      'h5p.json',
    );
  }

  zip.addBuffer(json({ question: 'Have you ever been to Kyiv?' }), 'content/content.json');
  zip.addBuffer(Buffer.from('a pronunciation clip would go here\n'), `content/${CONTENT_FILE}`);

  zip.addBuffer(
    json({
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
    `${MAIN_LIBRARY_DIR}/library.json`,
  );
  zip.addBuffer(Buffer.from('window.SpeakTestMain = {};\n'), `${MAIN_LIBRARY_DIR}/main.js`);

  zip.addBuffer(
    json({
      title: 'Speak Test Dep',
      machineName: DEP_LIBRARY.machineName,
      majorVersion: DEP_LIBRARY.majorVersion,
      minorVersion: DEP_LIBRARY.minorVersion,
      patchVersion,
      runnable: 0,
      preloadedJs: [{ path: 'dep.js' }],
    }),
    `${DEP_LIBRARY_DIR}/library.json`,
  );
  zip.addBuffer(Buffer.from('window.SpeakTestDep = {};\n'), `${DEP_LIBRARY_DIR}/dep.js`);

  zip.end();

  return collect(zip);
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
