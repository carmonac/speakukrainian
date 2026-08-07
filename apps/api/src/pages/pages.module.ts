import { Module } from '@nestjs/common';
import { PagesController } from './pages.controller.js';
import { PagesRepository } from './pages.repository.js';
import { PagesService } from './pages.service.js';
import { SectionPagesRepository } from './section-pages.repository.js';

/**
 * `FirestoreModule` and `CommonModule` are `@Global`, so neither is imported
 * here.
 *
 * `PagesRepository` and `PagesService` stay unexported. `SectionsModule` is the
 * only importer and it imports this module for the narrow
 * `SectionPagesRepository` port only — a section rename rewrites page paths, it
 * has no business creating or deleting pages.
 */
@Module({
  controllers: [PagesController],
  providers: [PagesService, PagesRepository, SectionPagesRepository],
  exports: [SectionPagesRepository],
})
export class PagesModule {}
