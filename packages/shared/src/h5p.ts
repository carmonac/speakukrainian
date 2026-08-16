import { z } from 'zod';
import { auditSchema, paginationQuerySchema } from './common.js';
import { pageIdSchema } from './page.js';

/**
 * Metadata for one piece of H5P content. The actual content files and libraries
 * live in Cloud Storage, managed by `@lumieducation/h5p-server`; this record is
 * the admin-facing index over them.
 */
export const h5pContentSchema = z.object({
  /** The H5P server's content id. */
  id: z.string().min(1),
  title: z.string().min(1),
  /** Main library ubername — machine name and version, `H5P.MultiChoice 1.16`. */
  mainLibrary: z.string().min(1),
  /**
   * Page this exercise is attached to, if any — a **back-reference**, written
   * only by `POST /api/h5p/content/:id/attach` and cleared only by
   * `POST /api/h5p/content/:id/detach`.
   *
   * `contentPage.body.h5pContentId` is the authoritative record of the same
   * relationship: that is what renders and what publication is gated on. This
   * field is deliberately not kept consistent with it — nothing clears it when
   * the page is deleted or when a page body stops naming this exercise — so it
   * may name a page that no longer exists, or one that now names another
   * exercise. **What a reader may then do with it is ADR-007's rule, under
   * _Who may read H5P content_, and only there** — including which reader is
   * exempt from it and which half of it a test enforces. Read it before
   * reading this field anywhere. It is deliberately not restated here: it was,
   * at three sites in three strengths, and the paraphrases had drifted apart by
   * the time they were first reviewed.
   */
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
 * What a save may change about an existing index row.
 *
 * **`pageId` and `storagePath` are deliberately absent.** `storagePath` is
 * derived from the content id, which a save never changes; `pageId` is written
 * by `POST /api/h5p/content/:id/attach|detach` and by nothing else, so a save
 * that rewrote the row from its own fields would silently detach an exercise
 * from its page a moment after an author attached it. Now that the field really
 * is written, that is a live failure mode rather than a precaution.
 */
export const updateH5pContentSchema = h5pContentSchema.pick({
  title: true,
  mainLibrary: true,
  sizeBytes: true,
});
export type UpdateH5pContentInput = z.infer<typeof updateH5pContentSchema>;

/**
 * The body of `POST /api/h5p/content/:id/attach`.
 *
 * **`strictObject`, not `object`**: a plain object strips an unrecognized key
 * silently, so `{ pageId, title }` would answer 200 for a title change that
 * never happened — the same argument `pageBodySchema` makes about a body posted
 * with the wrong variant's fields. Strict is what makes "this route cannot
 * write any other field" observable from the wire.
 *
 * **No `null`**: detaching is `POST /api/h5p/content/:id/detach`, a route of its
 * own, so the schema itself refuses the other mode rather than a handler
 * branching on it.
 *
 * A one-field object rather than a bare string because a JSON body has to be an
 * object, and it is the object that the strictness above applies to.
 */
export const attachH5pContentSchema = z.strictObject({ pageId: pageIdSchema });
export type AttachH5pContentInput = z.infer<typeof attachH5pContentSchema>;

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

/**
 * What the authoring widget posts back to `POST /api/h5p/editor[/:contentId]`.
 *
 * **Where the line is drawn:** this validates exactly what would otherwise turn
 * a request into a 500 or into a junk index row, and passes the library's own
 * payload through. Re-declaring H5P's metadata format in Zod would be a second
 * source of truth for someone else's schema, and it would break on their next
 * release; the library validates the rest against its own `save-metadata.json`,
 * and `h5p.errors.ts` maps that refusal to a 400.
 */
export const saveH5pContentSchema = z.object({
  /**
   * Ubername with whitespace: `H5P.MultiChoice 1.16`.
   *
   * Required, because `LibraryName.fromUberName(undefined)` is a plain `Error`
   * — a 500 — before the library's own 400 for a malformed one.
   */
  library: z.string().min(1).max(255),
  params: z.object({
    /**
     * `content.json`. Its shape is the library's semantics, not ours.
     *
     * A record and not `z.unknown()`: in Zod an `unknown` field is an optional
     * key, so `z.unknown()` would admit a body with no parameters at all, and
     * `scanForFiles(undefined, …)` is a `TypeError` and a 500. A JSON object at
     * the root is what `content.json` always is — the weakest bound that is
     * still a bound.
     */
    params: z.record(z.string(), z.unknown()),
    /**
     * `h5p.json`-shaped.
     *
     * Loose past `title` on purpose: `save-metadata.json` requires only
     * `title` and sets no `additionalProperties: false`, so a `/params` → save
     * round trip legitimately posts back `preloadedDependencies`, `embedTypes`,
     * `language`, `mainLibrary` and the rest. `title` is required here because
     * its absence is a plain `Error` and a 500.
     */
    metadata: z.looseObject({ title: z.string().min(1).max(255) }),
  }),
});
export type SaveH5pContentInput = z.infer<typeof saveH5pContentSchema>;

/** Result of uploading or saving H5P content through the admin panel. */
export const h5pSaveResultSchema = z.object({
  contentId: z.string().min(1),
  title: z.string(),
  mainLibrary: z.string(),
});
export type H5pSaveResult = z.infer<typeof h5pSaveResultSchema>;
