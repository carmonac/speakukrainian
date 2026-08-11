import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import {
  H5PAjaxEndpoint,
  H5PConfig,
  H5PEditor,
  H5PPlayer,
  fsImplementations,
} from '@lumieducation/h5p-server';
import type { IPlayerModel, ITemporaryFileStorage } from '@lumieducation/h5p-server';
import type { Env } from '../config/configuration.js';
import { H5pContentRepository } from './h5p-content.repository.js';
import { H5pContentStorage } from './h5p-content.storage.js';
import { H5pEditorController } from './h5p-editor.controller.js';
import { H5pEditorService } from './h5p-editor.service.js';
import { H5pLibraryStorage } from './h5p-library.storage.js';
import { H5pPublicController } from './h5p-public.controller.js';
import { H5pServeService } from './h5p-serve.service.js';
import { H5pTemporaryStorage } from './h5p-temporary.storage.js';
import { H5pClientAssets } from './h5p.client-assets.js';
import { createH5pConfig } from './h5p.config.js';
import { H5pController } from './h5p.controller.js';
import { H5pService } from './h5p.service.js';
import {
  H5P_AJAX_ENDPOINT,
  H5P_CONFIG,
  H5P_EDITOR,
  H5P_PLAYER,
  H5P_TEMPORARY_STORAGE,
  H5P_WORKING_DIRS,
  type H5pWorkingDirs,
} from './h5p.tokens.js';
import { H5pWorkingDirsModule } from './h5p.working-dirs.module.js';

/**
 * H5P package import, and everything the H5P client in a browser reads back.
 *
 * `StorageModule` and `FirestoreModule` are `@Global`, so the two adapters and
 * the repository need no imports here.
 */
@Module({
  imports: [
    H5pWorkingDirsModule,
    // The upload destination has to come from configuration, and
    // `FileInterceptor`'s options are fixed at decoration time — the route
    // cannot read `ConfigService`. Nest merges `MULTER_MODULE_OPTIONS` under
    // the route-level options, so the module supplies `dest` and
    // `h5pUploadOptions` supplies `limits` and `fileFilter`. `MulterModule` is
    // not global, so `MediaModule` — which passes its own memory storage
    // explicitly — is unaffected.
    MulterModule.registerAsync({
      imports: [H5pWorkingDirsModule],
      inject: [H5P_WORKING_DIRS],
      useFactory: (dirs: H5pWorkingDirs) => ({ dest: dirs.uploads }),
    }),
  ],
  controllers: [H5pController, H5pEditorController, H5pPublicController],
  providers: [
    {
      provide: H5P_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): H5PConfig =>
        createH5pConfig(config.get('H5P_BASE_URL', { infer: true })),
    },
    H5pClientAssets,
    H5pContentStorage,
    H5pLibraryStorage,
    H5pTemporaryStorage,
    {
      /**
       * The editor's scratch storage, in the bucket rather than on disk: a temp
       * file written by one Cloud Run instance is invisible to the next, and
       * the container filesystem is discarded anyway. The token stays so that
       * `H5PEditor`'s constructor argument is named by what it is rather than
       * by which class currently implements it.
       */
      provide: H5P_TEMPORARY_STORAGE,
      useExisting: H5pTemporaryStorage,
    },
    {
      provide: H5P_EDITOR,
      inject: [H5P_CONFIG, H5pLibraryStorage, H5pContentStorage, H5P_TEMPORARY_STORAGE],
      useFactory: async (
        config: H5PConfig,
        libraryStorage: H5pLibraryStorage,
        contentStorage: H5pContentStorage,
        temporaryStorage: ITemporaryFileStorage,
      ): Promise<H5PEditor> => {
        // `InMemoryStorage` is only reachable through `fsImplementations`; it is
        // not a named export of the package root.
        const keyValueStorage = new fsImplementations.InMemoryStorage();

        // **Seeded, and this is what keeps the server off `api.h5p.org`.**
        // `ContentTypeCache.get()` short-circuits on a truthy stored value, and
        // an empty array is truthy; left unseeded it falls through to
        // `forceUpdate()` → `registerOrGetUuid()`, which POSTs to
        // `config.hubRegistrationEndpoint` on **every** `GET /ajax?action=content-type-cache`.
        // `fetchingDisabled: 1` does not prevent that — it is only a field in
        // the registration payload — and the failure is caught, so nothing is
        // cached and the request is retried forever.
        //
        // The empty cache is not a placeholder: with `contentHubEnabled: false`
        // there are no hub content types, so `[]` is the truth.
        // `addLocalLibraries` still lists every installed library, which is
        // what the editor's content-type selector actually needs.
        //
        // The timestamp only makes `isOutdated()` false for
        // `contentTypeCacheRefreshInterval` — one day — after boot, so an
        // instance alive past that answers `outdated: true` to a client whose
        // only response to it, installing from the hub, the action allowlist
        // refuses with a 400. Nothing this API exposes calls
        // `updateIfNecessary`, so no outbound request follows from it; it is a
        // misleading flag on a long-lived instance and not a leak.
        await keyValueStorage.save('contentTypeCache', []);
        await keyValueStorage.save('contentTypeCacheUpdate', Date.now());

        // No `IPermissionSystem` is passed, so the default
        // `LaissezFairePermissionSystem` allows everything. That is correct
        // here rather than an oversight: authorization is `@Roles('editor')` at
        // the route, per CLAUDE.md rule 8, and the library never sees a request
        // that has not already passed it. No `contentUserDataStorage` either —
        // `trackResults` is off.
        return new H5PEditor(
          keyValueStorage,
          config,
          libraryStorage,
          contentStorage,
          temporaryStorage,
        );
      },
    },
    {
      provide: H5P_PLAYER,
      inject: [H5pLibraryStorage, H5pContentStorage, H5P_CONFIG],
      useFactory: (
        libraryStorage: H5pLibraryStorage,
        contentStorage: H5pContentStorage,
        config: H5PConfig,
      ): H5PPlayer =>
        // The stock renderer returns an HTML page. Both front ends want the
        // model: the admin hands it to `@lumieducation/h5p-webcomponents` and
        // the public site will render it server-side. `IPlayerModel` is
        // JSON-safe, unlike `IEditorModel`, which carries a live `UrlGenerator`
        // whose only enumerable field is the whole server configuration.
        new H5PPlayer(libraryStorage, contentStorage, config).setRenderer(
          (model: IPlayerModel) => model,
        ),
    },
    {
      provide: H5P_AJAX_ENDPOINT,
      inject: [H5P_EDITOR],
      useFactory: (editor: H5PEditor): H5PAjaxEndpoint => new H5PAjaxEndpoint(editor),
    },
    H5pContentRepository,
    H5pService,
    H5pServeService,
    H5pEditorService,
  ],
  exports: [H5P_EDITOR, H5P_PLAYER, H5P_CONFIG, H5pContentStorage, H5pLibraryStorage],
})
export class H5pModule {}
