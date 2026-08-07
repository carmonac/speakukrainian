import { Module } from '@nestjs/common';
import { PagesModule } from '../pages/pages.module.js';
import { SectionsController } from './sections.controller.js';
import { SectionsRepository } from './sections.repository.js';
import { SectionsService } from './sections.service.js';

/**
 * `FirestoreModule` and `CommonModule` are `@Global`, so neither is imported
 * here. `PagesModule` is: renaming or moving a section rewrites the paths of
 * the pages beneath it in the same transaction as the section write, so this
 * repository needs the `SectionPagesRepository` port that module exports.
 */
@Module({
  imports: [PagesModule],
  controllers: [SectionsController],
  providers: [SectionsService, SectionsRepository],
  exports: [SectionsService],
})
export class SectionsModule {}
