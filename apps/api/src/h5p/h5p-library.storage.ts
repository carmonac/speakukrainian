import type { Readable } from 'node:stream';
import { Injectable } from '@nestjs/common';
import { H5pError, InstalledLibrary, LibraryName, streamToString } from '@lumieducation/h5p-server';
import type {
  IAdditionalLibraryMetadata,
  IFileStats,
  IInstalledLibrary,
  ILibraryMetadata,
  ILibraryName,
  ILibraryStorage,
} from '@lumieducation/h5p-server';
import { StorageService } from '../infra/storage/storage.service.js';
import { LIBRARY_ROOT_PREFIX, libraryObjectPath, libraryPrefix } from './h5p.paths.js';

/** A library is "installed" exactly when this object exists under its prefix. */
const LIBRARY_METADATA_FILE = 'library.json';

/** Directory names that parse as an ubername; anything else is not a library. */
const UBERNAME_DIRECTORY = /^([\w.]+)-(\d+)\.(\d+)$/i;

/**
 * H5P libraries in Cloud Storage, under `h5p/libraries/<Machine.Name-major.minor>/`.
 *
 * Two consistency properties differ from a filesystem and cannot be fixed here,
 * because object storage has no atomic multi-object write and no rename:
 *
 * - `addLibrary` writes `library.json` before the files, and `isInstalled` keys
 *   on `library.json`. A concurrent reader can therefore see a library as
 *   installed while its files are still uploading. `FileLibraryStorage` has the
 *   same window; `LibraryManager.installLibrary` closes it after the fact by
 *   running `checkConsistency` and deleting the library if it fails.
 * - A crash mid-install leaves a partial library that the next install sees as
 *   present. That rollback is the only mitigation, and it is the library's.
 *
 * `LibraryManager`'s default lock provider is in-process, so two Cloud Run
 * instances installing the same library at the same moment are not serialised.
 * The library's `ILockProvider` is the seam if that ever matters.
 */
@Injectable()
export class H5pLibraryStorage implements ILibraryStorage {
  constructor(private readonly storage: StorageService) {}

  async addFile(library: ILibraryName, filename: string, readStream: Readable): Promise<boolean> {
    const path = libraryObjectPath(library, filename);

    if (!(await this.isInstalled(library))) {
      throw new H5pError(
        'storage-file-implementations:add-library-file-not-installed',
        { filename, libraryName: LibraryName.toUberName(library) },
        500,
      );
    }

    await this.storage.put(path, readStream);
    return true;
  }

  /**
   * Deviation from `FileLibraryStorage`: it wraps its "already installed" throw
   * in a `try` whose own `catch` swallows it, so that guard never fires. Doing
   * the check outside any `try` makes it real. Unreachable on the normal path —
   * `installFromDirectory` checks first — so the tightening cannot break an
   * install, only a caller that skipped that check.
   */
  async addLibrary(
    libraryMetadata: ILibraryMetadata,
    restricted = false,
  ): Promise<IInstalledLibrary> {
    if (await this.isInstalled(libraryMetadata)) {
      throw new H5pError('storage-file-implementations:install-library-already-installed', {
        libraryName: LibraryName.toUberName(libraryMetadata),
      });
    }

    const library = new InstalledLibrary(
      libraryMetadata.machineName,
      libraryMetadata.majorVersion,
      libraryMetadata.minorVersion,
      libraryMetadata.patchVersion,
      restricted,
    );

    try {
      await this.writeMetadata(library, libraryMetadata);
      return library;
    } catch (error) {
      await this.storage.deleteByPrefix(libraryPrefix(library)).catch(() => undefined);
      throw error;
    }
  }

  async clearFiles(library: ILibraryName): Promise<void> {
    if (!(await this.isInstalled(library))) {
      throw new H5pError('storage-file-implementations:clear-library-not-found', {
        libraryName: LibraryName.toUberName(library),
      });
    }

    const prefix = libraryPrefix(library);
    const doomed = (await this.storage.list(prefix)).filter(
      (object) => object.path !== `${prefix}${LIBRARY_METADATA_FILE}`,
    );

    await Promise.all(doomed.map((object) => this.storage.delete(object.path)));
  }

