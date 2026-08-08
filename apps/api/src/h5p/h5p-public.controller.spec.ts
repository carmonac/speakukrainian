import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { BadRequestException, HttpException, Logger } from '@nestjs/common';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { H5pPublicController } from './h5p-public.controller.js';
import type { ContentFileResult, H5pServeService, LibraryFileResult } from './h5p-serve.service.js';
import {
  missingAssetsMessage,
  type H5pAssetKind,
  type H5pClientAssets,
} from './h5p.client-assets.js';
import type { RangeCallback } from './h5p.responses.js';

/**
 * The four wildcard routes over a real Express app, with the layers below the
 * controller replaced by stubs that answer *anything* they are asked for.
 *
 * That is the point of the shape. `wildcardPath` is the only place the
 * traversal assert is wired into these routes, and every layer under it has a
 * guard of its own — the storage path builders raise their own 400 and
 * `send` refuses to leave its `root` — so a suite that exercises the whole
 * stack still passes with the controller's guard deleted. Stubs that would
 * happily serve a traversed path are what makes this file able to fail.
 *
 * Express rather than a hand-built request object because the decoding is half
 * the rule: Express 5 hands `*path` back as an array of already-decoded
 * segments, so `..%2f..%2fx` arrives *inside* one segment. And Express rather
 * than Nest's testing module because the unit config transforms with esbuild,
 * which emits no `emitDecoratorMetadata` for the injector to read
 * (`vitest.e2e.config.ts` says the same thing from the other side).
 */
const SECRET = 'THE-BYTES-OUTSIDE-THE-ROOT';

/** A clip whose every window differs from every other, so a range assertion means something. */
const CLIP = Buffer.from(Uint8Array.from({ length: 4096 }, (_value, index) => (index * 37) % 251));

interface Harness {
  app: express.Express;
  /** Everything the storage-backed layer was asked for, in order. */
  asked: () => string[];
  /** The exception the route let escape, which the global filter answers in the real app. */
  escaped: () => unknown;
  /** Whether the fetched client trees are on disk, which the asset routes check first. */
  setInstalled: (installed: boolean) => void;
  /**
   * Makes `res.sendFile` fail with a given error instead of reading the tree.
   *
   * A real `EACCES` would need a directory this process may not read, which is
   * not a state a test can create when it runs as root — and the mapping under
   * test is of `send`'s `status`, not of any particular syscall.
   */
  failAssetSendWith: (error: Error | null) => void;
  reset: () => void;
  cleanup: () => Promise<void>;
}

/** An error in the shape `send` raises, which carries the status it chose. */
function sendError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

