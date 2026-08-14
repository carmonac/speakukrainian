import { H5pError, LibraryName } from '@lumieducation/h5p-server';
import type { ContentId, ILibraryName } from '@lumieducation/h5p-server';
import { STORAGE_PREFIXES } from '@speakukrainian/shared';

/**
 * Content ids address a storage prefix, so they may only be path-safe atoms.
 *
 * It looks like `documentIdSchema`'s character class and is not it: this bounds
 * a **Cloud Storage path segment**, which Cloud Storage is far more permissive
 * about than Firestore is about an id — `__name__` and `|` are both legal
 * object names, and refusing the second is this rule's own choice, made for the
 * reason `assertSafeOwnerId` gives. Replacing it with the shared schema would
 * swap one rule for another that happens to have the same alphabet and a
 * different reason, so the two are left to move independently (ADR-018).
 */
const SAFE_CONTENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Refuses a filename that could escape its prefix or produce an object name
 * nothing can address again.
 *
 * **What this covers:** the storage boundary — every name either adapter is
 * about to turn into an object path. `addFile`, `deleteFile`, `fileExists` and
 * `getFileStream` are all reachable from the editor and player flows, where the
 * name comes from a request rather than from a package.
 *
 * **What it does not cover:** the import path's extraction step. By the time
 * `ContentStorer.copyFromDirectoryToStorage` reaches `addFile`, the package has
 * already been unpacked onto disk and it is enumerating the extracted
 * directory, so the names it passes have been normalised by the filesystem and
 * a `..` inside the archive has already been acted on. `assertSafePackageEntries`
 * is the guard for that, and it runs before the library opens the package.
 *
 * The rule is deliberately stricter than the library's own `checkFilename`: a
 * Cloud Storage object name is a flat string, so there is no `path.join` to
 * normalise a `..` away afterwards.
 */
export function assertSafeRelativePath(filename: string): void {
  const reason = unsafeReason(filename);
  if (reason) {
    throw new H5pError(`storage-file-implementations:${reason}`, { filename }, 400);
  }
}

/**
 * The same rule, worded for a caller who *asked* for a path rather than
 * uploaded one.
 *
 * The three `storage-file-implementations:*` ids all mean "the package contains
 * a file with an unusable path" (`h5p.errors.ts`), which is true of an import
 * and false of a GET: nobody uploaded anything. Same rule, same status,
 * different sentence — and the split is here rather than at the mapper because
 * only the caller knows which side of the API it is on.
 */
export function assertSafeRequestPath(path: string): void {
  if (unsafeReason(path)) {
    throw new H5pError('h5p-request:unusable-path', { filename: path }, 400);
  }
}

/** Which of the library's own three rules a path breaks, or `null` when it breaks none. */
type UnsafeReason = 'illegal-relative-filename' | 'illegal-absolute-filename' | 'illegal-character';

function unsafeReason(filename: string): UnsafeReason | null {
  if (filename === '') {
    return 'illegal-relative-filename';
  }
  if (filename.startsWith('/')) {
    return 'illegal-absolute-filename';
  }
  // A backslash is a separator on Windows and a legal object-name character in
  // Cloud Storage, so `..\..\x` would survive a slash-only check.
  if (filename.includes('\\')) {
    return 'illegal-character';
  }
  // The set Windows forbids, plus the control range it also forbids: a NUL in
  // particular truncates a path in the syscall and would leave Node throwing a
  // `TypeError` from somewhere much further in.
  // eslint-disable-next-line no-control-regex
  if (/[<>:"|?*\u0000-\u001f]/.test(filename)) {
    return 'illegal-character';
  }

  const segments = filename.split('/');
  // Anchoring only at the start would let `a/../../b` through, and that is a
  // traversal out of the prefix, not a cosmetic problem.
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return 'illegal-relative-filename';
  }

  return null;
}

/**
 * The same rule for a zip entry name, which — unlike a stored object name — may
 * denote a directory and end in `/`.
 */
export function assertSafeEntryName(name: string): void {
  assertSafeRelativePath(name.endsWith('/') ? name.slice(0, -1) : name);
}

export function assertSafeContentId(contentId: string): void {
  // `addContent` accepts a caller-supplied id and we join it into a path.
  // `FileContentStorage` does not check this; over object storage we must.
  //
  // Worded as a request rather than as a package: an id is generated on the
  // import path and comes from a URL on every other, so `GET /api/h5p/play/x/y`
  // is the only way this realistically fires.
  if (!SAFE_CONTENT_ID.test(contentId)) {
    throw new H5pError('h5p-request:unusable-path', { filename: contentId }, 400);
  }
}

