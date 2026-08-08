import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { IPlayerModel } from '@lumieducation/h5p-server';
import type { Request, Response } from 'express';
import { Public } from '../auth/public.decorator.js';
import { H5pClientAssets, missingAssetsMessage, type H5pAssetKind } from './h5p.client-assets.js';
import { joinContentFilePath } from './h5p.paths.js';
import { pipePartialStream, pipeWholeStream, rangeCallbackFor } from './h5p.responses.js';
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
  constructor(
    private readonly serve: H5pServeService,
    private readonly assets: H5pClientAssets,
  ) {}

  /**
   * The model `@lumieducation/h5p-webcomponents` renders an exercise from.
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
    const file = await this.serve.contentFile(contentId, wildcardPath(req), rangeCallbackFor(req));

    if (file.range) {
      pipePartialStream(res, file.stream, {
        mimetype: file.mimetype,
        totalLength: file.totalLength,
        start: file.range.start,
        end: file.range.end,
        cacheControl: CONTENT_CACHE_CONTROL,
      });
      return;
    }

    pipeWholeStream(res, file.stream, {
      mimetype: file.mimetype,
      contentLength: file.totalLength,
      cacheControl: CONTENT_CACHE_CONTROL,
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
   */
  private async sendAsset(kind: H5pAssetKind, req: Request, res: Response): Promise<void> {
    const path = wildcardPath(req);

    if (!(await this.assets.isInstalled(kind))) {
      // A 404 here would send whoever hits it looking for a wrong URL. This is
      // a server that was never finished installing, and the message says so.
      throw new ServiceUnavailableException(missingAssetsMessage(kind));
    }

    res.set({ 'Cross-Origin-Resource-Policy': 'cross-origin' });

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
    }).catch(() => {
      res.status(404).end();
    });
  }
}

/**
 * The `*path` wildcard, joined and asserted.
 *
 * Express 5 decodes each segment before handing it over, so
 * `media/..%2f..%2fx` arrives as `['media', '../../x']` — a per-segment check
 * sees two ordinary names. `joinContentFilePath` is where the assert runs after
 * the join, which is the only order that catches it.
 *
 * Its `H5pError` becomes a `BadRequestException` here rather than being carried
 * further: every one of these four routes refuses the path before it reaches
 * `StorageService` or `send`, and the caller is told the same thing whichever
 * one they asked.
 */
function wildcardPath(req: Request): string {
  const raw: unknown = (req.params as Record<string, unknown>)['path'];
  const segments = Array.isArray(raw) ? raw.map((segment) => String(segment)) : String(raw ?? '');

  try {
    return joinContentFilePath(segments);
  } catch {
    throw new BadRequestException('The requested file path is not valid.');
  }
}
