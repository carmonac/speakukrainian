import { Body, Controller, Get, Param, Patch, Query, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  paginationQuerySchema,
  updateUserRoleSchema,
  type Page,
  type PaginationQuery,
  type UpdateUserRoleInput,
  type UserProfile,
} from '@speakukrainian/shared';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/firebase-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { UsersService } from './users.service.js';

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /** Declared before any `:uid` GET route, or `me` would be read as a uid. */
  @Get('me')
  me(@CurrentUser() caller?: AuthenticatedUser): Promise<UserProfile> {
    // The global FirebaseAuthGuard makes this unreachable; it narrows the type
    // that `CurrentUser` cannot guarantee on its own.
    if (!caller) {
      throw new UnauthorizedException();
    }
    return this.users.getOrProvision(caller);
  }

  @Get()
  @Roles('admin')
  list(
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ): Promise<Page<UserProfile>> {
    return this.users.list(query);
  }

  @Patch(':uid/role')
  @Roles('admin')
  setRole(
    @Param('uid') uid: string,
    @Body(new ZodValidationPipe(updateUserRoleSchema)) body: UpdateUserRoleInput,
    @CurrentUser() caller?: AuthenticatedUser,
  ): Promise<UserProfile> {
    if (!caller) {
      throw new UnauthorizedException();
    }
    return this.users.setRole(uid, body.role, caller);
  }
}
