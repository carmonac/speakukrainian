import { inject } from '@angular/core';
import { RedirectCommand, Router, type ResolveFn } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type { ContentPage, H5pExercisePageBody } from '@speakukrainian/shared';
import { NotificationService } from '../../core/notifications/notification.service';
import type { H5pEditorContent } from './h5p-exercise.model';
import { H5pApi } from './h5p.api';
import { PAGE_IS_NOT_AN_EXERCISE } from './page-messages';
import { PagesApi } from './pages.api';

/** What the exercise route hands the screen. */
export interface H5pExerciseData {
  page: ContentPage;
  /** Narrowed: the resolver refuses a page with any other body. */
  body: H5pExercisePageBody;
  /** The attached exercise, or `null` for a page that has none yet. */
  contentId: string | null;
  /** Everything the widget boots from, already fetched. */
  content: H5pEditorContent;
}

/**
 * Loads the page **and** everything the widget needs before the route
 * activates, which is what makes `/pages/:id/exercise` pasted into a new tab
 * open the widget populated rather than flash empty.
 *
 * Its own resolver rather than a reuse of `pageFormResolver`: that one costs a
 * second `GET /sections/:id` this screen has no use for, and it answers
 * `page: ContentPage | null`, which would leave the body type un-narrowed on the
 * one route where the body type is the whole point.
 *
 * **Loading here rather than inside `loadContentCallback`.** The callback is
 * what the component's interface suggests, and it puts the failure inside the
 * widget — which answers it by writing `<p>Error loading H5P content from
 * server: …` into its own root, an unstyled paragraph this screen cannot
 * restyle, beside whatever error surface it would have needed anyway. Resolving
 * first gives one error path, the house one.
 *
 * The route takes **no query parameters**, and must not grow any:
 * `H5PEditorComponent.render` overrides `H5PEditor.getAjaxUrl` to append
 * `window.location.search` to every ajax URL the widget builds, so a query
 * parameter here would silently ride along on every request to
 * `GET/POST /api/h5p/ajax`.
 */
export const h5pExerciseResolver: ResolveFn<H5pExerciseData> = async (route) => {
  const pages = inject(PagesApi);
  const h5p = inject(H5pApi);
  const router = inject(Router);
  const notifications = inject(NotificationService);
  const id = route.paramMap.get('id') ?? '';

  let page: ContentPage;
  try {
    page = await firstValueFrom(pages.get(id));
  } catch {
    // The error interceptor has already toasted the API's own 404/403 wording,
    // so a second message here would only repeat it.
    return new RedirectCommand(router.createUrlTree(['/pages']));
  }

  const body = page.body;
  if (body.type !== 'h5p_exercise') {
    // Nothing failed, so nothing else would say anything.
    notifications.error(PAGE_IS_NOT_AN_EXERCISE);
    return new RedirectCommand(router.createUrlTree(['/pages', page.id]));
  }

  const contentId = body.h5pContentId;

  try {
    if (contentId === null) {
      // No `/h5p/params` call: the component's own documentation says
      // `library`, `metadata` and `params` "must only be defined if contentId
      // is defined".
      return { page, body, contentId, content: await firstValueFrom(h5p.editorModel()) };
    }

    const [model, parameters] = await Promise.all([
      firstValueFrom(h5p.editorModel(contentId)),
      firstValueFrom(h5p.contentParameters(contentId)),
    ]);

    return {
      page,
      body,
      contentId,
      content: {
        ...model,
        library: parameters.library,
        // `params.metadata`, not the response's `h5p` — the same object by
        // another route, and the one `render()` does not read.
        metadata: parameters.params.metadata,
        params: parameters.params.params,
      },
    };
  } catch {
    // Includes `That exercise does not exist.` for a body naming deleted
    // content; the interceptor carries the API's own sentence.
    return new RedirectCommand(router.createUrlTree(['/pages', page.id]));
  }
};
