import type { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import { H5PAjaxEndpoint, H5PPlayer } from '@lumieducation/h5p-server';
import type { IPlayerModel, IUser } from '@lumieducation/h5p-server';
import { toHttpException } from './h5p.errors.js';
import { assertSafeContentId } from './h5p.paths.js';
import type { RangeCallback } from './h5p.responses.js';
import { H5P_AJAX_ENDPOINT, H5P_PLAYER } from './h5p.tokens.js';

/**
 * The reader every public route acts as.
 *
 * The library's permission system is `LaissezFairePermissionSystem`
 * (`h5p.module.ts`), so this object is threaded through to the storage
 * adapters and decides nothing. Authorization is the route's, and these routes
 * are deliberately public — see ADR-007 on what protects H5P content.
 */
const ANONYMOUS_USER: IUser = { id: 'anonymous', name: 'Anonymous', email: '', type: 'local' };

/** The language the player localizes its own chrome into when none is asked for. */
const DEFAULT_LANGUAGE = 'en';

export interface ContentFileResult {
  mimetype: string;
  /** Present only when the request carried a satisfiable `Range`. */
  range?: { start: number; end: number };
  /** The size of the whole object, whether or not a range was asked for. */
  totalLength: number;
  stream: Readable;
}

export interface LibraryFileResult {
  mimetype: string;
  contentLength: number;
  stream: Readable;
}

/**
 * The three library calls the public routes need, with their errors already
 * mapped onto HTTP.
 *
 * Controllers validate and delegate (CLAUDE.md), and the mapping belongs on
 * this side of that line: `toHttpException` returning `null` is the decision
 * that an error is *this server's* fault, which is a judgement about the
 * library's behaviour rather than about the request.
 */
@Injectable()
export class H5pServeService {
  constructor(
    @Inject(H5P_PLAYER) private readonly player: H5PPlayer,
    @Inject(H5P_AJAX_ENDPOINT) private readonly ajax: H5PAjaxEndpoint,
  ) {}

  /**
   * The player model for one exercise.
   *
   * `H5PPlayer.render` answers an unknown id with a 404 `H5pError` of its own,
   * so no existence check is needed here — but the id is asserted first anyway,
   * because a malformed one would otherwise surface as a 400 raised from three
   * layers down inside a path builder.
   */
  async playerModel(contentId: string, language = DEFAULT_LANGUAGE): Promise<IPlayerModel> {
    return this.mapErrors(async () => {
      assertSafeContentId(contentId);

      // `H5pModule` sets a renderer that returns the model itself; the stock
      // one returns an HTML page. `render` is typed `Promise<string | any>` for
      // that reason, and the cast is what the renderer choice buys back.
      const model = (await this.player.render(contentId, ANONYMOUS_USER, language)) as IPlayerModel;
      return model;
    });
  }

  async contentFile(
    contentId: string,
    filename: string,
    range: RangeCallback,
  ): Promise<ContentFileResult> {
    return this.mapErrors(async () => {
      assertSafeContentId(contentId);

      const file = await this.ajax.getContentFile(contentId, filename, ANONYMOUS_USER, range);

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

  async libraryFile(ubername: string, filename: string): Promise<LibraryFileResult> {
    return this.mapErrors(async () => {
      const file = await this.ajax.getLibraryFile(ubername, filename);

      return { mimetype: file.mimetype, contentLength: file.stats.size, stream: file.stream };
    });
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
