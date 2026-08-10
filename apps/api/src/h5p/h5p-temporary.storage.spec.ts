import { Readable } from 'node:stream';
import type { ReadStream } from 'node:fs';
import { H5PConfig, H5pError } from '@lumieducation/h5p-server';
import type { IUser } from '@lumieducation/h5p-server';
import { beforeEach, describe, expect, it } from 'vitest';
import { H5pTemporaryStorage } from './h5p-temporary.storage.js';
import { InMemoryStorage } from './h5p.storage-fake.js';

/**
 * Deliberately not the library's 120-minute default: an assertion against the
 * default would also pass if `listFiles` read some *other* config field that
 * happens to hold two hours, and `contentTypeCacheRefreshInterval` does.
 */
const LIFETIME_MS = 90 * 60 * 1000;

const ALICE: IUser = {
  id: 'alice00000000000000000000001',
  name: 'Alice',
  email: '',
  type: 'local',
};
const BOB: IUser = { id: 'bob000000000000000000000000b', name: 'Bob', email: '', type: 'local' };

const CLIP = Buffer.from(Uint8Array.from({ length: 512 }, (_value, index) => (index * 31) % 251));

/** Two hours from `WRITTEN_AT` under the lifetime above, so "now" sits between them. */
const WRITTEN_AT = new Date('2026-05-01T12:00:00.000Z');
const NOW = new Date('2026-05-01T13:00:00.000Z');
const LONG_AGO = new Date('2026-05-01T09:00:00.000Z');

