import type { Readable } from 'node:stream';
import { H5pError } from '@lumieducation/h5p-server';
import type { Request, Response } from 'express';

/** The shape `H5PAjaxEndpoint.getContentFile` asks for. `undefined` means "the whole file". */
export type RangeCallback = (fileSize: number) => { start: number; end: number } | undefined;

/**
 * Cross-origin, deliberately, and only on these routes.
 *
 * `helmet` sets `Cross-Origin-Resource-Policy: same-origin` for the whole API,
 * which is right for JSON that only the admin reads and fatal for these: the
 * admin runs on :4200 and the API on :8080, so a browser refuses every
 * `<script>`, `<link>`, `<img>` and `<audio>` load from here — 200 in a test
 * client, blocked in Chrome. These five routes are the only ones that serve
 * subresources to another origin, so the override lives here rather than in
 * `main.ts`, where it would relax the whole API.
 */
const CROSS_ORIGIN_HEADERS: Record<string, string> = {
  'Cross-Origin-Resource-Policy': 'cross-origin',
  // Helmet already sets this globally. Repeated here so that these routes keep
  // it even if the global policy is ever narrowed to JSON responses, which is
  // exactly the change that would otherwise let a `.js` be sniffed as HTML.
  'X-Content-Type-Options': 'nosniff',
};

export interface WholeStreamOptions {
  mimetype: string;
  contentLength: number;
  cacheControl: string;
}

export interface PartialStreamOptions {
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
 */
export function rangeCallbackFor(req: Request): RangeCallback {
  return (fileSize: number) => {
    const parsed = req.range(fileSize);
    if (parsed === undefined) {
      return undefined;
    }

    // `-1` and `-2` are different answers and a media element treats them
    // differently: a range past the end of the file is a 416 carrying the real
    // size, which is how the element learns to ask again, while a header it
    // could not parse is the client's mistake and a 400.
    if (parsed === -1) {
      throw new H5pError('h5p-range:unsatisfiable', { size: String(fileSize) }, 416);
    }
    if (parsed === -2) {
      throw new H5pError('h5p-range:malformed', {}, 400);
    }
    if (parsed.type !== 'bytes' || parsed.length !== 1) {
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

  pipe(res, stream);
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

  pipe(res, stream);
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
 * `close` destroys the stream so an abandoned seek — which is every seek, since
 * a media element cancels the request it was reading — does not leave a Cloud
 * Storage read open behind it.
 */
function pipe(res: Response, stream: Readable): void {
  res.on('close', () => stream.destroy());

  stream.on('error', () => {
    if (res.headersSent) {
      res.destroy();
      return;
    }

    // These describe a body that is not going to arrive, and `Content-Length`
    // in particular would leave the client waiting for bytes.
    res.removeHeader('Content-Length');
    res.removeHeader('Content-Range');
    res.removeHeader('Content-Type');
    res.status(404).end();
  });

  stream.pipe(res);
}
