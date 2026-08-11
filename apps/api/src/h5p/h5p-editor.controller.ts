import { rm } from 'node:fs/promises';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UploadedFiles,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { IUser } from '@lumieducation/h5p-server';
import type { Request, Response } from 'express';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/firebase-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import type { Env } from '../config/configuration.js';
import { H5pEditorService, type AjaxUpload } from './h5p-editor.service.js';
import {
  editorLanguage,
  editorLibraryVersion,
  editorMachineName,
  wildcardPath,
} from './h5p.request.js';
import { pipePartialStream, pipeWholeStream, rangeCallbackFor } from './h5p.responses.js';
import { H5pAjaxUpload } from './h5p.upload.decorator.js';
import { h5pUserFor } from './h5p.user.js';

/**
 * A temporary file belongs to one editor, lives about two hours and is
 * role-guarded, so no shared cache may ever hold one — and a browser holding a
 * stale copy under a name the next upload can reuse is worse than a second
 * request.
 */
const TEMP_FILE_CACHE_CONTROL = 'private, no-store';

/**
 * The H5P editor's ajax surface: the content-type and library data its
 * JavaScript asks for, the files an author uploads from inside it, and reading
 * those files back.
 *
 * **Every route here is `@Roles('editor')`, and that is a file boundary rather
 * than a decorator habit** — the mirror of `h5p-public.controller.ts`, where
 * every route is `@Public()`. Nothing here may be relaxed: ADR-007 makes the
 * absence of any public enumeration what lets the play and content-file routes
 * be public, and `POST /ajax?action=files` writes into this server's bucket.
 * The guards are pinned per route by the metadata block at the bottom of
 * `h5p-editor.controller.spec.ts`.
 *
 * **A known limitation of `temp-files`, for whoever writes #13.** After
 * `POST /ajax?action=files`, Joubel's client renders the preview as
 * `<img src="${integration.editor.filesPath}/<filename>">`, and a browser
 * subresource sends no `Authorization` header — so the just-uploaded image or
 * clip does not render inside the editor. `@Public()` is **not** the fix: the
 * URL carries no owner id, and a filename is unique only within an owner, so an
 * unauthenticated request cannot resolve which object it means and would have
 * to guess. The realistic fix is a custom `IUrlGenerator` whose
 * `temporaryFiles()` emits a short-lived per-user token that this route
 * verifies instead of the bearer header. ADR-007 records it.
 *
 * **Why `@Res()` on `temp-files`.** The same reason `h5p-public.controller.ts`
 * gives: a status and headers that depend on the request's `Range` cannot be
 * expressed by returning a value. That docblock has the full account.
 */
@ApiTags('h5p')
@ApiBearerAuth()
@Controller('h5p')
export class H5pEditorController {
  private readonly logger = new Logger(H5pEditorController.name);
  private readonly stallTimeoutMs: number;

  constructor(
    private readonly editor: H5pEditorService,
    config: ConfigService<Env, true>,
  ) {
    this.stallTimeoutMs = config.get('H5P_STREAM_STALL_TIMEOUT_MS', { infer: true });
  }

  /**
   * `content-type-cache` and `libraries`.
   *
   * **Every one of the four query parameters is judged here**, because the
   * route owns them and the library does not answer for them: an illegal
   * machine name, a non-numeric version and a malformed language code are all
   * plain `Error`s out of `LibraryName.validate` and `validateLanguageCode`,
   * which `toHttpException` correctly declines to map — so each is a 500 for a
   * query string the caller typed. The versions stay strings, which is what the
   * endpoint wants; what moves here is the refusal, not the parsing.
   */
  @Get('ajax')
  @Roles('editor')
  async ajaxGet(
    @Query('action') action?: string,
    @Query('machineName') machineName?: string,
    @Query('majorVersion') majorVersion?: string,
    @Query('minorVersion') minorVersion?: string,
    @Query('language') language?: string,
    @CurrentUser() caller?: AuthenticatedUser,
  ): Promise<unknown> {
    const user = callerOf(caller);

    return this.editor.getAjax(
      {
        action,
        machineName: editorMachineName(machineName),
        majorVersion: editorLibraryVersion(majorVersion),
        minorVersion: editorLibraryVersion(minorVersion),
        language: editorLanguage(language),
      },
      user,
    );
  }

