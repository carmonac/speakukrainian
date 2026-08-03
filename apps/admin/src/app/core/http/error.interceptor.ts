import { inject } from '@angular/core';
import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { NotificationService } from '../notifications/notification.service';

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
