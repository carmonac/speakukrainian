import { get as httpGet } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import type { Firestore } from '@google-cloud/firestore';
import type { Auth } from 'firebase-admin/auth';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { COLLECTIONS, h5pSaveResultSchema, type H5pSaveResult } from '@speakukrainian/shared';
import { FIRESTORE } from '../src/infra/firestore/firestore.tokens.js';
import { StorageService } from '../src/infra/storage/storage.service.js';
import type * as Emulator from './emulator.js';
import { MAIN_LIBRARY_DIR, MEDIA_FILE, buildH5pPackage } from './fixtures/h5p-package.js';
import { startStorageFaultProxy, type StorageFaultProxy } from './storage-fault-proxy.js';

/**
 * What the H5P read paths do when the bucket, rather than the request, is the
 * thing that is wrong.
 *
 * This file exists because nothing else in the suite makes storage fail. Every
 * other failure assertion drives a hand-made stream that emits an `Error`, and
 * the Cloud Storage client only produces that shape for the failures it does
 * *not* retry — so the two commonest real ones, a transient 5xx and a
 * connection that stops mid-body, were both unreachable from a test and both
 * were broken: the first killed the process outright, the second held the
 * response open for ever and logged nothing.
 *
 * A proxy in front of `fake-gcs-server` is the whole mechanism. It is the only
 * way to reach the SDK's own retry and abort handling, which is where both
 * defects lived.
 */
const CONTENT_PREFIX = 'h5p/content/';

/**
 * Short, so a stalled read is observable in seconds rather than in the thirty
 * this defaults to. `H5P_STREAM_STALL_TIMEOUT_MS` exists for exactly this.
 */
const STALL_TIMEOUT_MS = 1_200;

/** Big enough that a truncated body is unmistakably shorter than a whole one. */
const MEDIA_BYTES = Buffer.from(
  Uint8Array.from({ length: 512 * 1024 }, (_value, index) => (index * 37 + (index >> 8)) % 251),
);

/** What a client saw of a response, including how much of it arrived. */
interface RawOutcome {
  status: number;
  contentLength: number;
  received: number;
  /** True when the connection was broken before the body was complete. */
  aborted: boolean;
  elapsedMs: number;
}

