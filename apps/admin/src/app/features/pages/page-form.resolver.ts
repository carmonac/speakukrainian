import { inject } from '@angular/core';
import { RedirectCommand, Router, type ResolveFn } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import {
  documentIdSchema,
  pageTypeSchema,
  type ContentPage,
  type PageType,
  type Section,
} from '@speakukrainian/shared';
import { NotificationService } from '../../core/notifications/notification.service';
import { SectionsApi } from '../sections/sections.api';
import { PAGE_NEEDS_SECTION, SECTION_CANNOT_HOLD_PAGES } from './page-messages';
import { PagesApi } from './pages.api';

/** What the form route hands the form. `page` is `null` on the create route. */
export interface PageFormData {
  page: ContentPage | null;
  /**
   * The owning section, for its title. `null` only when the section could not be
   * read on the edit route, where the form falls back to the page's own path.
   */
  section: Section | null;
  /** Which body editor the shell renders — from the stored page, or from `?type=`. */
  type: PageType;
}

/**
 * Loads the form's data before the route activates, which is what makes a cold
 * deep link to `/pages/:id` paint populated instead of flashing empty.
 */
export const pageFormResolver: ResolveFn<PageFormData> = async (route) => {
  const pages = inject(PagesApi);
  const sections = inject(SectionsApi);
  const router = inject(Router);
  const notifications = inject(NotificationService);
  const id = route.paramMap.get('id');

  if (id !== null) {
    let page: ContentPage;
    try {
      page = await firstValueFrom(pages.get(id));
    } catch {
      // The error interceptor has already toasted the API's own 404/403
      // wording, so a second message here would only repeat it.
      return new RedirectCommand(router.createUrlTree(['/pages']));
    }

    // Best effort: a page whose section read failed must still be editable, and
    // the form can derive the section path from the page's own path.
    let section: Section | null;
    try {
      section = await firstValueFrom(sections.get(page.sectionId));
    } catch {
      section = null;
    }
    return { page, section, type: page.body.type };
  }

  // A page is created inside a section, and `createContentPageSchema.sectionId`
  // goes straight into `collection.doc()` — so a missing or malformed id is
  // stopped here rather than sent to the API. Nothing failed, so nothing else
  // would say anything.
  const sectionId = documentIdSchema.safeParse(route.queryParamMap.get('sectionId'));
  if (!sectionId.success) {
    notifications.error(PAGE_NEEDS_SECTION);
    return new RedirectCommand(router.createUrlTree(['/pages']));
  }

  let section: Section;
  try {
    section = await firstValueFrom(sections.get(sectionId.data));
  } catch {
    return new RedirectCommand(router.createUrlTree(['/pages']));
  }

  // `PagesRepository.create` answers 422 for a link section, and both the list
  // and the section tree already refuse to offer "Add page" for one. A
  // hand-typed URL is the third way in, and without this it opens a form whose
  // only possible ending is that 422, after the author has written the page.
  if (section.kind !== 'content') {
    notifications.error(SECTION_CANNOT_HOLD_PAGES);
    return new RedirectCommand(router.createUrlTree(['/pages']));
  }

  // An unrecognized `?type=` falls back to the one body this release edits.
  // Downgrading a *recognized* type is what would create the wrong document, so
  // the shell renders a placeholder for those instead.
  const type = pageTypeSchema.safeParse(route.queryParamMap.get('type'));
  return { page: null, section, type: type.success ? type.data : 'rich_text' };
};
