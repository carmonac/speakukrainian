import { rm } from 'node:fs/promises';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { H5PEditor, LibraryName } from '@lumieducation/h5p-server';
import type { IContentMetadata, IUser } from '@lumieducation/h5p-server';
import {
  h5pSaveResultSchema,
  type H5pContent,
  type H5pSaveResult,
  type ListH5pContentQuery,
  type Page,
} from '@speakukrainian/shared';
import { StorageService } from '../infra/storage/storage.service.js';
import { H5pContentRepository } from './h5p-content.repository.js';
import { H5pContentStorage } from './h5p-content.storage.js';
import { CONTENT_MISSING_MESSAGE, toHttpException } from './h5p.errors.js';
import { assertSafePackageEntries } from './h5p.package-scan.js';
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
      // Before the library opens the package: `PackageImporter.extractPackage`
      // joins each entry name onto its temp directory and writes it unchecked,
      // so the names have to be refused while they are still only names.
      await assertSafePackageEntries(file.path);

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
      // filesystem is not ours to litter. Best-effort on purpose: `force: true`
      // covers ENOENT, but any other fs failure here would replace the outcome
      // of the whole import — an upload that succeeded and wrote its index
      // document would answer 500, and the caller would treat a real, indexed
      // content as failed with no route able to find or remove it.
      await rm(file.path, { force: true }).catch((error: unknown) =>
        this.logger.warn(
          `Could not remove the uploaded package at ${file.path}: ${messageOf(error)}`,
        ),
      );
    }
  }

  list(query: ListH5pContentQuery): Promise<Page<H5pContent>> {
    return this.repository.list(query);
  }

  /**
   * `findByIdOrFail` is not used: its `h5pContent/<id> not found` names an
   * internal collection to an admin, and says something different from what the
   * player says about the same missing exercise.
   */
  async findById(contentId: string): Promise<H5pContent> {
    const found = await this.repository.findById(contentId);
    if (!found) {
      throw new NotFoundException(CONTENT_MISSING_MESSAGE);
    }
    return found;
  }

  /**
   * Removes an exercise's objects and then its index document.
   *
   * The two halves cannot be one transaction — one is Cloud Storage, the other
   * Firestore — so one of them survives a crash between them, and the objects
   * go first so that **an object never outlives its index row**. The row is
   * what names the objects; delete it first and a crash leaves files under a
   * `randomUUID()` prefix nothing can ever name again, and, because
   * `GET /api/h5p/play/:contentId` is `@Public()`, leaves "deleted" content
   * playable by anyone holding an old link. The surviving-row case is instead
   * visible in the index and repaired by re-issuing this delete.
   *
   * That recovery is why the sweep is `deleteByPrefix` and not
   * `H5pContentStorage.deleteContent`: `deleteContent` throws a 404 when
   * `h5p.json` is absent, and `deleteByPrefix` removes a prefix's objects
   * concurrently and in no defined order, so a half-completed earlier sweep can
   * have lost `h5p.json` while other files survive — exactly the state
   * `deleteContent` refuses to act on. It would answer 404 and strand both the
   * leftovers and the row. `deleteByPrefix` is a no-op on an empty prefix and
   * sweeps whatever is left.
   *
   * So the Firestore document is the sole authority for the 404; storage state
   * never decides a status code. That authority is `exists`, not a read: a row
   * whose stored shape no longer satisfies the schema still has to be removable
   * through this route, which is the repair path the surviving-row case above
   * relies on.
   *
   * Installed libraries under `h5p/libraries/` are deliberately untouched:
   * other content may use them, and a library with no dependents left is disk,
   * not a dangling reference.
   */
  async remove(contentId: string): Promise<void> {
    if (!(await this.repository.exists(contentId))) {
      throw new NotFoundException(CONTENT_MISSING_MESSAGE);
    }

    await this.storage.deleteByPrefix(contentPrefix(contentId));

    try {
      await this.repository.delete(contentId);
    } catch (error) {
      // This line is the only thing that tells an operator which row is left
      // pointing at objects that are already gone.
      this.logger.error(
        `H5P content ${contentId} had its files removed but its index document remains: ${messageOf(error)}`,
      );
      throw error;
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
