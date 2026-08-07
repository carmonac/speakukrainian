import { Readable } from 'node:stream';
import { H5pError } from '@lumieducation/h5p-server';
import type { ILibraryMetadata } from '@lumieducation/h5p-server';
import { beforeEach, describe, expect, it } from 'vitest';
import { H5pLibraryStorage } from './h5p-library.storage.js';
import { InMemoryStorage } from './h5p.storage-fake.js';

const MAIN = { machineName: 'SpeakTest.Main', majorVersion: 1, minorVersion: 0 };
const DEP = { machineName: 'SpeakTest.Dep', majorVersion: 1, minorVersion: 0 };

function libraryMetadata(overrides: Partial<ILibraryMetadata> = {}): ILibraryMetadata {
  return {
    title: 'Speak Test Main',
    machineName: MAIN.machineName,
    majorVersion: 1,
    minorVersion: 0,
    patchVersion: 3,
    runnable: 1,
    ...overrides,
  } as ILibraryMetadata;
}

describe('H5pLibraryStorage', () => {
  let storage: InMemoryStorage;
  let libraries: H5pLibraryStorage;

  beforeEach(() => {
    storage = new InMemoryStorage();
    libraries = new H5pLibraryStorage(storage.asStorageService());
  });

  describe('addLibrary', () => {
    it('writes library.json under the ubername prefix', async () => {
      const installed = await libraries.addLibrary(libraryMetadata());

      expect(installed.machineName).toBe('SpeakTest.Main');
      expect(installed.patchVersion).toBe(3);
      expect(storage.paths()).toEqual(['h5p/libraries/SpeakTest.Main-1.0/library.json']);
    });

    it('refuses to install a version that is already installed', async () => {
      // `FileLibraryStorage` wraps this throw in a `try` whose own `catch`
      // swallows it, so its guard never fires. Ours does.
      await libraries.addLibrary(libraryMetadata());

      await expect(libraries.addLibrary(libraryMetadata())).rejects.toMatchObject({
        errorId: 'storage-file-implementations:install-library-already-installed',
      });
    });

    it('carries the restricted flag onto the installed library', async () => {
      const installed = await libraries.addLibrary(libraryMetadata(), true);

      expect(installed.restricted).toBe(true);
    });
  });

  describe('isInstalled', () => {
    it('is false when the prefix holds files but no library.json', async () => {
      await storage.put('h5p/libraries/SpeakTest.Main-1.0/main.js', Buffer.from('x'));

      await expect(libraries.isInstalled(MAIN)).resolves.toBe(false);
    });
  });

  describe('addFile', () => {
    it('refuses a file for a library that is not installed', async () => {
      await expect(libraries.addFile(MAIN, 'main.js', Readable.from(['x']))).rejects.toMatchObject({
        errorId: 'storage-file-implementations:add-library-file-not-installed',
      });
    });

    it('refuses a filename that escapes the library prefix', async () => {
      await libraries.addLibrary(libraryMetadata());

      await expect(
        libraries.addFile(MAIN, '../../content/x', Readable.from(['x'])),
      ).rejects.toThrow(H5pError);
    });
  });

  describe('clearFiles', () => {
    it('removes every file except library.json, and leaves other libraries alone', async () => {
      await libraries.addLibrary(libraryMetadata());
      await libraries.addFile(MAIN, 'main.js', Readable.from(['old']));
      await libraries.addFile(MAIN, 'dist/style.css', Readable.from(['old']));
      await libraries.addLibrary(libraryMetadata({ machineName: DEP.machineName }));

      await libraries.clearFiles(MAIN);

      expect(storage.paths()).toEqual([
        'h5p/libraries/SpeakTest.Dep-1.0/library.json',
        'h5p/libraries/SpeakTest.Main-1.0/library.json',
      ]);
    });

    it('throws for a library that is not installed', async () => {
      await expect(libraries.clearFiles(MAIN)).rejects.toMatchObject({
        errorId: 'storage-file-implementations:clear-library-not-found',
      });
    });
  });

  describe('deleteLibrary', () => {
    it('removes the whole prefix', async () => {
      await libraries.addLibrary(libraryMetadata());
      await libraries.addFile(MAIN, 'main.js', Readable.from(['x']));

      await libraries.deleteLibrary(MAIN);

      expect(storage.paths()).toEqual([]);
    });

    it('answers 404 for a library that is not installed', async () => {
      await expect(libraries.deleteLibrary(MAIN)).rejects.toMatchObject({
        httpStatusCode: 404,
        errorId: 'storage-file-implementations:remove-library-library-missing',
      });
    });
  });

  describe('getInstalledLibraryNames', () => {
    it('parses ubernames and skips a directory that is not one', async () => {
      await libraries.addLibrary(libraryMetadata());
      await libraries.addLibrary(libraryMetadata({ machineName: DEP.machineName }));
      // A stray object at the libraries root must not crash the parse.
      await storage.put('h5p/libraries/not-a-library/readme.txt', Buffer.from('x'));

      const names = await libraries.getInstalledLibraryNames();

      expect(names.map((name) => name.machineName).sort()).toEqual([
        'SpeakTest.Dep',
        'SpeakTest.Main',
      ]);
    });

    it('filters by machine name without matching a longer name that starts the same', async () => {
      await libraries.addLibrary(libraryMetadata({ machineName: 'H5P.Image' }));
      await libraries.addLibrary(libraryMetadata({ machineName: 'H5P.ImageHotspots' }));

      const names = await libraries.getInstalledLibraryNames('H5P.Image');

      expect(names).toEqual([{ machineName: 'H5P.Image', majorVersion: 1, minorVersion: 0 }]);
    });
  });

  describe('getLibrary', () => {
    it('returns the stored patch version, which is what the no-downgrade rule reads', async () => {
      // `InstalledLibrary.fromName` would leave `patchVersion` undefined, and
      // `LibraryManager.isPatchedLibrary` compares it — so a lost patch version
      // turns every patch upload into a silent no-op.
      await libraries.addLibrary(libraryMetadata({ patchVersion: 7 }));

      const library = await libraries.getLibrary(MAIN);

      expect(library.patchVersion).toBe(7);
      expect(library.title).toBe('Speak Test Main');
      expect(library.runnable).toBe(1);
    });

    it('answers 404 for a library that is not installed', async () => {
      await expect(libraries.getLibrary(MAIN)).rejects.toMatchObject({
        httpStatusCode: 404,
        errorId: 'storage-file-implementations:get-library-metadata-not-installed',
      });
    });
  });

  describe('updateLibrary', () => {
    it('rewrites library.json and reports the new patch version', async () => {
      await libraries.addLibrary(libraryMetadata({ patchVersion: 1 }));

      const updated = await libraries.updateLibrary(libraryMetadata({ patchVersion: 2 }));

      expect(updated.patchVersion).toBe(2);
      await expect(libraries.getLibrary(MAIN)).resolves.toMatchObject({ patchVersion: 2 });
    });

    it('answers 404 when the library is missing', async () => {
      await expect(libraries.updateLibrary(libraryMetadata())).rejects.toMatchObject({
        httpStatusCode: 404,
        errorId: 'storage-file-implementations:update-library-library-missing',
      });
    });
  });

  describe('getFileStats and getFileStream', () => {
    it('reads a stored file and its size', async () => {
      await libraries.addLibrary(libraryMetadata());
      await libraries.addFile(MAIN, 'main.js', Readable.from(['console.log(1)']));

      await expect(libraries.getFileStats(MAIN, 'main.js')).resolves.toEqual({
        size: 14,
        birthtime: new Date('2026-05-01T00:00:00.000Z'),
      });
      await expect(libraries.getFileAsString(MAIN, 'main.js')).resolves.toBe('console.log(1)');
    });

    it('answers 404 for a file the library does not have', async () => {
      await libraries.addLibrary(libraryMetadata());

      await expect(libraries.getFileStats(MAIN, 'nope.js')).rejects.toMatchObject({
        errorId: 'library-file-missing',
        httpStatusCode: 404,
      });
    });
  });

  describe('getFileAsJson', () => {
    it('parses a stored JSON file', async () => {
      await libraries.addLibrary(libraryMetadata());
      await libraries.addFile(MAIN, 'semantics.json', Readable.from(['[{"name":"q"}]']));

      await expect(libraries.getFileAsJson(MAIN, 'semantics.json')).resolves.toEqual([
        { name: 'q' },
      ]);
    });
  });

  describe('getLanguages', () => {
    it('returns the language codes without their extension', async () => {
      await libraries.addLibrary(libraryMetadata());
      await libraries.addFile(MAIN, 'language/uk.json', Readable.from(['{}']));
      await libraries.addFile(MAIN, 'language/en.json', Readable.from(['{}']));
      await libraries.addFile(MAIN, 'language/.gitkeep', Readable.from(['']));

      await expect(libraries.getLanguages(MAIN)).resolves.toEqual(['uk', 'en']);
    });

    it('returns none rather than throwing for a library with no translations', async () => {
      // The FS version lets `readdir` throw ENOENT here; there is no directory
      // to be missing in object storage.
      await libraries.addLibrary(libraryMetadata());

      await expect(libraries.getLanguages(MAIN)).resolves.toEqual([]);
    });
  });

  describe('listFiles', () => {
    it('lists paths relative to the library prefix, sorted', async () => {
      await libraries.addLibrary(libraryMetadata());
      await libraries.addFile(MAIN, 'main.js', Readable.from(['x']));
      await libraries.addFile(MAIN, 'dist/style.css', Readable.from(['x']));

      await expect(libraries.listFiles(MAIN)).resolves.toEqual([
        'dist/style.css',
        'library.json',
        'main.js',
      ]);
    });
  });

  describe('listAddons', () => {
    it('returns only the libraries that declare addTo', async () => {
      await libraries.addLibrary(libraryMetadata());
      await libraries.addLibrary(
        libraryMetadata({
          machineName: DEP.machineName,
          addTo: { content: { types: [{ text: { regex: 'x' } }] } },
        }),
      );

      const addons = await libraries.listAddons();

      expect(addons.map((addon) => addon.machineName)).toEqual(['SpeakTest.Dep']);
    });
  });

  describe('updateAdditionalMetadata', () => {
    it('reports false and rewrites nothing when nothing changed', async () => {
      await libraries.addLibrary(libraryMetadata());
      const before = storage.text('h5p/libraries/SpeakTest.Main-1.0/library.json');

      await expect(libraries.updateAdditionalMetadata(MAIN, { restricted: false })).resolves.toBe(
        false,
      );
      expect(storage.text('h5p/libraries/SpeakTest.Main-1.0/library.json')).toBe(before);
    });

    it('reports true and rewrites library.json when restricted flips', async () => {
      await libraries.addLibrary(libraryMetadata());

      await expect(libraries.updateAdditionalMetadata(MAIN, { restricted: true })).resolves.toBe(
        true,
      );
      await expect(libraries.getLibrary(MAIN)).resolves.toMatchObject({ restricted: true });
      await expect(libraries.updateAdditionalMetadata(MAIN, { restricted: true })).resolves.toBe(
        false,
      );
    });

    it('is the only thing that persists restricted, since addLibrary does not', async () => {
      // `addLibrary` writes `library.json` verbatim, exactly as
      // `FileLibraryStorage` does, so its `restricted` argument survives only
      // on the object it returns. `LibraryManager` sets the flag through this
      // method afterwards; a reader who assumes otherwise would think a
      // restricted library had quietly become public.
      await libraries.addLibrary(libraryMetadata(), true);

      await expect(libraries.getLibrary(MAIN)).resolves.toMatchObject({ restricted: false });
    });
  });

  describe('getAllDependentsCount', () => {
    it('counts every dependency list', async () => {
      await libraries.addLibrary(libraryMetadata({ preloadedDependencies: [DEP] }));
      await libraries.addLibrary(
        libraryMetadata({ machineName: DEP.machineName, preloadedDependencies: [] }),
      );

      await expect(libraries.getAllDependentsCount()).resolves.toEqual({
        'SpeakTest.Dep-1.0': 1,
      });
    });

    it('breaks the editor-dependency circle so a content type stays deletable', async () => {
      // H5P.InteractiveVideo lists H5PEditor.InteractiveVideo as an editor
      // dependency and that library lists H5P.InteractiveVideo back. Counted
      // naively, each has a dependent and neither can ever be removed.
      const player = {
        machineName: 'H5P.InteractiveVideo',
        majorVersion: 1,
        minorVersion: 0,
      };
      const editor = {
        machineName: 'H5PEditor.InteractiveVideo',
        majorVersion: 1,
        minorVersion: 0,
      };

      await libraries.addLibrary(
        libraryMetadata({ ...player, editorDependencies: [editor], preloadedDependencies: [] }),
      );
      await libraries.addLibrary(libraryMetadata({ ...editor, preloadedDependencies: [player] }));

      await expect(libraries.getAllDependentsCount()).resolves.toEqual({
        'H5PEditor.InteractiveVideo-1.0': 1,
      });
      await expect(libraries.getDependentsCount(player)).resolves.toBe(0);
      await expect(libraries.getDependentsCount(editor)).resolves.toBe(1);
    });
  });
});
