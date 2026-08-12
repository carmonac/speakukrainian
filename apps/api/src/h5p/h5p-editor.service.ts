import type { Readable } from 'node:stream';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { H5PAjaxEndpoint, H5PEditor, H5pError, LibraryName } from '@lumieducation/h5p-server';
import type { ContentId, IContentMetadata, IEditorModel, IUser } from '@lumieducation/h5p-server';
import {
  h5pSaveResultSchema,
  type H5pContent,
  type H5pSaveResult,
  type SaveH5pContentInput,
} from '@speakukrainian/shared';
import { StorageService } from '../infra/storage/storage.service.js';
import { H5pContentRepository } from './h5p-content.repository.js';
import { H5pContentStorage } from './h5p-content.storage.js';
import { CONTENT_MISSING_MESSAGE, mapH5pErrors } from './h5p.errors.js';
import { assertSafeContentId, contentPrefix, contentStoragePath } from './h5p.paths.js';
import type { RangeCallback } from './h5p.responses.js';
import { mainLibraryUberName } from './h5p.service.js';
import { H5P_AJAX_ENDPOINT, H5P_EDITOR } from './h5p.tokens.js';
import { h5pUserFor } from './h5p.user.js';

/**
 * How often one instance may sweep expired temporary files.
 *
 * Exported so the spec can drive the clock past it explicitly rather than
 * depending on how long another test took.
 */
export const TEMP_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * The language `POST /ajax` and the editor model fall back to.
 *
 * `H5PEditor.listLibraryLanguageFiles` — the `translations` action — declares
 * `language` as required and hands it straight to `validateLanguageCode`, which
 * refuses `undefined` with a plain `Error` and therefore a 500. `getLibraryData`
 * on the GET side already defaults to `en` for itself, so defaulting here is the
 * same answer said one layer earlier rather than a new behaviour.
 *
 * `H5PEditor.render` defaults to `en` too, in its own signature; passing it
 * explicitly keeps one answer to "what language is this API's fallback" rather
 * than two that can drift, and it is the same default `H5pServeService` gives
 * the player.
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

/**
 * What `GET /editor` and `GET /editor/:contentId` answer with.
 *
 * **`Pick`, never `Omit<IEditorModel, 'urlGenerator'>`.** `H5PEditor.render`
 * returns a live `UrlGenerator` alongside the three fields below, and its only
 * serialisable own property is `config` — the whole `H5PConfig`, 41 keys and
 * 1.6 KB of this server's setup, including `maxFileSize`, `contentWhitelist`,
 * `libraryWhitelist`, `hubRegistrationEndpoint`, `siteType`, `uuid` and
 * `installLibraryLockMaxOccupationTime`. An `Omit` would keep admitting every
 * field a future version of the library adds, which is the same defect written
 * in the type system instead of in the response. A field is added here only by
 * naming it.
 */
export type EditorModelResponse = Pick<IEditorModel, 'integration' | 'scripts' | 'styles'>;

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
 * `{ h5p, library, params: { metadata, params } }` — named through the endpoint
 * for the same reason `GetAjaxResult` is, rather than re-declaring someone
 * else's response shape.
 */
