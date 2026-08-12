import {
  Controller,
  Get,
  InternalServerErrorException,
  Logger,
  Param,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';
import type { IPlayerModel } from '@lumieducation/h5p-server';
import type { Request, Response } from 'express';
import { Public } from '../auth/public.decorator.js';
import type { Env } from '../config/configuration.js';
import { H5pClientAssets, missingAssetsMessage, type H5pAssetKind } from './h5p.client-assets.js';
import { wildcardPath } from './h5p.request.js';
import {
  CROSS_ORIGIN_HEADERS,
  pipePartialStream,
  pipeWholeStream,
  rangeCallbackFor,
} from './h5p.responses.js';
import { H5pServeService } from './h5p-serve.service.js';

/**
 * A content file is replaced under the same URL when an exercise is re-saved,
 * so it may not be cached for long — but a learner replaying a clip should not
 * fetch it twice.
 */
const CONTENT_CACHE_CONTROL = 'private, max-age=300';

/**
 * Library URLs carry `?version=<major.minor.patch>` (`UrlGenerator.libraryFile`),
 * so a patch upgrade changes the URL and a year is safe. It is also what
 * upstream serves them with.
 */
const LIBRARY_CACHE_CONTROL = 'public, max-age=31536000';

/**
 * An hour rather than a year, because the cache buster on these URLs is
 * `?version=${config.h5pVersion}` — a constant of the library (`1.27.0`), not
 * of the commit we pin. Bumping the pin does not change the URL, so a long TTL
 * would serve the previous core until the browser felt like asking again.
 */
const ASSET_MAX_AGE = '1h';

/**
 * Everything the H5P client in a browser reads: the player model, an exercise's
 * files, an installed library's files, and Joubel's own core and editor
 * JavaScript.
 *
 * **Every route here is `@Public()`, and that is a file boundary rather than a
 * decorator habit.** The authoring half lands in a controller of its own where
 * every route is `@Roles('editor')`, and `h5p.controller.ts` keeps the upload.
 * What protects the content served here is the unguessable `randomUUID()` id
 * plus the absence of any route that enumerates ids — see ADR-007, which also
 * records the constraint that places on future listing routes.
 *
 * **Why `@Res()`, which nothing else in this codebase uses.** These routes
 * stream bytes with a status and headers that depend on the request's `Range`;
 * returning a value cannot express a 206. The cost is that Nest's response
 * pipeline is off: an exception thrown before the first byte still reaches the
 * global filter, and one raised after it cannot, which is what the stream error
 * handling in `h5p.responses.ts` is for.
 *
 * **Why the wildcards are named.** Express 5 rejects a bare `*`, so the
 * parameter is `*path` — and it arrives as an array of *decoded* segments,
 * which `@Param('path')` would type as a `string`. Hence `@Req()` and
 * `wildcardPath`.
 */
@ApiTags('h5p')
@Controller('h5p')
export class H5pPublicController {
  private readonly logger = new Logger(H5pPublicController.name);
  private readonly stallTimeoutMs: number;

  constructor(
    private readonly serve: H5pServeService,
    private readonly assets: H5pClientAssets,
    config: ConfigService<Env, true>,
  ) {
    this.stallTimeoutMs = config.get('H5P_STREAM_STALL_TIMEOUT_MS', { infer: true });
  }

  /**
   * The model `@lumieducation/h5p-webcomponents` renders an exercise from.
   *
   * `?lang` selects the language of the player's own chrome — its fullscreen
   * and copyright labels — and English is the fallback, per key, for anything
   * the loaded locales do not cover. **Choosing it is the caller's job**: the
   * public site is server-rendered and knows the reader's locale, so it passes
   * that; absent `?lang` the answer is English. Exercise *content* is
   * unaffected either way, since that comes out of the uploaded package. See
   * ADR-007 and #36.
   *
   * `?lang` is deliberately not validated. `LibraryManager.getLanguage`
   * swallows a lookup miss and the translation callback only reads maps already
   * in memory, so a junk value is a 200 with English chrome — the right answer
   * for a public read route, and never a filesystem path.
   *
   * Note for whoever adds the authoring routes: `POST h5p/content` means
   * "install an uploaded package" and must keep meaning that, so a save route
   * needs its own path rather than the same one with a body.
   */
  @Public()
  @Get('play/:contentId')
  playerModel(
    @Param('contentId') contentId: string,
    @Query('lang') language?: string,
  ): Promise<IPlayerModel> {
    return language
      ? this.serve.playerModel(contentId, language)
      : this.serve.playerModel(contentId);
  }

  @Public()
  @Get('content/:contentId/*path')
  async contentFile(
    @Param('contentId') contentId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.serve.contentFile(
      contentId,
      wildcardPath(req),
      rangeCallbackFor(req, res),
    );

    if (file.range) {
      pipePartialStream(res, file.stream, {
        mimetype: file.mimetype,
        totalLength: file.totalLength,
        start: file.range.start,
        end: file.range.end,
        cacheControl: CONTENT_CACHE_CONTROL,
        stallTimeoutMs: this.stallTimeoutMs,
      });
      return;
    }

    pipeWholeStream(res, file.stream, {
      mimetype: file.mimetype,
      contentLength: file.totalLength,
      cacheControl: CONTENT_CACHE_CONTROL,
      stallTimeoutMs: this.stallTimeoutMs,
    });
  }

  @Public()
  @Get('libraries/:ubername/*path')
  async libraryFile(
    @Param('ubername') ubername: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.serve.libraryFile(ubername, wildcardPath(req));

    pipeWholeStream(res, file.stream, {
      mimetype: file.mimetype,
      contentLength: file.contentLength,
      cacheControl: LIBRARY_CACHE_CONTROL,
      stallTimeoutMs: this.stallTimeoutMs,
    });
  }

  @Public()
  @Get('core/*path')
  coreAsset(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.sendAsset('core', req, res);
  }

  @Public()
  @Get('editor-assets/*path')
  editorAsset(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.sendAsset('editor', req, res);
  }

  /**
   * Serves one file out of a fetched client library tree.
   *
   * `res.sendFile` is `send`, so the content type, `ETag`, `Last-Modified` and
   * range handling all come for free and correct. It also refuses to escape
   * `root` — but the path is asserted first anyway, so an attempt is answered
   * by our 400 naming the rule rather than by `send`'s bare 403.
   *
   * `dotfiles: 'deny'` is spelled out even though `send`'s default of `ignore`
   * refuses them too: these trees are fetched from someone else's repository,
   * so "nothing beginning with a dot is served out of them" is a decision this
   * route makes rather than one it inherits.
   *
   * A failure `send` blames on the request — a missing file, a dotfile — is a
   * 404, and the two are deliberately indistinguishable. Anything else is a
   * fault of this server's own installation, such as a tree it may not read, so
   * it is logged and answered 500 rather than quietly reported as a file that
   * does not exist.
   */
  private async sendAsset(kind: H5pAssetKind, req: Request, res: Response): Promise<void> {
    const path = wildcardPath(req);

    if (!(await this.assets.isInstalled(kind))) {
      // A 404 here would send whoever hits it looking for a wrong URL. This is
      // a server that was never finished installing, and the message says so.
      throw new ServiceUnavailableException(missingAssetsMessage(kind));
    }

    res.set(CROSS_ORIGIN_HEADERS);

    await new Promise<void>((resolve, reject) => {
      res.sendFile(
        path,
        { root: this.assets.rootOf(kind), dotfiles: 'deny', maxAge: ASSET_MAX_AGE },
        (error?: Error) => {
          if (!error || res.headersSent) {
            // A client that navigated away aborts `sendFile` after the headers
            // have gone out; there is nothing left to answer with.
            resolve();
            return;
          }
          reject(error);
        },
      );
    }).catch((error: unknown) => {
      if (sendFailureStatus(error) >= 500) {
        // Kept alongside `HttpExceptionFilter`'s own 5xx line: the filter is
        // handed the sanitized exception below, so the path and `send`'s own
        // failure — the `EACCES` that explains it — are recorded here or
        // nowhere.
        this.logger.error(
          `Serving "${path}" from the H5P ${kind} client tree failed: ${String(error)}`,
        );
        throw new InternalServerErrorException(
          `The H5P ${kind} client library could not be read on this server.`,
        );
      }

      res.status(404).end();
    });
  }
}

/**
 * The status `send` failed with, or 500 when it named none.
 *
 * `send` sets `status` on the errors it raises: 404 for a missing file, 403 for
 * a dotfile, 500 for a `stat` that failed for any other reason. An error
 * without one did not come from `send` at all, and neither case is the
 * caller's.
 */
function sendFailureStatus(error: unknown): number {
  const status: unknown = error instanceof Error ? (error as { status?: unknown }).status : null;
  return typeof status === 'number' ? status : 500;
}
