import { UrlGenerator } from '@lumieducation/h5p-server';
import type { H5PConfig, IUrlGenerator } from '@lumieducation/h5p-server';
import { H5P_URL_TOKEN_QUERY } from './h5p.url-token.js';

/**
 * The literal first path segment of the tokenised temporary-file route.
 *
 * Imported by both `H5pEditorController`'s `@Get` and {@link temporaryFilesUrlFor}
 * so the URL the editor model advertises and the route that has to answer it
 * cannot drift apart.
 *
 * **A distinct segment rather than a token on `temp-files/*path`.**
 * `temp-files/:token/*path` and `temp-files/*path` both match
 * `/temp-files/images/x.png`, so only declaration order would decide which one
 * answers — the same silent-shadowing class as two stacked `@Get` decorators.
 * A first segment that is *sometimes* a token and *sometimes* a directory name
 * cannot be parsed unambiguously either.
 */
export const TEMP_FILES_TOKEN_PATH = 'temp';

/**
 * The stock `UrlGenerator`, told to put a token in the ajax URLs.
 *
 * **No subclass is needed, and this is the whole change.** `UrlGenerator` takes
 * `csrfProtection` as its second constructor argument and `ajaxEndpoint(user)`
 * then answers `${baseUrl}${ajaxUrl}?<name>=<value>&action=`. Letting the
 * library build that string covers **both** `integration.ajaxPath` and
 * `integration.editor.ajaxPath` without this code having to know there are two,
 * and keeps the format upstream's responsibility, so a change to it cannot
 * silently produce an untokenised URL. `H5PEditor.getAjaxUrl` concatenates
 * `ajaxPath + action` and appends further parameters with `&`, and the ajax
 * handlers ignore query parameters they do not read.
 *
 * **`temporaryFiles()` is deliberately not the hook for the `<img>` preview,
 * and it cannot be.** `IUrlGenerator.temporaryFiles(): string` takes **no
 * user**, and `H5PEditor.generateEditorIntegration` calls it with no arguments
 * — so nothing here can bind a token to the caller. That half is decided in
 * `H5pEditorService.editorModel`, which is the nearest place the caller is
 * known.
 *
 * The query parameter name cannot collide: the ajax route reads `action`,
 * `machineName`, `majorVersion`, `minorVersion` and `language`.
 */
export function createH5pUrlGenerator(
  config: H5PConfig,
  mint: (uid: string) => string,
): IUrlGenerator {
  return new UrlGenerator(config, {
    protectAjax: true,
    // Neither route exists on this API: `trackResults` is off and no
    // `IContentUserDataStorage` is wired, so tokenising them would put a
    // credential into URLs nothing requests.
    protectContentUserData: false,
    protectSetFinished: false,
    queryParamGenerator: (user) => ({ name: H5P_URL_TOKEN_QUERY, value: mint(user.id) }),
  });
}

/**
 * The prefix Joubel's client builds a temporary file's preview URL from.
 *
 * `H5P.getPath` composes `filesPath + '/' + path`, so the token has to be a
 * **path segment** — a query string in the prefix would be mangled by the
 * concatenation.
 */
export function temporaryFilesUrlFor(baseUrl: string, token: string): string {
  return `${baseUrl}/${TEMP_FILES_TOKEN_PATH}/${token}`;
}
