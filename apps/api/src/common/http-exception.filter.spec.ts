import {
  type ArgumentsHost,
  BadRequestException,
  HttpException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { MAX_JSON_BODY_BYTES, jsonBodyTooLargeMessage } from '@speakukrainian/shared';
import { HttpExceptionFilter } from './http-exception.filter.js';

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

const URL = '/api/pages';

/** Runs the filter over a fake host and returns what the client would receive. */
function run(exception: unknown, url = URL): Answer {
  const answer: Answer = { status: 0, body: {} };
  const response = {
    status(code: number) {
      answer.status = code;
      return this;
    },
    json(payload: Record<string, unknown>) {
      answer.body = payload;
      return this;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ method: 'POST', url }),
    }),
  } as unknown as ArgumentsHost;

  new HttpExceptionFilter().catch(exception, host);
  return answer;
}

/** What the socket was left holding once the filter had run. */
interface Interrupted {
  statuses: number[];
  bodies: unknown[];
  destroyed: number;
  ended: number;
}

/**
 * Runs the filter over a response whose headers have already gone out. A GET by
 * default, because every route that can flush before it throws is one that reads
 * a file.
 *
 * The counters are the outcome for the socket — severed rather than completed —
 * in the same shape `h5p.responses.spec.ts` records it.
 */
function runAfterHeadersSent(
  exception: unknown,
  sentStatus = 206,
  url = URL,
  method = 'GET',
): Interrupted {
  const record: Interrupted = { statuses: [], bodies: [], destroyed: 0, ended: 0 };
  const response = {
    headersSent: true,
    statusCode: sentStatus,
    status(code: number) {
      record.statuses.push(code);
      return this;
    },
    json(payload: unknown) {
      record.bodies.push(payload);
      return this;
    },
    destroy() {
      record.destroyed += 1;
      return this;
    },
    end() {
      record.ended += 1;
      return this;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ method, url }),
    }),
  } as unknown as ArgumentsHost;

  new HttpExceptionFilter().catch(exception, host);
  return record;
}

/**
 * The shape body-parser gives an oversized body. `expose`, `status` and
 * `statusCode` sit on `http-errors`' prototype rather than on the instance, so
 * they are set here as own properties — the filter reads them the same way
 * either route. The real shape is pinned by the e2e suite.
 */
function payloadTooLarge(): Error {
  return Object.assign(new Error('request entity too large'), {
    expose: true,
    status: 413,
    statusCode: 413,
    type: 'entity.too.large',
    length: MAX_JSON_BODY_BYTES + 1024,
    limit: MAX_JSON_BODY_BYTES,
  });
}

/** A genuine stack from real code, not a string literal standing in for one. */
function realTypeError(): TypeError {
  try {
    (undefined as never as { boom(): void }).boom();
  } catch (error) {
    return error as TypeError;
  }
  throw new Error('expected the call to throw');
}

