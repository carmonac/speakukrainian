import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type { H5pContent, H5pSaveResult, SaveH5pContentInput } from '@speakukrainian/shared';
import { ApiService } from '../../core/http/api.service';

/**
 * `GET /api/h5p/editor[/:contentId]` — `Pick<IEditorModel, 'integration' |
 * 'scripts' | 'styles'>`, as the API's own `EditorModelResponse` names it.
 *
 * `integration` is forwarded to the widget unopened, so it is typed as opaque
 * rather than restated: the shape is the library's, it carries the two minted
 * URL tokens, and nothing in the admin reads a field of it.
 */
export interface H5pEditorModel {
  integration: unknown;
  scripts: string[];
  styles: string[];
}

/**
 * `GET /api/h5p/params/:contentId` — the endpoint's own
 * `{ h5p, library, params: { metadata, params } }`.
 *
 * `h5p` is deliberately absent: it is `params.metadata` by another route, and
 * it is not what the widget reads.
 */
export interface H5pContentParameters {
  library: string;
  params: { metadata: unknown; params: unknown };
}

/**
 * `GET /api/h5p/play/:contentId` — everything `<h5p-player>` boots from.
 *
 * Ours and not the package's, for the reason ADR-019 records for the editor
 * model: the package's own `.d.ts` files import from
 * `@lumieducation/h5p-server`, which does not resolve from the admin and
 * degrades silently to `any` under `skipLibCheck`.
 *
 * `integration` is opaque because nothing in the admin reads a field of it — the
 * player merges it into `window.H5PIntegration` itself. `embedTypes` is carried
 * because it is what decides `renderDiv` against `renderIframe`
 * (`h5p-player.js:335-340`), which is the one thing this feature can do to the
 * admin's own styling.
 */
export interface H5pPlayerModel {
  contentId: string;
  integration: unknown;
  scripts: string[];
  styles: string[];
  embedTypes: ('iframe' | 'div')[];
}

/**
 * HTTP surface for `/api/h5p`, for the authoring widget and the exercise body
 * editor. Types only — a value import of the shared barrel would pull Zod into
 * the eager bundle, as `pages.api.ts` explains.
 */
@Injectable({ providedIn: 'root' })
export class H5pApi {
  private readonly api = inject(ApiService);

  /**
   * Everything the widget needs to boot. **Never cached**: the model carries two
   * URL tokens minted server-side that expire with `temporaryFileLifetime`, so
   * a mount always fetches its own.
   */
  editorModel(contentId?: string): Observable<H5pEditorModel> {
    return this.api.get<H5pEditorModel>(
      contentId === undefined ? '/h5p/editor' : `/h5p/editor/${contentId}`,
    );
  }

  contentParameters(contentId: string): Observable<H5pContentParameters> {
    return this.api.get<H5pContentParameters>(`/h5p/params/${contentId}`);
  }

  /**
   * Everything the preview's `<h5p-player>` boots from. The route is `@Public()`
   * and the subresources the model points at carry
   * `Cross-Origin-Resource-Policy: cross-origin` (#62), so nothing on the API
   * changes for this to be fetched from the admin's origin.
   *
   * **No `?lang`.** That parameter selects the *player's own chrome* (#36), not
   * the explanation's language; passing it would put the preview locale into the
   * mount key and reload the exercise every time the author switched language,
   * and upstream ships no Ukrainian chrome anyway (ADR-007).
   */
  playerModel(contentId: string): Observable<H5pPlayerModel> {
    return this.api.get<H5pPlayerModel>(`/h5p/play/${contentId}`);
  }

  /**
   * `POST /h5p/editor` (201, the library assigns the id) or
   * `POST /h5p/editor/:contentId` (200, the id is the caller's). Both answer
   * with the whole `H5pSaveResult`, whose `mainLibrary` is the ubername the
   * page body records.
   */
  save(contentId: string | undefined, input: SaveH5pContentInput): Observable<H5pSaveResult> {
    return this.api.post<H5pSaveResult>(
      contentId === undefined ? '/h5p/editor' : `/h5p/editor/${contentId}`,
      input,
    );
  }

  /**
   * Installs an uploaded `.h5p` package — `POST /h5p/content`, which is a
   * **different route from `POST /h5p/editor`** despite the similar shape: this
   * one unpacks a package the author brought and registers its libraries, that
   * one saves parameters the widget produced. Both answer `H5pSaveResult`, so
   * neither the return type nor the caller would notice the mix-up.
   */
  uploadPackage(file: File): Observable<H5pSaveResult> {
    return this.api.upload<H5pSaveResult>('/h5p/content', file);
  }

  /**
   * The index row behind an attached exercise, for its title — which the page
   * body does not store, so a title held in a signal would vanish on refresh.
   *
   * `@Roles('editor')` on the API side and it must stay so: ADR-007 makes the
   * absence of any public enumeration of H5P content the reason the play route
   * can be `@Public()`.
   */
  content(contentId: string): Observable<H5pContent> {
    return this.api.get<H5pContent>(`/h5p/content/${contentId}`);
  }

  /**
   * Points `h5pContent.pageId` at the page that now shows this exercise. The
   * page body is the authoritative record of the same relationship, so this is
   * the index catching up — `reattachExercise` in `h5p-exercise.model.ts` is
   * what orders this against the detach and decides what a failure means.
   */
  attach(contentId: string, pageId: string): Observable<H5pContent> {
    return this.api.post<H5pContent>(`/h5p/content/${contentId}/attach`, { pageId });
  }

  /**
   * Clears the same field. A route of its own rather than an attach carrying
   * `null`, so it reads no body — `null` and not `{}`, which would be a body
   * the handler declares no parameter for.
   */
  detach(contentId: string): Observable<H5pContent> {
    return this.api.post<H5pContent>(`/h5p/content/${contentId}/detach`, null);
  }
}
