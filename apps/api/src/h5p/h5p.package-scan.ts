import { H5pError } from '@lumieducation/h5p-server';
import { MAX_H5P_UPLOAD_BYTES } from '@speakukrainian/shared';
import { open } from 'yauzl-promise';
import type { ZipEntry } from 'yauzl-promise';
import { assertSafeEntryName } from './h5p.paths.js';

/** The one top-level folder in a package that is not a library folder. */
const CONTENT_FOLDER = 'content';

/** The one top-level file the extractor writes out. */
const METADATA_FILE = 'h5p.json';

/**
 * The compression methods the reader can decode: stored and deflate.
 * `Entry.openReadStream` asserts on everything else, and what an archiver
 * writes when asked for something else is Deflate64 (9), BZip2 (12) or
 * LZMA (14).
 */
const READABLE_COMPRESSION_METHODS = new Set([0, 8]);

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
 * component, a top-level folder that is not a library, and an entry whose data
 * the reader will not hand over. All are malformed packages that the library
 * answers with a plain `Error` raised mid-import — an `ENAMETOOLONG` from
 * `mkdir`, an assertion inside `PackageValidator`, an assertion inside
 * `openReadStream` — which `toHttpException` rightly declines to map and which
 * therefore reached the caller as a 500 for a problem in their file.
 *
 * **Why it reads the data and does not only look at the headers:** because the
 * alternative is worse than a 500. `extractPackage` pipes each entry to disk
 * with `promisepipe`, and when the read fails part-way — a checksum that does
 * not match, data that stops early, a deflate stream that will not inflate —
 * the read stream errors while the write stream emits nothing, so the pipe's
 * `Promise.all` never settles. The request then hangs forever: no response, no
 * log line, and the `finally` that deletes the uploaded file never runs.
 * Reading each entry here costs one extra pass over the package and turns every
 * one of those into a 400 before the importer starts.
 *
 * `maxUnpackedBytes` is the budget for that read: the total the package's
 * entries may unpack to, which is the same ceiling `createH5pConfig` gives the
 * library as `maxTotalSize`.
 */
export async function assertSafePackageEntries(
  packagePath: string,
  maxUnpackedBytes = MAX_H5P_UPLOAD_BYTES,
): Promise<void> {
  let zip;
  try {
    zip = await open(packagePath, { validateFilenames: false });
  } catch (error) {
    throw unreadableArchive(error);
  }

  const layout = new PackageLayout();
  let unpackedBytes = 0;
  try {
    for await (const entry of zip) {
      assertUnpackableName(entry.filename);
      if (isExtracted(entry.filename)) {
        assertReadableData(entry);
        unpackedBytes += await readEntry(entry, maxUnpackedBytes - unpackedBytes);
      }
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
 * Every rule that applies to one entry's data, decided from its headers.
 *
 * `Entry.openReadStream` refuses an encrypted entry and every compression
 * method but deflate, with a plain `Error` raised from inside
 * `PackageImporter.extractPackage` — half way through unpacking, where no
 * mapping can tell it from a server fault. Both are ordinary mistakes rather
 * than exotic ones: encryption is one checkbox in every archiver, and
 * Deflate64, BZip2 and LZMA are what 7-Zip writes when asked for a `.zip` at
 * anything but its default. The central directory says which an entry is, so
 * the caller is told before the archive is unpacked.
 *
 * Both are checked from the headers rather than left to the read below only so
 * that the caller is told which of the two it was: "password-protected" and
 * "an unreadable compression method" are each something they can fix, where
 * "not a readable ZIP archive" is not.
 */
function assertReadableData(entry: ZipEntry): void {
  if (entry.isEncrypted()) {
    throw new H5pError('package-scan:encrypted-entry', { filename: entry.filename }, 400);
  }
  if (!READABLE_COMPRESSION_METHODS.has(entry.compressionMethod)) {
    throw new H5pError(
      'package-scan:unsupported-compression',
      { filename: entry.filename, method: String(entry.compressionMethod) },
      400,
    );
  }
}

/**
 * Reads one entry to the end and returns how many bytes it produced, so that
 * whatever the reader would have raised mid-extraction is raised here instead.
 * The data is discarded: the importer reads the package again, and this is only
 * asking whether it can.
 *
 * `remainingBytes` is what is left of the total the API accepts. Without it a
 * few kilobytes of zip could ask this to inflate a hundred gigabytes — the
 * declared sizes the library's own `validateFileSizes` rejects that by are not
 * available until after it has extracted, which is after this runs.
 */
async function readEntry(entry: ZipEntry, remainingBytes: number): Promise<number> {
  const stream = await entry.openReadStream();
  let bytes = 0;

  for await (const chunk of stream) {
    bytes += (chunk as Buffer).length;
    if (bytes > remainingBytes) {
      stream.destroy();
      throw new H5pError('package-scan:unpacks-too-large', {}, 400);
    }
  }

  return bytes;
}

/**
 * Whether `PackageImporter.extractPackage` will open this entry and write it
 * out. It skips directory entries, anything whose basename starts with `.` or
 * `_`, and every top-level file but `h5p.json`.
 *
 * Mirrored rather than approximated: an entry the importer never opens can
 * never fail on the way out of `openReadStream`, so refusing a package for one
 * would be refusing a package the library imports fine.
 */
function isExtracted(name: string): boolean {
  if (name.endsWith('/')) {
    return false;
  }
  const basename = name.slice(name.lastIndexOf('/') + 1);
  if (basename.startsWith('.') || basename.startsWith('_')) {
    return false;
  }
  return name.includes('/') || name === METADATA_FILE;
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
    // A folder holding only entries the extractor skips is never created on
    // disk, so the validator never sees it and refusing the package for it
    // would be refusing nothing.
    const separator = name.indexOf('/');
    if (separator < 0 || !isExtracted(name)) {
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
