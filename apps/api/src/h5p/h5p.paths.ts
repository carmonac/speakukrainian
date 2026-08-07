import { H5pError, LibraryName } from '@lumieducation/h5p-server';
import type { ContentId, ILibraryName } from '@lumieducation/h5p-server';
import { STORAGE_PREFIXES } from '@speakukrainian/shared';

/** Content ids address a storage prefix, so they may only be path-safe atoms. */
const SAFE_CONTENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Refuses a filename that could escape its prefix or produce an object name
 * nothing can address again.
 *
 * This is deliberately stricter than the library's own `checkFilename`, and it
 * is not decoration. `PackageImporter.addPackageLibrariesAndContent` streams
 * every file out of the package straight to `addFile`, without routing it
 * through `getUniqueFilename` — so `sanitizeFilename` is never consulted on the
 * install path and this is the only check standing between a crafted package
 * and an object written outside its prefix. A Cloud Storage object name is a
 * flat string: there is no `path.join` to normalise it away afterwards.
 */
export function assertSafeRelativePath(filename: string): void {
  const illegal = (errorId: string): never => {
    throw new H5pError(`storage-file-implementations:${errorId}`, { filename }, 400);
  };

  if (filename === '') {
    illegal('illegal-relative-filename');
  }
  if (filename.startsWith('/')) {
    illegal('illegal-absolute-filename');
  }
  // A backslash is a separator on Windows and a legal object-name character in
  // Cloud Storage, so `..\..\x` would survive a slash-only check.
  if (filename.includes('\\')) {
    illegal('illegal-character');
  }
  if (/[<>:"|?*]/.test(filename)) {
    illegal('illegal-character');
  }

  const segments = filename.split('/');
  // Anchoring only at the start would let `a/../../b` through, and that is a
  // traversal out of the prefix, not a cosmetic problem.
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    illegal('illegal-relative-filename');
  }
}

export function assertSafeContentId(contentId: string): void {
  // `addContent` accepts a caller-supplied id and we join it into a path.
  // `FileContentStorage` does not check this; over object storage we must.
  if (!SAFE_CONTENT_ID.test(contentId)) {
    throw new H5pError(
      'storage-file-implementations:illegal-relative-filename',
      { filename: contentId },
      400,
    );
  }
}

/** `h5p/content/<id>/` — with the trailing slash, as prefix operations need. */
export function contentPrefix(contentId: ContentId): string {
  const id = String(contentId);
  assertSafeContentId(id);
  return `${STORAGE_PREFIXES.h5pContent}/${id}/`;
}

/** `h5p/content/<id>` — what the index document stores. */
export function contentStoragePath(contentId: ContentId): string {
  return contentPrefix(contentId).slice(0, -1);
}

export function contentObjectPath(contentId: ContentId, filename: string): string {
  assertSafeRelativePath(filename);
  return `${contentPrefix(contentId)}${filename}`;
}

/** `h5p/libraries/<Machine.Name-major.minor>/`. */
export function libraryPrefix(library: ILibraryName): string {
  return `${STORAGE_PREFIXES.h5pLibraries}/${LibraryName.toUberName(library)}/`;
}

export function libraryObjectPath(library: ILibraryName, filename: string): string {
  assertSafeRelativePath(filename);
  return `${libraryPrefix(library)}${filename}`;
}

/** Root prefixes, with the trailing slash a delimited listing needs. */
export const CONTENT_ROOT_PREFIX = `${STORAGE_PREFIXES.h5pContent}/`;
export const LIBRARY_ROOT_PREFIX = `${STORAGE_PREFIXES.h5pLibraries}/`;
