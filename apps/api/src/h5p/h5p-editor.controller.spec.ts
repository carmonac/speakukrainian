import 'reflect-metadata';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { BadRequestException, HttpException, UnauthorizedException } from '@nestjs/common';
import { HTTP_CODE_METADATA, INTERCEPTORS_METADATA } from '@nestjs/common/constants.js';
import type { ConfigService } from '@nestjs/config';
import type { IUser } from '@lumieducation/h5p-server';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_H5P_UPLOAD_BYTES,
  h5pEditorUploadTooLargeMessage,
  type UserRole,
} from '@speakukrainian/shared';
import type { AuthenticatedUser } from '../auth/firebase-auth.guard.js';
import { IS_PUBLIC_KEY } from '../auth/public.decorator.js';
import { ROLES_KEY } from '../auth/roles.decorator.js';
import { UploadLimitInterceptor } from '../common/upload-limit.interceptor.js';
import type { Env } from '../config/configuration.js';
import { H5pEditorController } from './h5p-editor.controller.js';
import type {
  GetAjaxRequest,
  H5pEditorService,
  PostAjaxRequest,
  TemporaryFileResult,
} from './h5p-editor.service.js';
import { toHttpException } from './h5p.errors.js';
import type { RangeCallback } from './h5p.responses.js';

const CALLER: AuthenticatedUser = { uid: 'editor000001', email: 'e@x.local', role: 'editor' };

/** A clip whose every window differs from every other, so a range assertion means something. */
const CLIP = Buffer.from(Uint8Array.from({ length: 4096 }, (_value, index) => (index * 37) % 251));

interface Recorded {
  gets: { request: GetAjaxRequest; user: IUser }[];
  posts: { request: PostAjaxRequest; user: IUser }[];
  temporaryFiles: string[];
  sweeps: number;
}

interface Stub {
  service: H5pEditorService;
  recorded: Recorded;
  /** Makes the next `postAjax` reject, so the upload cleanup can be checked on the failure path. */
  failNextPost: (error: Error) => void;
}

function createStub(): Stub {
  const recorded: Recorded = { gets: [], posts: [], temporaryFiles: [], sweeps: 0 };
  let postFailure: Error | null = null;

  const service = {
    getAjax: (ajaxRequest: GetAjaxRequest, user: IUser): Promise<unknown> => {
      recorded.gets.push({ request: ajaxRequest, user });
      return Promise.resolve({ answered: ajaxRequest.action });
    },
    postAjax: (ajaxRequest: PostAjaxRequest, user: IUser): Promise<unknown> => {
      recorded.posts.push({ request: ajaxRequest, user });
      if (postFailure) {
        const failure = postFailure;
        postFailure = null;
        return Promise.reject(failure);
      }
      return Promise.resolve({ answered: ajaxRequest.action });
    },
    temporaryFile: (
      filename: string,
      _user: IUser,
      range: RangeCallback,
    ): Promise<TemporaryFileResult> => {
      recorded.temporaryFiles.push(filename);

      // The real service maps the library's errors onto HTTP before they leave
      // it, and `rangeCallbackFor` throws its 416 from inside this call — so a
      // stub that skipped the mapping would answer 500 for a range the route
      // handles correctly in production.
      try {
        const slice = range(CLIP.length);

        return Promise.resolve({
          mimetype: 'audio/mpeg',
          totalLength: CLIP.length,
          ...(slice ? { range: slice } : {}),
          stream: Readable.from([slice ? CLIP.subarray(slice.start, slice.end + 1) : CLIP]),
        });
      } catch (error) {
        return Promise.reject(toHttpException(error) ?? error);
      }
    },
    maybeSweep: (): Promise<void> => {
      recorded.sweeps += 1;
      return Promise.resolve();
    },
  } as unknown as H5pEditorService;

  return {
    service,
    recorded,
    failNextPost: (error: Error) => {
      postFailure = error;
    },
  };
}

/** Long enough that no test here trips the stalled-read watchdog by accident. */
const config = { get: (): number => 60_000 } as unknown as ConfigService<Env, true>;

