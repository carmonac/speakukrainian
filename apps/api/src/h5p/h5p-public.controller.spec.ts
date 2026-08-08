import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { BadRequestException, HttpException } from '@nestjs/common';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { H5pPublicController } from './h5p-public.controller.js';
import type { ContentFileResult, H5pServeService, LibraryFileResult } from './h5p-serve.service.js';
import type { H5pAssetKind, H5pClientAssets } from './h5p.client-assets.js';
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
  reset: () => void;
  cleanup: () => Promise<void>;
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

  const assets = {
    isInstalled: (): Promise<boolean> => Promise.resolve(true),
    rootOf: (kind: H5pAssetKind): string => roots[kind],
  } as unknown as H5pClientAssets;

  const controller = new H5pPublicController(serve, assets);
  const app = express();

  app.get('/h5p/content/:contentId/*path', (req: Request, res: Response, next: NextFunction) => {
    controller.contentFile(named(req, 'contentId'), req, res).catch(next);
  });
  app.get('/h5p/libraries/:ubername/*path', (req: Request, res: Response, next: NextFunction) => {
    controller.libraryFile(named(req, 'ubername'), req, res).catch(next);
  });
  app.get('/h5p/core/*path', (req: Request, res: Response, next: NextFunction) => {
    controller.coreAsset(req, res).catch(next);
  });
  app.get('/h5p/editor-assets/*path', (req: Request, res: Response, next: NextFunction) => {
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
    reset: () => {
      asked.length = 0;
      escaped = undefined;
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

    it('never serves a dotfile out of the tree', async () => {
      const response = await request(harness.app).get('/h5p/core/.htpasswd');

      expect(response.status).toBe(404);
      expect(response.text).not.toContain(SECRET);
    });
  });
});