describe('h5p serving when storage fails (e2e)', () => {
  let app: INestApplication;
  let auth: Auth;
  let storage: StorageService;
  let firestore: Firestore;
  let editor: Emulator.TestUser;
  let exercise: H5pSaveResult;
  let proxy: StorageFaultProxy;

  const server = (): ReturnType<INestApplication['getHttpServer']> => app.getHttpServer();
  const mediaUrl = (): string => `/api/h5p/content/${exercise.contentId}/${MEDIA_FILE}`;

  /**
   * The status a request came to rest on, or 0 for a connection the server
   * broke — so that "the client was answered" and "the client was told nothing"
   * are two results rather than one result and one timed-out test.
   */
  const settle = (path: string): Promise<number> =>
    request(server())
      .get(path)
      .then(
        (response) => response.status,
        () => 0,
      );

  /**
   * A request made without a client library, because the outcome under test is
   * one no client library reports faithfully: how many bytes arrived before the
   * connection was broken. Superagent turns that into a rejection with nothing
   * left to inspect, which would let "answered 500 immediately" and "half a body
   * and then a broken socket" look the same.
   */
  const rawGet = (path: string): Promise<RawOutcome> =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const { port } = app.getHttpServer().address() as AddressInfo;

      httpGet({ host: '127.0.0.1', port, path }, (response) => {
        let received = 0;
        response.on('data', (chunk: Buffer) => (received += chunk.length));
        const finish = (aborted: boolean) => (): void => {
          resolve({
            status: response.statusCode ?? 0,
            contentLength: Number(response.headers['content-length'] ?? 0),
            received,
            aborted,
            elapsedMs: Date.now() - started,
          });
        };
        response.on('end', finish(false));
        response.on('aborted', finish(true));
        response.on('error', finish(true));
      }).on('error', reject);
    });

  const captureErrors = (): (() => string[]) => {
    const spy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    return () => spy.mock.calls.map(([message]) => String(message));
  };

  const rejectionListeners: ((reason: unknown) => void)[] = [];

  /**
   * Every promise rejection nothing awaited, which is how the blocker showed
   * itself.
   *
   * The crash is not raised anywhere a request can catch it: the Cloud Storage
   * client pipes into a stream its own retry has just destroyed, from inside a
   * `then` callback, so it surfaces as an unhandled rejection. `node dist/main.js`
   * exits on one of those and takes every route with it. A test runner installs
   * a handler of its own and merely reports it, which is exactly why this has
   * to be asserted — otherwise the suite goes green over a defect that ends the
   * process in production.
   */
  const collectRejections = (): (() => string[]) => {
    const reasons: string[] = [];
    const onRejection = (reason: unknown): void => {
      reasons.push(reason instanceof Error ? reason.message : String(reason));
    };
    process.on('unhandledRejection', onRejection);
    rejectionListeners.push(onRejection);
    return () => [...reasons];
  };

  beforeAll(async () => {
    proxy = await startStorageFaultProxy(
      process.env['STORAGE_API_ENDPOINT'] ?? 'http://localhost:4443',
    );
    process.env['STORAGE_API_ENDPOINT'] = proxy.url;
    process.env['H5P_STREAM_STALL_TIMEOUT_MS'] = String(STALL_TIMEOUT_MS);

    // Imported here rather than at the top of the file, and that is the whole
    // reason this works: `ConfigModule.forRoot` reads and validates the
    // environment as `AppModule`'s decorator is *evaluated*, so anything
    // importing it — `emulator.ts` does — freezes the configuration at import
    // time. A static import would put both settings above out of reach and the
    // API would quietly talk to the real emulator instead of to the proxy.
    const emulator: typeof Emulator = await import('./emulator.js');

    // The exercise is uploaded from an app that is then thrown away, and that
    // is load-bearing rather than tidy. `File.save()` switches
    // `retryOptions.autoRetry` off on the Cloud Storage *client* for a write it
    // may not safely repeat, and restores it from a value it captured after
    // that same mutation — so a client that has written one object never
    // retries anything again. Reading through the same client would therefore
    // exercise a retry path that is switched off, which is not the state a
    // container serving these public read paths is in: it has written nothing,
    // and its reads retry. A second app gives the tests below that client.
    const uploader = await emulator.createTestApp();
    auth = emulator.authOf(uploader);
    editor = await emulator.signInAs(auth, 'editor');

    const response = await request(uploader.getHttpServer())
      .post('/api/h5p/content')
      .set('Authorization', `Bearer ${editor.idToken}`)
      .attach('file', await buildH5pPackage({ mediaBytes: MEDIA_BYTES }), {
        filename: 'drill.h5p',
        contentType: 'application/octet-stream',
      })
      .expect(201);
    exercise = h5pSaveResultSchema.parse(response.body);
    await uploader.close();

    app = await emulator.createTestApp();
    storage = app.get(StorageService);
    firestore = app.get<Firestore>(FIRESTORE);
  });

  afterEach(() => {
    proxy.inject({ kind: 'none' });
    vi.restoreAllMocks();
    for (const listener of rejectionListeners.splice(0)) {
      process.off('unhandledRejection', listener);
    }
  });

  afterAll(async () => {
    if (proxy) {
      proxy.inject({ kind: 'none' });
    }
    if (storage && exercise) {
      await storage.deleteByPrefix(`${CONTENT_PREFIX}${exercise.contentId}/`);
    }
    if (firestore && exercise) {
      await firestore.collection(COLLECTIONS.h5pContent).doc(exercise.contentId).delete();
    }
    if (editor) {
      await auth.deleteUser(editor.uid);
    }
    if (app) {
      await app.close();
    }
    if (proxy) {
      await proxy.close();
    }
  });

  it('serves the whole clip through the proxy when nothing is injected', async () => {
    // The control, and it is doing two jobs: it says the proxy is in the path
    // at all — without which every assertion below would pass for the wrong
    // reason — and it says an unfaulted read through it is byte-for-byte right.
    const response = await request(server()).get(mediaUrl()).expect(200);

    expect(Buffer.from(response.body as Buffer)).toEqual(MEDIA_BYTES);
    expect(proxy.mediaReads()).toBeGreaterThan(0);
  });

  describe('a 5xx on the object read', () => {
    // The retryable half of the failure space. The SDK answers it by destroying
    // the in-flight request stream and starting another attempt, and the
    // request library then pipes into that destroyed stream from inside an
    // event handler — an `ERR_STREAM_UNABLE_TO_PIPE` thrown where nothing can
    // catch it. Before the fix these two cases did not fail this suite, they
    // ended the process running it.
    it.each([503, 500])(
      'answers a content file with 500 rather than dying (%i)',
      async (status) => {
        const errors = captureErrors();
        const rejections = collectRejections();
        proxy.inject({ kind: 'status', status });

        const answered = await settle(mediaUrl());

        expect(rejections()).toEqual([]);
        expect(answered).toBe(500);
        // The fault really was the injected one and not some earlier refusal.
        expect(proxy.mediaReads()).toBeGreaterThan(0);
        expect(errors().join('\n')).toContain(MEDIA_FILE);
      },
    );

    it('answers a library file with 500 rather than dying', async () => {
      const errors = captureErrors();
      const rejections = collectRejections();
      proxy.inject({ kind: 'status', status: 503 });

      const answered = await settle(`/api/h5p/libraries/${MAIN_LIBRARY_DIR}/main.js`);

      expect(rejections()).toEqual([]);
      expect(answered).toBe(500);
      expect(proxy.mediaReads()).toBeGreaterThan(0);
      expect(errors().join('\n')).toContain('main.js');
    });

    it('does not retry the read, which is the mechanism that killed the process', async () => {
      // One attempt, not four. The SDK's stream retry is what destroys the
      // in-flight request and then pipes into it, so "how many reads reached
      // storage" is the difference between the crash and the answer above —
      // and asserting it keeps that from being switched back on unnoticed.
      captureErrors();
      proxy.inject({ kind: 'status', status: 503 });

      await settle(mediaUrl());

      expect(proxy.mediaReads()).toBe(1);
    });

    it('is still serving everything else afterwards', async () => {
      // The assertion that says "handled" and not merely "reported": a process
      // that died would fail here, and so would one whose Cloud Storage client
      // had been left in a bad state.
      captureErrors();
      proxy.inject({ kind: 'status', status: 503 });
      await settle(mediaUrl());

      proxy.inject({ kind: 'none' });
      await request(server()).get('/readyz').expect(200);
      const response = await request(server()).get(mediaUrl()).expect(200);
      expect(Buffer.from(response.body as Buffer)).toEqual(MEDIA_BYTES);
    });
  });

  describe('a connection that stops part way through the body', () => {
    it('breaks the response instead of holding it open, and says so', async () => {
      // The Cloud Storage client raises neither `error` nor `end` for this —
      // `node-fetch@2` swallows the premature close — so before the watchdog
      // the client waited until it gave up, with nothing in the log. A test
      // that hangs here is that defect.
      const errors = captureErrors();
      proxy.inject({ kind: 'truncate', bytes: 4096 });

      const outcome = await rawGet(mediaUrl());

      // 200 and a full `Content-Length` are already on the wire, so the only
      // signal left is the broken connection — and it has to arrive, rather
      // than the client being left to work it out for itself.
      expect(outcome.status).toBe(200);
      expect(outcome.contentLength).toBe(MEDIA_BYTES.length);
      expect(outcome.received).toBeGreaterThan(0);
      expect(outcome.received).toBeLessThan(MEDIA_BYTES.length);
      expect(outcome.aborted).toBe(true);
      expect(outcome.elapsedMs).toBeLessThan(STALL_TIMEOUT_MS * 8);
      expect(errors().join('\n')).toContain('truncated');
      expect(errors().join('\n')).toContain(MEDIA_FILE);
    });

    it('is still serving everything else afterwards', async () => {
      captureErrors();
      proxy.inject({ kind: 'truncate', bytes: 4096 });
      await settle(mediaUrl());

      proxy.inject({ kind: 'none' });
      await request(server()).get('/readyz').expect(200);
      await request(server()).get(mediaUrl()).expect(200);
    });
  });
});
