import { BadRequestException, Controller, Post, UploadedFile } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { assetRefSchema, type AssetRef, type MediaKind } from '@speakukrainian/shared';
import { Roles } from '../auth/roles.decorator.js';
import { MediaUpload } from './media.upload.decorator.js';
import { MediaService } from './media.service.js';

/**
 * Uploads land in Cloud Storage and come back as an `AssetRef` the rich text
 * editor embeds. There is no Firestore document behind them: the media library
 * and orphan collection are a later phase.
 *
 * The global guards run before the interceptors `MediaUpload` installs, so an
 * unauthenticated or under-privileged caller is refused before a byte of the
 * file is read.
 */
@ApiTags('media')
@ApiBearerAuth()
@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post('image')
  @Roles('editor')
  @MediaUpload('image')
  uploadImage(@UploadedFile() file?: Express.Multer.File): Promise<AssetRef> {
    return this.handle('image', file);
  }

  @Post('audio')
  @Roles('editor')
  @MediaUpload('audio')
  uploadAudio(@UploadedFile() file?: Express.Multer.File): Promise<AssetRef> {
    return this.handle('audio', file);
  }

  private async handle(kind: MediaKind, file?: Express.Multer.File): Promise<AssetRef> {
    if (!file) {
      throw new BadRequestException('A file is required in the "file" field.');
    }
    return assetRefSchema.parse(await this.media.upload(kind, file));
  }
}
