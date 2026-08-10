import { z } from 'zod';
import { auditSchema, paginationQuerySchema } from './common.js';

/**
 * Metadata for one piece of H5P content. The actual content files and libraries
 * live in Cloud Storage, managed by `@lumieducation/h5p-server`; this record is
 * the admin-facing index over them.
 */
export const h5pContentSchema = z.object({
  /** The H5P server's content id. */
  id: z.string().min(1),
  title: z.string().min(1),
  /** Main library machine name, e.g. `H5P.MultiChoice 1.16`. */
  mainLibrary: z.string().min(1),
  /** Page this exercise is attached to, if any. */
  pageId: z.string().min(1).nullable().default(null),
  /** Storage prefix holding the content's files. */
  storagePath: z.string().min(1),
  sizeBytes: z.number().int().nonnegative().default(0),
  audit: auditSchema,
});
export type H5pContent = z.infer<typeof h5pContentSchema>;

/** Input to the H5P content index; `audit` is stamped by the repository. */
export const createH5pContentSchema = h5pContentSchema.omit({ audit: true });
export type CreateH5pContentInput = z.infer<typeof createH5pContentSchema>;

/**
 * Query for `GET /api/h5p/content`. It carries no filters of its own yet; the
 * first one — `pageId`, or the main library — belongs here rather than as a
 * second query type on the route, so the route signature never has to change.
 */
export const listH5pContentQuerySchema = paginationQuerySchema;
export type ListH5pContentQuery = z.infer<typeof listH5pContentQuerySchema>;

export const MAX_H5P_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * Uploaded packages are identified by extension, not content type: browsers
 * report a `.h5p` as `application/zip`, `application/octet-stream` or nothing
 * at all depending on the operating system, so the declared type cannot be the
 * gate.
 */
export const H5P_PACKAGE_EXTENSION = '.h5p';

/** "100 MB". The limit is a whole number of megabytes. */
export function formatMaxH5pUploadSize(): string {
  return `${MAX_H5P_UPLOAD_BYTES / (1024 * 1024)} MB`;
}

/**
 * The admin pre-checks an upload in the browser and the API rejects it, so both
 * sides have to describe the same rule — the same reason
 * `uploadTooLargeMessage` lives here.
 */
export function h5pUploadTooLargeMessage(): string {
  return `H5P packages must be under ${formatMaxH5pUploadSize()}.`;
}

/**
 * The same byte limit, said to someone who did not upload a package.
 *
 * `POST /api/h5p/ajax` shares `MAX_H5P_UPLOAD_BYTES` with the package route,
 * but the field an author fills there is usually a pronunciation clip or an
 * image, and a 413 that says "H5P packages" describes a file they never sent.
 */
export function h5pEditorUploadTooLargeMessage(): string {
  return `Uploads must be under ${formatMaxH5pUploadSize()}.`;
}

export function notAnH5pPackageMessage(filename: string): string {
  return `${filename} is not an H5P package. Upload a file with the ${H5P_PACKAGE_EXTENSION} extension.`;
}

/** Case-insensitive, because Windows hands over `PACKAGE.H5P`. */
export function isH5pPackageFilename(filename: string): boolean {
  return filename.toLowerCase().endsWith(H5P_PACKAGE_EXTENSION);
}

/** Result of uploading or saving H5P content through the admin panel. */
export const h5pSaveResultSchema = z.object({
  contentId: z.string().min(1),
  title: z.string(),
  mainLibrary: z.string(),
});
export type H5pSaveResult = z.infer<typeof h5pSaveResultSchema>;