function createController(stub: Stub): H5pEditorController {
  return new H5pEditorController(stub.service, config);
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

describe('H5pEditorController', () => {
  let stub: Stub;
  let controller: H5pEditorController;

  beforeEach(() => {
    stub = createStub();
    controller = createController(stub);
  });

  describe('GET ajax', () => {
    it('threads the query through and acts as the authenticated caller', async () => {
      await controller.ajaxGet('libraries', 'H5P.MultiChoice', '1', '16', 'uk', CALLER);

      expect(stub.recorded.gets).toEqual([
        {
          request: {
            action: 'libraries',
            machineName: 'H5P.MultiChoice',
            majorVersion: '1',
            minorVersion: '16',
            language: 'uk',
          },
          // The owner of every temporary file this caller writes, so it may
          // never come from anywhere but the verified token.
          user: { id: CALLER.uid, email: CALLER.email, name: '', type: 'local' },
        },
      ]);
    });

    it.each([['not a code'], ['e'], ['english'], ['uk-'], ['../etc']])(
      'refuses the language %j with a 400 and never reaches the service',
      async (language) => {
        // `H5PEditor.validateLanguageCode` refuses these with a plain `Error`,
        // which the mapper correctly declines — so without this the caller gets
        // a 500 for a query parameter they typed.
        await expect(
          controller.ajaxGet('libraries', 'H5P.MultiChoice', '1', '16', language, CALLER),
        ).rejects.toThrow(BadRequestException);
        expect(stub.recorded.gets).toEqual([]);
      },
    );

    it.each([['en'], ['uk'], ['zh-hans'], ['pt-BR']])(
      'accepts the language %j',
      async (language) => {
        await controller.ajaxGet('libraries', 'H5P.MultiChoice', '1', '16', language, CALLER);

        expect(stub.recorded.gets[0]?.request.language).toBe(language);
      },
    );

    it.each([['../../etc'], ['H5P Multi Choice'], ['H5P.Multi/Choice'], ['']])(
      'refuses the machine name %j with a 400 and never reaches the service',
      async (machineName) => {
        // `LibraryName.validateMachineName` refuses these with a plain `Error`
        // — a 500 for a query string the caller typed. No traversal follows
        // from the first one, since `libraryPrefix` refuses it again, but the
        // status is wrong either way.
        await expect(
          controller.ajaxGet('libraries', machineName, '1', '16', 'en', CALLER),
        ).rejects.toThrow(BadRequestException);
        expect(stub.recorded.gets).toEqual([]);
      },
    );

    it.each([
      ['a non-numeric major', 'x', '16'],
      ['a non-numeric minor', '1', 'y'],
      ['an empty major', '', '16'],
      ['a word for a version', 'one', 'two'],
    ])('refuses %s with a 400 and never reaches the service', async (_shape, major, minor) => {
      // `LibraryName.validate` is where these are noticed, and it raises a
      // plain `Error`, which the mapper declines: a 500.
      await expect(
        controller.ajaxGet('libraries', 'H5P.MultiChoice', major, minor, 'en', CALLER),
      ).rejects.toThrow(BadRequestException);
      expect(stub.recorded.gets).toEqual([]);
    });

    it('refuses a machine name for an action that would have ignored it', async () => {
      // The choice recorded on `ajaxGet`, pinned so that "validate per action"
      // is a decision to revisit rather than a change nothing notices:
      // `getAjax` reads `machineName` only on its `libraries` branch, and
      // mirroring that branch structure here would put the library's internals
      // in this controller.
      await expect(
        controller.ajaxGet('content-type-cache', 'not valid', undefined, undefined, 'en', CALLER),
      ).rejects.toThrow(BadRequestException);
      expect(stub.recorded.gets).toEqual([]);
    });

    it('leaves an absent version to the endpoint, which names all three at once', async () => {
      // The library's own 400 for `libraries` with no versions is a better
      // answer than one this route invents, and it is the *invalid* version —
      // not the missing one — that was the 500.
      await controller.ajaxGet('libraries', 'H5P.MultiChoice', undefined, undefined, 'en', CALLER);

      expect(stub.recorded.gets[0]?.request).toMatchObject({
        machineName: 'H5P.MultiChoice',
        majorVersion: undefined,
        minorVersion: undefined,
      });
    });

    it('accepts the versions the endpoint accepts, unparsed', async () => {
      await controller.ajaxGet('libraries', 'H5P.MultiChoice', '1', '16', 'en', CALLER);

      expect(stub.recorded.gets[0]?.request.majorVersion).toBe('1');
      expect(stub.recorded.gets[0]?.request.minorVersion).toBe('16');
    });

    it('treats an absent language as none rather than as a bad one', async () => {
      await controller.ajaxGet('content-type-cache', undefined, undefined, undefined, '', CALLER);

      expect(stub.recorded.gets[0]?.request.language).toBeUndefined();
    });

    it('refuses a request the guard somehow let through without a caller', async () => {
      await expect(
        controller.ajaxGet('content-type-cache', undefined, undefined, undefined, undefined),
      ).rejects.toThrow(UnauthorizedException);
      expect(stub.recorded.gets).toEqual([]);
    });
  });

  describe('POST ajax', () => {
    let uploads: string;

    beforeAll(async () => {
      uploads = await mkdtemp(join(tmpdir(), 'h5p-ajax-uploads-'));
    });

    afterAll(async () => {
      await rm(uploads, { recursive: true, force: true });
    });

    const multerFile = async (
      fieldname: string,
      originalname: string,
      mimetype: string,
    ): Promise<Express.Multer.File> => {
      const path = join(uploads, `${fieldname}-${originalname}-${String(Date.now())}`);
      const body = Buffer.from(`the bytes of ${originalname}`);
      await writeFile(path, body);

      return {
        fieldname,
        originalname,
        encoding: '7bit',
        mimetype,
        size: body.length,
        destination: uploads,
        filename: path,
        path,
        buffer: Buffer.alloc(0),
        stream: Readable.from([]),
      };
    };

    it('hands the file part on as a path and no buffer, so a big upload is never held in memory', async () => {
      const file = await multerFile('file', 'clip.mp3', 'audio/mpeg');

      await controller.ajaxPost(
        'files',
        { field: '{"type":"audio"}' },
        'en',
        { file: [file] },
        CALLER,
      );

      const [post] = stub.recorded.posts;
      expect(post?.request.upload).toEqual({
        mimetype: 'audio/mpeg',
        name: 'clip.mp3',
        size: file.size,
        tempFilePath: file.path,
      });
      // `file.data?.length > 0` is false for `undefined`, which is what makes
      // the library read the path rather than a buffer.
      expect(post?.request.upload).not.toHaveProperty('data');
      expect(post?.request.packageUpload).toBeUndefined();
    });

    it('hands the h5p part on separately, since library-upload reads a different field', async () => {
      const packageFile = await multerFile('h5p', 'drill.h5p', 'application/zip');

      await controller.ajaxPost('library-upload', {}, 'en', { h5p: [packageFile] }, CALLER);

      const [post] = stub.recorded.posts;
      expect(post?.request.packageUpload?.name).toBe('drill.h5p');
      expect(post?.request.upload).toBeUndefined();
    });

    it('removes both uploads after a request that succeeded', async () => {
      // Multer does not clean up after a successful request, and the container
      // filesystem is not ours to litter.
      const file = await multerFile('file', 'clip.mp3', 'audio/mpeg');
      const packageFile = await multerFile('h5p', 'drill.h5p', 'application/zip');

      await controller.ajaxPost('files', {}, 'en', { file: [file], h5p: [packageFile] }, CALLER);

      expect(await exists(file.path)).toBe(false);
      expect(await exists(packageFile.path)).toBe(false);
    });

    it('removes the upload after a request that failed, without replacing the failure', async () => {
      const file = await multerFile('file', 'clip.mp3', 'audio/mpeg');
      stub.failNextPost(new BadRequestException('that file type is not allowed'));

      await expect(
        controller.ajaxPost('files', {}, 'en', { file: [file] }, CALLER),
      ).rejects.toThrow('that file type is not allowed');
      expect(await exists(file.path)).toBe(false);
    });

    it('does not let a missing temp file turn a successful upload into a 500', async () => {
      // `rm` is best-effort on purpose: an upload that was stored and answered
      // must not be reported as failed because a cleanup could not run.
      const file = await multerFile('file', 'clip.mp3', 'audio/mpeg');
      await rm(file.path);

      await expect(
        controller.ajaxPost('files', {}, 'en', { file: [file] }, CALLER),
      ).resolves.toEqual({ answered: 'files' });
    });

    it('sweeps expired temporary files after answering, not before', async () => {
      // `ContentStorer.addOrUpdateContent` leaves temp copies behind on create,
      // and Cloud Run scales to zero, so this route is one of the two places
      // where an instance is both alive and standing next to the garbage.
      await controller.ajaxPost('files', {}, 'en', {}, CALLER);

      expect(stub.recorded.sweeps).toBe(1);
    });

    it('does not sweep when the request failed', async () => {
      stub.failNextPost(new BadRequestException('nope'));

      await expect(controller.ajaxPost('files', {}, 'en', {}, CALLER)).rejects.toThrow();
      expect(stub.recorded.sweeps).toBe(0);
    });

    it('refuses an invalid language before the upload is handed on', async () => {
      const file = await multerFile('file', 'clip.mp3', 'audio/mpeg');

      await expect(
        controller.ajaxPost('files', {}, 'not a code', { file: [file] }, CALLER),
      ).rejects.toThrow(BadRequestException);
      expect(stub.recorded.posts).toEqual([]);
      // The cleanup still runs: the file is on disk either way.
      expect(await exists(file.path)).toBe(false);
    });

    it('refuses a request the guard somehow let through without a caller', async () => {
      await expect(controller.ajaxPost('files', {}, 'en', {}, undefined)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(stub.recorded.posts).toEqual([]);
    });
  });
});

/**
 * `temp-files` over a real Express app, with the service replaced by a stub that
 * answers *anything* it is asked for.
 *
 * The same shape and the same reason as `h5p-public.controller.spec.ts`: the
 * layers below have traversal guards of their own, so a suite running the whole
 * stack still passes with the controller's guard deleted. A stub that would
 * happily serve a traversed path is what makes this able to fail. Express
 * rather than a hand-built request because the decoding is half the rule —
 * Express 5 hands `*path` back as already-decoded segments, so `..%2f..%2fx`
 * arrives inside one of them.
 */
describe('H5pEditorController temp-files', () => {
  let stub: Stub;
  let app: express.Express;
  let escaped: unknown;

  beforeEach(() => {
    stub = createStub();
    const controller = createController(stub);
    escaped = undefined;

    app = express();
    app.get('/h5p/temp-files/*path', (req: Request, res: Response, next: NextFunction) => {
      controller.temporaryFile(req, res, CALLER).catch(next);
    });
    app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
      escaped = error;
      res.status(error instanceof HttpException ? error.getStatus() : 500).end();
    });
  });

  afterEach(() => {
    escaped = undefined;
  });

  const escapedMessage = (): string => {
    if (!(escaped instanceof HttpException)) {
      throw new Error(`Expected an HttpException to escape the route, got ${String(escaped)}.`);
    }
    return escaped.message;
  };

  it.each([
    ['a traversal inside one decoded segment', '/h5p/temp-files/images/..%2f..%2fh5p.json'],
    ['a doubly encoded dot-dot', '/h5p/temp-files/%2e%2e%2f%2e%2e%2fh5p.json'],
    ['a backslash separator', '/h5p/temp-files/images/..%5c..%5ch5p.json'],
    ['an absolute path', '/h5p/temp-files/%2fetc%2fpasswd'],
  ])('refuses %s before it reaches the service', async (_shape, path) => {
    const response = await request(app).get(path);

    expect(response.status).toBe(400);
    // This sentence is the controller's alone; asserting the status would pass
    // for a refusal that happened somewhere else.
    expect(escapedMessage()).toBe('The requested file path is not valid.');
    expect(stub.recorded.temporaryFiles).toEqual([]);
  });

  it('serves an ordinary path, so the guard is not simply refusing everything', async () => {
    const response = await request(app)
      .get('/h5p/temp-files/images/image-aB34xQz9.png')
      .expect(200);

    expect(stub.recorded.temporaryFiles).toEqual(['images/image-aB34xQz9.png']);
    expect(Buffer.from(response.body as Buffer)).toEqual(CLIP);
  });

  it('offers ranges and refuses to let any cache keep the file', async () => {
    const response = await request(app).get('/h5p/temp-files/audios/audio.mp3').expect(200);

    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(response.headers['content-length']).toBe(String(CLIP.length));
    // Per-user, short-lived and role-guarded: a shared cache must never hold
    // one, and a browser holding a stale copy under a name the next upload can
    // reuse is worse than a second request.
    expect(response.headers['cache-control']).toBe('private, no-store');
  });

  it('answers a byte range with 206 and exactly those bytes', async () => {
    const response = await request(app)
      .get('/h5p/temp-files/audios/audio.mp3')
      .set('Range', 'bytes=100-199')
      .expect(206);

    expect(response.headers['content-range']).toBe(`bytes 100-199/${String(CLIP.length)}`);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(Buffer.from(response.body as Buffer)).toEqual(CLIP.subarray(100, 200));
  });

  it('answers a range past the end with 416 and the real size', async () => {
    const response = await request(app)
      .get('/h5p/temp-files/audios/audio.mp3')
      .set('Range', `bytes=${String(CLIP.length + 10)}-${String(CLIP.length + 20)}`);

    expect(response.status).toBe(416);
    expect(response.headers['content-range']).toBe(`bytes */${String(CLIP.length)}`);
  });
});

