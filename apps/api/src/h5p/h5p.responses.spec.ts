import { PassThrough, Readable } from 'node:stream';
import { Logger } from '@nestjs/common';
import { H5pError } from '@lumieducation/h5p-server';
import express from 'express';
import type { Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  pipePartialStream,
  pipeWholeStream,
  rangeCallbackFor,
  type RangeCallback,
} from './h5p.responses.js';

/** The URL the fake response reports, which is what a log line has to name. */
const REQUEST_PATH = '/api/h5p/content/abc/media/tone.mp3';

/**
 * Short enough that a stalled read is observable in a unit test without fake
 * timers, which would have to stand in for `Date.now` as well and would then be
 * asserting against their own clock rather than against elapsed silence.
 */
const STALL_MS = 50;

/** Long enough that a timer armed for `STALL_MS` has fired several times over. */
const WELL_PAST_STALL_MS = STALL_MS * 5;

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A real Express request carrying one header, so `req.range()` under test is
 * Express's own method over its own parser. A hand-written parser here would
 * only assert that two implementations of the same guess agree.
 */
function requestWithRange(header?: string): Request {
  return Object.assign(Object.create(express.request) as Request, {
    headers: header === undefined ? {} : { range: header },
  });
}

/** The callback under test, and the response it may set a header on before throwing. */
function rangeCallback(header?: string): { call: RangeCallback; record: RecordedResponse } {
  const record = recordingResponse();
  return { call: rangeCallbackFor(requestWithRange(header), record.res), record };
}

/**
 * Starts capturing what `Logger.error` is told, and hands back a reader for it.
 *
 * The log line is the outcome under test here rather than a detail of it: a
 * stream that fails is never seen by the exception filter, so this is the only
 * trace such a failure leaves anywhere.
 */
function captureErrors(): () => string[] {
  const spy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  return () => spy.mock.calls.map(([message]) => String(message));
}

