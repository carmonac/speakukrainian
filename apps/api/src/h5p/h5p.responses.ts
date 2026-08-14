import type { Readable } from 'node:stream';
import { Logger } from '@nestjs/common';
import { H5pError } from '@lumieducation/h5p-server';
import type { Request, Response } from 'express';

const logger = new Logger('H5pResponses');

/** The shape `H5PAjaxEndpoint.getContentFile` asks for. `undefined` means "the whole file". */
export type RangeCallback = (fileSize: number) => { start: number; end: number } | undefined;

/**
 * Cross-origin, deliberately, and only on these routes.
 *
 * `helmet` sets `Cross-Origin-Resource-Policy: same-origin` for the whole API
 * (`common/security-headers.ts`), which is right for JSON that only the admin
 * reads and fatal for these: the admin runs on :4200 and the API on :8080, so a
 * browser refuses every `<script>`, `<link>`, `<img>` and `<audio>` load from
 * here — 200 in a test client, blocked in Chrome. **Six routes** serve
 * subresources to another origin — content files, library files, the core and
 * editor client trees, and the two temporary-file routes the authoring widget
 * previews an upload through — so the override lives here rather than in
 * `main.ts`, where it would relax the whole API. `play` is not one of them: it
 * is JSON the admin reads with a CORS `fetch`, and it keeps helmet's
 * `same-origin`.
 *
 * `createTestApp` installs the same helmet middleware, so the e2e assertions on
 * these values are assertions that the route beats the global default rather
 * than that it sets a header nobody contradicted.
 *
 * Exported because the asset routes send their bytes with `res.sendFile`
 * instead of a stream from here, and a second copy of the policy is how the
 * two drift apart.
 */
export const CROSS_ORIGIN_HEADERS: Record<string, string> = {
  'Cross-Origin-Resource-Policy': 'cross-origin',
  // Helmet already sets this globally. Repeated here so that these routes keep
  // it even if the global policy is ever narrowed to JSON responses, which is
  // exactly the change that would otherwise let a `.js` be sniffed as HTML.
  'X-Content-Type-Options': 'nosniff',
};

/**
 * How long a read may deliver nothing at all before it is declared dead.
 *
 * It measures silence, not duration: any byte from storage restarts the clock,
 * and so does a client that is too slow to take them, so a big file over a slow
 * link never trips it. See `pipe` for why the guard has to exist.
 */
export interface StallTimeout {
  stallTimeoutMs: number;
}

export interface WholeStreamOptions extends StallTimeout {
  mimetype: string;
  contentLength: number;
  cacheControl: string;
}

export interface PartialStreamOptions extends StallTimeout {
  mimetype: string;
  /** The size of the whole object, which is what `Content-Range` reports after the slash. */
  totalLength: number;
  start: number;
  end: number;
  cacheControl: string;
}

/**
 * Reads the request's `Range` header into the callback the H5P endpoint wants.
 *
 * A callback rather than a value because the header cannot be resolved without
 * the file size — `bytes=90-` means "to the end", and only the storage knows
 * where that is. The endpoint calls this after its own `stat`.
 *
 * The response is here because of the 416 below: that is the one answer this
 * function shapes rather than merely refuses, and the size it needs is known
 * nowhere else. The throw travels back up through the endpoint's own call stack
 * to the exception filter, which adds no headers of its own.
 */
export function rangeCallbackFor(req: Request, res: Response): RangeCallback {
  return (fileSize: number) => {
    const parsed = req.range(fileSize);
    if (parsed === undefined) {
      return undefined;
    }

    // `-1` and `-2` are different answers and a media element treats them
    // differently: a range past the end of the file is a 416 carrying the real
    // size, which is how the element learns to ask again, while a header it
    // could not parse is the client's mistake and a 400. RFC 9110 §15.5.17
    // spells the size as `bytes */<size>` with no range before the slash.
    if (parsed === -1) {
      res.set('Content-Range', `bytes */${String(fileSize)}`);
      throw new H5pError('h5p-range:unsatisfiable', {}, 416);
    }
    if (parsed === -2) {
      throw new H5pError('h5p-range:malformed', {}, 400);
    }
    // A range unit this server does not implement is ignored and the whole
    // representation served, which is what RFC 9110 §14.2 requires. Refusing it
    // would also mean answering `Range: items=0-9` with a sentence about
    // multiple ranges, which describes a mistake the caller did not make.
    if (parsed.type !== 'bytes') {
      return undefined;
    }
    if (parsed.length !== 1) {
      // Answering a multi-range request needs a `multipart/byteranges` body.
      // Nothing H5P serves needs one, and a wrong single-range answer to it
      // would be silently corrupt data rather than an error.
      throw new H5pError('h5p-range:multipart', {}, 400);
    }

    const [range] = parsed;
    return range === undefined ? undefined : { start: range.start, end: range.end };
  };
}

/** 200 with the whole object, and the advertisement that ranges are available. */
export function pipeWholeStream(
  res: Response,
  stream: Readable,
  options: WholeStreamOptions,
): void {
  res.status(200);
  res.set({
    ...CROSS_ORIGIN_HEADERS,
    'Content-Type': options.mimetype,
    'Content-Length': String(options.contentLength),
    // Without this a media element never issues a range request at all, so a
    // learner cannot seek in a lesson clip.
    'Accept-Ranges': 'bytes',
    'Cache-Control': options.cacheControl,
  });

  pipe(res, stream, options.stallTimeoutMs);
}

