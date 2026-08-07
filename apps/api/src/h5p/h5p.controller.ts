import {
  BadRequestException,
  Controller,
  Post,
  UnauthorizedException,
  UploadedFile,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { h5pSaveResultSchema, type H5pSaveResult } from '@speakukrainian/shared';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/firebase-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { H5pPackageUpload } from './h5p.upload.decorator.js';
import { H5pService } from './h5p.service.js';

/**
 * Uploaded packages are installed into Cloud Storage and indexed in Firestore.
 * There is no read or delete route yet — those and the editor endpoints land
 * with the admin exercise screen.
 *
 * The global guards run before the interceptors `H5pPackageUpload` installs, so
 * an unauthenticated or under-privileged caller is refused before a byte of the
 * package is read.
 */
@ApiTags('h5p')
@ApiBearerAuth()
@Controller('h5p')
export class H5pController {
  constructor(private readonly h5p: H5pService) {}

  @Post('content')
  @Roles('editor')
  @H5pPackageUpload()
  async upload(
    @UploadedFile() file?: Express.Multer.File,
    @CurrentUser() caller?: AuthenticatedUser,
  ): Promise<H5pSaveResult> {
    if (!file) {
      throw new BadRequestException('A file is required in the "file" field.');
    }
    // The global FirebaseAuthGuard makes this unreachable; it narrows the type
    // that `CurrentUser` cannot guarantee on its own.
    if (!caller) {
      throw new UnauthorizedException();
    }

    return h5pSaveResultSchema.parse(await this.h5p.importPackage(file, caller.uid));
  }
}
