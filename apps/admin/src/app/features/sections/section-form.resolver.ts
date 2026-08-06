import { inject } from '@angular/core';
import { RedirectCommand, Router, type ResolveFn } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type { Section } from '@speakukrainian/shared';
import { SectionsApi } from './sections.api';

/**
 * What the form route hands the form. Exactly one of the two is set on an
 * existing section or a subsection being created; both are `null` for a new
 * root section.
 */
export interface SectionFormData {
  section: Section | null;
  parent: Section | null;
}

/**
 * Loads the form's data before the route activates, which is what makes a cold
 * deep link to `/sections/:id` paint populated instead of flashing empty.
 *
 * The parent is not fetched on the edit route: a section's parent path is its
 * own path minus the last segment — the same trick `SectionsRepository.update`
 * uses — and nothing else on that screen needs the parent document.
 */
export const sectionFormResolver: ResolveFn<SectionFormData> = async (route) => {
  const api = inject(SectionsApi);
  const router = inject(Router);
  const id = route.paramMap.get('id');
  const parentId = route.queryParamMap.get('parentId');

  try {
    if (id !== null) {
      return { section: await firstValueFrom(api.get(id)), parent: null };
    }
    if (parentId !== null) {
      return { section: null, parent: await firstValueFrom(api.get(parentId)) };
    }
    return { section: null, parent: null };
  } catch {
    // The error interceptor has already toasted the API's own 404/403 wording,
    // so a second message here would only repeat it. `RedirectCommand` is how a
    // resolver bounces a navigation; `ResolveFn` accepts one without a cast.
    return new RedirectCommand(router.createUrlTree(['/sections']));
  }
};