interface MulterInstance {
  limits?: { fileSize?: number; files?: number };
  fileFilter?: (
    request: unknown,
    file: { originalname: string },
    callback: (error: Error | null, acceptFile: boolean) => void,
  ) => void;
}

/** A multer-backed interceptor mixin, which holds its options on `multer`. */
interface FileInterceptorMixin {
  multer: MulterInstance;
}

/**
 * Instantiating the mixin is the only way to see which options the interceptor
 * was given: they are captured in its closure and reachable only through the
 * multer instance the constructor builds.
 */
function multerOf(entry: unknown): MulterInstance {
  if (typeof entry !== 'function') {
    throw new Error('expected a FileFieldsInterceptor mixin class, got ' + typeof entry);
  }
  const Mixin = entry as new () => FileInterceptorMixin;
  return new Mixin().multer;
}

/** Runs the route's own `fileFilter` over a filename, as `h5p.controller.spec.ts` does. */
function accepts(instance: MulterInstance, originalname: string): boolean {
  const filter = instance.fileFilter;
  if (!filter) {
    throw new Error('the route was given multer options with no fileFilter at all');
  }

  let outcome: boolean | undefined;
  filter(null, { originalname }, (error, acceptFile) => {
    outcome = error === null && acceptFile;
  });
  if (outcome === undefined) {
    throw new Error(`fileFilter never called back for ${originalname}`);
  }
  return outcome;
}

