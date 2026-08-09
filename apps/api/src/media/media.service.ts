import {
  Injectable,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import {
  MEDIA_UPLOAD_RULES,
  contentDoesNotMatchMessage,
  contentMatchesBytes,
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
   *
   * The byte check is not a repeat: it is the half that decides. A browser
   * derives the declared content type from the filename extension, so a text
   * file renamed to `.mp3` is declared `audio/mpeg` and gets past every check
   * above; only the leading bytes can say what the file is. It runs here rather
   * than in `fileFilter` because busboy calls that on the part's headers, with
   * no byte read yet. Memory storage is what makes the bytes available at this
   * point, and it is also why a rejection leaves nothing to unwind: nothing has
   * been written to the bucket or to disk. A route wired with disk storage
   * would hand `contentMatchesBytes` no buffer and be refused, not waved
   * through.
   *
   * The declared type is what gets stored, and `buildObjectPath` keeps deriving
   * the extension from it — corroborated by the bytes, to within what a
   * container header can prove.
   *
   * Type, then bytes, then size, which is the order the admin's pre-check runs
   * in: a file that is both the wrong format and too big has to be given the
   * same reason at both ends, or an author who is told "this is not an MP3"
   * locally gets "too big" back from the API for the same file.
   */
  async upload(kind: MediaKind, file: Express.Multer.File): Promise<AssetRef> {
    if (!isAllowedContentType(kind, file.mimetype)) {
      throw new UnsupportedMediaTypeException(unsupportedContentTypeMessage(kind, file.mimetype));
    }
    if (!contentMatchesBytes(file.mimetype, file.buffer)) {
      throw new UnsupportedMediaTypeException(contentDoesNotMatchMessage(kind, file.mimetype));
    }
    if (file.size > MEDIA_UPLOAD_RULES[kind].maxBytes) {
      throw new PayloadTooLargeException(uploadTooLargeMessage(kind));
    }

    const path = buildObjectPath(kind, file.mimetype);
    return this.storage.upload(file.buffer, { path, contentType: file.mimetype });
  }
}
