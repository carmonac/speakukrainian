import {
  BadRequestException,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { assetRefSchema, type AssetRef, type MediaKind } from '@speakukrainian/shared';
import { Roles } from '../auth/roles.decorator.js';
import { mediaUploadOptions } from './media.multer.js';
import { UploadLimitInterceptor } from './media.upload-limit.interceptor.js';
import { MediaService } from './media.service.js';

/** OpenAPI shape of the multipart body; the field name matches `ApiService.upload`. */
const FILE_BODY = {
  schema: {
    type: 'object',
    required: ['file'],
    properties: { file: { type: 'string', format: 'binary' } },
  },
};

/**
 * Uploads land in Cloud Storage and come back as an `AssetRef` the rich text
 * editor embeds. There is no Firestore document behind them: the media library
 * and orphan collection are a later phase.
 *
 * The global guards run before the interceptor, so an unauthenticated or
 * under-privileged caller is refused before a byte of the file is read.
 */
@ApiTags('media')
@ApiBearerAuth()
@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post('image')
  @Roles('editor')
  @UseInterceptors(
    new UploadLimitInterceptor('image'),
    FileInterceptor('file', mediaUploadOptions('image')),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody(FILE_BODY)
  uploadImage(@UploadedFile() file?: Express.Multer.File): Promise<AssetRef> {
    return this.handle('image', file);
  }

  @Post('audio')
  @Roles('editor')
  @UseInterceptors(
    new UploadLimitInterceptor('audio'),
    FileInterceptor('file', mediaUploadOptions('audio')),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody(FILE_BODY)
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
