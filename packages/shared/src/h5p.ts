import { z } from 'zod';
import { auditSchema } from './common.js';

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

export const MAX_H5P_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Result of uploading or saving H5P content through the admin panel. */
export const h5pSaveResultSchema = z.object({
  contentId: z.string().min(1),
  title: z.string(),
  mainLibrary: z.string(),
});
export type H5pSaveResult = z.infer<typeof h5pSaveResultSchema>;
