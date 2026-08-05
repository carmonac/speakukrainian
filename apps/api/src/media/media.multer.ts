import { UnsupportedMediaTypeException } from '@nestjs/common';
import multer from 'multer';
import {
  MEDIA_UPLOAD_RULES,
  isAllowedContentType,
  unsupportedContentTypeMessage,
  type MediaKind,
} from '@speakukrainian/shared';

/**
 * Nest's `MulterOptions` declares the filter callback as a plain two-argument
 * function, which is narrower than multer's own overloaded `FileFilterCallback`
 * and is the shape the options object has to satisfy. It lives behind a deep
 * path in a package with no `exports` map, so the signature is restated rather
 * than imported from there.
 */
type FileFilterCallback = (error: Error | null, acceptFile: boolean) => void;

/**
 * Multer options for a media route, passed as `FileInterceptor`'s second
 * argument.
 *
 * `limits.fileSize` is what keeps an oversize upload cheap: busboy emits
 * `limit` as soon as the byte count is exceeded, multer discards the buffer and
 * the handler never runs, so at most `maxBytes` is ever held and nothing
 * reaches Cloud Storage. Checking `file.size` in the controller would mean the
 * whole body had already been buffered.
 *
 * This is a plain factory called from a decorator, not a Nest provider.
 */
export function mediaUploadOptions(kind: MediaKind) {
  const rule = MEDIA_UPLOAD_RULES[kind];

  return {
    storage: multer.memoryStorage(),
    limits: { fileSize: rule.maxBytes, files: 1 },
    fileFilter(_req: unknown, file: Express.Multer.File, callback: FileFilterCallback): void {
      if (isAllowedContentType(kind, file.mimetype)) {
        callback(null, true);
        return;
      }

      // Pass the rejection to the callback rather than throwing: multer does
      // not catch a throw from here and the request would hang. Nest's
      // `transformException` forwards an HttpException untouched, so this
      // reaches the client as a 415 with this message.
      callback(
        new UnsupportedMediaTypeException(unsupportedContentTypeMessage(kind, file.mimetype)),
        false,
      );
    },
  };
}
