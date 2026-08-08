import { PassThrough, Readable } from 'node:stream';
import { H5pError } from '@lumieducation/h5p-server';
import express from 'express';
import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { pipePartialStream, pipeWholeStream, rangeCallbackFor } from './h5p.responses.js';

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
  res['set'] = (values: Record<string, string>) => {
    for (const [name, value] of Object.entries(values)) {
      record.headers.set(name, value);
    }
    return record.res;
  };
  res['removeHeader'] = (name: string) => {
    record.headers.delete(name);
  };
  res['getHeader'] = (name: string) => record.headers.get(name);
  Object.defineProperty(sink, 'headersSent', { get: () => record.headersSent });
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
    expect(rangeCallbackFor(requestWithRange())(100)).toBeUndefined();
  });

  it('reads a closed range', () => {
    expect(rangeCallbackFor(requestWithRange('bytes=10-19'))(100)).toEqual({ start: 10, end: 19 });
  });

  it('reads the open-ended form a media element actually sends', () => {
    // `bytes=90-` is what an `<audio>` element sends when a learner drags the
    // scrubber; only the file size can close it, which is why this is a
    // callback and not a value.
    expect(rangeCallbackFor(requestWithRange('bytes=90-'))(100)).toEqual({ start: 90, end: 99 });
  });

  it('reads a suffix range', () => {
    expect(rangeCallbackFor(requestWithRange('bytes=-10'))(100)).toEqual({ start: 90, end: 99 });
  });

  it('answers a range past the end of the file with 416, not 400', () => {
    // A media element treats these differently: 416 carries the real size and
    // teaches it to ask again, where 400 is a dead end. Conflating the parser's
    // `-1` with its `-2` is how that happens.
    const error = thrownBy(() => rangeCallbackFor(requestWithRange('bytes=200-300'))(100));

    expect(error.httpStatusCode).toBe(416);
    expect(error.errorId).toBe('h5p-range:unsatisfiable');
  });

  it('answers a header it cannot parse with 400', () => {
    const error = thrownBy(() => rangeCallbackFor(requestWithRange('bytes=abc'))(100));

    expect(error.httpStatusCode).toBe(400);
    expect(error.errorId).toBe('h5p-range:malformed');
  });

  it('refuses a multi-range request rather than answering part of it', () => {
    // The correct answer is a `multipart/byteranges` body. Serving only the
    // first range instead would be silently wrong data, not an error.
    const error = thrownBy(() => rangeCallbackFor(requestWithRange('bytes=0-9,20-29'))(100));

    expect(error.errorId).toBe('h5p-range:multipart');
  });

  it('refuses a unit that is not bytes', () => {
    const error = thrownBy(() => rangeCallbackFor(requestWithRange('items=0-9'))(100));

    expect(error.errorId).toBe('h5p-range:multipart');
  });
});

describe('pipeWholeStream', () => {
  it('answers 200 with the bytes, the length and the offer of ranges', async () => {
    const record = recordingResponse();

    pipeWholeStream(record.res, Readable.from([Buffer.from('abcdefghij')]), {
      mimetype: 'audio/mpeg',
      contentLength: 10,
      cacheControl: 'private, max-age=300',
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
    });

    expect(record.headers.get('Content-Type')).toBe('audio/mpeg');
    expect(record.headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
  });
});

describe('a storage stream that fails', () => {
  it('answers 404 and clears the headers that promised a body, when nothing has been written', async () => {
    const record = recordingResponse();
    const stream = new PassThrough();

    pipeWholeStream(record.res, stream, {
      mimetype: 'audio/mpeg',
      contentLength: 4096,
      cacheControl: 'private, max-age=300',
    });
    stream.destroy(new Error('the object is not there'));
    await new Promise((resolve) => setImmediate(resolve));

    expect(record.statusCode).toBe(404);
    // Answered rather than left hanging: with `@Res()` in the controller,
    // Nest's exception filter cannot do this for us.
    expect(record.ended).toBe(true);
    // A stale `Content-Length: 4096` would leave the client waiting for bytes
    // that are never coming.
    expect(record.headers.has('Content-Length')).toBe(false);
    expect(record.headers.has('Content-Type')).toBe(false);
    expect(record.written()).toEqual(Buffer.alloc(0));
  });

  it('breaks the connection rather than writing a second status, once bytes have gone out', async () => {
    const record = recordingResponse();
    const stream = new PassThrough();

    pipeWholeStream(record.res, stream, {
      mimetype: 'audio/mpeg',
      contentLength: 4096,
      cacheControl: 'private, max-age=300',
    });
    stream.write('some bytes');
    record.headersSent = true;
    stream.destroy(new Error('the connection to the bucket dropped'));
    await new Promise((resolve) => setImmediate(resolve));

    expect(record.destroyed).toBe(true);
    // 200 was already on the wire; a 404 appended to a truncated body would be
    // a lie the client cannot see.
    expect(record.statusCode).toBe(200);
  });

  it('destroys the storage stream when the client goes away mid-seek', async () => {
    // Every seek ends this way: a media element cancels the request it was
    // reading. Without this each one leaks an open Cloud Storage read.
    const record = recordingResponse();
    const stream = new PassThrough();

    pipeWholeStream(record.res, stream, {
      mimetype: 'audio/mpeg',
      contentLength: 4096,
      cacheControl: 'private, max-age=300',
    });
    record.res.emit('close');
    await new Promise((resolve) => setImmediate(resolve));

    expect(stream.destroyed).toBe(true);
  });
});
