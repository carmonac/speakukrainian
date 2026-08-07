import { H5pError } from '@lumieducation/h5p-server';
import { open } from 'yauzl-promise';
import { assertSafeEntryName } from './h5p.paths.js';

/**
 * Refuses a package whose zip entry names are not safe to unpack, before the
 * library unpacks it.
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
 */
export async function assertSafePackageEntries(packagePath: string): Promise<void> {
  let zip;
  try {
    zip = await open(packagePath, { validateFilenames: false });
  } catch (error) {
    throw unreadableArchive(error);
  }

  try {
    for await (const entry of zip) {
      assertSafeEntryName(entry.filename);
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
}

/**
 * An archive the scan cannot read is an archive the importer cannot import, so
 * the caller is told so with the wording a corrupt package already gets.
 *
 * Errors the filesystem raises — a missing or unreadable upload — are passed
 * through untouched: those are ours, and a 500 is the honest answer.
 */
function unreadableArchive(error: unknown): unknown {
  if (error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string') {
    return error;
  }

  const detail = error instanceof Error ? error.message : String(error);
  return new H5pError('unable-to-unzip', {}, 400, detail);
}
