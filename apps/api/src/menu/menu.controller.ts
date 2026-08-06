import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { menuQuerySchema, type MenuEntry, type MenuQuery } from '@speakukrainian/shared';
import { Public } from '../auth/public.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { MenuService } from './menu.service.js';

/**
 * The site navigation, on its own controller rather than under `/sections`:
 * every route there is `@Roles('editor')`, and a public projection sitting
 * among them is how a `@Public()` decorator ends up copy-pasted onto a mutating
 * route later. No `@ApiBearerAuth()` — nothing here is authenticated.
 */
@ApiTags('menu')
@Controller('menu')
export class MenuController {
  constructor(private readonly menu: MenuService) {}

  /** `@Public()`: the site's navigation is read before anyone signs in. */
  @Get()
  @Public()
  list(@Query(new ZodValidationPipe(menuQuerySchema)) query: MenuQuery): Promise<MenuEntry[]> {
    return this.menu.menu(query);
  }
}