async function createHarness(): Promise<Harness> {
  const base = await mkdtemp(join(tmpdir(), 'h5p-public-controller-'));
  const roots: Record<H5pAssetKind, string> = {
    core: join(base, 'core'),
    editor: join(base, 'editor'),
  };

  await mkdir(join(roots.core, 'js'), { recursive: true });
  await mkdir(roots.editor, { recursive: true });
  await writeFile(join(roots.core, 'js', 'h5p.js'), 'window.H5P = {};\n');
  await writeFile(join(roots.core, '.htpasswd'), SECRET);
  // One level above both roots, which is where a traversal out of them lands.
  await writeFile(join(base, 'outside.txt'), SECRET);

  const asked: string[] = [];
  let escaped: unknown;

  const serve = {
    contentFile: (
      contentId: string,
      filename: string,
      range: RangeCallback,
    ): Promise<ContentFileResult> => {
      asked.push(`content/${contentId}/${filename}`);
      const slice = range(CLIP.length);

      return Promise.resolve({
        mimetype: 'audio/mpeg',
        totalLength: CLIP.length,
        ...(slice ? { range: slice } : {}),
        stream: Readable.from([slice ? CLIP.subarray(slice.start, slice.end + 1) : CLIP]),
      });
    },
    libraryFile: (ubername: string, filename: string): Promise<LibraryFileResult> => {
      asked.push(`libraries/${ubername}/${filename}`);
      const body = Buffer.from(SECRET);

      return Promise.resolve({
        mimetype: 'application/javascript',
        contentLength: body.length,
        stream: Readable.from([body]),
      });
    },
  } as unknown as H5pServeService;

  let installed = true;
  let sendFailure: Error | null = null;

  const assets = {
    isInstalled: (): Promise<boolean> => Promise.resolve(installed),
    rootOf: (kind: H5pAssetKind): string => roots[kind],
  } as unknown as H5pClientAssets;

  /** Stands in for `send` failing on the tree itself rather than on the path asked for. */
  const withFailingSendFile = (res: Response): void => {
    if (!sendFailure) {
      return;
    }
    const failure = sendFailure;
    res.sendFile = ((_path: string, _options: unknown, callback: (error?: Error) => void) => {
      callback(failure);
    }) as unknown as Response['sendFile'];
  };

  const controller = new H5pPublicController(serve, assets);
  const app = express();

  app.get('/h5p/content/:contentId/*path', (req: Request, res: Response, next: NextFunction) => {
    controller.contentFile(named(req, 'contentId'), req, res).catch(next);
  });
  app.get('/h5p/libraries/:ubername/*path', (req: Request, res: Response, next: NextFunction) => {
    controller.libraryFile(named(req, 'ubername'), req, res).catch(next);
  });
  app.get('/h5p/core/*path', (req: Request, res: Response, next: NextFunction) => {
    withFailingSendFile(res);
    controller.coreAsset(req, res).catch(next);
  });
  app.get('/h5p/editor-assets/*path', (req: Request, res: Response, next: NextFunction) => {
    withFailingSendFile(res);
    controller.editorAsset(req, res).catch(next);
  });
  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    // Stands in for the global filter, which still answers anything raised
    // before the first byte goes out even though these routes hold `@Res()`.
    escaped = error;
    res.status(error instanceof HttpException ? error.getStatus() : 500).end();
  });

  return {
    app,
    asked: () => [...asked],
    escaped: () => escaped,
    setInstalled: (value: boolean) => {
      installed = value;
    },
    failAssetSendWith: (error: Error | null) => {
      sendFailure = error;
    },
    reset: () => {
      asked.length = 0;
      escaped = undefined;
      installed = true;
      sendFailure = null;
    },
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

/**
 * A named route parameter, which `@Param()` would hand the controller.
 *
 * Express 5 types every parameter as `string | string[]` because a wildcard is
 * an array; `:contentId` and `:ubername` are not wildcards and never are one.
 */
function named(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? value.join('/') : (value ?? '');
}

/** The message of the exception that escaped, or a failure saying what escaped instead. */
function escapedMessage(error: unknown): string {
  if (!(error instanceof HttpException)) {
    throw new Error(`Expected an HttpException to escape the route, got ${String(error)}.`);
  }
  return error.message;
}

describe('H5pPublicController', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  beforeEach(() => {
    harness.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('the traversal guard on every wildcard route', () => {
    it.each([
      ['a content file', '/h5p/content/abc/media/..%2f..%2fh5p.json'],
      ['a library file', '/h5p/libraries/H5P.Main-1.0/..%2f..%2fcontent%2Fh5p.json'],
      ['the core client', '/h5p/core/js/..%2f..%2foutside.txt'],
      ['the editor client', '/h5p/editor-assets/..%2f..%2foutside.txt'],
    ])('refuses %s whose path escapes its prefix', async (_route, path) => {
      const response = await request(harness.app).get(path);

      expect(response.status).toBe(400);
      // This sentence is the controller's alone: no layer below it produces
      // these words, so asserting the status would pass for a refusal that
      // happened somewhere else — which is the whole failure mode here.
      expect(harness.escaped()).toBeInstanceOf(BadRequestException);
      expect(escapedMessage(harness.escaped())).toBe('The requested file path is not valid.');
      // Refused *before* it reaches the storage layer, which is what the
      // acceptance criterion says and what the stubs above would otherwise
      // have served.
      expect(harness.asked()).toEqual([]);
      expect(response.text).not.toContain(SECRET);
    });

    it.each([
      // Every shape here is percent-encoded through the separator on purpose:
      // a bare `%2e%2e/` segment is a dot-segment to the URL parser in the HTTP
      // client, which resolves it away before the request is ever sent, so such
      // a case would assert nothing about this server.
      ['a doubly encoded dot-dot', '/h5p/content/abc/media/%2e%2e%2f%2e%2e%2fh5p.json'],
      ['a traversal spread over two segments', '/h5p/content/abc/media/..%2f../h5p.json'],
      ['a backslash separator', '/h5p/content/abc/media/..%5c..%5ch5p.json'],
      ['an absolute path', '/h5p/content/abc/%2fetc%2fpasswd'],
    ])('refuses %s', async (_shape, path) => {
      const response = await request(harness.app).get(path);

      expect(response.status).toBe(400);
      expect(escapedMessage(harness.escaped())).toBe('The requested file path is not valid.');
      expect(harness.asked()).toEqual([]);
    });

    it('serves an ordinary path, so the guard is not simply refusing everything', async () => {
      await request(harness.app).get('/h5p/content/abc/media/clip.mp3').expect(200);

      expect(harness.asked()).toEqual(['content/abc/media/clip.mp3']);
    });
  });

  describe('content files', () => {
    it('caches a whole file privately and briefly', async () => {
      const response = await request(harness.app)
        .get('/h5p/content/abc/media/clip.mp3')
        .expect(200);

      // A re-save replaces this object under the same URL, so a long TTL would
      // keep serving the previous clip; `private` also keeps a shared cache
      // from holding an exercise's media at all.
      expect(response.headers['cache-control']).toBe('private, max-age=300');
      expect(Buffer.from(response.body as Buffer)).toEqual(CLIP);
    });

    it('caches a byte range the same way', async () => {
      const response = await request(harness.app)
        .get('/h5p/content/abc/media/clip.mp3')
        .set('Range', 'bytes=100-199')
        .expect(206);

      expect(response.headers['cache-control']).toBe('private, max-age=300');
      expect(response.headers['content-range']).toBe(`bytes 100-199/${CLIP.length}`);
      expect(Buffer.from(response.body as Buffer)).toEqual(CLIP.subarray(100, 200));
    });
  });

  describe('the client asset routes', () => {
    it('serves a file out of the tree with an hour of caching', async () => {
      const response = await request(harness.app).get('/h5p/core/js/h5p.js').expect(200);

      // An hour rather than a year: these URLs are busted by
      // `?version=<h5pVersion>`, which is a constant of the library and not of
      // the commit we pin, so a long TTL outlives an upgrade.
      expect(response.headers['cache-control']).toBe('public, max-age=3600');
      expect(response.text).toContain('window.H5P');
    });

    it('never serves a dotfile out of the tree, and does not call it a server fault', async () => {
      const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      const response = await request(harness.app).get('/h5p/core/.htpasswd');

      expect(response.status).toBe(404);
      expect(response.text).not.toContain(SECRET);
      // `send` refuses this with a 403 and the route answers 404, which is a
      // decision about the request rather than an incident: logging it would
      // put a line in the log for every probe.
      expect(errors).not.toHaveBeenCalled();
    });

    it.each([
      ['core', '/h5p/core/js/h5p.js'],
      ['editor', '/h5p/editor-assets/scripts/h5peditor.js'],
    ] as const)('answers 503 for the %s tree when it was never fetched', async (kind, path) => {
      // A 404 per file sends whoever hits it looking for a wrong URL. This is a
      // server that was never finished installing, and only a status of its own
      // says so — `pnpm install` on a machine with no network leaves exactly
      // this state.
      harness.setInstalled(false);

      const response = await request(harness.app).get(path);

      expect(response.status).toBe(503);
      expect(escapedMessage(harness.escaped())).toBe(missingAssetsMessage(kind));
      expect(escapedMessage(harness.escaped())).toContain('pnpm h5p:fetch');
    });

    it('refuses a traversal before it checks whether the tree is there', async () => {
      // Otherwise a server missing its assets answers a probe with a 503, which
      // says more about this server than the probe deserves.
      harness.setInstalled(false);

      const response = await request(harness.app).get('/h5p/core/js/..%2f..%2foutside.txt');

      expect(response.status).toBe(400);
      expect(escapedMessage(harness.escaped())).toBe('The requested file path is not valid.');
    });

    it('answers 500 and logs when the tree itself cannot be read', async () => {
      // `send` blames the request for a missing file and a dotfile. Anything
      // else — a directory this process may not read, a disk error — is this
      // installation's fault, and reporting it as a 404 hides an outage behind
      // a message about a file that is actually there.
      const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      harness.failAssetSendWith(sendError('EACCES: permission denied', 500));

      const response = await request(harness.app).get('/h5p/core/js/h5p.js');

      const logged = errors.mock.calls.map(([message]) => String(message));
      expect(response.status).toBe(500);
      expect(escapedMessage(harness.escaped())).toContain('could not be read');
      expect(logged).toHaveLength(1);
      // The cause and the file, because neither alone is enough to act on.
      expect(logged[0]).toContain('EACCES: permission denied');
      expect(logged[0]).toContain('js/h5p.js');
    });

    it('answers 404 without logging when send refuses the request itself', async () => {
      const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      harness.failAssetSendWith(sendError('ENOENT: no such file or directory', 404));

      const response = await request(harness.app).get('/h5p/core/js/absent.js');

      expect(response.status).toBe(404);
      expect(errors).not.toHaveBeenCalled();
    });
  });
});
