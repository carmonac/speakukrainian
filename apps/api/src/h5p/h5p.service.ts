import { rm } from 'node:fs/promises';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { H5PEditor, LibraryName } from '@lumieducation/h5p-server';
import type { IContentMetadata, IUser } from '@lumieducation/h5p-server';
import { h5pSaveResultSchema, type H5pSaveResult } from '@speakukrainian/shared';
import { StorageService } from '../infra/storage/storage.service.js';
import { H5pContentRepository } from './h5p-content.repository.js';
import { H5pContentStorage } from './h5p-content.storage.js';
import { toHttpException } from './h5p.errors.js';
import { contentPrefix, contentStoragePath } from './h5p.paths.js';
import { H5P_EDITOR } from './h5p.tokens.js';

@Injectable()
export class H5pService {
  private readonly logger = new Logger(H5pService.name);

  constructor(
    @Inject(H5P_EDITOR) private readonly editor: H5PEditor,
    private readonly contentStorage: H5pContentStorage,
    private readonly repository: H5pContentRepository,
    private readonly storage: StorageService,
  ) {}

  /**
   * Installs an uploaded package's libraries and content, then records the
   * index document that makes it findable.
   *
   * De-duplication and the no-downgrade rule are `LibraryManager`'s, not ours:
   * it asks `isInstalled`, then compares the stored `patchVersion` against the
   * incoming one and writes nothing when the incoming version is equal or
   * older. Our only obligation is that the library storage answers those
   * questions truthfully.
   */
  async importPackage(file: Express.Multer.File, actorId: string): Promise<H5pSaveResult> {
    // The permission system is `LaissezFaire`, so this user is only threaded
    // through to the storage calls; authorization is the route's `@Roles`.
    const user: IUser = { id: actorId, email: '', name: '', type: 'local' };

    try {
      const { id, metadata } = await this.editor.packageImporter.addPackageLibrariesAndContent(
        file.path,
        user,
      );
      const contentId = String(id);
      const mainLibrary = mainLibraryUberName(metadata);

      // One listing rather than a `stat` per file: sizes come back with it.
      const objects = await this.storage.list(contentPrefix(contentId));
      const sizeBytes = objects.reduce((total, object) => total + object.sizeBytes, 0);

      try {
        await this.repository.create(
          {
            id: contentId,
            title: metadata.title,
            mainLibrary,
            storagePath: contentStoragePath(contentId),
            sizeBytes,
            pageId: null,
          },
          actorId,
        );
      } catch (error) {
        // A failed index write would otherwise leave content objects that
        // nothing references and no route can ever delete.
        this.logger.error(`Rolling back H5P content ${contentId} after a failed index write`);
        await this.contentStorage.deleteContent(contentId).catch(() => undefined);
        throw error;
      }

      return h5pSaveResultSchema.parse({ contentId, title: metadata.title, mainLibrary });
    } catch (error) {
      const http = toHttpException(error);
      if (http) {
        throw http;
      }
      throw error;
    } finally {
      // Multer does not clean up after a successful request, and the container
      // filesystem is not ours to litter.
      await rm(file.path, { force: true });
    }
  }
}

/**
 * `H5P.MultiChoice 1.16` — the whitespace form `h5pContentSchema` documents,
 * not the hyphenated directory form.
 *
 * A package whose `preloadedDependencies` omits its own main library is
 * malformed but reachable, and the machine name alone is more useful to an
 * admin than a thrown error at the end of a successful install.
 */
function mainLibraryUberName(metadata: IContentMetadata): string {
  const dependency = metadata.preloadedDependencies?.find(
    (library) => library.machineName === metadata.mainLibrary,
  );

  return dependency
    ? LibraryName.toUberName(dependency, { useWhitespace: true, useHyphen: false })
    : metadata.mainLibrary;
}
