import { H5pError } from '@lumieducation/h5p-server';
import { open } from 'yauzl-promise';
import { assertSafeEntryName } from './h5p.paths.js';

/** The one top-level folder in a package that is not a library folder. */
const CONTENT_FOLDER = 'content';

/**
 * The per-component limit of every filesystem the extractor could land on —
 * ext4, APFS and NTFS all stop at 255. `PackageImporter.extractPackage` creates
 * one directory per segment, so a longer segment is an `ENAMETOOLONG` from
 * `mkdir` halfway through unpacking.
 */
const MAX_SEGMENT_BYTES = 255;

/**
 * A content file is stored at `h5p/content/<uuid>/<name>`, and Cloud Storage
 * caps an object name at 1024 bytes — 49 of which that prefix already spends.
 * A longer name could not be stored even if it unpacked, and long before that
 * it is a `PATH_MAX` failure from `mkdir`.
 */
const MAX_NAME_BYTES = 1024 - 49;

/**
 * Refuses a package the importer cannot unpack safely, before it unpacks it.
 *
 * **What this covers:** the import path, and it is the only guard on it.
 * `PackageImporter.extractPackage` writes every entry to
 * `path.join(tempDirectory, entry.filename)` with no check of its own, so a
 * `..` segment in an entry name is a straight write onto the container
 * filesystem. Until this ran, the only thing standing in the way was
 * `yauzl-promise`'s own `validateFilename` — a dependency of
 * `@lumieducation/h5p-server` that nothing here pinned and no test here
 * asserted. `assertSafeRelativePath` in the content adapter does not cover it:
 * that guard sits *behind* the extraction, on names the filesystem has already
 * normalised.
 *
 * **Why it reads the archive with yauzl rather than parsing it here:** a second
 * parser could disagree with the extractor about which entries an archive has,
 * and an entry the scan never saw is an entry the scan never checked. Yauzl
 * prefers the name in an Info-ZIP Unicode Path extra field over the one in the
 * header, for instance, which a naive central-directory reader would miss
 * entirely. So the scan opens the package with the same reader the importer
 * will, with yauzl's own filename validation turned off so that the rule
 * applied is this one — stricter, ours, and pinned by the specs next door.
 *
 * **What else it refuses, and why here:** a name too long for a filesystem
 * component, and a top-level folder that is not a library. Both are malformed
 * packages that the library answers with a plain `Error` raised mid-import —
 * an `ENAMETOOLONG` from `mkdir`, and an assertion inside `PackageValidator` —
 * which `toHttpException` rightly declines to map and which therefore reached
 * the caller as a 500 for a problem in their file. Both are decidable from the
 * entry names alone, so they are decided before a byte is extracted rather than
 * recognised afterwards from an errno or a library-internal message.
 */
export async function assertSafePackageEntries(packagePath: string): Promise<void> {
  let zip;
  try {
    zip = await open(packagePath, { validateFilenames: false });
  } catch (error) {
    throw unreadableArchive(error);
  }

  const layout = new PackageLayout();
  try {
    for await (const entry of zip) {
      assertUnpackableName(entry.filename);
      layout.add(entry.filename);
    }
  } catch (error) {
    if (error instanceof H5pError) {
      throw error;
    }
    throw unreadableArchive(error);
  } finally {
    // A failure to close must not replace the reason we are leaving.
    await zip.close().catch(() => undefined);
  }

  layout.assertEveryFolderIsALibrary();
}

/** Every rule that applies to one entry name on its own. */
function assertUnpackableName(name: string): void {
  assertSafeEntryName(name);

  if (Buffer.byteLength(name, 'utf-8') > MAX_NAME_BYTES) {
    throw new H5pError('package-scan:filename-too-long', { filename: name }, 400);
  }
  for (const segment of name.split('/')) {
    if (Buffer.byteLength(segment, 'utf-8') > MAX_SEGMENT_BYTES) {
      throw new H5pError('package-scan:filename-too-long', { filename: name }, 400);
    }
  }
}

/**
 * Which top-level folders the extractor will create, and which of them carry a
 * `library.json`.
 *
 * `PackageValidator.librariesMustBeValid` treats every top-level folder except
 * `content` as a library and reads `<folder>/library.json` without first
 * checking that it is there; when it is not, it throws a plain `Error` rather
 * than an `H5pError`. So `__MACOSX/…`, or any stray folder a user zipped
 * alongside the real ones, was a 500. This reproduces the layout rule the H5P
 * package format already states, from the names alone.
 */
class PackageLayout {
  private readonly folders = new Set<string>();
  private readonly libraries = new Set<string>();

  add(name: string): void {
    // Mirrors `extractPackage`'s own filter: it skips directory entries and
    // anything whose basename starts with `.` or `_`, so a folder holding only
    // those is never created on disk and the validator never sees it.
    const separator = name.indexOf('/');
    if (name.endsWith('/') || separator < 0) {
      return;
    }
    const basename = name.slice(name.lastIndexOf('/') + 1);
    if (basename.startsWith('.') || basename.startsWith('_')) {
      return;
    }

    const folder = name.slice(0, separator);
    if (folder === CONTENT_FOLDER) {
      return;
    }

    this.folders.add(folder);
    // The validator matches the metadata file case-insensitively, so this must
    // too, or a package it accepts would be refused here.
    if (name.slice(folder.length + 1).toLowerCase() === 'library.json') {
      this.libraries.add(folder);
    }
  }

  assertEveryFolderIsALibrary(): void {
    for (const folder of this.folders) {
      if (!this.libraries.has(folder)) {
        throw new H5pError('package-scan:not-a-library-folder', { folder }, 400);
      }
    }
  }
}

/**
 * Turns a failure to read the archive into the 400 a corrupt package already
 * gets — unless the operating system is what refused, which is this server's
 * problem and stays a 500.
 */
function unreadableArchive(error: unknown): unknown {
  if (isSystemError(error)) {
    return error;
  }

  const detail = error instanceof Error ? error.message : String(error);
  return new H5pError('unable-to-unzip', {}, 400, detail);
}

/**
 * A failure the operating system reported, as opposed to one the archive's own
 * bytes caused.
 *
 * Keyed on `errno` and `syscall` together, which only Node's `SystemError`
 * carries. A string `code` alone does not distinguish the two: *every* Node
 * built-in error has one, and a zero-length entry name reaches
 * `Buffer.allocUnsafe(undefined)` inside yauzl and throws
 * `TypeError [ERR_INVALID_ARG_TYPE]` — a fact about the uploaded file, wearing
 * a `code`.
 */
function isSystemError(error: unknown): error is NodeJS.ErrnoException {
  if (!(error instanceof Error)) {
    return false;
  }

  const { errno, syscall } = error as NodeJS.ErrnoException;
  return typeof errno === 'number' && typeof syscall === 'string';
}
