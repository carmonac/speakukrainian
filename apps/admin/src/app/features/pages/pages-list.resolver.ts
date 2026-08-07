import { inject } from '@angular/core';
import type { ResolveFn } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import {
  documentIdSchema,
  type ContentPage,
  type Page,
  type SectionTreeNode,
} from '@speakukrainian/shared';
import { SectionsApi } from '../sections/sections.api';
import { PagesApi } from './pages.api';

export interface PagesListData {
  result: Page<ContentPage>;
  sections: SectionTreeNode[];
  /** The active filter, already validated. `null` means every section. */
  sectionId: string | null;
  /** True when either read failed, so an outage never renders as "no pages yet". */
  failed: boolean;
}

export const PAGE_LIST_LIMIT = 25;

/**
 * Resolves the list on every activation, warm or cold — which is what makes
 * `/pages?sectionId=…` deep-link and what makes a status changed on the form
 * visible on the way back without a manual reload. There is deliberately no
 * client-side page store between the two screens.
 *
 * A failure resolves an empty result rather than rejecting: a rejected resolver
 * cancels the navigation, and a cold deep link would then land nowhere at all.
 */
export const pagesListResolver: ResolveFn<PagesListData> = async (route) => {
  const pages = inject(PagesApi);
  const sections = inject(SectionsApi);

  // An unparseable filter is treated as no filter rather than forwarded, which
  // the API would answer with a 400 for a query the author never typed.
  const parsed = documentIdSchema.safeParse(route.queryParamMap.get('sectionId'));
  const sectionId = parsed.success ? parsed.data : null;

  try {
    const [result, tree] = await Promise.all([
      firstValueFrom(
        pages.list({
          limit: PAGE_LIST_LIMIT,
          ...(sectionId === null ? {} : { sectionId }),
        }),
      ),
      firstValueFrom(sections.tree()),
    ]);
    return { result, sections: tree, sectionId, failed: false };
  } catch {
    // Reported by the HTTP error interceptor.
    return { result: { items: [], nextCursor: null }, sections: [], sectionId, failed: true };
  }
};
