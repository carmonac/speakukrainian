import { Module } from '@nestjs/common';
import { LocalesModule } from '../locales/locales.module.js';
import { SectionsModule } from '../sections/sections.module.js';
import { MenuController } from './menu.controller.js';
import { MenuService } from './menu.service.js';

/**
 * The Firestore query stays in `SectionsRepository`, which is not exported:
 * this module reaches it through `SectionsService`, so the layering holds.
 */
@Module({
  imports: [SectionsModule, LocalesModule],
  controllers: [MenuController],
  providers: [MenuService],
})
export class MenuModule {}
