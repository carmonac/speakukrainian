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
 * HTTP surface for `/api/h5p`, for the authoring widget and the exercise body
 * editor. Types only — a value import of the shared barrel would pull Zod into
 * the eager bundle, as `pages.api.ts` explains.
 *
 * There is no `playerModel`: the preview is #70's, and it adds that method with
 * the component that calls it. An unused method is dead code.
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