function bytes(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/** The library hands `saveFile` an `fs.ReadStream`; every caller of ours is any `Readable`. */
function source(body: Buffer): ReadStream {
  return Readable.from([body]) as unknown as ReadStream;
}

describe('H5pTemporaryStorage', () => {
  let objects: InMemoryStorage;
  let temporary: H5pTemporaryStorage;

  beforeEach(() => {
    objects = new InMemoryStorage(WRITTEN_AT);
    temporary = new H5pTemporaryStorage(
      objects.asStorageService(),
      new H5PConfig(undefined, { temporaryFileLifetime: LIFETIME_MS }),
    );
  });

  describe('saveFile', () => {
    it('writes under the owner and returns the expiry it was handed', async () => {
      const expiresAt = new Date('2026-05-01T14:00:00.000Z');

      const saved = await temporary.saveFile('images/clip.mp3', source(CLIP), ALICE, expiresAt);

      expect(objects.paths()).toEqual([`h5p/temp/${ALICE.id}/images/clip.mp3`]);
      expect(saved).toEqual({
        expiresAt,
        filename: 'images/clip.mp3',
        ownedByUserId: ALICE.id,
      });
    });

    it('stores the bytes rather than the stream object', async () => {
      await temporary.saveFile('images/clip.mp3', source(CLIP), ALICE, NOW);

      const stream = await temporary.getFileStream('images/clip.mp3', ALICE);
      expect(await bytes(stream)).toEqual(CLIP);
    });

    it.each([['../../escape.png'], ['/etc/passwd'], ['a\\b.png']])(
      'refuses the filename %j with a 400',
      async (filename) => {
        await expect(temporary.saveFile(filename, source(CLIP), ALICE, NOW)).rejects.toThrow(
          H5pError,
        );
        expect(objects.paths()).toEqual([]);
      },
    );

    it('refuses an owner id that is not a path-safe atom', async () => {
      const hostile: IUser = { ...ALICE, id: '../other' };

      await expect(temporary.saveFile('clip.png', source(CLIP), hostile, NOW)).rejects.toThrow(
        H5pError,
      );
      expect(objects.paths()).toEqual([]);
    });
  });

  describe('owner isolation', () => {
    // The single most important property of this adapter, and the one a
    // "simplification" of the layout would destroy silently: two editors upload
    // a file, `FilenameGenerator` gives both the same name because it only
    // checks uniqueness within an owner, and nothing else in the stack would
    // notice them colliding.
    beforeEach(async () => {
      await temporary.saveFile('images/clip.mp3', source(CLIP), ALICE, NOW);
    });

    it('does not report the other owner’s file as existing', async () => {
      expect(await temporary.fileExists('images/clip.mp3', ALICE)).toBe(true);
      expect(await temporary.fileExists('images/clip.mp3', BOB)).toBe(false);
    });

    it('answers 404 when the other owner asks for its stats', async () => {
      await expect(temporary.getFileStats('images/clip.mp3', BOB)).rejects.toMatchObject({
        errorId: 'storage-file-implementations:temporary-file-not-found',
        httpStatusCode: 404,
      });
    });

    it('answers 404 when the other owner asks for its bytes', async () => {
      await expect(temporary.getFileStream('images/clip.mp3', BOB)).rejects.toMatchObject({
        errorId: 'storage-file-implementations:temporary-file-not-found',
        httpStatusCode: 404,
      });
    });

    it('deletes only the named owner’s copy of an identical filename', async () => {
      const bobs = Buffer.from('bob owns these bytes');
      await temporary.saveFile('images/clip.mp3', source(bobs), BOB, NOW);

      await temporary.deleteFile('images/clip.mp3', ALICE.id);

      expect(objects.paths()).toEqual([`h5p/temp/${BOB.id}/images/clip.mp3`]);
      expect(await bytes(await temporary.getFileStream('images/clip.mp3', BOB))).toEqual(bobs);
    });
  });

  describe('getFileStats', () => {
    it('reports the size and the creation time of the stored object', async () => {
      await temporary.saveFile('images/clip.mp3', source(CLIP), ALICE, NOW);

      expect(await temporary.getFileStats('images/clip.mp3', ALICE)).toEqual({
        size: CLIP.length,
        birthtime: WRITTEN_AT,
      });
    });
  });

  describe('getFileStream', () => {
    beforeEach(async () => {
      await temporary.saveFile('images/clip.mp3', source(CLIP), ALICE, NOW);
    });

    it('returns exactly the requested byte range', async () => {
      const stream = await temporary.getFileStream('images/clip.mp3', ALICE, 100, 199);

      expect(await bytes(stream)).toEqual(CLIP.subarray(100, 200));
    });

    it('returns the whole object when no range is asked for', async () => {
      expect(await bytes(await temporary.getFileStream('images/clip.mp3', ALICE))).toEqual(CLIP);
    });

    it('answers 404 for a file that is not there', async () => {
      await expect(temporary.getFileStream('images/gone.mp3', ALICE)).rejects.toMatchObject({
        errorId: 'storage-file-implementations:temporary-file-not-found',
        httpStatusCode: 404,
      });
    });
  });

  describe('deleteFile', () => {
    it('is a no-op for a file that has already gone, so a sweep can race a save', async () => {
      await expect(temporary.deleteFile('images/gone.mp3', ALICE.id)).resolves.toBeUndefined();
    });

    it('refuses an owner id that is not a path-safe atom', async () => {
      await expect(temporary.deleteFile('clip.png', '../other')).rejects.toThrow(H5pError);
    });
  });

  describe('listFiles', () => {
    beforeEach(async () => {
      await temporary.saveFile('images/clip.mp3', source(CLIP), ALICE, NOW);
      await temporary.saveFile('audios/note.mp3', source(CLIP), ALICE, NOW);
      await temporary.saveFile('images/clip.mp3', source(CLIP), BOB, NOW);
    });

    it('lists only one user’s files when it is given one', async () => {
      const files = await temporary.listFiles(ALICE);

      expect(files.map((file) => file.filename).sort()).toEqual([
        'audios/note.mp3',
        'images/clip.mp3',
      ]);
      expect(files.every((file) => file.ownedByUserId === ALICE.id)).toBe(true);
    });

    it('lists every owner’s files when it is given none, keeping each owner', async () => {
      const files = await temporary.listFiles();

      expect(files.map((file) => `${file.ownedByUserId}/${file.filename}`).sort()).toEqual([
        `${ALICE.id}/audios/note.mp3`,
        `${ALICE.id}/images/clip.mp3`,
        `${BOB.id}/images/clip.mp3`,
      ]);
    });

    it('derives the expiry from the creation time plus the configured lifetime', async () => {
      // Driven through the fake's object map because a bucket will not let a
      // caller choose `timeCreated`. The two dates straddle `NOW`, so this
      // distinguishes "the sweep spares live files" from "nothing was expired"
      // — the pair of outcomes a single-file test cannot tell apart, and the
      // one that would delete an editor's uploads mid-session.
      objects.objects.set(`h5p/temp/${ALICE.id}/images/old.png`, {
        body: CLIP,
        createdAt: LONG_AGO,
      });

      const byName = new Map(
        (await temporary.listFiles()).map((file) => [
          `${file.ownedByUserId}/${file.filename}`,
          file,
        ]),
      );

      const stale = byName.get(`${ALICE.id}/images/old.png`);
      const live = byName.get(`${ALICE.id}/images/clip.mp3`);
      expect(stale?.expiresAt).toEqual(new Date(LONG_AGO.getTime() + LIFETIME_MS));
      expect(live?.expiresAt).toEqual(new Date(WRITTEN_AT.getTime() + LIFETIME_MS));
      expect(stale?.expiresAt.getTime()).toBeLessThan(NOW.getTime());
      expect(live?.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
    });

    it('skips an object with no owner segment instead of throwing', async () => {
      // Anything under `h5p/temp/` that this adapter did not write. Throwing
      // here would stop the sweep for every owner, forever.
      objects.objects.set('h5p/temp/stray.png', { body: CLIP, createdAt: WRITTEN_AT });
      objects.objects.set('h5p/temp/orphan/', { body: CLIP, createdAt: WRITTEN_AT });

      const files = await temporary.listFiles();

      expect(files).toHaveLength(3);
      expect(files.map((file) => file.filename)).not.toContain('stray.png');
    });
  });

  describe('sanitizeFilename', () => {
    it('strips characters an object name cannot carry, keeping the path shape', () => {
      expect(temporary.sanitizeFilename('images/a b#c.png')).toBe('images/abc.png');
    });

    it('shortens a basename far longer than an object name should be', () => {
      const long = `images/${'a'.repeat(400)}.png`;

      const clean = temporary.sanitizeFilename(long);

      expect(clean.startsWith('images/')).toBe(true);
      expect(clean.endsWith('.png')).toBe(true);
      expect(clean.length).toBeLessThan(long.length);
    });
  });
});
