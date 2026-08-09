import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Storage } from '@google-cloud/storage';
import type { Auth } from 'firebase-admin/auth';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_IMAGE_UPLOAD_BYTES,
  assetRefSchema,
  contentDoesNotMatchMessage,
  uploadTooLargeMessage,
  type AssetRef,
} from '@speakukrainian/shared';
import type { Env } from '../src/config/configuration.js';
import { CLOUD_STORAGE } from '../src/infra/storage/storage.tokens.js';
import { StorageService } from '../src/infra/storage/storage.service.js';
import { authOf, createTestApp, signInAs, type TestUser } from './emulator.js';

// Real signatures: the API decides what a file is from these, so a fixture
// that is not the format it claims is refused rather than stored.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const MP3 = Buffer.from('494433030000000000004142434445', 'hex');
// Same ID3v2 header, different payload — a second valid MP3 that is not the
// first one's bytes.
const OTHER_MP3 = Buffer.from('4944330300000000000046474849', 'hex');
const TEXT = Buffer.from('this is a text file that was renamed');
// The same text saved as "Unicode", so it opens on the UTF-16LE BOM `FF FE`.
const UTF16_TEXT = Buffer.concat([
  Buffer.from([0xff, 0xfe]),
  Buffer.from('this is a text file that was renamed', 'utf16le'),
]);

interface ErrorBody {
  statusCode: number;
  message: string;
}

