import { UnsupportedMediaTypeException } from '@nestjs/common';
import {
  MAX_H5P_UPLOAD_BYTES,
  isH5pPackageFilename,
  notAnH5pPackageMessage,
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
 * Multer options for the `.h5p` upload, passed as `FileInterceptor`'s second
 * argument.
 *
 * No `storage` is set here: `H5pModule` supplies `dest` through
 * `MulterModule.registerAsync`, so multer writes the package to disk under
 * `<H5P_TEMP_DIR>/uploads` and the handler gets a `path`. Memory storage would
 * be wrong twice over — 100 MB held per concurrent upload against Cloud Run's
 * default memory, and the importer wants a file path anyway.
 *
 * `limits.fileSize` is what keeps an oversize upload cheap: busboy emits
 * `limit` as soon as the byte count is exceeded, so nothing beyond the limit is
 * ever written.
 *
 * The gate is the *extension*, not the declared content type: browsers report a
 * `.h5p` as `application/zip`, `application/octet-stream` or nothing at all
 * depending on the operating system. The filename is used only for this
 * accept/reject decision and never to name a stored object — the same rule
 * `media.paths.ts` follows. A `.zip` renamed to `.h5p` gets through here and is
 * rejected by the library's own archive and schema validation, which is where
 * that question can actually be answered.
 */
export function h5pUploadOptions() {
  return {
    limits: { fileSize: MAX_H5P_UPLOAD_BYTES, files: 1 },
    fileFilter(_req: unknown, file: Express.Multer.File, callback: FileFilterCallback): void {
      if (isH5pPackageFilename(file.originalname)) {
        callback(null, true);
        return;
      }

      // Pass the rejection to the callback rather than throwing: multer does
      // not catch a throw from here and the request would hang. Nest's
      // `transformException` forwards an HttpException untouched, so this
      // reaches the client as a 415 with this message.
      callback(new UnsupportedMediaTypeException(notAnH5pPackageMessage(file.originalname)), false);
    },
  };
}
