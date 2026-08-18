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
  createScheduleSlotSchema,
  documentIdSchema,
  listScheduleSlotsQuerySchema,
  updateScheduleSlotSchema,
  type CreateScheduleSlotInput,
  type DeleteSeriesResult,
  type ListScheduleSlotsQuery,
  type ScheduleSlot,
  type UpdateScheduleSlotInput,
} from '@speakukrainian/shared';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/firebase-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ScheduleService } from './schedule.service.js';

/**
 * Staff-only throughout: booking a slot is Phase 2 and will need its own
 * projected read route. Reading is `editor` and writing is `admin`, because a
 * slot commits someone's time and an editor's job is the content tree.
 *
 * **The role is the whole of the check.** `PATCH` and `DELETE` are deliberately
 * not owner-scoped in Phase 1 — any admin may edit or delete another admin's
 * slots, including a whole series. Only *overlap* is per-owner, because two
 * teachers may legitimately offer the same hour. Admins are a handful of
 * trusted staff and the list route is site-wide for the same reason. What would
 * change it: teachers administering their own calendars, or admins who are not
 * all trusted with each other's time. ADR-014 records the decision and what
 * enforcing ownership would cost.
 *
 * `:id` and `recurrenceId` are both validated with `documentIdSchema` — the
 * first so a hand-crafted path segment never reaches `collection.doc()`, the
 * second to bound the shape of a value that goes into a `where`.
 */
@ApiTags('schedule')
@ApiBearerAuth()
@Controller('schedule/slots')
export class ScheduleController {
  constructor(private readonly schedule: ScheduleService) {}

  @Get()
  @Roles('editor')
  list(
    @Query(new ZodValidationPipe(listScheduleSlotsQuerySchema)) query: ListScheduleSlotsQuery,
  ): Promise<ScheduleSlot[]> {
    return this.schedule.list(query);
  }

  @Get(':id')
  @Roles('editor')
  findOne(@Param('id', new ZodValidationPipe(documentIdSchema)) id: string): Promise<ScheduleSlot> {
    return this.schedule.findById(id);
  }

  /** Answers with a list even for a single slot — a recurrence uses this same route. */
  @Post()
  @Roles('admin')
  create(
    @Body(new ZodValidationPipe(createScheduleSlotSchema)) body: CreateScheduleSlotInput,
    @CurrentUser() caller?: AuthenticatedUser,
  ): Promise<ScheduleSlot[]> {
    // The global FirebaseAuthGuard makes this unreachable; it narrows the type
    // that `CurrentUser` cannot guarantee on its own.
    if (!caller) {
      throw new UnauthorizedException();
    }
    return this.schedule.create(body, caller.uid);
  }

  @Patch(':id')
  @Roles('admin')
  update(
    @Param('id', new ZodValidationPipe(documentIdSchema)) id: string,
    @Body(new ZodValidationPipe(updateScheduleSlotSchema)) body: UpdateScheduleSlotInput,
    @CurrentUser() caller?: AuthenticatedUser,
  ): Promise<ScheduleSlot> {
    if (!caller) {
      throw new UnauthorizedException();
    }
    return this.schedule.update(id, body, caller.uid);
  }

  /**
   * Declared before `DELETE /:id` — they are different paths, so there is no
   * collision, but `SectionsController` orders `tree` the same way and the
   * habit is what keeps a later `:id`-shaped route from shadowing this one.
   *
   * Answers 200 `{ deleted: 0 }` rather than 404 for a series with nothing left
   * in the future: DELETE is idempotent, and "nothing to remove" is success.
   */
  @Delete()
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  removeSeries(
    @Query('recurrenceId', new ZodValidationPipe(documentIdSchema)) recurrenceId: string,
  ): Promise<DeleteSeriesResult> {
    return this.schedule.removeSeries(recurrenceId);
  }

  @Delete(':id')
  @Roles('admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', new ZodValidationPipe(documentIdSchema)) id: string): Promise<void> {
    return this.schedule.remove(id);
  }
}