/** 206 with one byte range. */
export function pipePartialStream(
  res: Response,
  stream: Readable,
  options: PartialStreamOptions,
): void {
  res.status(206);
  res.set({
    ...CROSS_ORIGIN_HEADERS,
    // The mimetype, not the filename. `@lumieducation/h5p-express` passes the
    // filename here, which makes a seek in `media/clip.mp3` answer
    // `Content-Type: media/clip.mp3`.
    'Content-Type': options.mimetype,
    'Content-Length': String(options.end - options.start + 1),
    'Content-Range': `bytes ${options.start}-${options.end}/${options.totalLength}`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': options.cacheControl,
  });

  pipe(res, stream, options.stallTimeoutMs);
}

/**
 * The one place a storage stream is attached to a response.
 *
 * Two failures have to be handled here rather than by Nest's exception filter,
 * because `@Res()` takes the response out of its hands: a read that fails
 * before any byte is written still has to become a status, and a read that
 * fails after one cannot — the only honest answer then is to break the
 * connection rather than append an error to a truncated body.
 *
 * **A failure before the first byte is a 500, not a 404.**
 * `H5PAjaxEndpoint.getContentFile` stats the object before it opens a stream,
 * so by the time this runs the file is known to exist; what is left is a reset
 * connection, a 5xx from the bucket or expired credentials, and every one of
 * those is this server's fault. Answering 404 would tell a learner the audio
 * does not exist and send whoever reads the logs looking for missing content.
 *
 * **Both branches log.** Nothing else can: the exception filter never sees
 * these, so without a line here a bucket outage is a wall of failed media
 * requests with nothing anywhere to explain them.
 *
 * **A read that simply stops is a failure too, and it is the common one.** The
 * bucket dropping the connection part way through a body raises no `error` and
 * no `end` on this stream at all: the Cloud Storage client reads its response
 * through `node-fetch@2`, which pipes the socket into a `PassThrough` and does
 * not forward the `aborted` that Node raises on a premature close, so the
 * stream sits open with nothing coming. Without the timer below the response
 * stays open too, holding a socket, and the learner's clip freezes for as long
 * as the client is willing to wait — with nothing in the log, because neither
 * branch above ever runs.
 *
 * `close` destroys the stream so an abandoned seek — which is every seek, since
 * a media element cancels the request it was reading — does not leave a Cloud
 * Storage read open behind it.
 */
function pipe(res: Response, stream: Readable, stallTimeoutMs: number): void {
  // `close` also fires when the response finishes normally, which is what makes
  // this the right test for "there is no longer anybody to answer or to warn":
  // the destroy below is itself a plausible cause of the error handler running,
  // and an abandoned seek is not an incident.
  let responseClosed = false;
  let reported = false;
  let stallTimer: NodeJS.Timeout | undefined;
  let lastByteAt = Date.now();

  const stopWatching = (): void => {
    if (stallTimer) {
      clearTimeout(stallTimer);
      stallTimer = undefined;
    }
  };

  const report = (error: Error): void => {
    // `reported` covers the stalled case reporting itself and then hearing the
    // consequences of its own `destroy` as a second error: one failure, one log
    // line, one answer.
    if (responseClosed || reported) {
      return;
    }
    reported = true;
    stopWatching();

    if (res.headersSent) {
      logger.error(
        `Reading ${res.req.originalUrl} failed after the response had started, so its body is truncated: ${error.message}`,
      );
      res.destroy();
      return;
    }

    logger.error(
      `Reading ${res.req.originalUrl} failed before any byte was written: ${error.message}`,
    );
    // These describe a body that is not going to arrive, and `Content-Length`
    // in particular would leave the client waiting for bytes.
    res.removeHeader('Content-Length');
    res.removeHeader('Content-Range');
    res.removeHeader('Content-Type');
    res.status(500).end();
  };

  const checkForStall = (): void => {
    if (responseClosed) {
      return;
    }

    // A response that is waiting to drain has stopped asking for bytes, so
    // none should be expected: `pipe` pauses the source until the client
    // catches up. Counting that as silence would cut off every learner whose
    // connection is slower than the bucket.
    const silentFor = res.writableNeedDrain ? 0 : Date.now() - lastByteAt;
    if (silentFor < stallTimeoutMs) {
      stallTimer = setTimeout(checkForStall, stallTimeoutMs - silentFor);
      return;
    }

    // Reported before the stream is destroyed, so that the log names the
    // silence rather than whatever the destroy makes the stream say about
    // itself; and destroyed rather than left to time out again, because this
    // read is never going to speak and its Cloud Storage connection is ours to
    // release.
    report(new Error(`storage sent nothing for ${String(stallTimeoutMs)} ms`));
    stream.destroy();
  };

  res.on('close', () => {
    responseClosed = true;
    stopWatching();
    stream.destroy();
  });

  stream.on('data', () => {
    lastByteAt = Date.now();
  });
  stream.on('end', stopWatching);
  stream.on('error', report);

  stallTimer = setTimeout(checkForStall, stallTimeoutMs);
  stream.pipe(res);
}