describe('media (e2e)', () => {
  let app: INestApplication;
  let auth: Auth;
  let storage: StorageService;
  let client: Storage;
  let bucketName: string;
  let editor: TestUser;
  let student: TestUser;

  // Everything written by this suite, removed in teardown so repeated local
  // runs do not fill `docker/storage/data/`.
  const uploadedPaths: string[] = [];

  const server = (): ReturnType<INestApplication['getHttpServer']> => app.getHttpServer();

  const currentMonthPrefix = (kind: 'images' | 'audio'): string => {
    const now = new Date();
    return `${kind}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/`;
  };

  const countObjects = async (prefix: string): Promise<number> => {
    const [files] = await client.bucket(bucketName).getFiles({ prefix });
    return files.length;
  };

  const upload = async (
    kind: 'image' | 'audio',
    body: Buffer,
    filename: string,
    contentType: string,
  ): Promise<AssetRef> => {
    const response = await request(server())
      .post(`/api/media/${kind}`)
      .set('Authorization', `Bearer ${editor.idToken}`)
      .attach('file', body, { filename, contentType })
      .expect(201);

    const asset = assetRefSchema.parse(response.body);
    uploadedPaths.push(asset.path);
    return asset;
  };

  beforeAll(async () => {
    app = await createTestApp();
    auth = authOf(app);
    storage = app.get(StorageService);
    client = app.get<Storage>(CLOUD_STORAGE);
    bucketName = app
      .get<ConfigService<Env, true>>(ConfigService)
      .get('STORAGE_BUCKET', { infer: true });
    [editor, student] = await Promise.all([signInAs(auth, 'editor'), signInAs(auth, 'student')]);
  });

  afterAll(async () => {
    if (storage) {
      await Promise.all(uploadedPaths.map((path) => storage.delete(path)));
    }
    const created = [editor, student].filter((user) => user !== undefined);
    await Promise.all(created.map((user) => auth.deleteUser(user.uid)));
    if (app) {
      await app.close();
    }
  });

  it('stores an image and serves it back from the returned url', async () => {
    const asset = await upload('image', PNG, 'diagram.png', 'image/png');

    expect(asset.path).toMatch(/^images\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/);
    expect(asset.contentType).toBe('image/png');
    expect(asset.sizeBytes).toBe(PNG.length);
    await expect(storage.exists(asset.path)).resolves.toBe(true);

    // The url has to be fetchable as-is: this is what the editor puts in
    // `<img src>`, and it is what breaks if `publicUrl` is "corrected" to the
    // bucket-path form fake-gcs-server does not serve.
    const served = await fetch(asset.url);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toContain('image/png');
    expect(Buffer.from(await served.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('stores audio under its own prefix and serves it with its content type', async () => {
    const asset = await upload('audio', MP3, 'intro.mp3', 'audio/mpeg');

    expect(asset.path).toMatch(/^audio\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.mp3$/);
    await expect(storage.exists(asset.path)).resolves.toBe(true);

    const served = await fetch(asset.url);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toContain('audio/mpeg');
    expect(Buffer.from(await served.arrayBuffer()).equals(MP3)).toBe(true);
  });

  it('keeps both objects when the same filename is uploaded twice', async () => {
    const first = await upload('audio', MP3, 'intro.mp3', 'audio/mpeg');
    const second = await upload('audio', OTHER_MP3, 'intro.mp3', 'audio/mpeg');

    expect(first.path).not.toBe(second.path);
    await expect(storage.exists(first.path)).resolves.toBe(true);
    await expect(storage.exists(second.path)).resolves.toBe(true);
    // The second upload must not have overwritten the first one's bytes.
    const servedFirst = await fetch(first.url);
    expect(Buffer.from(await servedFirst.arrayBuffer()).equals(MP3)).toBe(true);
  });

  it('rejects a part whose declared content type is not on the allow-list', async () => {
    const prefix = currentMonthPrefix('audio');
    const before = await countObjects(prefix);

    const response = await request(server())
      .post('/api/media/audio')
      .set('Authorization', `Bearer ${editor.idToken}`)
      .attach('file', Buffer.from('this is text'), {
        filename: 'not-audio.mp3',
        contentType: 'text/plain',
      })
      .expect(415);

    const body = response.body as ErrorBody;
    expect(body.statusCode).toBe(415);
    expect(body.message).toContain('text/plain');
    // The filter runs before the storage engine, so a refused part must leave
    // the bucket exactly as it was.
    await expect(countObjects(prefix)).resolves.toBe(before);
  });

  it('rejects a text file renamed to .mp3 with 415 and writes nothing', async () => {
    // The issue's own reproduction, minus the browser: a renamed file is
    // declared `audio/mpeg` and only its bytes say otherwise.
    const prefix = currentMonthPrefix('audio');
    const before = await countObjects(prefix);

    const response = await request(server())
      .post('/api/media/audio')
      .set('Authorization', `Bearer ${editor.idToken}`)
      .attach('file', TEXT, { filename: 'notes.mp3', contentType: 'audio/mpeg' })
      .expect(415);

    const body = response.body as ErrorBody;
    expect(body.statusCode).toBe(415);
    // The admin renders this message verbatim, so it has to tell an author
    // what to do about it.
    expect(body.message).toBe(contentDoesNotMatchMessage('audio', 'audio/mpeg'));
    await expect(countObjects(prefix)).resolves.toBe(before);
  });

  it('rejects a UTF-16 text file renamed to .mp3 with 415 and writes nothing', async () => {
    // A `.txt` saved with the encoding Notepad calls "Unicode" opens on `FF FE`,
    // which satisfies an MP3 frame sync on its own — this file was stored until
    // the rest of the frame header was decoded.
    const prefix = currentMonthPrefix('audio');
    const before = await countObjects(prefix);

    const response = await request(server())
      .post('/api/media/audio')
      .set('Authorization', `Bearer ${editor.idToken}`)
      .attach('file', UTF16_TEXT, { filename: 'notes.mp3', contentType: 'audio/mpeg' })
      .expect(415);

    const body = response.body as ErrorBody;
    expect(body.message).toBe(contentDoesNotMatchMessage('audio', 'audio/mpeg'));
    await expect(countObjects(prefix)).resolves.toBe(before);
  });

  it('rejects PNG bytes declared as audio with 415 and writes nothing', async () => {
    // Proves the check reads the bytes rather than the filename: this one is
    // named `.mp3`, declared `audio/mpeg`, and is a valid image.
    const prefix = currentMonthPrefix('audio');
    const before = await countObjects(prefix);

    await request(server())
      .post('/api/media/audio')
      .set('Authorization', `Bearer ${editor.idToken}`)
      .attach('file', PNG, { filename: 'clip.mp3', contentType: 'audio/mpeg' })
      .expect(415);

    await expect(countObjects(prefix)).resolves.toBe(before);
  });

  it('rejects MP3 bytes declared as an image with 415 and writes nothing', async () => {
    const prefix = currentMonthPrefix('images');
    const before = await countObjects(prefix);

    await request(server())
      .post('/api/media/image')
      .set('Authorization', `Bearer ${editor.idToken}`)
      .attach('file', MP3, { filename: 'diagram.png', contentType: 'image/png' })
      .expect(415);

    await expect(countObjects(prefix)).resolves.toBe(before);
  });

  it('rejects an oversize upload with 413 naming the limit and writes nothing', async () => {
    const prefix = currentMonthPrefix('images');
    const before = await countObjects(prefix);

    const response = await request(server())
      .post('/api/media/image')
      .set('Authorization', `Bearer ${editor.idToken}`)
      // All zeros, which no byte check would accept — but `limits.fileSize`
      // aborts the part mid-stream and the handler never runs, so this stays a
      // 413 rather than becoming a 415.
      .attach('file', Buffer.alloc(MAX_IMAGE_UPLOAD_BYTES + 1), {
        filename: 'huge.png',
        contentType: 'image/png',
      })
      .expect(413);

    // Pinned: multer's LIMIT_FILE_SIZE takes Nest's HttpException path, so the
    // response carries the normal error envelope rather than a bare 413.
    const body = response.body as ErrorBody;
    expect(body.statusCode).toBe(413);
    // Not multer's bare `File too large`: a caller that skipped the admin's
    // pre-check still has to be told what the limit is.
    expect(body.message).toBe(uploadTooLargeMessage('image'));
    await expect(countObjects(prefix)).resolves.toBe(before);
  });

  it('answers 400 when the request carries no file part', async () => {
    await request(server())
      .post('/api/media/image')
      .set('Authorization', `Bearer ${editor.idToken}`)
      .field('file', 'not-a-file')
      .expect(400);
  });

  it('answers 400 for a JSON body instead of a multipart upload', async () => {
    const response = await request(server())
      .post('/api/media/image')
      .set('Authorization', `Bearer ${editor.idToken}`)
      .send({ file: 'https://example.com/diagram.png' })
      .expect(400);

    // Multer skips a non-multipart request entirely, so the handler decides.
    expect((response.body as ErrorBody).message).toContain('file');
  });

  it('refuses a second file part rather than picking one', async () => {
    const prefix = currentMonthPrefix('images');
    const before = await countObjects(prefix);

    const response = await request(server())
      .post('/api/media/image')
      .set('Authorization', `Bearer ${editor.idToken}`)
      .attach('file', PNG, { filename: 'first.png', contentType: 'image/png' })
      .attach('file', PNG, { filename: 'second.png', contentType: 'image/png' })
      .expect(400);

    // `limits.files: 1` is what produces this; without it the route would
    // silently keep one of the two.
    expect((response.body as ErrorBody).message).toBe('Too many files');
    await expect(countObjects(prefix)).resolves.toBe(before);
  });

  it('refuses a file sent under a field name other than "file"', async () => {
    const response = await request(server())
      .post('/api/media/image')
      .set('Authorization', `Bearer ${editor.idToken}`)
      .attach('upload', PNG, { filename: 'diagram.png', contentType: 'image/png' })
      .expect(400);

    // The field name is part of the contract with `ApiService.upload`.
    expect((response.body as ErrorBody).message).toBe('Unexpected field - upload');
  });

  it('refuses an upload without a token', async () => {
    await request(server())
      .post('/api/media/image')
      .attach('file', PNG, { filename: 'diagram.png', contentType: 'image/png' })
      .expect(401);
  });

  it('refuses an upload from a student', async () => {
    await request(server())
      .post('/api/media/image')
      .set('Authorization', `Bearer ${student.idToken}`)
      .attach('file', PNG, { filename: 'diagram.png', contentType: 'image/png' })
      .expect(403);
  });
});
