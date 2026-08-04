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
  Put,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  createLocaleSchema,
  listLocalesQuerySchema,
  localeCodeSchema,
  updateLocaleSchema,
  type CreateLocaleInput,
  type ListLocalesQuery,
  type Locale,
  type UpdateLocaleInput,
} from '@speakukrainian/shared';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/firebase-auth.guard.js';
import { Public } from '../auth/public.decorator.js';
import { Roles } from '../auth/roles.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { LocalesService } from './locales.service.js';

/**
 * `:code` is validated with `localeCodeSchema` so a hand-crafted path segment
 * never reaches `collection.doc()`.
 */
@ApiTags('locales')
@ApiBearerAuth()
@Controller('locales')
export class LocalesController {
  constructor(private readonly locales: LocalesService) {}

  /** Public: both front ends need the locale list before any authenticated call. */
  @Get()
  @Public()
  list(
    @Query(new ZodValidationPipe(listLocalesQuerySchema)) query: ListLocalesQuery,
  ): Promise<Locale[]> {
    return this.locales.list(query);
  }

  @Post()
  @Roles('admin')
  create(
    @Body(new ZodValidationPipe(createLocaleSchema)) body: CreateLocaleInput,
    @CurrentUser() caller?: AuthenticatedUser,
  ): Promise<Locale> {
    // The global FirebaseAuthGuard makes this unreachable; it narrows the type
    // that `CurrentUser` cannot guarantee on its own.
    if (!caller) {
      throw new UnauthorizedException();
    }
    return this.locales.create(body, caller.uid);
  }

  @Patch(':code')
  @Roles('admin')
  update(
    @Param('code', new ZodValidationPipe(localeCodeSchema)) code: string,
    @Body(new ZodValidationPipe(updateLocaleSchema)) body: UpdateLocaleInput,
    @CurrentUser() caller?: AuthenticatedUser,
  ): Promise<Locale> {
    if (!caller) {
      throw new UnauthorizedException();
    }
    return this.locales.update(code, body, caller.uid);
  }

  @Put(':code/default')
  @Roles('admin')
  setDefault(
    @Param('code', new ZodValidationPipe(localeCodeSchema)) code: string,
    @CurrentUser() caller?: AuthenticatedUser,
  ): Promise<Locale> {
    if (!caller) {
      throw new UnauthorizedException();
    }
    return this.locales.setDefault(code, caller.uid);
  }

  @Delete(':code')
  @Roles('admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('code', new ZodValidationPipe(localeCodeSchema)) code: string): Promise<void> {
    return this.locales.remove(code);
  }
}
