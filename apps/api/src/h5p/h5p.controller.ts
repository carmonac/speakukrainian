import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UploadedFile,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  attachH5pContentSchema,
  documentIdSchema,
  h5pSaveResultSchema,
  listH5pContentQuerySchema,
  type AttachH5pContentInput,
  type H5pContent,
  type H5pSaveResult,
  type ListH5pContentQuery,
  type Page,
} from '@speakukrainian/shared';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/firebase-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { H5pPackageUpload } from './h5p.upload.decorator.js';
import { H5pService } from './h5p.service.js';
import { requireCaller } from './h5p.user.js';

/**
 * The authoring half of H5P: installing an uploaded package, and reading or
 * removing what that produced.
 *
 * **Every route here is `@Roles('editor')`, and that is a file boundary rather
 * than a decorator habit** — the mirror of `h5p-public.controller.ts`, where
 * every route is `@Public()`. `GET content` in particular **may never be
 * relaxed to `@Public()`**: ADR-007 makes the absence of any public enumeration
 * the thing that lets the play and content-file routes be public, so serving
 * this index anonymously would unprotect every unpublished exercise in the
 * bucket without a single test going red. The guards are pinned per route by
 * the metadata block at the bottom of `h5p.controller.spec.ts`.
 *
 * The global guards run before the interceptors `H5pPackageUpload` installs, so
 * an unauthenticated or under-privileged caller is refused before a byte of the
 * package is read.
 *
 * `attach` and `detach` are inside that boundary too, and they are the **only**
 * writers of `h5pContent.pageId`: the save route merges over the stored row and
 * carries no `pageId` at all, which is what stops a save detaching an exercise.
 *
 * `documentIdSchema` on `:id` is what keeps a `/` or a `..` out of
 * `collection.doc()`, for the same reason `PagesController` validates its own.
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

    return h5pSaveResultSchema.parse(await this.h5p.importPackage(file, requireCaller(caller).uid));
  }

  @Get('content')
  @Roles('editor')
  list(
    @Query(new ZodValidationPipe(listH5pContentQuerySchema)) query: ListH5pContentQuery,
  ): Promise<Page<H5pContent>> {
    return this.h5p.list(query);
  }

  @Get('content/:id')
  @Roles('editor')
  findOne(@Param('id', new ZodValidationPipe(documentIdSchema)) id: string): Promise<H5pContent> {
    return this.h5p.findById(id);
  }

  /**
   * A verb rather than `PUT`/`DELETE` on a `…/page` sub-resource: the REST-pretty
   * form would put `DELETE /api/h5p/content/:id/page` one dropped path segment
   * away from `DELETE /api/h5p/content/:id`, which destroys the exercise. A
   * client bug that truncates a URL must not be able to cross that line.
   *
   * Two routes rather than one taking `{ pageId: string | null }`, because the
   * outcomes differ in both directions: attach reads a foreign document and can
   * answer 404 or 409, detach reads nothing and can answer neither. The split is
   * also what lets the body schema be non-nullable and closed.
   *
   * `@HttpCode(OK)` because `@Post` defaults to 201 and neither route creates
   * anything; both answer with the updated row, so the admin renders the result
   * without a second read.
   */
  @Post('content/:id/attach')
  @Roles('editor')
  @HttpCode(HttpStatus.OK)
  // `async` so an absent caller is a rejected promise rather than a synchronous
  // throw, which is how every other handler here reports a refusal.
  async attach(
    @Param('id', new ZodValidationPipe(documentIdSchema)) id: string,
    @Body(new ZodValidationPipe(attachH5pContentSchema)) body: AttachH5pContentInput,
    @CurrentUser() caller?: AuthenticatedUser,
  ): Promise<H5pContent> {
    return this.h5p.attachToPage(id, body.pageId, requireCaller(caller).uid);
  }

  @Post('content/:id/detach')
  @Roles('editor')
  @HttpCode(HttpStatus.OK)
  async detach(
    @Param('id', new ZodValidationPipe(documentIdSchema)) id: string,
    @CurrentUser() caller?: AuthenticatedUser,
  ): Promise<H5pContent> {
    return this.h5p.detachFromPage(id, requireCaller(caller).uid);
  }

  @Delete('content/:id')
  @Roles('editor')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', new ZodValidationPipe(documentIdSchema)) id: string): Promise<void> {
    return this.h5p.remove(id);
  }
}