  async deleteLibrary(library: ILibraryName): Promise<void> {
    if (!(await this.isInstalled(library))) {
      throw new H5pError(
        'storage-file-implementations:remove-library-library-missing',
        { libraryName: LibraryName.toUberName(library) },
        404,
      );
    }
    await this.storage.deleteByPrefix(libraryPrefix(library));
  }

  async fileExists(library: ILibraryName, filename: string): Promise<boolean> {
    return this.storage.exists(libraryObjectPath(library, filename));
  }

  /**
   * A straight port of the FS implementation, including its de-circularisation
   * of editor dependencies: `H5P.InteractiveVideo` lists
   * `H5PEditor.InteractiveVideo` as an editor dependency and that library lists
   * `H5P.InteractiveVideo` back, so without this the pair would each show a
   * dependent and neither could ever be deleted.
   */
  async getAllDependentsCount(): Promise<{ [ubername: string]: number }> {
    const names = await this.getInstalledLibraryNames();
    const libraries = await Promise.all(names.map((name) => this.getLibrary(name)));

    const byUberName = new Map<string, IInstalledLibrary>();
    for (const library of libraries) {
      byUberName.set(LibraryName.toUberName(library), library);
    }

    for (const library of libraries) {
      for (const dependency of library.editorDependencies ?? []) {
        const dependent = byUberName.get(LibraryName.toUberName(dependency));
        const index =
          dependent?.preloadedDependencies?.findIndex((name) => LibraryName.equal(name, library)) ??
          -1;
        if (index >= 0) {
          dependent?.preloadedDependencies?.splice(index, 1);
        }
      }
    }

    const counts: { [ubername: string]: number } = {};
    for (const library of libraries) {
      const dependencies = [
        ...(library.preloadedDependencies ?? []),
        ...(library.editorDependencies ?? []),
        ...(library.dynamicDependencies ?? []),
      ];
      for (const dependency of dependencies) {
        const ubername = LibraryName.toUberName(dependency);
        counts[ubername] = (counts[ubername] ?? 0) + 1;
      }
    }

    return counts;
  }

  async getDependentsCount(library: ILibraryName): Promise<number> {
    return (await this.getAllDependentsCount())[LibraryName.toUberName(library)] ?? 0;
  }

  async getFileAsJson(library: ILibraryName, file: string): Promise<unknown> {
    return JSON.parse(await this.getFileAsString(library, file));
  }

  async getFileAsString(library: ILibraryName, file: string): Promise<string> {
    return streamToString(await this.getFileStream(library, file));
  }

  async getFileStats(library: ILibraryName, file: string): Promise<IFileStats> {
    const stats = await this.storage.stat(libraryObjectPath(library, file));
    if (!stats) {
      throw this.missingFile(library, file);
    }
    return { birthtime: stats.createdAt, size: stats.sizeBytes };
  }

  async getFileStream(library: ILibraryName, file: string): Promise<Readable> {
    const path = libraryObjectPath(library, file);
    if (!(await this.storage.exists(path))) {
      throw this.missingFile(library, file);
    }
    return this.storage.createReadStream(path);
  }

  /**
   * Deviation: the directory listing is always the full one, filtered in
   * memory, rather than narrowing the prefix to the machine name. A machine
   * name is a prefix of other machine names (`H5P.Image` of `H5P.ImageHotspots`),
   * so a narrowed listing would pick up libraries that only look related and
   * then have to filter them out anyway.
   */
  async getInstalledLibraryNames(machineName?: string): Promise<ILibraryName[]> {
    const directories = await this.storage.listSubdirectories(LIBRARY_ROOT_PREFIX);

    return directories
      .filter((name) => UBERNAME_DIRECTORY.test(name))
      .map((name) => LibraryName.fromUberName(name))
      .filter((library) => !machineName || library.machineName === machineName);
  }

