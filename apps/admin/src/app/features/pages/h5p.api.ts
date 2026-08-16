import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type { H5pSaveResult, SaveH5pContentInput } from '@speakukrainian/shared';
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
 * HTTP surface for `/api/h5p`, for the authoring widget alone. Types only — a
 * value import of the shared barrel would pull Zod into the eager bundle, as
 * `pages.api.ts` explains.
 *
 * There is no `uploadPackage`, no `playerModel` and no `attach`: #13 adds each
 * one with the screen that calls it, and an unused method is dead code.
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
}
