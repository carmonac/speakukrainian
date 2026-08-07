import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  createContentPageSchema,
  listPagesQuerySchema,
  pageIdSchema,
  updateContentPageSchema,
  type ContentPage,
  type CreateContentPageInput,
  type ListPagesQuery,
  type Page,
  type UpdateContentPageInput,
} from '@speakukrainian/shared';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/firebase-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { PagesService } from './pages.service.js';

/**
 * Every route is staff-only: the public site reads page content through its own
 * projections, which Phase 2 adds. `:id` is validated with `pageIdSchema` so a
 * hand-crafted path segment never reaches `collection.doc()`.
 */
@ApiTags('pages')
@ApiBearerAuth()
@Controller('pages')
export class PagesController {
  constructor(private readonly pages: PagesService) {}

  @Get()
  @Roles('editor')
  list(
    @Query(new ZodValidationPipe(listPagesQuerySchema)) query: ListPagesQuery,
  ): Promise<Page<ContentPage>> {
    return this.pages.list(query);
  }

  @Get(':id')
  @Roles('editor')
  findOne(@Param('id', new ZodValidationPipe(pageIdSchema)) id: string): Promise<ContentPage> {
    return this.pages.findById(id);
  }

  @Post()
  @Roles('editor')
  create(
    @Body(new ZodValidationPipe(createContentPageSchema)) body: CreateContentPageInput,
    @CurrentUser() caller?: AuthenticatedUser,
  ): Promise<ContentPage> {
    // The global FirebaseAuthGuard makes this unreachable; it narrows the type
    // that `CurrentUser` cannot guarantee on its own.
    if (!caller) {
      throw new UnauthorizedException();
    }
    return this.pages.create(body, caller.uid);
  }

  @Patch(':id')
  @Roles('editor')
  update(
    @Param('id', new ZodValidationPipe(pageIdSchema)) id: string,
    @Body(new ZodValidationPipe(updateContentPageSchema)) body: UpdateContentPageInput,
    @CurrentUser() caller?: AuthenticatedUser,
  ): Promise<ContentPage> {
    if (!caller) {
      throw new UnauthorizedException();
    }
    return this.pages.update(id, body, caller.uid);
  }

  /** `@Post` defaults to 201; this answers with the updated page, not a new one. */
  @Post(':id/publish')
  @Roles('editor')
  @HttpCode(HttpStatus.OK)
  publish(
    @Param('id', new ZodValidationPipe(pageIdSchema)) id: string,
    @CurrentUser() caller?: AuthenticatedUser,
  ): Promise<ContentPage> {
    if (!caller) {
      throw new UnauthorizedException();
    }
    return this.pages.publish(id, caller.uid);
  }

  @Post(':id/unpublish')
  @Roles('editor')
  @HttpCode(HttpStatus.OK)
  unpublish(
    @Param('id', new ZodValidationPipe(pageIdSchema)) id: string,
    @CurrentUser() caller?: AuthenticatedUser,
  ): Promise<ContentPage> {
    if (!caller) {
      throw new UnauthorizedException();
    }
    return this.pages.unpublish(id, caller.uid);
  }

  @Delete(':id')
  @Roles('editor')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', new ZodValidationPipe(pageIdSchema)) id: string): Promise<void> {
    return this.pages.remove(id);
  }
}