/** The `H5pError` a call threw, or a failure saying it did not throw at all. */
function thrownBy(call: () => unknown): H5pError {
  try {
    call();
  } catch (error) {
    if (error instanceof H5pError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the call to throw an H5pError.');
}

interface RecordedResponse {
  res: Response;
  statusCode: number | null;
  headers: Map<string, string>;
  headersSent: boolean;
  /**
   * Stands in for a client that has stopped taking bytes.
   *
   * The sink below is drained as fast as it is written, so the only way to put
   * a response under backpressure here is to say so — the same way
   * `headersSent` is said rather than reached.
   */
  needsDrain: boolean;
  destroyed: boolean;
  ended: boolean;
  /** Resolves when the response ends, with everything that was written to it. */
  body: () => Promise<Buffer>;
  /** Everything written so far, for a response that has already ended. */
  written: () => Buffer;
}

/**
 * A `Response` that records what was set on it and collects what was piped
 * into it, so an assertion can be about the bytes the client would receive
 * rather than about which method was called.
 */
function recordingResponse(): RecordedResponse {
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on('data', (chunk: Buffer) => chunks.push(chunk));

  const record: RecordedResponse = {
    res: sink as unknown as Response,
    statusCode: null,
    headers: new Map<string, string>(),
    headersSent: false,
    needsDrain: false,
    destroyed: false,
    ended: false,
    body: () =>
      new Promise((resolve) => {
        sink.on('end', () => resolve(Buffer.concat(chunks)));
        sink.resume();
      }),
    written: () => Buffer.concat(chunks),
  };

  const res = sink as unknown as Record<string, unknown>;
  res['status'] = (code: number) => {
    record.statusCode = code;
    return record.res;
  };
  // Both of Express's shapes: the whole-header object, and the single header
  // `rangeCallbackFor` sets on its way to a 416.
  res['set'] = (values: Record<string, string> | string, value?: string) => {
    const entries = typeof values === 'string' ? [[values, value ?? '']] : Object.entries(values);
    for (const [name, header] of entries) {
      record.headers.set(String(name), String(header));
    }
    return record.res;
  };
  // Express sets this on every response, and a log line about a failed read is
  // worth nothing without the URL that was being read.
  res['req'] = { originalUrl: REQUEST_PATH };
  res['removeHeader'] = (name: string) => {
    record.headers.delete(name);
  };
  res['getHeader'] = (name: string) => record.headers.get(name);
  Object.defineProperty(sink, 'headersSent', { get: () => record.headersSent });
  Object.defineProperty(sink, 'writableNeedDrain', { get: () => record.needsDrain });
  const destroy = sink.destroy.bind(sink);
  res['destroy'] = () => {
    record.destroyed = true;
    destroy();
    return record.res;
  };
  const end = sink.end.bind(sink);
  res['end'] = () => {
    record.ended = true;
    end();
    return record.res;
  };

  return record;
}

describe('rangeCallbackFor', () => {
  it('asks for the whole file when the request carries no Range', () => {
    expect(rangeCallback().call(100)).toBeUndefined();
  });

  it('reads a closed range', () => {
    expect(rangeCallback('bytes=10-19').call(100)).toEqual({ start: 10, end: 19 });
  });

  it('reads the open-ended form a media element actually sends', () => {
    // `bytes=90-` is what an `<audio>` element sends when a learner drags the
    // scrubber; only the file size can close it, which is why this is a
    // callback and not a value.
    expect(rangeCallback('bytes=90-').call(100)).toEqual({ start: 90, end: 99 });
  });

  it('reads a suffix range', () => {
    expect(rangeCallback('bytes=-10').call(100)).toEqual({ start: 90, end: 99 });
  });

  it('answers a range past the end of the file with 416 carrying the real size', () => {
    // A media element treats a 416 and a 400 differently, and the size is the
    // difference: `Content-Range: bytes */<size>` (RFC 9110 §15.5.17) is how it
    // learns what to ask for instead, where a 400 is a dead end. Conflating the
    // parser's `-1` with its `-2` loses the status; leaving the header off
    // loses the only part of the answer that is actionable.
    const { call, record } = rangeCallback('bytes=200-300');

    const error = thrownBy(() => call(100));

    expect(error.httpStatusCode).toBe(416);
    expect(error.errorId).toBe('h5p-range:unsatisfiable');
    expect(record.headers.get('Content-Range')).toBe('bytes */100');
  });

  it('answers a header it cannot parse with 400 and no Content-Range', () => {
    // Nothing is known about what the caller should have asked for, so there is
    // no size to report — and a `bytes */…` on a 400 would be an answer to a
    // question they did not ask.
    const { call, record } = rangeCallback('bytes=abc');

    const error = thrownBy(() => call(100));

    expect(error.httpStatusCode).toBe(400);
    expect(error.errorId).toBe('h5p-range:malformed');
    expect(record.headers.has('Content-Range')).toBe(false);
  });

  it('refuses a multi-range request rather than answering part of it', () => {
    // The correct answer is a `multipart/byteranges` body. Serving only the
    // first range instead would be silently wrong data, not an error.
    const error = thrownBy(() => rangeCallback('bytes=0-9,20-29').call(100));

    expect(error.errorId).toBe('h5p-range:multipart');
  });

  it('serves the whole file for a unit it does not implement', () => {
    // RFC 9110 §14.2: an unrecognised range unit is ignored. Refusing it would
    // also have to explain itself, and the only sentence to hand says the
    // caller asked for two ranges, which they did not.
    expect(rangeCallback('items=0-9').call(100)).toBeUndefined();
  });
});

describe('pipeWholeStream', () => {
  it('answers 200 with the bytes, the length and the offer of ranges', async () => {
    const record = recordingResponse();

    pipeWholeStream(record.res, Readable.from([Buffer.from('abcdefghij')]), {
      mimetype: 'audio/mpeg',
      contentLength: 10,
      cacheControl: 'private, max-age=300',
      stallTimeoutMs: STALL_MS,
    });

    await expect(record.body()).resolves.toEqual(Buffer.from('abcdefghij'));
    expect(record.statusCode).toBe(200);
    expect(record.headers.get('Content-Type')).toBe('audio/mpeg');
    expect(record.headers.get('Content-Length')).toBe('10');
    // Without this a media element never issues a range request at all.
    expect(record.headers.get('Accept-Ranges')).toBe('bytes');
    expect(record.headers.get('Cache-Control')).toBe('private, max-age=300');
  });

  it('overrides the same-origin resource policy helmet sets for the rest of the API', () => {
    // The only automated guard on this: a browser is what enforces it, so
    // without the header these routes are 200 in a test client and blocked in
    // Chrome when the admin on :4200 loads them from :8080.
    const record = recordingResponse();

    pipeWholeStream(record.res, Readable.from([Buffer.from('x')]), {
      mimetype: 'text/javascript',
      contentLength: 1,
      cacheControl: 'public, max-age=31536000',
      stallTimeoutMs: STALL_MS,
    });

    expect(record.headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
    expect(record.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
});

describe('pipePartialStream', () => {
  it('answers 206 with the range, its length and the total', async () => {
    const record = recordingResponse();

    pipePartialStream(record.res, Readable.from([Buffer.from('0123456789')]), {
      mimetype: 'audio/mpeg',
      totalLength: 100,
      start: 10,
      end: 19,
      cacheControl: 'private, max-age=300',
      stallTimeoutMs: STALL_MS,
    });

    await expect(record.body()).resolves.toEqual(Buffer.from('0123456789'));
    expect(record.statusCode).toBe(206);
    expect(record.headers.get('Content-Range')).toBe('bytes 10-19/100');
    // The length of the slice, not of the object.
    expect(record.headers.get('Content-Length')).toBe('10');
  });

  it('sets Content-Type to the mimetype and never to the filename', () => {
    // `@lumieducation/h5p-express` passes the filename to its partial-response
    // helper, so a seek in `media/clip.mp3` answers
    // `Content-Type: media/clip.mp3`. This is the assertion that says we did
    // not copy that.
    const record = recordingResponse();

    pipePartialStream(record.res, Readable.from([Buffer.from('x')]), {
      mimetype: 'audio/mpeg',
      totalLength: 100,
      start: 0,
      end: 0,
      cacheControl: 'private, max-age=300',
      stallTimeoutMs: STALL_MS,
    });

    expect(record.headers.get('Content-Type')).toBe('audio/mpeg');
    expect(record.headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
  });
});

describe('a storage stream that fails', () => {
  /** Attaches a stream that is about to fail, in the shape the routes attach one. */
  function pipingWholeFile(stallTimeoutMs = 60_000): {
    record: RecordedResponse;
    stream: PassThrough;
  } {
    const record = recordingResponse();
    const stream = new PassThrough();

    pipeWholeStream(record.res, stream, {
      mimetype: 'audio/mpeg',
      contentLength: 4096,
      cacheControl: 'private, max-age=300',
      stallTimeoutMs,
    });

    return { record, stream };
  }

  const settle = (): Promise<unknown> => new Promise((resolve) => setImmediate(resolve));

  it('answers 500, not 404, and clears the headers that promised a body', async () => {
    // The endpoint stats the object before it opens a stream, so by the time
    // this runs the file is known to exist and what failed is the read. A 404
    // would tell a learner their audio does not exist and send whoever reads
    // the logs looking for missing content instead of for a bucket.
    const errors = captureErrors();
    const { record, stream } = pipingWholeFile();

    stream.destroy(new Error('socket hang up'));
    await settle();

    expect(record.statusCode).toBe(500);
    // Answered rather than left hanging: with `@Res()` in the controller,
    // Nest's exception filter cannot do this for us.
    expect(record.ended).toBe(true);
    // A stale `Content-Length: 4096` would leave the client waiting for bytes
    // that are never coming.
    expect(record.headers.has('Content-Length')).toBe(false);
    expect(record.headers.has('Content-Type')).toBe(false);
    expect(record.written()).toEqual(Buffer.alloc(0));
    expect(errors()).toHaveLength(1);
    expect(errors()[0]).toContain(REQUEST_PATH);
    expect(errors()[0]).toContain('socket hang up');
  });

  it('breaks the connection rather than writing a second status, once bytes have gone out', async () => {
    const errors = captureErrors();
    const { record, stream } = pipingWholeFile();

    stream.write('some bytes');
    record.headersSent = true;
    stream.destroy(new Error('the connection to the bucket dropped'));
    await settle();

    expect(record.destroyed).toBe(true);
    // 200 was already on the wire; a 500 appended to a truncated body would be
    // a lie the client cannot see. The log line is the only place this failure
    // is visible at all, which is why it is asserted rather than assumed.
    expect(record.statusCode).toBe(200);
    expect(errors()).toHaveLength(1);
    expect(errors()[0]).toContain('the connection to the bucket dropped');
  });

  it('destroys the storage stream when the client goes away mid-seek', async () => {
    // Every seek ends this way: a media element cancels the request it was
    // reading. Without this each one leaks an open Cloud Storage read.
    const { record, stream } = pipingWholeFile();

    record.res.emit('close');
    await settle();

    expect(stream.destroyed).toBe(true);
  });

  it('says nothing about a stream that fails after the response has closed', async () => {
    // The destroy above is itself a plausible cause of a stream error, and an
    // abandoned seek is not an incident: logging it would put a line in the log
    // for every seek a learner makes and bury the outage this logging is for.
    const errors = captureErrors();
    const { record, stream } = pipingWholeFile();

    record.res.emit('close');
    // Emitted rather than destroyed: the `close` handler has already destroyed
    // it, and a stream reports the consequences of that itself — a Cloud
    // Storage read answers a cancelled request with `Premature close`.
    stream.emit('error', new Error('Premature close'));
    await settle();

    expect(errors()).toEqual([]);
    expect(record.statusCode).toBe(200);
  });
});

describe('a storage stream that goes silent', () => {
  /**
   * The failure the `error` handler above cannot see.
   *
   * A bucket that drops the connection part way through a body raises neither
   * `error` nor `end` on the stream the Cloud Storage client hands over —
   * `node-fetch@2` swallows the premature close — so a `PassThrough` that never
   * speaks again is the shape production actually produces. Every other test in
   * this file emits an `Error`, which is what let a hang ship unnoticed.
   */
  function pipingWholeFile(): { record: RecordedResponse; stream: PassThrough } {
    const record = recordingResponse();
    const stream = new PassThrough();

    pipeWholeStream(record.res, stream, {
      mimetype: 'audio/mpeg',
      contentLength: 4096,
      cacheControl: 'private, max-age=300',
      stallTimeoutMs: STALL_MS,
    });

    return { record, stream };
  }

  const after = (ms: number): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, ms));

  it('answers 500 rather than holding a response open for a read that never starts', async () => {
    const errors = captureErrors();
    const { record, stream } = pipingWholeFile();

    await after(WELL_PAST_STALL_MS);

    expect(record.statusCode).toBe(500);
    expect(record.ended).toBe(true);
    expect(record.headers.has('Content-Length')).toBe(false);
    // The Cloud Storage read is released too; leaving it open is how a bucket
    // outage turns into an exhausted connection pool.
    expect(stream.destroyed).toBe(true);
    expect(errors()).toHaveLength(1);
    expect(errors()[0]).toContain(REQUEST_PATH);
    expect(errors()[0]).toContain(`${String(STALL_MS)} ms`);
  });

  it('breaks a body that stopped arriving, instead of leaving the client to time out', async () => {
    const errors = captureErrors();
    const { record, stream } = pipingWholeFile();

    stream.write('the first few bytes');
    record.headersSent = true;
    await after(WELL_PAST_STALL_MS);

    expect(record.destroyed).toBe(true);
    // 200 is already on the wire and the body is short of its `Content-Length`,
    // so breaking the connection is the only signal left; the log line is the
    // only trace, which is why silence here was the defect.
    expect(record.statusCode).toBe(200);
    expect(errors()).toHaveLength(1);
    expect(errors()[0]).toContain('truncated');
  });

  it('keeps waiting while bytes are still arriving', async () => {
    // A read slower than the timeout but never silent for that long — a big
    // clip, in other words. Nothing here may be cut off.
    const errors = captureErrors();
    const { record, stream } = pipingWholeFile();

    for (let written = 0; written < 5; written++) {
      stream.write('still going');
      await after(STALL_MS / 2);
    }
    // Ended so the watcher stops with the read, rather than reporting this
    // finished response to whichever test is running by then.
    stream.end();
    await after(STALL_MS);

    expect(errors()).toEqual([]);
    expect(record.statusCode).toBe(200);
    // Finished rather than broken: `end` is what a whole body looks like, where
    // the failures above answer 500 or destroy the connection.
    expect(record.ended).toBe(true);
    expect(record.written().toString()).toBe('still going'.repeat(5));
  });

  it('does not cut off a client that is slower than the bucket', async () => {
    // `pipe` pauses the source while the response waits to drain, so no bytes
    // arrive — and counting that as a stall would disconnect every learner on a
    // slow link. The second half is what says the timer kept re-arming rather
    // than never being set.
    const errors = captureErrors();
    const { record } = pipingWholeFile();
    record.needsDrain = true;

    await after(WELL_PAST_STALL_MS);
    expect(errors()).toEqual([]);
    expect(record.statusCode).toBe(200);

    record.needsDrain = false;
    await after(WELL_PAST_STALL_MS);
    expect(record.statusCode).toBe(500);
  });

  it('says nothing once the response has closed', async () => {
    // An abandoned seek leaves this timer armed and the stream destroyed; it
    // must not report an incident for a client that simply went away.
    const errors = captureErrors();
    const { record } = pipingWholeFile();

    record.res.emit('close');
    await after(WELL_PAST_STALL_MS);

    expect(errors()).toEqual([]);
  });
});