describe('H5pEditorController route metadata', () => {
  const routes = [
    ['ajaxGet', H5pEditorController.prototype.ajaxGet],
    ['ajaxPost', H5pEditorController.prototype.ajaxPost],
    ['temporaryFile', H5pEditorController.prototype.temporaryFile],
  ] as const;

  // The file boundary, pinned. `temp-files` is the one a future contributor is
  // most likely to relax to `@Public()`, because that looks like a fix for the
  // editor's own `<img>` preview — and it is not: the URL carries no owner id,
  // so an unauthenticated request cannot resolve which object it means, and the
  // filename is unique only within an owner. This is the test that refuses it.
  it.each(routes)('restricts %s to editors and above', (_name, route) => {
    expect(Reflect.getMetadata(ROLES_KEY, route) as UserRole[] | undefined).toEqual(['editor']);
  });

  it.each(routes)('does not mark %s public', (_name, route) => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, route)).toBeUndefined();
  });

  it('puts the limit interceptor ahead of multer with the editor wording', () => {
    // Reversed, multer aborts the oversize upload before the interceptor is in
    // the chain and the 413 falls back to its bare `File too large`.
    const [limit, upload, ...rest] =
      (Reflect.getMetadata(INTERCEPTORS_METADATA, H5pEditorController.prototype.ajaxPost) as
        unknown[] | undefined) ?? [];

    expect(limit).toBeInstanceOf(UploadLimitInterceptor);
    expect((limit as UploadLimitInterceptor).message).toBe(h5pEditorUploadTooLargeMessage());
    expect(multerOf(upload).limits).toEqual({ fileSize: MAX_H5P_UPLOAD_BYTES, files: 1 });
    expect(rest).toEqual([]);
  });

  it('installs no filter of its own, because the gate here is per action', () => {
    // `action=files` is gated by `config.contentWhitelist` and
    // `action=library-upload` by the `.h5p` extension, both inside the library.
    // A filter here could only be one of the two, and would refuse whatever the
    // other action legitimately accepts — including the `.h5p` the package
    // route insists on and the `.png` it refuses.
    const multer = multerOf(
      (
        Reflect.getMetadata(INTERCEPTORS_METADATA, H5pEditorController.prototype.ajaxPost) as
          unknown[] | undefined
      )?.[1],
    );

    expect(accepts(multer, 'clip.png')).toBe(true);
    expect(accepts(multer, 'drill.h5p')).toBe(true);
  });

  it('answers the ajax POST 200, since four of its five actions create nothing', () => {
    // Nest's default is 201. The library's endpoint documentation says each of
    // these must come back as 200, and `libraries`, `translations`, `filter`
    // and `library-upload` are reads the H5P client happens to send as POSTs.
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, H5pEditorController.prototype.ajaxPost)).toBe(
      200,
    );
  });

  it('installs no upload interceptor on the two routes that take no file', () => {
    expect(
      Reflect.getMetadata(INTERCEPTORS_METADATA, H5pEditorController.prototype.ajaxGet),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(INTERCEPTORS_METADATA, H5pEditorController.prototype.temporaryFile),
    ).toBeUndefined();
  });
});
