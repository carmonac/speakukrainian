import {
  Injectable,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import {
  MEDIA_UPLOAD_RULES,
  isAllowedContentType,
  unsupportedContentTypeMessage,
  uploadTooLargeMessage,
  type AssetRef,
  type MediaKind,
} from '@speakukrainian/shared';
import { StorageService } from '../infra/storage/storage.service.js';
import { buildObjectPath } from './media.paths.js';

@Injectable()
export class MediaService {
  constructor(private readonly storage: StorageService) {}

  /**
   * The type and size checks repeat what the route's multer options already
   * enforce. They are defence in depth for a route wired without the matching
   * interceptor — multer is the check that matters, because it is the one that
   * stops an oversize body from being buffered at all.
   */
  async upload(kind: MediaKind, file: Express.Multer.File): Promise<AssetRef> {
    if (!isAllowedContentType(kind, file.mimetype)) {
      throw new UnsupportedMediaTypeException(unsupportedContentTypeMessage(kind, file.mimetype));
    }
    if (file.size > MEDIA_UPLOAD_RULES[kind].maxBytes) {
      throw new PayloadTooLargeException(uploadTooLargeMessage(kind));
    }

    const path = buildObjectPath(kind, file.mimetype);
    return this.storage.upload(file.buffer, { path, contentType: file.mimetype });
  }
}
