import type { Router } from '@angular/router';

/**
 * Reads a value the current navigation carries in `extras.state` — put there by
 * `router.navigate(..., { state })` or by a guard's `RedirectCommand`.
 *
 * Both sources are needed. With the default `urlUpdateStrategy: 'deferred'` the
 * router only writes the state into `history` after the target component is
 * activated, so during the navigation itself the pending navigation is the only
 * place it exists; after a refresh or a back button the pending navigation is
 * gone and the browser replays it from `history.state`. Reading one of the two
 * loses either the first paint or the refresh.
 */
export function navigationState<T>(router: Router, key: string): T | undefined {
  return (
    (router.getCurrentNavigation()?.extras.state?.[key] as T | undefined) ??
    (history.state?.[key] as T | undefined)
  );
}