  /**
   * Deviation: the FS version lets `readdir` throw `ENOENT` for a library with
   * no `language/` directory. There is no directory to be missing in object
   * storage, and the honest answer for a library with no translations is none.
   */
  async getLanguages(library: ILibraryName): Promise<string[]> {
    const prefix = `${libraryPrefix(library)}language/`;

    return (await this.storage.list(prefix))
      .map((object) => object.path.slice(prefix.length))
      .filter((name) => name.endsWith('.json') && !name.includes('/'))
      .map((name) => name.slice(0, -'.json'.length));
  }

  /**
   * `InstalledLibrary.fromMetadata`, never `fromName`: `fromName` leaves
   * `patchVersion` undefined, and `LibraryManager.isPatchedLibrary` compares
   * patch versions to decide whether an upload is an upgrade, a no-op or a
   * downgrade. A lost patch version silently turns every patch into a no-op.
   */
  async getLibrary(library: ILibraryName): Promise<IInstalledLibrary> {
    if (!(await this.isInstalled(library))) {
      throw new H5pError(
        'storage-file-implementations:get-library-metadata-not-installed',
        { libraryName: LibraryName.toUberName(library) },
        404,
      );
    }

    const metadata = JSON.parse(
      await this.getFileAsString(library, LIBRARY_METADATA_FILE),
    ) as ILibraryMetadata & IAdditionalLibraryMetadata;

    return InstalledLibrary.fromMetadata(metadata);
  }

  async isInstalled(library: ILibraryName): Promise<boolean> {
    return this.storage.exists(libraryObjectPath(library, LIBRARY_METADATA_FILE));
  }

  /** Without this the editor and player silently render without their addons. */
  async listAddons(): Promise<ILibraryMetadata[]> {
    const names = await this.getInstalledLibraryNames();
    const libraries = await Promise.all(names.map((name) => this.getLibrary(name)));

    return libraries.filter((library) => library.addTo !== undefined);
  }

  async listFiles(library: ILibraryName): Promise<string[]> {
    const prefix = libraryPrefix(library);

    return (await this.storage.list(prefix))
      .map((object) => object.path.slice(prefix.length))
      .sort();
  }

  async updateAdditionalMetadata(
    library: ILibraryName,
    additionalMetadata: Partial<IAdditionalLibraryMetadata>,
  ): Promise<boolean> {
    const metadata = await this.getLibrary(library);

    let dirty = false;
    for (const [property, value] of Object.entries(additionalMetadata)) {
      const record = metadata as unknown as Record<string, unknown>;
      if (record[property] !== value) {
        record[property] = value;
        dirty = true;
      }
    }
    if (!dirty) {
      return false;
    }

    try {
      await this.writeMetadata(library, metadata);
      return true;
    } catch (error) {
      throw new H5pError(
        'storage-file-implementations:error-updating-metadata',
        { library: LibraryName.toUberName(library), error: messageOf(error) },
        500,
      );
    }
  }

  async updateLibrary(libraryMetadata: ILibraryMetadata): Promise<IInstalledLibrary> {
    if (!(await this.isInstalled(libraryMetadata))) {
      throw new H5pError(
        'storage-file-implementations:update-library-library-missing',
        { libraryName: LibraryName.toUberName(libraryMetadata) },
        404,
      );
    }

    await this.writeMetadata(libraryMetadata, libraryMetadata);
    return InstalledLibrary.fromMetadata(libraryMetadata);
  }

  private async writeMetadata(library: ILibraryName, metadata: unknown): Promise<void> {
    await this.storage.put(
      libraryObjectPath(library, LIBRARY_METADATA_FILE),
      Buffer.from(JSON.stringify(metadata), 'utf-8'),
      { contentType: 'application/json' },
    );
  }

  private missingFile(library: ILibraryName, filename: string): H5pError {
    return new H5pError(
      'library-file-missing',
      { filename, library: LibraryName.toUberName(library) },
      404,
    );
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
