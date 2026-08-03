import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser, RequestWithUser } from './firebase-auth.guard.js';

/** Injects the verified caller into a handler parameter. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser | undefined =>
    context.switchToHttp().getRequest<RequestWithUser>().user,
);
