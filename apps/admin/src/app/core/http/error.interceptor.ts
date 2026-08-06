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
 *
 * Status 0 is false: the request never got a response, so there is no API
 * message and the toast falls back to Angular's own transport wording
 * ("Failed to fetch"), which names neither the cause nor the request — exactly
 * the case a caller has something to add to.
 *
 * The branch chain below is the other half of this rule; the spec drives every
 * status through both and fails if they disagree.
 */
export function showsApiMessage(error: HttpErrorResponse): boolean {
  return error.status !== 0 && error.status !== 401 && error.status !== 403 && error.status < 500;
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
        if (error.status === 401) {
          void router.navigate(['/login'], { state: { returnUrl: router.url } });
        } else if (error.status === 403) {
          notifications.error('You do not have permission to do that.');
        } else if (error.status >= 500) {
          notifications.error('Something went wrong on the server. Please try again.');
        } else {
          // A transport failure (status 0) lands here as well as every 4xx that
          // is not 401/403: `extractMessage` has no body to read and falls back
          // to Angular's own wording, which is all there is to say.
          notifications.error(extractMessage(error));
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
