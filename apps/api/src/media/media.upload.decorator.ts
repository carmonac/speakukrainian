import { UseInterceptors, applyDecorators } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes } from '@nestjs/swagger';
import { uploadTooLargeMessage, type MediaKind } from '@speakukrainian/shared';
import { UploadLimitInterceptor } from '../common/upload-limit.interceptor.js';
import { mediaUploadOptions } from './media.multer.js';

/** OpenAPI shape of the multipart body; the field name matches `ApiService.upload`. */
const FILE_BODY = {
  schema: {
    type: 'object',
    required: ['file'],
    properties: { file: { type: 'string', format: 'binary' } },
  },
};

/**
 * Everything a media upload route needs, stated once.
 *
 * Two things about this pair are easy to get wrong and impossible to notice
 * once wrong, which is why they are not left to each route to repeat:
 *
 * - `UploadLimitInterceptor` has to come *before* `FileInterceptor`. Multer
 *   aborts an oversize upload inside `FileInterceptor`, so only an interceptor
 *   listed ahead of it sees that rejection through `next.handle()`. Reversed,
 *   the 413 silently falls back to multer's bare `File too large`.
 * - Both halves have to be given the *same* kind, or the response names one
 *   limit while multer enforces the other.
 *
 * Taking a single `kind` makes both mechanical rather than remembered.
 */
export function MediaUpload(kind: MediaKind) {
  return applyDecorators(
    UseInterceptors(
      new UploadLimitInterceptor(uploadTooLargeMessage(kind)),
      FileInterceptor('file', mediaUploadOptions(kind)),
    ),
    ApiConsumes('multipart/form-data'),
    ApiBody(FILE_BODY),
  );
}
