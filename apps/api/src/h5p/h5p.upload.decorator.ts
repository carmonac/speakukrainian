import { UseInterceptors, applyDecorators } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes } from '@nestjs/swagger';
import { h5pUploadTooLargeMessage } from '@speakukrainian/shared';
import { UploadLimitInterceptor } from '../common/upload-limit.interceptor.js';
import { h5pUploadOptions } from './h5p.multer.js';

/** OpenAPI shape of the multipart body; the field name matches `ApiService.upload`. */
const FILE_BODY = {
  schema: {
    type: 'object',
    required: ['file'],
    properties: { file: { type: 'string', format: 'binary' } },
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
