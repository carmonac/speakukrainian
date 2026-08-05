import { randomUUID } from 'node:crypto';
import {
  FILE_EXTENSION_BY_CONTENT_TYPE,
  MEDIA_UPLOAD_RULES,
  type MediaContentType,
  type MediaKind,
} from '@speakukrainian/shared';

/**
 * Object path for a newly uploaded file: `<prefix>/<yyyy>/<mm>/<uuid>.<ext>`.
 *
 * The uuid is what makes two uploads of the same filename two distinct
 * objects, so nothing is ever overwritten and the `immutable` cache header
 * `StorageService` sets is honest. The date segments are UTC so a path does not
 * depend on the region an instance happens to run in, and the extension comes
 * from the content type — the uploaded filename is never used as a path
 * segment.
 */
export function buildObjectPath(
  kind: MediaKind,
  contentType: MediaContentType,
  now = new Date(),
): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const extension = FILE_EXTENSION_BY_CONTENT_TYPE[contentType];

  return `${MEDIA_UPLOAD_RULES[kind].prefix}/${year}/${month}/${randomUUID()}.${extension}`;
}
