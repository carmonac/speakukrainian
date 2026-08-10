import type { Readable } from 'node:stream';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { H5PAjaxEndpoint, H5PEditor, H5pError } from '@lumieducation/h5p-server';
import type { IUser } from '@lumieducation/h5p-server';
import { toHttpException } from './h5p.errors.js';
import type { RangeCallback } from './h5p.responses.js';
import { H5P_AJAX_ENDPOINT, H5P_EDITOR } from './h5p.tokens.js';

/**
 * How often one instance may sweep expired temporary files.
 *
 * Exported so the spec can drive the clock past it explicitly rather than
 * depending on how long another test took.
 */
export const TEMP_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * The language `POST /ajax` falls back to.
 *
 * `H5PEditor.listLibraryLanguageFiles` — the `translations` action — declares
 * `language` as required and hands it straight to `validateLanguageCode`, which
 * refuses `undefined` with a plain `Error` and therefore a 500. `getLibraryData`
 * on the GET side already defaults to `en` for itself, so defaulting here is the
 * same answer said one layer earlier rather than a new behaviour.
 */
const DEFAULT_LANGUAGE = 'en';

/** `GET /ajax` actions this API serves. The endpoint refuses everything else itself. */
const GET_AJAX_ACTIONS = new Set(['content-type-cache', 'libraries']);

/**
 * `POST /ajax` actions this API serves, as an allowlist rather than a denylist.
 *
 * Three of `postAjax`'s eight are deliberately unreachable:
 * `library-install` and `get-content` both talk to the H5P Hub, which
 * `contentHubEnabled: false` switches off, and `content-hub-metadata-cache`
 * does the same from the GET side. An unknown action reaches the endpoint's own
 * `default` branch, which raises `malformed-request` with a **500** — a server
 * error for a query string the caller chose.
 *
 * `library-upload` is on the list and is also why the allowlist has to be
 * checked *with* the uploaded parts in hand: `postAjax` dereferences
 * `libraryUploadFile.name` unconditionally, so that action without an `h5p`
 * part is a `TypeError` and a 500.
 */
const POST_AJAX_ACTIONS = new Set([
  'libraries',
  'translations',
  'files',
  'filter',
  'library-upload',
]);

/** A file part multer wrote to disk, in the shape the endpoint asks for. */
export interface AjaxUpload {
  mimetype: string;
  name: string;
  size: number;
  /** No `data`: `file.data?.length > 0` is false for `undefined`, so the library reads the path. */
  tempFilePath: string;
}

export interface GetAjaxRequest {
  /** `?action`, which a caller can simply leave out — the allowlist refuses that too. */
  action?: string;
  machineName?: string;
  majorVersion?: string;
  minorVersion?: string;
  language?: string;
}

export interface PostAjaxRequest {
  action?: string;
  /** The parsed JSON body, or nothing at all for a multipart request. */
  body?: unknown;
  language?: string;
  /** The `file` part — `action=files`. */
  upload?: AjaxUpload;
  /** The `h5p` part — `action=library-upload`. */
  packageUpload?: AjaxUpload;
}

export interface TemporaryFileResult {
  mimetype: string;
  /** Present only when the request carried a satisfiable `Range`. */
  range?: { start: number; end: number };
  totalLength: number;
  stream: Readable;
}

/**
 * The body shapes `postAjax` declares.
 *
 * It narrows per action with `in` checks and raises its own 400 naming the
 * missing property, so this route may not pre-declare which of the three
 * arrived — every branch would be wrong for four of the five actions.
 */
type PostAjaxBody = Parameters<H5PAjaxEndpoint['postAjax']>[1];

/**
 * Whatever the endpoint answers, named through the endpoint rather than by
 * listing its union: `IHubInfo` and `ILibraryDetailedDataForClient` are not
 * exported from the package root, and re-declaring either would be a second
 * source of truth for someone else's response shape.
 */
type GetAjaxResult = Awaited<ReturnType<H5PAjaxEndpoint['getAjax']>>;
type PostAjaxResult = Awaited<ReturnType<H5PAjaxEndpoint['postAjax']>>;

/**
 * The range callback `getTemporaryFile` declares.
 *
 * It is narrower than the one it is handed to and than `getContentFile`'s: it
 * omits the `undefined` its own documentation asks for ("if the request doesn't
 * specify a range, simply return undefined"), and the implementation reads
 * `range?.start`, so `undefined` is what it expects at runtime. The cast is
 * against the declaration and not against the behaviour, and it goes when
 * upstream widens the type.
 */
type TemporaryFileRangeCallback = Parameters<H5PAjaxEndpoint['getTemporaryFile']>[2];

