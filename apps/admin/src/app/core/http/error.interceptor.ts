import { inject } from '@angular/core';
import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { NotificationService } from '../notifications/notification.service';

/**
 * Whether the toast this interceptor raises for `error` is the API's own
 * message rather than generic wording.
 *
 * Exported because a caller that wants to add context of its own ("Could not
 * upload clip.mp3.") has to know which it is: adding to a generic 5xx toast
 * helps, stacking on top of the API's already-specific explanation buries it.
 * The interceptor consumes the same predicate, so the two cannot disagree.
 */
export function showsApiMessage(error: HttpErrorResponse): boolean {
  return error.status !== 401 && error.status !== 403 && error.status < 500;
}

/**
 * Surfaces API failures as toasts and bounces expired sessions to the login
 * page. Errors are re-thrown so callers can still handle them specifically.
 */
export const errorInterceptor: HttpInterceptorFn = (req, next) => {
  const notifications = inject(NotificationService);
  const router = inject(Router);

  return next(req).pipe(
    catchError((error: unknown) => {
      if (error instanceof HttpErrorResponse) {
        // 401 first: it is the one status that navigates instead of toasting.
        // What is left once `showsApiMessage` is false is 403 and 5xx.
        if (error.status === 401) {
          void router.navigate(['/login'], { state: { returnUrl: router.url } });
        } else if (showsApiMessage(error)) {
          notifications.error(extractMessage(error));
        } else if (error.status === 403) {
          notifications.error('You do not have permission to do that.');
        } else {
          notifications.error('Something went wrong on the server. Please try again.');
        }
      }
      return throwError(() => error);
    }),
  );
};

function extractMessage(error: HttpErrorResponse): string {
  const body = error.error as { message?: string; errors?: { message: string }[] } | undefined;
  if (body?.errors?.length) {
    return body.errors.map((e) => e.message).join(', ');
  }
  return body?.message ?? error.message;
}
