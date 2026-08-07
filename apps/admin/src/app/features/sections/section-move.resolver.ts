import { inject } from '@angular/core';
import { RedirectCommand, Router, type ResolveFn } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type { SectionTreeNode } from '@speakukrainian/shared';
import { NotificationService } from '../../core/notifications/notification.service';
import { SECTION_GONE } from './section-messages';
import { findNode } from './sections.model';
import { SectionsApi } from './sections.api';

/** What the move route hands the screen: the section, and the tree it sits in. */
export interface SectionMoveData {
  section: SectionTreeNode;
  tree: SectionTreeNode[];
}

/**
 * Loads the whole tree on every entry, warm or cold, and finds the section in
 * it — which is what makes a hard refresh of `/sections/:id/move` paint the
 * same screen a click from the tree does.
 *
 * The tree is not an extra fetch to save: the parent picker is a list of
 * candidate parents with the moving section's own subtree taken out, so the
 * screen needs it either way, and the moving section is a node inside it.
 * Carrying a second copy in the navigation state would put two documents for
 * one section on one screen, of which the copy is the one that can be stale.
 */
export const sectionMoveResolver: ResolveFn<SectionMoveData> = async (route) => {
  const api = inject(SectionsApi);
  const router = inject(Router);
  const notifications = inject(NotificationService);
  const id = route.paramMap.get('id') ?? '';

  let tree: SectionTreeNode[];
  try {
    tree = await firstValueFrom(api.tree());
  } catch {
    // The error interceptor has already toasted the API's own wording, so a
    // second message here would only repeat it.
    return new RedirectCommand(router.createUrlTree(['/sections']));
  }

  const section = findNode(tree, id);
  if (section === null) {
    // Nothing failed, so nothing else would say anything: the tree simply has
    // no such section — deleted in another tab, or a mistyped deep link.
    notifications.error(SECTION_GONE);
    return new RedirectCommand(router.createUrlTree(['/sections']));
  }

  return { section, tree };
};