/**
 * The library calls the editor's ajax routes need, with their errors already
 * mapped onto HTTP.
 *
 * The counterpart of `H5pServeService` on the authoring side, and the mapping
 * belongs here for the same reason: `toHttpException` returning `null` is the
 * decision that an error is *this server's* fault, which is a judgement about
 * the library's behaviour rather than about the request.
 */
@Injectable()
export class H5pEditorService {
  private readonly logger = new Logger(H5pEditorService.name);

  /** Per-instance, per-process. See `maybeSweep`. */
  private lastSweptAt = 0;

  constructor(
    @Inject(H5P_AJAX_ENDPOINT) private readonly ajax: H5PAjaxEndpoint,
    @Inject(H5P_EDITOR) private readonly editor: H5PEditor,
  ) {}

  async getAjax(request: GetAjaxRequest, user: IUser): Promise<GetAjaxResult> {
    return this.mapErrors(async () => {
      assertAllowedAction(request.action, GET_AJAX_ACTIONS);

      return this.ajax.getAjax(
        request.action,
        request.machineName,
        request.majorVersion,
        request.minorVersion,
        request.language,
        user,
      );
    });
  }

  async postAjax(request: PostAjaxRequest, user: IUser): Promise<PostAjaxResult> {
    return this.mapErrors(async () => {
      assertAllowedAction(request.action, POST_AJAX_ACTIONS);

      if (request.action === 'library-upload' && !request.packageUpload) {
        // `postAjax` reads `libraryUploadFile.name` before anything else, so
        // without this the request is a `TypeError` and a 500 instead of the
        // 400 a missing part deserves.
        throw new H5pError(
          'malformed-request',
          { error: 'the request must carry a package in the "h5p" field' },
          400,
        );
      }

      return this.ajax.postAjax(
        request.action,
        // `'libraries' in body` on three of the five branches, so a request with
        // no body at all raises `TypeError: Cannot use 'in' operator`.
        (request.body ?? {}) as PostAjaxBody,
        request.language ?? DEFAULT_LANGUAGE,
        user,
        request.upload,
        undefined,
        undefined,
        request.packageUpload,
      );
    });
  }

  async temporaryFile(
    filename: string,
    user: IUser,
    range: RangeCallback,
  ): Promise<TemporaryFileResult> {
    return this.mapErrors(async () => {
      const file = await this.ajax.getTemporaryFile(
        filename,
        user,
        range as TemporaryFileRangeCallback,
      );

      return {
        mimetype: file.mimetype,
        // The endpoint types `range` as always present and returns `undefined`
        // when the request carried no `Range`.
        ...(file.range ? { range: file.range } : {}),
        totalLength: file.stats.size,
        stream: file.stream,
      };
    });
  }

  /**
   * Removes expired temporary files, at most once per instance per interval.
   *
   * **This exists because there is a real leak and no scheduler can close it.**
   * `ContentStorer.addOrUpdateContent` passes `deleteTemporaryFiles = isUpdate`,
   * so on *create* — every first save of a new exercise — the temp copies of
   * every uploaded file are deliberately left behind for "the regular
   * expiration mechanism". With none, the rate is one permanently orphaned
   * object per media file per newly created exercise, under a prefix no route
   * can enumerate or delete.
   *
   * Opportunistic rather than scheduled: Cloud Run scales to zero, so an
   * interval only runs while an instance happens to be alive, which is exactly
   * what nothing guarantees. An instance serving an upload is an instance that
   * is alive, and an upload is when the garbage appears.
   *
   * **It must never affect a response.** Callers compute their answer first and
   * then `void` this; the rejection is caught and logged here so a listing that
   * failed cannot turn a successful upload into a 500.
   */
  async maybeSweep(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSweptAt < TEMP_SWEEP_INTERVAL_MS) {
      return;
    }
    // Claimed before the await, so two requests arriving together sweep once.
    this.lastSweptAt = now;

    try {
      await this.editor.temporaryFileManager.cleanUp();
    } catch (error) {
      this.logger.warn(
        `Sweeping expired H5P temporary files failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Everything the library raises that is about the request becomes an
   * `HttpException`; everything else is rethrown untouched so it stays a 500.
   */
  private async mapErrors<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const http = toHttpException(error);
      if (http) {
        throw http;
      }
      throw error;
    }
  }
}

function assertAllowedAction(
  action: string | undefined,
  allowed: ReadonlySet<string>,
): asserts action is string {
  if (action === undefined || !allowed.has(action)) {
    throw new H5pError(
      'h5p-request:unsupported-ajax-action',
      { action: action ?? '', allowed: [...allowed].join(', ') },
      400,
    );
  }
}
