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
  createSectionSchema,
  listSectionsQuerySchema,
  moveSectionSchema,
  sectionIdSchema,
  updateSectionSchema,
  type CreateSectionInput,
  type ListSectionsQuery,
  type MoveSectionInput,
  type Page,
  type Section,
  type SectionTreeNode,
  type UpdateSectionInput,
} from '@speakukrainian/shared';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/firebase-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { SectionsService } from './sections.service.js';

/**
 * Every route is staff-only: the public site reads sections through its own
 * projected endpoints, which land with the menu work. `:id` is validated with
 * `sectionIdSchema` so a hand-crafted path segment never reaches
 * `collection.doc()`.
 */
@ApiTags('sections')
@ApiBearerAuth()
@Controller('sections')
export class SectionsController {
  constructor(private readonly sections: SectionsService) {}

  /** Declared before any `:id` GET route, or `tree` would be read as an id. */
  @Get('tree')
  @Roles('editor')
  tree(): Promise<SectionTreeNode[]> {
    return this.sections.tree();
  }

  @Get()
  @Roles('editor')
  list(
    @Query(new ZodValidationPipe(listSectionsQuerySchema)) query: ListSectionsQuery,
  ): Promise<Page<Section>> {
    return this.sections.list(query);
  }

  @Get(':id')
  @Roles('editor')
  findOne(@Param('id', new ZodValidationPipe(sectionIdSchema)) id: string): Promise<Section> {
    return this.sections.findById(id);
  }

  @Post()
  @Roles('editor')
  create(
    @Body(new ZodValidationPipe(createSectionSchema)) body: CreateSectionInput,
    @CurrentUser() caller?: AuthenticatedUser,
  ): Promise<Section> {
    // The global FirebaseAuthGuard makes this unreachable; it narrows the type
    // that `CurrentUser` cannot guarantee on its own.
    if (!caller) {
      throw new UnauthorizedException();
    }
    return this.sections.create(body, caller.uid);
  }

  @Patch(':id')
  @Roles('editor')
  update(
    @Param('id', new ZodValidationPipe(sectionIdSchema)) id: string,
    @Body(new ZodValidationPipe(updateSectionSchema)) body: UpdateSectionInput,
    @CurrentUser() caller?: AuthenticatedUser,
  ): Promise<Section> {
    if (!caller) {
      throw new UnauthorizedException();
    }
    return this.sections.update(id, body, caller.uid);
  }

  @Patch(':id/move')
  @Roles('editor')
  move(
    @Param('id', new ZodValidationPipe(sectionIdSchema)) id: string,
    @Body(new ZodValidationPipe(moveSectionSchema)) body: MoveSectionInput,
    @CurrentUser() caller?: AuthenticatedUser,
  ): Promise<Section> {
    if (!caller) {
      throw new UnauthorizedException();
    }
    return this.sections.move(id, body, caller.uid);
  }

  @Delete(':id')
  @Roles('editor')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', new ZodValidationPipe(sectionIdSchema)) id: string): Promise<void> {
    return this.sections.remove(id);
  }
}