describe('HttpExceptionFilter', () => {
  let warn: MockInstance<Logger['warn']>;
  let error: MockInstance<Logger['error']>;

  beforeEach(() => {
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('a 4xx raised outside Nest', () => {
    it('answers an oversized body 413 with a message naming the limit', () => {
      const answer = run(payloadTooLarge());

      expect(answer.status).toBe(413);
      expect(answer.body['statusCode']).toBe(413);
      // Not the error's own `request entity too large`, which never says 1 MB.
      expect(answer.body['message']).toBe(jsonBodyTooLargeMessage());
      expect(answer.body['message']).toBe('Request bodies must be under 1 MB.');
      expect(answer.body['path']).toBe(URL);
      expect(Number.isNaN(Date.parse(String(answer.body['timestamp'])))).toBe(false);
      expect('errors' in answer.body).toBe(false);
      expect(Object.keys(answer.body)).toEqual(['statusCode', 'message', 'path', 'timestamp']);
    });

    it('logs the oversized body once at warn, with no stack', () => {
      run(payloadTooLarge());

      expect(error).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]?.[0]);
      expect(line).toContain('413');
      expect(line).toContain('POST');
      expect(line).toContain(URL);
      expect(line).toContain('entity.too.large');
      expect(line).not.toMatch(/\n\s+at /);
    });

    it('takes no wording from a parse failure it maps itself', () => {
      // Not the path a malformed body takes today: Nest's `mapExternalException`
      // converts the `SyntaxError` to a `BadRequestException` above the filter,
      // and the `HttpException` branch then forwards V8's parse message — which
      // quotes a fragment of the caller's body — verbatim (ADR-015 records why
      // that is accepted). This pins the 4xx branch below, so that if that
      // mapping ever changes the fragment does not start coming from here.
      const answer = run(
        Object.assign(new SyntaxError('Unexpected end of JSON input'), {
          expose: true,
          status: 400,
          statusCode: 400,
          type: 'entity.parse.failed',
          body: '{"a":',
        }),
      );

      expect(answer.status).toBe(400);
      expect(answer.body['message']).toBe('Bad Request');
      expect(JSON.stringify(answer.body)).not.toContain('{\\"a\\":');
      expect(JSON.stringify(answer.body)).not.toContain('Unexpected end of JSON input');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).not.toContain('{"a":');
    });

    it('falls back to the reason phrase for a 4xx it has no wording for', () => {
      const answer = run(
        Object.assign(new Error('unsupported charset "UTF-7"'), {
          expose: true,
          status: 415,
          statusCode: 415,
          type: 'charset.unsupported',
        }),
      );

      expect(answer.status).toBe(415);
      expect(answer.body['message']).toBe('Unsupported Media Type');
    });

    it('reads statusCode when status is absent', () => {
      const answer = run(Object.assign(new Error('nope'), { expose: true, statusCode: 429 }));

      expect(answer.status).toBe(429);
      expect(answer.body['message']).toBe('Too Many Requests');
    });
  });

  describe('a genuine unexpected error', () => {
    it('is 500 with the generic message and its real stack logged', () => {
      const thrown = realTypeError();

      const answer = run(thrown);

      expect(answer.status).toBe(500);
      expect(answer.body['statusCode']).toBe(500);
      expect(answer.body['message']).toBe('Internal server error');
      expect(warn).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledTimes(1);
      // The logged value must *be* the stack: logging `String(exception)` would
      // satisfy a weaker assertion and lose every frame.
      expect(error.mock.calls[0]?.[1]).toBe(thrown.stack);
      expect(String(error.mock.calls[0]?.[1])).toMatch(/\n\s+at /);

      const serialized = JSON.stringify(answer.body);
      expect(serialized).not.toContain(thrown.message);
      expect(serialized).not.toContain(thrown.name);
      expect(serialized).not.toContain(' at ');
      expect(serialized).not.toContain('http-exception.filter');
      expect(Object.keys(answer.body)).toEqual(['statusCode', 'message', 'path', 'timestamp']);
    });

    it('keeps a storage outage a 500 rather than blaming the caller', () => {
      // The shape `@google-cloud/storage` throws: gaxios copies the bucket's
      // status onto the error, but never sets `expose`.
      const answer = run(
        Object.assign(new Error('Not Found'), {
          status: 404,
          code: 404,
          response: { status: 404 },
        }),
      );

      expect(answer.status).toBe(500);
      expect(answer.body['message']).toBe('Internal server error');
      expect(error).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    });

    it('keeps a Node built-in error a 500', () => {
      const answer = run(
        Object.assign(new TypeError('The "size" argument must be of type number'), {
          code: 'ERR_INVALID_ARG_TYPE',
        }),
      );

      expect(answer.status).toBe(500);
      expect(answer.body['message']).toBe('Internal server error');
      expect(error).toHaveBeenCalledTimes(1);
    });

    it('keeps a 5xx carried by middleware a 500 with the generic message', () => {
      const answer = run(
        Object.assign(new Error('upstream exploded'), {
          status: 503,
          statusCode: 503,
          expose: false,
        }),
      );

      expect(answer.status).toBe(500);
      expect(answer.body['message']).toBe('Internal server error');
      expect(error).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    });

    it('keeps a status below 4xx a 500 even when it is exposed', () => {
      const answer = run(Object.assign(new Error('x'), { expose: true, status: 399 }));

      expect(answer.status).toBe(500);
      expect(answer.body['message']).toBe('Internal server error');
      expect(error).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    });

    it('keeps an exposed 5xx a 500 with its stack logged', () => {
      // 503 rather than 500: an exposed 500 answers 500 whether or not the upper
      // bound is checked, so it cannot fail on the property this test names.
      const thrown = Object.assign(new Error('upstream refused'), {
        expose: true,
        status: 503,
        statusCode: 503,
      });

      const answer = run(thrown);

      expect(answer.status).toBe(500);
      expect(answer.body['message']).toBe('Internal server error');
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0]?.[1]).toBe(thrown.stack);
      expect(warn).not.toHaveBeenCalled();
    });

    it('requires expose to be the boolean, not something truthy', () => {
      const answer = run(Object.assign(new Error('x'), { expose: 'true', status: 400 }));

      expect(answer.status).toBe(500);
      expect(answer.body['message']).toBe('Internal server error');
    });

    it('handles a thrown non-error without a stack to log', () => {
      const answer = run('something threw a string');

      expect(answer.status).toBe(500);
      expect(answer.body['message']).toBe('Internal server error');
      expect(error.mock.calls[0]?.[1]).toBe('something threw a string');
    });
  });

  describe('an HttpException', () => {
    it('forwards the validation issues the Zod pipe attaches', () => {
      const issues = [{ path: 'title.en', message: 'Required', code: 'invalid_type' }];

      const answer = run(new BadRequestException({ message: 'Validation failed', errors: issues }));

      expect(answer.status).toBe(400);
      expect(answer.body['message']).toBe('Validation failed');
      expect(answer.body['errors']).toEqual(issues);
    });

    it('forwards a string payload as the message', () => {
      const answer = run(new HttpException('teapot', 418));

      expect(answer.status).toBe(418);
      expect(answer.body['message']).toBe('teapot');
    });

    it('forwards an object payload without inventing an errors key', () => {
      const answer = run(new NotFoundException());

      expect(answer.status).toBe(404);
      expect(answer.body['message']).toBe('Not Found');
      expect('errors' in answer.body).toBe(false);
    });

    it('falls back to the exception message when the payload carries none', () => {
      const answer = run(new HttpException({ statusCode: 400 }, 400));

      expect(answer.status).toBe(400);
      expect(answer.body['message']).toBe(new HttpException({ statusCode: 400 }, 400).message);
    });

    it('logs nothing at all', () => {
      run(new NotFoundException());
      run(new BadRequestException('bad'));
      run(new HttpException('teapot', 418));

      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    });
  });

  describe('once the response has started', () => {
    it('writes neither a status nor a body', () => {
      const interrupted = runAfterHeadersSent(realTypeError());

      expect(interrupted.statuses).toEqual([]);
      expect(interrupted.bodies).toEqual([]);
    });

    it('destroys the response rather than ending it', () => {
      // `end` would write the terminating zero-length chunk, telling the client
      // the truncated body was all of it.
      const interrupted = runAfterHeadersSent(realTypeError());

      expect(interrupted.destroyed).toBe(1);
      expect(interrupted.ended).toBe(0);
    });

    it("logs at error with the exception's real stack", () => {
      const thrown = realTypeError();

      runAfterHeadersSent(thrown);

      expect(error).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
      expect(error.mock.calls[0]?.[1]).toBe(thrown.stack);
      expect(String(error.mock.calls[0]?.[1])).toMatch(/\n\s+at /);
    });

    it('logs a line naming the request and the status the client was already given', () => {
      runAfterHeadersSent(realTypeError(), 206);

      const line = String(error.mock.calls[0]?.[0]);
      expect(line).toContain('GET');
      expect(line).toContain(URL);
      expect(line).toContain('206');
      expect(line).toContain('truncated');

      // A second run differing in all three, so that a line spelling any of them
      // as a literal is not mistaken for one that reads the request. HEAD rather
      // than an invented method: Express routes a HEAD with no handler of its own
      // to the GET one, so the asset routes answer it and can truncate on it.
      runAfterHeadersSent(realTypeError(), 200, '/api/h5p/content/abc/media/clip.mp3', 'HEAD');

      const second = String(error.mock.calls[1]?.[0]);
      expect(second).toContain('HEAD');
      expect(second).toContain('/api/h5p/content/abc/media/clip.mp3');
      expect(second).toContain('200');
      expect(second).not.toContain('GET');
      expect(second).not.toContain('206');
      expect(second).not.toContain(URL);
    });

    it('logs a 5xx raised after the first byte exactly once', () => {
      // The guard runs before the classification, so one failure is one line —
      // and it is the more informative of the two, since no 500 was ever sent.
      const interrupted = runAfterHeadersSent(new InternalServerErrorException('the bucket left'));

      expect(error).toHaveBeenCalledTimes(1);
      expect(interrupted.statuses).toEqual([]);
      expect(interrupted.bodies).toEqual([]);
      expect(interrupted.destroyed).toBe(1);
    });

    it('logs a 4xx raised after the first byte too', () => {
      // A truncated response is a server fault whatever the exception said.
      const interrupted = runAfterHeadersSent(new BadRequestException('nope'));

      expect(error).toHaveBeenCalledTimes(1);
      expect(interrupted.destroyed).toBe(1);
    });

    it('handles a thrown non-error after headers were sent', () => {
      const interrupted = runAfterHeadersSent('something threw a string');

      expect(error.mock.calls[0]?.[1]).toBe('something threw a string');
      expect(interrupted.statuses).toEqual([]);
      expect(interrupted.destroyed).toBe(1);
    });
  });
});
