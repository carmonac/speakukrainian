import { Module } from '@nestjs/common';
import { LocalesController } from './locales.controller.js';
import { LocalesRepository } from './locales.repository.js';
import { LocalesService } from './locales.service.js';

/** `FirestoreModule` is `@Global`, so its token needs no import here. */
@Module({
  controllers: [LocalesController],
  providers: [LocalesService, LocalesRepository],
  exports: [LocalesService],
})
export class LocalesModule {}
