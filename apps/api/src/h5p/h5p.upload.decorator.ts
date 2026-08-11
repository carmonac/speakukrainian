import { UseInterceptors, applyDecorators } from '@nestjs/common';
import { FileFieldsInterceptor, FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes } from '@nestjs/swagger';
import { h5pEditorUploadTooLargeMessage, h5pUploadTooLargeMessage } from '@speakukrainian/shared';
import { UploadLimitInterceptor } from '../common/upload-limit.interceptor.js';
import { h5pEditorUploadOptions, h5pUploadOptions } from './h5p.multer.js';

/** OpenAPI shape of the multipart body; the field name matches `ApiService.upload`. */
const FILE_BODY = {
  schema: {
    type: 'object',
    required: ['file'],
    properties: { file: { type: 'string', format: 'binary' } },
  },
};

/**
 * The ajax route's multipart body: `file` for `action=files`, `h5p` for
 * `action=library-upload`, and neither for the three JSON actions.
 */
const AJAX_BODY = {
  schema: {
    type: 'object',
    properties: {
      file: { type: 'string', format: 'binary' },
      h5p: { type: 'string', format: 'binary' },
      field: { type: 'string' },
      libraries: { type: 'string' },
      libraryParameters: { type: 'string' },
    },
  },
};

/**
 * Everything the package upload route needs, stated once.
 *
 * `UploadLimitInterceptor` has to come *before* `FileInterceptor`: multer
 * aborts an oversize upload inside `FileInterceptor`, so only an interceptor
 * listed ahead of it sees that rejection through `next.handle()`. Reversed, the
 * 413 silently falls back to multer's bare `File too large`. That ordering is
 * the reason this is a decorator rather than two lines on the route.
 */
export function H5pPackageUpload() {
  return applyDecorators(
    UseInterceptors(
      new UploadLimitInterceptor(h5pUploadTooLargeMessage()),
      FileInterceptor('file', h5pUploadOptions()),
    ),
    ApiConsumes('multipart/form-data'),
    ApiBody(FILE_BODY),
  );
}

/**
 * The same for the editor's ajax route, which has two possible file fields.
 *
 * The interceptor order rule is the one `H5pPackageUpload` states and it holds
 * for the same reason: multer aborts an oversize upload inside the file
 * interceptor, so only an interceptor listed ahead of it sees that rejection
 * through `next.handle()`.
 *
 * A non-multipart `POST /ajax` — the `libraries`, `translations` and `filter`
 * actions all send JSON — passes straight through: multer's middleware is a
 * no-op when the content type is not multipart.
 */
export function H5pAjaxUpload() {
  return applyDecorators(
    UseInterceptors(
      new UploadLimitInterceptor(h5pEditorUploadTooLargeMessage()),
      FileFieldsInterceptor(
        [
          { name: 'file', maxCount: 1 },
          { name: 'h5p', maxCount: 1 },
        ],
        h5pEditorUploadOptions(),
      ),
    ),
    ApiConsumes('multipart/form-data'),
    ApiBody(AJAX_BODY),
  );
}