  /**
   * `libraries`, `translations`, `files`, `filter` and `library-upload`.
   *
   * The two file parts are handed on as `{ mimetype, name, size, tempFilePath }`
   * with no `data`, so both `saveContentFile` and `uploadPackage` take their
   * path branch rather than holding a 100 MB package in memory.
   *
   * Multer does not clean up after a *successful* request, so both parts are
   * removed in a `finally` — caught and logged, never replacing the outcome, for
   * the same reason `H5pService.importPackage` gives: a save that succeeded must
   * not answer 500 because a `rm` did not.
   */
  @Post('ajax')
  @Roles('editor')
  // Nest answers a POST 201 by default, and four of the five actions here
  // create nothing at all — they are reads the H5P client happens to send as
  // POSTs because that is how its own client works. The library's endpoint
  // documentation says each of them must come back as 200.
  @HttpCode(HttpStatus.OK)
  @H5pAjaxUpload()
  async ajaxPost(
    @Query('action') action?: string,
    @Body() body?: unknown,
    @Query('language') language?: string,
    @UploadedFiles() files?: Record<string, Express.Multer.File[]>,
    @CurrentUser() caller?: AuthenticatedUser,
  ): Promise<unknown> {
    const user = callerOf(caller);
    const upload = uploadOf(files, 'file');
    const packageUpload = uploadOf(files, 'h5p');

    try {
      const result = await this.editor.postAjax(
        { action, body, language: editorLanguage(language), upload, packageUpload },
        user,
      );

      // After the answer is computed, never before it, and never awaited.
      void this.editor.maybeSweep();
      return result;
    } finally {
      await this.removeUploads([upload, packageUpload]);
    }
  }

  /**
   * One file out of the caller's own temporary storage.
   *
   * The owner is the authenticated caller and nothing in the URL, which is what
   * makes the same filename mean a different object for a different editor.
   */
  @Get('temp-files/*path')
  @Roles('editor')
  async temporaryFile(
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() caller?: AuthenticatedUser,
  ): Promise<void> {
    const user = callerOf(caller);
    const file = await this.editor.temporaryFile(
      wildcardPath(req),
      user,
      rangeCallbackFor(req, res),
    );

    if (file.range) {
      pipePartialStream(res, file.stream, {
        mimetype: file.mimetype,
        totalLength: file.totalLength,
        start: file.range.start,
        end: file.range.end,
        cacheControl: TEMP_FILE_CACHE_CONTROL,
        stallTimeoutMs: this.stallTimeoutMs,
      });
      return;
    }

    pipeWholeStream(res, file.stream, {
      mimetype: file.mimetype,
      contentLength: file.totalLength,
      cacheControl: TEMP_FILE_CACHE_CONTROL,
      stallTimeoutMs: this.stallTimeoutMs,
    });
  }

  private async removeUploads(uploads: (AjaxUpload | undefined)[]): Promise<void> {
    for (const upload of uploads) {
      if (!upload) {
        continue;
      }
      await rm(upload.tempFilePath, { force: true }).catch((error: unknown) =>
        this.logger.warn(
          `Could not remove the ajax upload at ${upload.tempFilePath}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }
}

/**
 * The H5P `IUser` for the verified caller.
 *
 * The global `FirebaseAuthGuard` makes the `undefined` branch unreachable; it
 * narrows a type `CurrentUser` cannot guarantee on its own, exactly as
 * `H5pController.upload` does.
 */
function callerOf(caller: AuthenticatedUser | undefined): IUser {
  if (!caller) {
    throw new UnauthorizedException();
  }
  return h5pUserFor(caller.uid, caller.email);
}

/** The one file multer wrote for a field, in the shape the endpoint asks for. */
function uploadOf(
  files: Record<string, Express.Multer.File[]> | undefined,
  field: string,
): AjaxUpload | undefined {
  const found = files?.[field]?.[0];
  if (!found) {
    return undefined;
  }

  return {
    mimetype: found.mimetype,
    name: found.originalname,
    size: found.size,
    tempFilePath: found.path,
  };
}
