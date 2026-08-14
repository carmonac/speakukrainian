import 'reflect-metadata';
import { BadRequestException, UnauthorizedException, type PipeTransform } from '@nestjs/common';
import {
  HTTP_CODE_METADATA,
  INTERCEPTORS_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants.js';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum.js';
import { describe, expect, it } from 'vitest';
import { MAX_H5P_UPLOAD_BYTES, h5pUploadTooLargeMessage } from '@speakukrainian/shared';
import type {
  H5pContent,
  H5pSaveResult,
  ListH5pContentQuery,
  Page,
  UserRole,
} from '@speakukrainian/shared';
import { IS_PUBLIC_KEY } from '../auth/public.decorator.js';
import type { AuthenticatedUser } from '../auth/firebase-auth.guard.js';
import { ROLES_KEY } from '../auth/roles.decorator.js';
import { UploadLimitInterceptor } from '../common/upload-limit.interceptor.js';
import { H5pController } from './h5p.controller.js';
import type { H5pService } from './h5p.service.js';

const SAVED: H5pSaveResult = {
  contentId: 'ff6c4a3a-4d1f-4f0f-9a4b-9d3b2f5a1c77',
  title: 'Present perfect drill',
  mainLibrary: 'H5P.MultiChoice 1.16',
};

const CALLER: AuthenticatedUser = { uid: 'editor-1', email: 'e@x.local', role: 'editor' };

const packageFile = (): Express.Multer.File =>
  ({ originalname: 'drill.h5p', path: '/tmp/uploads/abc' }) as Express.Multer.File;

const CONTENT: H5pContent = {
  id: SAVED.contentId,
  title: SAVED.title,
  mainLibrary: SAVED.mainLibrary,
  storagePath: `h5p/content/${SAVED.contentId}`,
  sizeBytes: 4096,
  pageId: null,
  audit: {
    createdAt: '2026-05-01T00:00:00.000Z',
    createdBy: 'editor-1',
    updatedAt: '2026-05-01T00:00:00.000Z',
    updatedBy: 'editor-1',
  },
};

const PAGE: Page<H5pContent> = { items: [CONTENT], nextCursor: 'next-id' };

const ATTACHED_PAGE_ID = 'a-page-id';

interface ServiceSpy {
  service: H5pService;
  calls: { file: Express.Multer.File; actorId: string }[];
  listed: ListH5pContentQuery[];
  read: string[];
  removed: string[];
  attached: { id: string; pageId: string; actorId: string }[];
  detached: { id: string; actorId: string }[];
}

function createServiceSpy(result: H5pSaveResult = SAVED): ServiceSpy {
  const calls: { file: Express.Multer.File; actorId: string }[] = [];
  const listed: ListH5pContentQuery[] = [];
  const read: string[] = [];
  const removed: string[] = [];
  const attached: { id: string; pageId: string; actorId: string }[] = [];
  const detached: { id: string; actorId: string }[] = [];
  const service = {
    importPackage: (file: Express.Multer.File, actorId: string): Promise<H5pSaveResult> => {
      calls.push({ file, actorId });
      return Promise.resolve(result);
    },
    list: (query: ListH5pContentQuery): Promise<Page<H5pContent>> => {
      listed.push(query);
      return Promise.resolve(PAGE);
    },
    findById: (id: string): Promise<H5pContent> => {
      read.push(id);
      return Promise.resolve(CONTENT);
    },
    remove: (id: string): Promise<void> => {
      removed.push(id);
      return Promise.resolve();
    },
    attachToPage: (id: string, pageId: string, actorId: string): Promise<H5pContent> => {
      attached.push({ id, pageId, actorId });
      return Promise.resolve({ ...CONTENT, pageId });
    },
    detachFromPage: (id: string, actorId: string): Promise<H5pContent> => {
      detached.push({ id, actorId });
      return Promise.resolve(CONTENT);
    },
  } as unknown as H5pService;

  return { service, calls, listed, read, removed, attached, detached };
}

describe('H5pController', () => {
  it('imports the package on behalf of the caller and answers with the result', async () => {
    const { service, calls } = createServiceSpy();
    const file = packageFile();

    const result = await new H5pController(service).upload(file, CALLER);

    expect(calls).toEqual([{ file, actorId: 'editor-1' }]);
    expect(result).toEqual(SAVED);
  });

  it('rejects a request with no file part and never reaches the service', async () => {
    const { service, calls } = createServiceSpy();

    await expect(new H5pController(service).upload(undefined, CALLER)).rejects.toThrow(
      BadRequestException,
    );
    expect(calls).toEqual([]);
  });

  it('refuses a request the guard somehow let through without a caller', async () => {
    const { service, calls } = createServiceSpy();

    await expect(new H5pController(service).upload(packageFile(), undefined)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(calls).toEqual([]);
  });

  it('refuses to answer with a result that does not satisfy h5pSaveResultSchema', async () => {
    const { service } = createServiceSpy({ ...SAVED, contentId: '' });

    await expect(new H5pController(service).upload(packageFile(), CALLER)).rejects.toThrow();
  });

  it('lists with the parsed query and answers with the page the service built', async () => {
    const { service, listed } = createServiceSpy();

    const page = await new H5pController(service).list({ limit: 10, cursor: 'abc' });

    expect(listed).toEqual([{ limit: 10, cursor: 'abc' }]);
    expect(page).toEqual(PAGE);
  });

  it('reads one content by id', async () => {
    const { service, read } = createServiceSpy();

    const content = await new H5pController(service).findOne(CONTENT.id);

    expect(read).toEqual([CONTENT.id]);
    expect(content).toEqual(CONTENT);
  });

  it('removes one content by id', async () => {
    const { service, removed } = createServiceSpy();

    await new H5pController(service).remove(CONTENT.id);

    expect(removed).toEqual([CONTENT.id]);
  });

  it('attaches on behalf of the caller and answers with the row that names the page', async () => {
    const { service, attached } = createServiceSpy();

    const content = await new H5pController(service).attach(
      CONTENT.id,
      { pageId: ATTACHED_PAGE_ID },
      CALLER,
    );

    expect(attached).toEqual([{ id: CONTENT.id, pageId: ATTACHED_PAGE_ID, actorId: 'editor-1' }]);
    expect(content.pageId).toBe(ATTACHED_PAGE_ID);
  });

  it('detaches on behalf of the caller and answers with the row', async () => {
    const { service, detached } = createServiceSpy();

    const content = await new H5pController(service).detach(CONTENT.id, CALLER);

    expect(detached).toEqual([{ id: CONTENT.id, actorId: 'editor-1' }]);
    expect(content.pageId).toBeNull();
  });

  it.each([
    ['attach', (controller: H5pController) => controller.attach(CONTENT.id, { pageId: 'p' })],
    ['detach', (controller: H5pController) => controller.detach(CONTENT.id)],
  ])('refuses a %s the guard somehow let through without a caller', async (_name, call) => {
    const { service, attached, detached } = createServiceSpy();

    await expect(call(new H5pController(service))).rejects.toThrow(UnauthorizedException);
    expect([...attached, ...detached]).toEqual([]);
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

/** A multer-backed `FileInterceptor` mixin, which holds its options on `multer`. */
interface FileInterceptorMixin {
  multer: MulterInstance;
}

/**
 * Instantiating the mixin is the only way to see which options `FileInterceptor`
 * was given: they are captured in its closure and reachable only through the
 * multer instance the constructor builds.
 */
function multerOf(entry: unknown): MulterInstance {
  if (typeof entry !== 'function') {
    throw new Error('expected a FileInterceptor mixin class, got ' + typeof entry);
  }
  const Mixin = entry as new () => FileInterceptorMixin;
  return new Mixin().multer;
}

/** Runs the route's own `fileFilter` over a filename. */
function accepts(instance: MulterInstance, originalname: string): boolean {
  const filter = instance.fileFilter;
  if (!filter) {
    throw new Error('the route was given multer options with no fileFilter');
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

/**
 * The pipes a handler's argument actually carries, read off the decorator
 * metadata: the unit config transforms with esbuild and emits no
 * `emitDecoratorMetadata`, so a Nest testing module cannot build this
 * controller. A body parameter carries no name, and its key is
 * `RouteParamtypes.BODY`.
 */
function paramPipesOf(handler: string, name?: string): PipeTransform<unknown, unknown>[] {
  const metadata = (Reflect.getMetadata(ROUTE_ARGS_METADATA, H5pController, handler) ??
    {}) as Record<string, { data?: unknown; pipes?: unknown[] }>;
  const parameter = Object.entries(metadata).find(([key, entry]) =>
    name === undefined ? key.startsWith(`${RouteParamtypes.BODY}:`) : entry.data === name,
  )?.[1];

  if (!parameter) {
    throw new Error(`${handler} has no ${name === undefined ? 'body' : `parameter named ${name}`}`);
  }
  return (parameter.pipes ?? []) as PipeTransform<unknown, unknown>[];
}

/** Runs an argument's pipes in order, as Nest does before calling the handler. */
function throughPipes(handler: string, name: string | undefined, value: unknown): unknown {
  const pipes = paramPipesOf(handler, name);
  if (pipes.length === 0) {
    throw new Error(`${handler} validates no ${name ?? 'body'} at all`);
  }

  return pipes.reduce<unknown>(
    (carried, pipe) =>
      pipe.transform(carried, { type: name === undefined ? 'body' : 'param', data: name }),
    value,
  );
}

describe('H5pController route metadata', () => {
  const handler = H5pController.prototype.upload;
  const interceptors = (): unknown[] =>
    (Reflect.getMetadata(INTERCEPTORS_METADATA, handler) as unknown[] | undefined) ?? [];

  const routes = [
    ['upload', H5pController.prototype.upload],
    ['list', H5pController.prototype.list],
    ['findOne', H5pController.prototype.findOne],
    ['attach', H5pController.prototype.attach],
    ['detach', H5pController.prototype.detach],
    ['remove', H5pController.prototype.remove],
  ] as const;

  // Rule 8 for the upload and the two page writes, and ADR-007 for the reads:
  // what protects H5P content is the unguessable id *plus the absence of any
  // public enumeration*, which is what lets the play and content-file routes be
  // `@Public()`. Moving `list` to the public controller, or dropping a
  // decorator, compiles — this is what refuses it.
  it.each(routes)('restricts %s to editors and above', (_name, route) => {
    expect(Reflect.getMetadata(ROLES_KEY, route) as UserRole[] | undefined).toEqual(['editor']);
  });

  it.each(routes)('does not mark %s public', (_name, route) => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, route)).toBeUndefined();
  });

  it('answers a delete with 204 rather than an empty 200', () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, H5pController.prototype.remove)).toBe(204);
  });

  it.each([
    ['attach', H5pController.prototype.attach],
    ['detach', H5pController.prototype.detach],
  ])('answers %s with 200, since it creates nothing', (_name, route) => {
    // `@Post` defaults to 201, which would tell a client something was created.
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, route)).toBe(200);
  });

  it('keeps the two page writes on verbs, away from the delete they sit beside', () => {
    // `DELETE content/:id/page` would be one dropped path segment from
    // `DELETE content/:id`, which destroys the exercise.
    expect(Reflect.getMetadata(PATH_METADATA, H5pController.prototype.attach)).toBe(
      'content/:id/attach',
    );
    expect(Reflect.getMetadata(PATH_METADATA, H5pController.prototype.detach)).toBe(
      'content/:id/detach',
    );
  });

  it.each([
    ['attach', H5pController.prototype.attach],
    ['detach', H5pController.prototype.detach],
  ])('installs no interceptor on %s', (_name, route) => {
    // `@H5pPackageUpload()` is one line away in the same file, and it would put
    // a multipart parser in front of a JSON route.
    expect(Reflect.getMetadata(INTERCEPTORS_METADATA, route)).toBeUndefined();
  });

  it('accepts an attach body that carries the page id and nothing else', () => {
    expect(throughPipes('attach', undefined, { pageId: 'abc-123' })).toEqual({ pageId: 'abc-123' });
  });

  it.each([
    ['no page id', {}],
    ['a null page id', { pageId: null }],
    ['a page id with a path segment', { pageId: '../other' }],
    ['a second field', { pageId: 'abc-123', title: 'hacked' }],
    ['the storage path', { pageId: 'abc-123', storagePath: 'h5p/elsewhere' }],
  ])('refuses an attach body carrying %s before the service is reached', (_shape, body) => {
    expect(() => throughPipes('attach', undefined, body)).toThrow(BadRequestException);
  });

  it.each([['attach'], ['detach']])('refuses an unsafe content id on %s', (route) => {
    expect(() => throughPipes(route, 'id', '../x')).toThrow(BadRequestException);
    expect(throughPipes(route, 'id', CONTENT.id)).toBe(CONTENT.id);
  });

  it('puts the limit interceptor ahead of multer with the H5P wording', () => {
    // Reversed, multer aborts the oversize upload before the interceptor is in
    // the chain and the 413 falls back to its bare `File too large`.
    const [limit, upload, ...rest] = interceptors();

    expect(limit).toBeInstanceOf(UploadLimitInterceptor);
    expect((limit as UploadLimitInterceptor).message).toBe(h5pUploadTooLargeMessage());
    expect(multerOf(upload).limits).toEqual({ fileSize: MAX_H5P_UPLOAD_BYTES, files: 1 });
    expect(rest).toEqual([]);
  });

  it('filters the route by the .h5p extension', () => {
    const multer = multerOf(interceptors()[1]);

    expect(accepts(multer, 'drill.h5p')).toBe(true);
    expect(accepts(multer, 'drill.zip')).toBe(false);
  });
});
