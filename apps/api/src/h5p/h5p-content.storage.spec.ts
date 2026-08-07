import { Readable } from 'node:stream';
import { H5pError } from '@lumieducation/h5p-server';
import type { IContentMetadata, IUser } from '@lumieducation/h5p-server';
import { beforeEach, describe, expect, it } from 'vitest';
import { H5pContentStorage } from './h5p-content.storage.js';
import { InMemoryStorage } from './h5p.storage-fake.js';

const USER: IUser = { id: 'editor-1', email: '', name: '', type: 'local' };

const MAIN = { machineName: 'SpeakTest.Main', majorVersion: 1, minorVersion: 0 };
const DEP = { machineName: 'SpeakTest.Dep', majorVersion: 1, minorVersion: 0 };

function metadata(overrides: Partial<IContentMetadata> = {}): IContentMetadata {
  return {
    title: 'Present perfect drill',
    language: 'en',
    mainLibrary: MAIN.machineName,
    embedTypes: ['iframe'],
    preloadedDependencies: [MAIN, DEP],
    ...overrides,
  } as IContentMetadata;
}

describe('H5pContentStorage', () => {
  let storage: InMemoryStorage;
  let content: H5pContentStorage;

  beforeEach(() => {
    storage = new InMemoryStorage();
    content = new H5pContentStorage(storage.asStorageService());
  });

  describe('addContent', () => {
    it('writes h5p.json and content.json under a generated id', async () => {
      const id = await content.addContent(metadata(), { question: 'a' }, USER);

      expect(String(id)).toMatch(/^[0-9a-f-]{36}$/);
      expect(storage.paths()).toEqual([
        `h5p/content/${id}/content.json`,
        `h5p/content/${id}/h5p.json`,
      ]);
      expect(JSON.parse(storage.text(`h5p/content/${id}/h5p.json`))).toEqual(metadata());
      expect(JSON.parse(storage.text(`h5p/content/${id}/content.json`))).toEqual({ question: 'a' });
    });

    it('honours a supplied content id', async () => {
      const id = await content.addContent(metadata(), {}, USER, 'chosen-id');

      expect(id).toBe('chosen-id');
      await expect(content.contentExists('chosen-id')).resolves.toBe(true);
    });

    it('refuses a supplied id that would escape the content prefix', async () => {
      // `FileContentStorage` does not check this; over object storage, where the
      // name is a flat string, nothing else would.
      await expect(content.addContent(metadata(), {}, USER, '../libraries')).rejects.toThrow(
        H5pError,
      );
      expect(storage.paths()).toEqual([]);
    });
  });

  describe('addFile', () => {
    it('stores the stream under the content prefix', async () => {
      const id = await content.addContent(metadata(), {}, USER, 'abc');

      await content.addFile(id, 'media/clip.txt', Readable.from(['hello']));

      expect(storage.text('h5p/content/abc/media/clip.txt')).toBe('hello');
    });

    it('answers 404 when the content does not exist', async () => {
      await expect(content.addFile('missing', 'a.txt', Readable.from(['x']))).rejects.toMatchObject(
        { httpStatusCode: 404 },
      );
    });

    it('refuses a package file whose path escapes the content prefix', async () => {
      // The package importer streams files straight here without consulting
      // `sanitizeFilename`, so this assertion is the only thing between a
      // crafted package and an object written outside `h5p/content/<id>/`.
      await content.addContent(metadata(), {}, USER, 'abc');

      await expect(
        content.addFile('abc', '../../../etc/passwd', Readable.from(['x'])),
      ).rejects.toThrow(H5pError);
      expect(storage.paths()).toEqual(['h5p/content/abc/content.json', 'h5p/content/abc/h5p.json']);
    });
  });

  describe('deleteContent', () => {
    it('removes every object under the content and nothing beside it', async () => {
      // The prefix bug this pins is silent: built without the trailing slash it
      // takes out `abc2` as well, and no integration test would notice.
      await content.addContent(metadata(), {}, USER, 'abc');
      await content.addFile('abc', 'media/clip.txt', Readable.from(['x']));
      await content.addContent(metadata(), {}, USER, 'abc2');
      await storage.put('h5p/libraries/SpeakTest.Main-1.0/library.json', Buffer.from('{}'));
      await storage.put('images/2026/05/a.png', Buffer.from('png'));

      await content.deleteContent('abc');

      expect(storage.paths()).toEqual([
        'h5p/content/abc2/content.json',
        'h5p/content/abc2/h5p.json',
        'h5p/libraries/SpeakTest.Main-1.0/library.json',
        'images/2026/05/a.png',
      ]);
    });

    it('answers 404 for content that is not there', async () => {
      await expect(content.deleteContent('missing')).rejects.toMatchObject({ httpStatusCode: 404 });
    });
  });

  describe('deleteFile', () => {
    it('removes one file and answers 404 for one that is absent', async () => {
      await content.addContent(metadata(), {}, USER, 'abc');
      await content.addFile('abc', 'media/clip.txt', Readable.from(['x']));

      await content.deleteFile('abc', 'media/clip.txt');

      await expect(content.fileExists('abc', 'media/clip.txt')).resolves.toBe(false);
      await expect(content.deleteFile('abc', 'media/clip.txt')).rejects.toMatchObject({
        httpStatusCode: 404,
      });
    });
  });

  describe('getFileStats', () => {
    it('maps the stored size and creation time onto the library shape', async () => {
      await content.addContent(metadata(), {}, USER, 'abc');
      await content.addFile('abc', 'media/clip.txt', Readable.from(['hello']));

      await expect(content.getFileStats('abc', 'media/clip.txt', USER)).resolves.toEqual({
        size: 5,
        birthtime: new Date('2026-05-01T00:00:00.000Z'),
      });
    });

    it('answers 404 for a file that is not stored', async () => {
      await content.addContent(metadata(), {}, USER, 'abc');

      await expect(content.getFileStats('abc', 'nope.txt', USER)).rejects.toMatchObject({
        errorId: 'content-file-missing',
        httpStatusCode: 404,
      });
    });
  });

  describe('getFileStream', () => {
    it('serves the requested byte range', async () => {
      await content.addContent(metadata(), {}, USER, 'abc');
      await content.addFile('abc', 'a.txt', Readable.from(['0123456789']));

      const stream = await content.getFileStream('abc', 'a.txt', USER, 2, 4);

      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk as Buffer));
      }
      expect(Buffer.concat(chunks).toString()).toBe('234');
    });
  });

  describe('getMetadata and getParameters', () => {
    it('reads back exactly what addContent wrote', async () => {
      await content.addContent(metadata({ title: 'Round trip' }), { q: [1, 2] }, USER, 'abc');

      await expect(content.getMetadata('abc')).resolves.toMatchObject({ title: 'Round trip' });
      await expect(content.getParameters('abc')).resolves.toEqual({ q: [1, 2] });
    });
  });

  describe('listFiles', () => {
    it('returns content files relative to the prefix, without the two JSON files', async () => {
      await content.addContent(metadata(), {}, USER, 'abc');
      await content.addFile('abc', 'media/clip.txt', Readable.from(['x']));
      await content.addFile('abc', 'images/pic.png', Readable.from(['y']));

      await expect(content.listFiles('abc', USER)).resolves.toEqual([
        'media/clip.txt',
        'images/pic.png',
      ]);
    });
  });

  describe('listContent', () => {
    it('returns the ids of every stored piece of content', async () => {
      await content.addContent(metadata(), {}, USER, 'abc');
      await content.addContent(metadata(), {}, USER, 'def');
      await storage.put('h5p/libraries/SpeakTest.Main-1.0/library.json', Buffer.from('{}'));

      await expect(content.listContent()).resolves.toEqual(['abc', 'def']);
    });
  });

  describe('getUsage', () => {
    it('separates main-library use from dependency use', async () => {
      await content.addContent(metadata(), {}, USER, 'one');
      await content.addContent(metadata(), {}, USER, 'two');
      await content.addContent(
        metadata({ mainLibrary: DEP.machineName, preloadedDependencies: [DEP] }),
        {},
        USER,
        'three',
      );

      await expect(content.getUsage(MAIN)).resolves.toEqual({
        asMainLibrary: 2,
        asDependency: 0,
      });
      await expect(content.getUsage(DEP)).resolves.toEqual({
        asMainLibrary: 1,
        asDependency: 2,
      });
    });

    it('counts nothing for a library no content depends on', async () => {
      await content.addContent(metadata(), {}, USER, 'one');

      await expect(
        content.getUsage({ machineName: 'H5P.Other', majorVersion: 1, minorVersion: 0 }),
      ).resolves.toEqual({ asMainLibrary: 0, asDependency: 0 });
    });
  });

  describe('sanitizeFilename', () => {
    it('strips characters an object name cannot carry, keeping the path shape', () => {
      expect(content.sanitizeFilename('images/a b?c.png')).toBe('images/abc.png');
    });
  });
});
