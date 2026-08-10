import 'reflect-metadata';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { HTTP_CODE_METADATA, INTERCEPTORS_METADATA } from '@nestjs/common/constants.js';
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

interface ServiceSpy {
  service: H5pService;
  calls: { file: Express.Multer.File; actorId: string }[];
  listed: ListH5pContentQuery[];
  read: string[];
  removed: string[];
}

function createServiceSpy(result: H5pSaveResult = SAVED): ServiceSpy {
  const calls: { file: Express.Multer.File; actorId: string }[] = [];
  const listed: ListH5pContentQuery[] = [];
  const read: string[] = [];
  const removed: string[] = [];
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
  } as unknown as H5pService;

  return { service, calls, listed, read, removed };
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

describe('H5pController route metadata', () => {
  const handler = H5pController.prototype.upload;
  const interceptors = (): unknown[] =>
    (Reflect.getMetadata(INTERCEPTORS_METADATA, handler) as unknown[] | undefined) ?? [];

  // Rule 8 for the upload, and ADR-007 for the other three: what protects H5P
  // content is the unguessable id *plus the absence of any public enumeration*,
  // which is what lets the play and content-file routes be `@Public()`. Moving
  // `list` to the public controller, or dropping a decorator, compiles — this
  // is what refuses it.
  it.each([
    ['upload', H5pController.prototype.upload],
    ['list', H5pController.prototype.list],
    ['findOne', H5pController.prototype.findOne],
    ['remove', H5pController.prototype.remove],
  ])('restricts %s to editors and above', (_name, route) => {
    expect(Reflect.getMetadata(ROLES_KEY, route) as UserRole[] | undefined).toEqual(['editor']);
  });

  it.each([
    ['upload', H5pController.prototype.upload],
    ['list', H5pController.prototype.list],
    ['findOne', H5pController.prototype.findOne],
    ['remove', H5pController.prototype.remove],
  ])('does not mark %s public', (_name, route) => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, route)).toBeUndefined();
  });

  it('answers a delete with 204 rather than an empty 200', () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, H5pController.prototype.remove)).toBe(204);
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
