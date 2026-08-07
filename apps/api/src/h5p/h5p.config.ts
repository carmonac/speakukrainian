import { H5PConfig } from '@lumieducation/h5p-server';
import { MAX_H5P_UPLOAD_BYTES } from '@speakukrainian/shared';

/**
 * The H5P server's runtime configuration.
 *
 * No `IKeyValueStorage` is passed — the storage argument is optional and we do
 * not persist configuration; these values come from code and the environment,
 * so a deploy is what changes them.
 *
 * Trap worth knowing before adding anything here: `H5PConfig`'s defaults loop is
 * `for (const key in defaults) if (this[key] !== undefined) this[key] = defaults[key]`.
 * A key whose *class* default is `undefined` — `editorAddons`, `libraryConfig`,
 * `proxy`, `contentFilesUrlPlayerOverride` — is silently ignored. Setting one
 * of those here would look right and do nothing.
 */
export function createH5pConfig(): H5PConfig {
  return new H5PConfig(undefined, {
    // Not cosmetic. The stock defaults are 16 MiB per file and 64 MiB total,
    // and `PackageValidator.validateFileSizes` enforces them before anything
    // else runs — so without these a 70 MB package that passes the route's own
    // 100 MB limit dies inside the library quoting a limit no part of this API
    // advertises. One limit, stated once.
    maxFileSize: MAX_H5P_UPLOAD_BYTES,
    maxTotalSize: MAX_H5P_UPLOAD_BYTES,

    // `trackResults` is out of scope for Phase 1 and no
    // `IContentUserDataStorage` is wired, so the "finished" call would have
    // nowhere to land.
    setFinishedEnabled: false,

    // Keeps the server off `api.h5p.org` entirely: no content hub, no content
    // type cache fetches, no usage statistics. That is a deployment property
    // first and what makes the e2e hermetic second.
    contentHubEnabled: false,
    fetchingDisabled: 1,
    sendUsageStatistics: false,

    // Used by `UrlGenerator` for the editor and player routes that #12 and #13
    // add; harmless while nothing generates a URL.
    baseUrl: '/api/h5p',
  });
}
