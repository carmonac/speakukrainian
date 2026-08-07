import {
  PayloadTooLargeException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { catchError, throwError, type Observable } from 'rxjs';

/**
 * Replaces multer's bare `File too large` with the wording the admin shows for
 * the same rejection, so the response names the limit. The admin's pre-check
 * catches this first in the browser, but the API is callable directly and a
 * 413 that does not say how large is too large is useless to that caller.
 *
 * This cannot be a check in the route handler: multer aborts the upload before
 * the handler runs, and the exception surfaces out of `FileInterceptor`.
 * Listing this interceptor before `FileInterceptor` puts it upstream, where
 * `next.handle()` carries that rejection — which is why routes install it
 * through an upload decorator rather than ordering it themselves.
 *
 * Constructed per route rather than injected — it has no dependencies beyond
 * the message of the route it guards. `message` is public so a test can read
 * the pairing back off the route's interceptor metadata.
 */
export class UploadLimitInterceptor implements NestInterceptor {
  constructor(public readonly message: string) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next
      .handle()
      .pipe(
        catchError((error: unknown) =>
          throwError(() =>
            error instanceof PayloadTooLargeException
              ? new PayloadTooLargeException(this.message)
              : error,
          ),
        ),
      );
  }
}