export type ContentParametersResult = Awaited<ReturnType<H5PAjaxEndpoint['getContentParameters']>>;

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
 * belongs here for the same reason: what `mapH5pErrors` declines to map is the
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
    private readonly repository: H5pContentRepository,
    /** Only for rolling a failed create back; every read goes through the library. */
    private readonly contentStorage: H5pContentStorage,
    private readonly storage: StorageService,
  ) {}

  async getAjax(request: GetAjaxRequest, user: IUser): Promise<GetAjaxResult> {
    return mapH5pErrors(async () => {
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
    const result = await mapH5pErrors(async () => {
      assertAllowedAction(request.action, POST_AJAX_ACTIONS);

      if (request.action === 'library-upload' && !request.packageUpload) {
        // `postAjax` reads `libraryUploadFile.name` before anything else, so
        // without this the request is a `TypeError` and a 500 instead of the
        // 400 a missing part deserves.
        throw missingPart('h5p');
      }

      if (request.action === 'files' && !request.upload) {
        // The same defect one action over, and it survives the body being
        // well formed: `postAjax` validates and parses `field` and then hands
        // the missing part to `H5PEditor.saveContentFile`, which reads
        // `file.mimetype` unconditionally.
        throw missingPart('file');
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

    // After the answer is computed, never before it, and never awaited. This is
    // the commonest source of the garbage: an editor session abandoned after an
    // upload produces temp objects and no save at all.
    void this.maybeSweep();
    return result;
  }

  /**
   * What the H5P authoring widget boots from: the integration object, the core
   * scripts and the core styles, for an existing exercise or for a new one.
   *
   * `contentId` is `undefined` for content that has never been saved. The
   * library declares it as a plain `ContentId` and carries it through to
   * `integration.editor.nodeVersionId`, where `undefined` is exactly right —
   * the widget reads it as "this is new".
   *
   * The response is built by naming three fields; see `EditorModelResponse` for
   * what the fourth one carries and why it may never be spread in.
   */
  async editorModel(
    contentId: string | undefined,
    language: string | undefined,
    user: IUser,
  ): Promise<EditorModelResponse> {
    return mapH5pErrors(async () => {
      if (contentId !== undefined) {
        // The id becomes a storage prefix inside `generateIntegration`'s URLs
        // and inside every read the widget makes afterwards.
        assertSafeContentId(contentId);
      }

      // `h5p.module.ts` sets a renderer that returns the model itself; the
      // stock one returns an HTML page. `render` is typed `Promise<string |
      // any>` for that reason, and the cast is what the renderer choice buys
      // back — the same trade `H5pServeService.playerModel` makes.
      const model = (await this.editor.render(
        contentId as ContentId,
        language ?? DEFAULT_LANGUAGE,
        user,
      )) as IEditorModel;

      return { integration: model.integration, scripts: model.scripts, styles: model.styles };
    });
  }

  /**
   * The stored parameters of one exercise, in the shape a save posts back.
   *
   * **Who reads this, checked rather than assumed:** the *host page*. Joubel's
   * `h5peditor-init.js` takes the parameters from a hidden form field
   * (`new ns.Editor(library, $params.val(), …)`) and nothing under
   * `apps/api/h5p/editor/` or `core/` contains this URL at all. The only
   * reference to `UrlGenerator.parameters()` in the library is the default
   * editor renderer's own page, which this API replaces — so the consumer is
   * whatever renders the widget, which is #13's admin screen.
   *
   * The path matches `config.paramsUrl` (`/params`) under our `baseUrl`
   * anyway, which keeps a future `setRenderer` change honest.
   */
  async contentParameters(contentId: string, user: IUser): Promise<ContentParametersResult> {
    return mapH5pErrors(async () => {
      assertSafeContentId(contentId);

      return this.ajax.getContentParameters(contentId, user);
    });
  }

  /**
   * Stores what the widget edited, and brings the index row into line with it.
   *
   * `contentId` is `undefined` for an exercise that has never been saved; the
   * library assigns one, and this is the second route that creates an
   * `h5pContent` row (the first installs an uploaded package).
   *
   * **The index document is the authority for the 404**, exactly as
   * `H5pService.remove` argues. Without the check the library still refuses an
   * unknown id, but by accident of ordering and with a sentence about a missing
   * file — and `H5pContentStorage.addContent` will happily create content under
   * a caller-supplied id, so this is what stops a save from minting an exercise
   * at an id of the caller's choosing if that ordering ever changes.
   *
   * The size is recomputed from a listing rather than adjusted: a save copies
   * temporary files in and deletes the ones the parameters no longer reference,
   * so the stored total is wrong in both directions.
   */
  async save(
    contentId: string | undefined,
    input: SaveH5pContentInput,
    caller: { uid: string; email?: string },
  ): Promise<H5pSaveResult> {
    const user = h5pUserFor(caller.uid, caller.email);

    const saved = await mapH5pErrors(async () => {
      if (contentId !== undefined) {
        assertSafeContentId(contentId);
        if (!(await this.repository.exists(contentId))) {
          throw new NotFoundException(CONTENT_MISSING_MESSAGE);
        }
      }

      // `generateContentMetadata` reads `getLibrary(mainLibrary).machineName`
      // without checking that the library is there, so an ubername nobody
      // installed is a `TypeError` and a 500 for a value the caller sent.
      // `fromUberName` raises its own 400 for one that is merely malformed.
      const library = LibraryName.fromUberName(input.library, { useWhitespace: true });
      if (!(await this.editor.libraryManager.libraryExists(library))) {
        // The same answer `GET /ajax?action=libraries` gives for the same
        // condition, rather than a second sentence for one fact.
        throw new H5pError('library-not-found', { name: input.library }, 404);
      }

      const { id, metadata } = await this.editor.saveOrUpdateContentReturnMetaData(
        // Declared as a plain `ContentId`; the implementation documents
        // `undefined` as "content that has not been saved before" and assigns
        // an id for it.
        contentId as ContentId,
        input.params.params,
        // `IContentMetadata` describes the `h5p.json` `generateContentMetadata`
        // *produces* — `embedTypes`, `language`, `mainLibrary`,
        // `preloadedDependencies`, `defaultLanguage` and `license` all
        // required — not what a client may send: the library validates the
        // inbound direction against `save-metadata.json`, which requires only
        // `title`. One cast, here, for that difference; a second one anywhere
        // else means one of them is wrong.
        input.params.metadata as unknown as IContentMetadata,
        input.library,
        user,
      );

      const objects = await this.storage.list(contentPrefix(id));
      const sizeBytes = objects.reduce((total, object) => total + object.sizeBytes, 0);
      const mainLibrary = mainLibraryUberName(metadata);

      await this.index(
        contentId,
        { id, title: metadata.title, mainLibrary, sizeBytes },
        caller.uid,
      );

      return h5pSaveResultSchema.parse({ contentId: id, title: metadata.title, mainLibrary });
    });

    // A create deliberately leaves the temporary copies behind:
    // `ContentStorer.addOrUpdateContent` passes `deleteTemporaryFiles = isUpdate`.
    void this.maybeSweep();
    return saved;
  }

  /**
   * The `h5pContent` row for a save that has already written its objects.
   *
   * **The rollback is asymmetric, and getting it the wrong way round destroys
   * an exercise.** On a *create* the objects sit under an id nothing
   * references, no route can enumerate and no route can delete, so a failed
   * index write leaves garbage forever — the same case `H5pService.importPackage`
   * rolls back, for the same reason. On an *update* the row already names those
   * objects and the objects are the newer truth, so deleting them would throw
   * away a good exercise because an audit field could not be written; the
   * failure is logged with the id and rethrown instead.
   */
  private async index(
    contentId: string | undefined,
    row: { id: string; title: string; mainLibrary: string; sizeBytes: number },
    actorId: string,
  ): Promise<void> {
    if (contentId === undefined) {
      try {
        await this.repository.create(
          {
            id: row.id,
            title: row.title,
            mainLibrary: row.mainLibrary,
            storagePath: contentStoragePath(row.id),
            sizeBytes: row.sizeBytes,
            pageId: null,
          },
          actorId,
        );
      } catch (error) {
        this.logger.error(`Rolling back H5P content ${row.id} after a failed index write`);
        await this.contentStorage.deleteContent(row.id).catch(() => undefined);
        throw error;
      }
      return;
    }

    let updated: H5pContent | null;
    try {
      updated = await this.repository.update(
        row.id,
        { title: row.title, mainLibrary: row.mainLibrary, sizeBytes: row.sizeBytes },
        actorId,
      );
    } catch (error) {
      // The only line that tells an operator which exercise now has newer files
      // than its index row says.
      this.logger.error(
        `H5P content ${row.id} was saved but its index document was not updated: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }

    if (!updated) {
      // The row was removed between the existence check and this commit. The
      // objects stay: they are what a re-created row would have to point at.
      this.logger.error(`H5P content ${row.id} was saved but its index document no longer exists`);
      throw new NotFoundException(CONTENT_MISSING_MESSAGE);
    }
  }

  async temporaryFile(
    filename: string,
    user: IUser,
    range: RangeCallback,
  ): Promise<TemporaryFileResult> {
    return mapH5pErrors(async () => {
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
}

/**
 * A `POST /ajax` action that needs an uploaded part and did not get one.
 *
 * `malformed-request` rather than an id of this API's own, because that is the
 * library's own answer to a request it cannot use and it is what the same
 * request gets when the *body* is the part that is missing — one sentence for
 * one fact, whichever half of the request was left out.
 */
function missingPart(field: string): H5pError {
  return new H5pError(
    'malformed-request',
    { error: `the request must carry a file in the "${field}" field` },
    400,
  );
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
