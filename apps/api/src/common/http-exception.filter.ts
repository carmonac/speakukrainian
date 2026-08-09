import { STATUS_CODES } from 'node:http';
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { jsonBodyTooLargeMessage } from '@speakukrainian/shared';

export interface ErrorResponseBody {
  statusCode: number;
  message: string;
  errors?: unknown;
  path: string;
  timestamp: string;
}

/**
 * Wording for the `http-errors` rejections worth naming, keyed on body-parser's
 * own `type`. Only the oversized-body case is here, because AC1 wants the 413 to
 * name the limit; every other 4xx falls back to its reason phrase. A full table
 * of body-parser's ten `type` values would be nine entries no test can reach.
 */
const CLIENT_ERROR_MESSAGES: Record<string, string> = {
  'entity.too.large': jsonBodyTooLargeMessage(),
};

function numericStatus(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/**
 * Recognises a 4xx raised by middleware outside Nest — body-parser's
 * `PayloadTooLargeError` above all, which never reaches a controller and so is
 * not an `HttpException`.
 *
 * The status alone is not a safe test, which is why `expose === true` is
 * required as well. `expose` is `http-errors`' own "this status is safe to show
 * a client" flag (`err.expose = status < 500`) and nothing else in this
 * dependency tree sets it. A status-only predicate has a live over-match here:
 * `GaxiosError` — what `@google-cloud/storage` throws — copies the upstream
 * response's status onto itself, so a bucket answering 403 for a lost IAM role
 * or 404 for a missing object would be reported to the caller as their mistake
 * rather than as the outage it is. The same trap in its other costume is a
 * predicate keyed on a string `code`, which matches every Node built-in error.
 *
 * The wording answered from here never comes from the exception: body-parser
 * attaches a fragment of the request body to its parse failures, and the wording
 * of middleware we might add later is not ours to vouch for. That holds for this
 * branch only — a malformed body is converted to a `BadRequestException` by
 * Nest's `mapExternalException` before the filter is entered, and the
 * `HttpException` branch forwards that message (V8's parse error, which quotes a
 * fragment of the caller's body) verbatim. ADR-015 records why that is accepted.
 */
function exposedClientError(exception: unknown): { status: number; message: string } | null {
  if (!(exception instanceof Error)) {
    return null;
  }

  const candidate = exception as { expose?: unknown; status?: unknown; statusCode?: unknown };
  if (candidate.expose !== true) {
    return null;
  }

  const status = numericStatus(candidate.status) ?? numericStatus(candidate.statusCode);
  if (
    status === null ||
    status < HttpStatus.BAD_REQUEST ||
    status >= HttpStatus.INTERNAL_SERVER_ERROR
  ) {
    return null;
  }

  const type = (exception as { type?: unknown }).type;
  const named = typeof type === 'string' ? CLIENT_ERROR_MESSAGES[type] : undefined;
  return { status, message: named ?? STATUS_CODES[status] ?? 'Bad request' };
}

/**
 * Turns every thrown error into a consistent JSON envelope. Unexpected errors
 * are logged with their stack but reported to the client as a generic 500 so we
 * never leak internals.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const isHttp = exception instanceof HttpException;
    const clientError = isHttp ? null : exposedClientError(exception);

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let errors: unknown;

    if (isHttp) {
      status = exception.getStatus();
      const payload = exception.getResponse();
      if (typeof payload === 'string') {
        message = payload;
      } else if (payload && typeof payload === 'object') {
        const record = payload as Record<string, unknown>;
        message = typeof record['message'] === 'string' ? record['message'] : exception.message;
        errors = record['errors'];
      }
    } else if (clientError) {
      status = clientError.status;
      message = clientError.message;
      // One line, no stack: a client sending a bad request is not a server
      // fault. The exception's own `body` is deliberately not logged — it is
      // arbitrary client input that may carry credentials.
      const type = (exception as { type?: unknown }).type;
      this.logger.warn(
        `${status} ${request.method} ${request.url}${typeof type === 'string' ? ` (${type})` : ''}`,
      );
    } else {
      this.logger.error(
        `Unhandled ${request.method} ${request.url}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const body: ErrorResponseBody = {
      statusCode: status,
      message,
      ...(errors ? { errors } : {}),
      path: request.url,
      timestamp: new Date().toISOString(),
    };

    response.status(status).json(body);
  }
}
