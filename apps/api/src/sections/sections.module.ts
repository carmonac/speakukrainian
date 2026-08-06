import { Module } from '@nestjs/common';
import { SectionsController } from './sections.controller.js';
import { SectionsRepository } from './sections.repository.js';
import { SectionsService } from './sections.service.js';

/** `FirestoreModule` and `CommonModule` are `@Global`, so neither is imported here. */
@Module({
  controllers: [SectionsController],
  providers: [SectionsService, SectionsRepository],
  exports: [SectionsService],
})
export class SectionsModule {}
