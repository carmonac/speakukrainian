import { Module } from '@nestjs/common';
import { ScheduleSlotsRepository } from './schedule-slots.repository.js';
import { ScheduleController } from './schedule.controller.js';
import { ScheduleService } from './schedule.service.js';

/**
 * `FirestoreModule` and `CommonModule` are `@Global`, so neither is imported
 * here. There is no `schedule.tokens.ts` either: this module provides no
 * injection token of its own, it only injects `FIRESTORE`, which has one.
 *
 * Nothing is exported. No other module reaches into schedule yet, and when one
 * does, `SectionPagesRepository` is the precedent — a narrow port for the one
 * thing the other module needs, not the whole repository.
 */
@Module({
  controllers: [ScheduleController],
  providers: [ScheduleService, ScheduleSlotsRepository],
})
export class ScheduleModule {}