/**
 * A temporary file's owner is a path segment, so it obeys the same rule a
 * content id does — under an id of its own, because "that path is not valid"
 * said about a Firebase uid names the wrong thing to whoever reads it.
 *
 * A Firebase uid satisfies this today: 28 alphanumeric characters. An auth
 * provider whose subject carried a `:` or a `|` would turn every editor upload
 * into a 400, which is loud rather than silent, so it is named here rather
 * than worked around with an encoding nothing else in this module uses.
 */
export function assertSafeOwnerId(ownerId: string): void {
  if (!SAFE_CONTENT_ID.test(ownerId)) {
    throw new H5pError('h5p-request:unusable-owner', { ownerId }, 400);
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
  // The library-file route builds this from an ubername in the request URL, so
  // the rule every other builder in this module follows applies here too — and
  // it runs on the machine name, ahead of `toUberName`, for two reasons. It is
  // the only part of an ubername a caller controls freely, the versions being
  // numbers; and `toUberName` refuses a name its own pattern rejects with a
  // plain `Error`, which would surface as a 500 where this is a 400 about the
  // request. A machine name that satisfies this rule cannot produce an unsafe
  // ubername, because all `toUberName` appends is `-<major>.<minor>`.
  //
  // Worded as a request for the same reason: `GET /api/h5p/libraries/..-1.0/x`
  // is what reaches this, and telling that caller their package contains a bad
  // file names something they never sent.
  assertSafeRequestPath(library.machineName);
  const ubername = LibraryName.toUberName(library);
  return `${STORAGE_PREFIXES.h5pLibraries}/${ubername}/`;
}

/**
 * Joins an Express wildcard's segments into one relative path and asserts it.
 *
 * Express 5 hands a `*path` parameter back as an array of **decoded** segments,
 * so a percent-encoded separator arrives *inside* one segment:
 * `media/..%2f..%2fx` becomes `['media', '../../x']`. Checking each segment
 * would see `../../x` as one harmless name; only the joined string, split on
 * `/` again, sees it as a traversal. That is why the assert runs after the join
 * and never per segment.
 */
export function joinContentFilePath(segments: readonly string[] | string): string {
  const joined = Array.isArray(segments) ? segments.join('/') : String(segments);
  assertSafeRequestPath(joined);
  return joined;
}

export function libraryObjectPath(library: ILibraryName, filename: string): string {
  assertSafeRelativePath(filename);
  return `${libraryPrefix(library)}${filename}`;
}

/** Root prefixes, with the trailing slash a delimited listing needs. */
export const CONTENT_ROOT_PREFIX = `${STORAGE_PREFIXES.h5pContent}/`;
export const LIBRARY_ROOT_PREFIX = `${STORAGE_PREFIXES.h5pLibraries}/`;
export const TEMP_ROOT_PREFIX = `${STORAGE_PREFIXES.h5pTemp}/`;

/** `h5p/temp/<ownerId>/` — every temporary file one editor owns. */
export function tempPrefix(ownerId: string): string {
  assertSafeOwnerId(ownerId);
  return `${TEMP_ROOT_PREFIX}${ownerId}/`;
}

/**
 * `h5p/temp/<ownerId>/<filename>`.
 *
 * The filename legitimately contains a `/`: `H5PEditor.saveContentFile` files
 * an upload under its mimetype (`images/`, `audios/`, `videos/`), which
 * `assertSafeRelativePath` already permits.
 */
export function tempObjectPath(ownerId: string, filename: string): string {
  const prefix = tempPrefix(ownerId);
  assertSafeRelativePath(filename);
  return `${prefix}${filename}`;
}

/**
 * The inverse of `tempObjectPath`.
 *
 * `listFiles()` over the whole `h5p/temp/` prefix has to turn every object name
 * back into an owner and a filename, and doing that inline in the adapter would
 * put the layout in two places. `null` for anything without at least one owner
 * segment and a non-empty filename, so that a stray object directly under
 * `h5p/temp/` is skipped rather than making the expiry sweep throw — the
 * difference between a sweep that runs and a sweep that fails forever.
 */
export function parseTempObjectPath(
  objectPath: string,
): { ownerId: string; filename: string } | null {
  if (!objectPath.startsWith(TEMP_ROOT_PREFIX)) {
    return null;
  }

  const rest = objectPath.slice(TEMP_ROOT_PREFIX.length);
  const separator = rest.indexOf('/');
  if (separator <= 0) {
    return null;
  }

  const filename = rest.slice(separator + 1);
  return filename === '' ? null : { ownerId: rest.slice(0, separator), filename };
}
